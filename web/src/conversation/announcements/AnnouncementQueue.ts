// The display's announcement queue: a port of YanniHome's ProactiveCoordinator (and AnnouncementStore). The add-on
// parses the notify payload (server/src/announce.ts) and sends a typed command; this holds announcements until there
// is an audience and it's appropriate, shows the has-a-message face, and hands batches to the voice loop, which
// pulls them (`takeBatch`) and reports back (`finish`); conversation/home's CoordinatorAnnouncements adapts it. Every finished message is reported through `onResult`
// (the app sends it as the `announcement` event: delivered / expired / cancelled / failed).
//
// Rules (spec § Proactivity):
// - Asleep, drowsy, half-awake, waking, force sleep or bedtime: hold silently and never wake Yanni. A night wake with
//   someone looking shows the has-a-message face only; delivery waits until bedtime ends and Yanni is awake.
// - Awake, nobody in view: hold. Someone arrives: idle / noticing → has-a-message. If they stay 3 minutes without
//   engaging, back to idle until a new arrival, new eye contact or a new message re-arms it.
// - They engage: the voice loop pulls the batch. A `high` message asks for a turn after 1.5 s of presence even
//   without eye contact (never overriding quiet mode). A conversation under way is never interrupted.
// - Quiet mode: the face only. Settings open: paused. Expiry is wall-clock and survives a relaunch.
//
// Agent-state writes: only idle / noticing → hasMessage and back; from delivery on the conversation loop owns it.
import type { AnnounceCommand, AnnouncementPriority, Nudge } from '@yanni/server/announce';
import type { AnnouncementOutcome, DisplayState } from '@yanni/server/protocol';
import type { AgentState } from '../../engine/AgentState';
import type { LifePhase } from '../../life/LifeTypes';

export interface HeldAnnouncement {
  id: string;
  /** Untrusted text. Never logged or shown on a status page. */
  text: string;
  context: Record<string, string>;
  priority: AnnouncementPriority;
  /** Wall clock, ms since the epoch. */
  receivedAt: number;
  expiresAt: number;
  state: 'pending' | 'delivering';
  /** Times delivery was interrupted (barge-in, the person leaving, a relaunch mid-delivery). */
  interruptions: number;
  /** The last attempt found the voice services unavailable (expiry then reports `failed`, not `expired`). */
  lastAttemptUnavailable: boolean;
}

export interface AnnouncementResult {
  id: string;
  outcome: AnnouncementOutcome;
  /** `partial`, `overflow`, `replaced`, `unavailable`, `reset`, `removed`, `cancel`. */
  reason?: string;
}

/** What the queue needs each poll (4 Hz). */
export interface ProactiveContext {
  agentState: AgentState;
  lifePhase: LifePhase;
  isBedtime: boolean;
  isForceSleep: boolean;
  /** Debounced presence. */
  personPresent: boolean;
  /** Someone is looking at Yanni (eye contact / engaged person). */
  eyeContact: boolean;
  quietMode: boolean;
  /** The owner Settings panel is open: delivery pauses. */
  settingsOpen: boolean;
}

export interface AudienceContext { people: number; engaged: boolean }
export interface AnnouncementBatch { id: number; items: HeldAnnouncement[] }

/** How a delivery attempt ended (the voice loop's report). */
export type DeliveryResult =
  /** Spoken to the end. */
  | 'spoken'
  /** Barge-in or the person leaving. Requeued once; a second interruption counts as delivered (`partial`). */
  | 'interrupted'
  /** The voice services were unavailable (or no speech voice in Yanni's voice): stays queued, `failed` at expiry. */
  | 'unavailable'
  /** Dropped before speaking (nobody left to tell): back to pending, no interruption counted. */
  | 'cancelled';

/** The voice loop's side: it pulls batches; the queue only pushes for a `high` message with an audience. */
export interface ProactiveConversation {
  /** Look-to-talk closed (the owner Settings panel is open). */
  isSuppressed: boolean;
  /** Start a proactive turn now; the loop then calls `takeBatch`. */
  requestProactiveTurn(): void;
}

export interface AnnouncementStore { load(): unknown; save(items: HeldAnnouncement[]): void }

/** Local storage at `yanni.pendingAnnouncements` (the Swift key); unreadable entries are dropped. */
export function localAnnouncementStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): AnnouncementStore {
  const key = 'yanni.pendingAnnouncements';
  return {
    load: () => { try { return JSON.parse(storage.getItem(key) ?? '[]'); } catch { return []; } },
    save: (items) => {
      try { if (items.length) storage.setItem(key, JSON.stringify(items)); else storage.removeItem(key); } catch { /* full or blocked */ }
    },
  };
}

export interface AnnouncementQueueDeps {
  /** Monotonic seconds (presence and has-a-message timers). */
  now(): number;
  /** Wall clock, ms since the epoch (expiry). */
  wallNow(): number;
  setAgentState(s: AgentState): void;
  store?: AnnouncementStore;
  conversation?: ProactiveConversation;
  onResult?(r: AnnouncementResult): void;
  /** A message arrived: an emotion impulse ("something to share"). */
  onArrival?(): void;
  /** A nudge to apply (awake, not bedtime). */
  onNudge?(n: Nudge): void;
}

const ACTIVITY: ReadonlySet<AgentState> = new Set<AgentState>(['engaged', 'listening', 'thinking', 'speaking', 'followUp', 'interrupted']);

const isHeld = (a: any): a is HeldAnnouncement => typeof a?.id === 'string' && typeof a.text === 'string'
  && Number.isFinite(a.receivedAt) && Number.isFinite(a.expiresAt) && (a.priority === 'normal' || a.priority === 'high');

export class AnnouncementQueue {
  static readonly maxQueue = 8;
  static readonly highPriorityDelay = 1.5;
  static readonly unengagedTimeout = 180;

  /** Priority, then oldest first. */
  items: HeldAnnouncement[] = [];
  lastResult: AnnouncementResult | undefined;
  inFlight: AnnouncementBatch | undefined;
  /** Has-a-message is armed (cleared after 3 minutes present without engagement). */
  armed = true;

  private ctx: ProactiveContext = { agentState: 'idle', lifePhase: 'awake', isBedtime: false, isForceSleep: false,
    personPresent: false, eyeContact: false, quietMode: false, settingsOpen: false };
  private wroteHasMessage = false;
  private presentSince: number | undefined;
  private hasMessageSince: number | undefined;
  private lastEyeContact = false;
  private highRequested = false;
  private nextBatchId = 1;
  /** A message with the same id that arrived while its predecessor was being spoken. */
  private inFlightReplacement: HeldAnnouncement | undefined;

  constructor(private readonly d: AnnouncementQueueDeps) { this.restore(); }

  // ---- Persistence ----

  /** Relaunch: drop expired messages; anything mid-delivery goes back to pending and counts as one interruption. */
  private restore(): void {
    const raw = this.d.store?.load();
    if (!Array.isArray(raw)) return;
    const now = this.d.wallNow();
    this.items = raw.filter(isHeld).filter((a) => a.expiresAt > now).map((a) => ({
      id: a.id, text: a.text, context: { ...a.context }, priority: a.priority, receivedAt: a.receivedAt, expiresAt: a.expiresAt,
      state: 'pending' as const, interruptions: (a.interruptions | 0) + (a.state === 'pending' ? 0 : 1),
      lastAttemptUnavailable: a.lastAttemptUnavailable === true,
    }));
    this.sort();
    this.items = this.items.slice(0, AnnouncementQueue.maxQueue);
    this.persist();
  }

  private persist(): void { this.d.store?.save(this.items); }

  private sort(): void {
    this.items.sort((a, b) => a.priority !== b.priority ? (a.priority === 'high' ? -1 : 1) : a.receivedAt - b.receivedAt);
  }

  // ---- Input ----

  /** A command from the add-on (`command: 'announce'`). */
  receive(cmd: AnnounceCommand): void {
    switch (cmd.kind) {
      case 'announce': {
        const a = cmd.announcement;
        const t = this.d.wallNow();
        return this.enqueue({ id: a.id, text: a.text, context: { ...a.context }, priority: a.priority, receivedAt: t,
          expiresAt: t + a.expiresIn * 1000, state: 'pending', interruptions: 0, lastAttemptUnavailable: false });
      }
      case 'cancel': return this.cancel(cmd.id, 'cancel');
      case 'nudge':
        // Never while asleep or at bedtime (a nudge is a feeling, not a reason to wake).
        if (this.ctx.lifePhase !== 'awake' || this.ctx.isBedtime || this.ctx.isForceSleep) return;
        this.d.onNudge?.(cmd.nudge);
    }
  }

  enqueue(a: HeldAnnouncement): void {
    const i = this.items.findIndex((x) => x.id === a.id);
    if (i >= 0) {
      // A repeated id replaces the pending one ("dryer: 5 min left" → "dryer done"), unless it's being spoken.
      if (this.items[i]!.state === 'delivering') { this.inFlightReplacement = a; return; }
      this.items.splice(i, 1);
      this.emit({ id: a.id, outcome: 'cancelled', reason: 'replaced' });
    }
    this.items.push(a);
    this.sort();
    while (this.items.length > AnnouncementQueue.maxQueue) {
      // Overflow: the oldest normal message goes (the oldest high one if there is no normal one).
      const pending = this.items.filter((x) => x.state === 'pending');
      const normals = pending.filter((x) => x.priority === 'normal');
      const pool = normals.length ? normals : pending;
      if (!pool.length) break;
      const victim = pool.reduce((m, x) => (x.receivedAt < m.receivedAt ? x : m));
      this.items.splice(this.items.indexOf(victim), 1);
      this.emit({ id: victim.id, outcome: 'cancelled', reason: 'overflow' });
    }
    this.armed = true;
    this.highRequested = false;
    this.persist();
    this.d.onArrival?.();
    this.evaluate();
  }

  cancel(id: string, reason: string): void {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [a] = this.items.splice(i, 1);
    if (this.inFlight) {
      this.inFlight.items = this.inFlight.items.filter((x) => x.id !== id);
      if (!this.inFlight.items.length) this.inFlight = undefined;
    }
    this.persist();
    this.emit({ id: a!.id, outcome: 'cancelled', reason });
    this.evaluate();
  }

  /** Revoked / reset: everything goes, reported as cancelled. */
  clearAll(reason: string): void {
    const gone = this.items;
    this.items = [];
    this.inFlight = undefined;
    this.inFlightReplacement = undefined;
    this.persist();
    for (const a of gone) this.emit({ id: a.id, outcome: 'cancelled', reason });
    this.evaluate();
  }

  // ---- Poll ----

  /** Called at 4 Hz with the latest context: expiry, the has-a-message face, high-priority turns. */
  update(ctx: ProactiveContext): void {
    const wasPresent = this.ctx.personPresent;
    this.ctx = { ...ctx };
    const now = this.d.now();
    if (ctx.personPresent) {
      if (!wasPresent || this.presentSince === undefined) {
        this.presentSince = now;
        this.armed = true; // a new arrival re-arms
        this.highRequested = false;
      }
    } else {
      this.presentSince = undefined;
      this.highRequested = false;
    }
    if (ctx.eyeContact && !this.lastEyeContact) this.armed = true;
    this.lastEyeContact = ctx.eyeContact;
    if (this.d.conversation) this.d.conversation.isSuppressed = ctx.settingsOpen;
    this.expire();
    this.evaluate();
  }

  private expire(): void {
    const now = this.d.wallNow();
    const expired = this.items.filter((a) => a.expiresAt <= now && a.state === 'pending');
    if (!expired.length) return;
    this.items = this.items.filter((a) => !expired.includes(a));
    this.persist();
    for (const a of expired) {
      this.emit(a.lastAttemptUnavailable ? { id: a.id, outcome: 'failed', reason: 'unavailable' } : { id: a.id, outcome: 'expired' });
    }
  }

  private get isAwakeDaytime(): boolean {
    return this.ctx.lifePhase === 'awake' && !this.ctx.isBedtime && !this.ctx.isForceSleep;
  }

  /** Delivery may happen now (an audience is a separate condition). */
  get canDeliver(): boolean {
    return this.isAwakeDaytime && !this.ctx.quietMode && !this.ctx.settingsOpen && this.inFlight === undefined;
  }

  private get pending(): HeldAnnouncement[] { return this.items.filter((a) => a.state === 'pending'); }

  private evaluate(): void {
    const c = this.ctx;
    const state = c.agentState;
    const now = this.d.now();
    const hasPending = this.pending.length > 0 || this.inFlight !== undefined;

    // Leave has-a-message when there's nothing left to tell.
    if (!hasPending) {
      if (this.wroteHasMessage && state === 'hasMessage') this.d.setAgentState(c.personPresent ? 'noticing' : 'idle');
      this.wroteHasMessage = false;
      this.hasMessageSince = undefined;
      return;
    }
    if (state !== 'hasMessage') this.hasMessageSince = undefined;

    // Has-a-message: awake daytime with someone there, or a night wake with someone looking (face only).
    const nightWakeLooking = c.isBedtime && c.lifePhase === 'awake' && !c.isForceSleep && c.eyeContact;
    const mayShow = (this.isAwakeDaytime && c.personPresent) || nightWakeLooking;
    if (mayShow && this.armed && !c.settingsOpen && (state === 'idle' || state === 'noticing')) {
      this.d.setAgentState('hasMessage');
      this.wroteHasMessage = true;
      this.hasMessageSince = now;
    }

    // Three minutes present without engaging: give up on the face until something new happens.
    if (state === 'hasMessage' && this.wroteHasMessage && !c.eyeContact) {
      this.hasMessageSince ??= now;
      if (now - this.hasMessageSince >= AnnouncementQueue.unengagedTimeout) {
        this.armed = false;
        this.d.setAgentState(c.personPresent ? 'noticing' : 'idle');
        this.hasMessageSince = undefined;
      }
    } else if (c.eyeContact) {
      this.hasMessageSince = state === 'hasMessage' ? now : undefined;
    }

    // A high-priority message asks for a turn after 1.5 s of presence, even without eye contact.
    if (this.canDeliver && !ACTIVITY.has(state) && !this.highRequested && !c.eyeContact
      && this.pending.some((a) => a.priority === 'high')
      && this.presentSince !== undefined && now - this.presentSince >= AnnouncementQueue.highPriorityDelay) {
      this.highRequested = true;
      this.d.conversation?.requestProactiveTurn();
    }
  }

  // ---- Voice loop contract ----

  hasDeliverable(audience: AudienceContext): boolean {
    return this.canDeliver && audience.people > 0 && this.pending.length > 0;
  }

  /** When engagement starts (or a follow-up ends with the person still engaged): every pending message, as one turn. */
  takeBatch(audience: AudienceContext): AnnouncementBatch | null {
    this.expire();
    if (!this.hasDeliverable(audience)) return null;
    const items = this.pending;
    for (const a of items) a.state = 'delivering';
    const batch = { id: this.nextBatchId++, items: items.map((a) => ({ ...a, context: { ...a.context } })) };
    this.inFlight = batch;
    this.wroteHasMessage = false; // the conversation loop owns the state from here
    this.persist();
    return batch;
  }

  /** The voice loop's result for a batch (Swift `finish(batch:result:)`). */
  finish(id: number, result: DeliveryResult): void {
    const batch = this.inFlight;
    if (!batch || batch.id !== id) return;
    this.inFlight = undefined;
    const ids = new Set(batch.items.map((a) => a.id));
    const done: AnnouncementResult[] = [];
    this.items = this.items.filter((a) => {
      if (!ids.has(a.id)) return true;
      if (result === 'spoken') { done.push({ id: a.id, outcome: 'delivered' }); return false; }
      if (result === 'interrupted') {
        if (a.interruptions >= 1) { done.push({ id: a.id, outcome: 'delivered', reason: 'partial' }); return false; }
        a.interruptions += 1;
      }
      if (result === 'unavailable') a.lastAttemptUnavailable = true;
      a.state = 'pending';
      return true;
    });
    const r = this.inFlightReplacement;
    if (r) {
      this.inFlightReplacement = undefined;
      this.items = this.items.filter((a) => a.id !== r.id);
      this.items.push(r);
    }
    this.sort();
    this.persist();
    for (const x of done) this.emit(x);
    this.armed = true;
    this.evaluate();
  }

  /** The `pending_messages` sensor and its attributes. */
  report(): Pick<DisplayState, 'pending_messages' | 'pending_ids' | 'pending_expires'> {
    return { pending_messages: this.items.length, pending_ids: this.items.map((a) => a.id),
      pending_expires: this.items.map((a) => new Date(a.expiresAt).toISOString()) };
  }

  private emit(r: AnnouncementResult): void {
    this.lastResult = r;
    this.d.onResult?.(r);
  }
}
