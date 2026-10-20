// Port of FaceEmotion/Decision/DecisionScheduler.swift.
import type { Decision } from './DecisionMessage';

export type DropReason = 'late' | 'stale' | 'cancelled' | 'gated' | 'expired';

/// A decision due at a layer time, with the host time its cue belongs to.
export interface ScheduledDecision { decision: Decision; at: number; hostTime: number | null }

export type ScheduleOutcome =
  | { kind: 'scheduled'; at: number }
  | { kind: 'waiting' }
  | { kind: 'dropped'; reason: DropReason };

export interface DroppedDecision { decision: Decision | null; turnId: string; reason: DropReason }

interface Turn {
  id: string;
  order: number;
  cancelled: boolean;
  gated: boolean;
  /// Sentence index → audible layer time (and host time).
  starts: Map<number, { at: number; host: number | null }>;
  replyStartedAt: number | null;
}

const scheduled = (at: number): ScheduleOutcome => ({ kind: 'scheduled', at });
const droppedO = (reason: DropReason): ScheduleOutcome => ({ kind: 'dropped', reason });

/// When decisions apply (decision model design §5–6), in layer time.
///
/// - Pass A (utterance) applies on arrival, unless its turn's reply audio has already started (late), the turn was
///   cancelled or gated, or a newer turn has begun (stale).
/// - Pass B (sentence) applies when its sentence becomes audible (`sentenceAudioStarted`). A tag that arrives first
///   waits (dropped after `pendingExpiry`); one that arrives more than `lateGrace` after its sentence became audible
///   is dropped, never applied late.
/// - Barge-in: `cancel` drops everything pending for the turn and anything that arrives for it later.
/// - A message for an unseen turn makes it the current turn; older turns' pending work is dropped as stale.
export class DecisionScheduler {
  static readonly turnCapacity = 8;

  lateGrace = 0.1;
  pendingExpiry = 20;

  private turns: Turn[] = [];
  private nextOrder = 0;
  /// Due-ordered (by `at`) decisions waiting for their time.
  readonly scheduled: ScheduledDecision[] = [];
  /// Pass B tags waiting for their sentence's audio start (with receipt time).
  readonly waiting: { decision: Decision; receivedAt: number }[] = [];
  /// Dropped since the last `takeDropped()` (status card, log).
  private dropped: DroppedDecision[] = [];

  get currentTurnId(): string | null {
    let best: Turn | null = null;
    for (const t of this.turns) if (best === null || t.order > best.order) best = t;
    return best?.id ?? null;
  }

  private index(id: string): number { return this.turns.findIndex((t) => t.id === id); }

  /// Finds or creates the turn; a new turn becomes current and drops older turns' pending work.
  private turn(id: string): number {
    const i = this.index(id);
    if (i >= 0) return i;
    this.nextOrder += 1;
    // Older turns' pending work is stale now.
    const keep = this.scheduled.filter((s) => {
      if (s.decision.turnId === id) return true;
      this.dropped.push({ decision: s.decision, turnId: s.decision.turnId, reason: 'stale' });
      return false;
    });
    this.scheduled.length = 0; this.scheduled.push(...keep);
    const keepW = this.waiting.filter((w) => {
      if (w.decision.turnId === id) return true;
      this.dropped.push({ decision: w.decision, turnId: w.decision.turnId, reason: 'stale' });
      return false;
    });
    this.waiting.length = 0; this.waiting.push(...keepW);
    this.turns.push({ id, order: this.nextOrder, cancelled: false, gated: false, starts: new Map(), replyStartedAt: null });
    if (this.turns.length > DecisionScheduler.turnCapacity) {
      let oldest = 0;
      for (let k = 1; k < this.turns.length; k++) if (this.turns[k].order < this.turns[oldest].order) oldest = k;
      this.turns.splice(oldest, 1);
    }
    return this.index(id);
  }

  private isStale(i: number): boolean {
    const o = this.turns[i].order;
    return this.turns.some((t) => t.order > o);
  }

  /// A decision arrived at layer time `now` (host time `host`).
  receive(d: Decision, now: number, host: number | null): ScheduleOutcome {
    const known = this.index(d.turnId) >= 0;
    const i = this.turn(d.turnId);
    const t = this.turns[i];
    if (t.cancelled) return droppedO('cancelled');
    if (t.gated) return droppedO('gated');
    if (known && this.isStale(i)) return droppedO('stale');
    if (d.pass === 'utterance') {
      if (t.replyStartedAt !== null && t.replyStartedAt <= now) return droppedO('late');
      this.insert({ decision: d, at: now, hostTime: host });
      return scheduled(now);
    }
    const idx = d.sentenceIndex ?? 0;
    const s = t.starts.get(idx);
    if (s) {
      if (s.at < now - this.lateGrace) return droppedO('late');
      const at = Math.max(s.at, now);
      this.insert({ decision: d, at, hostTime: s.host });
      return scheduled(at);
    }
    this.waiting.push({ decision: d, receivedAt: now });
    return { kind: 'waiting' };
  }

  /// The voice loop: sentence `index` of `turnId` becomes audible at layer time `at` (host time `host`).
  /// Returns the outcomes of tags that were waiting for it.
  sentenceAudioStarted(turnId: string, idx: number, at: number, host: number | null, now: number): ScheduleOutcome[] {
    const i = this.turn(turnId);
    const t = this.turns[i];
    if (t.cancelled || t.gated) return [];
    t.starts.set(idx, { at, host });
    if (t.replyStartedAt === null || at < t.replyStartedAt) t.replyStartedAt = at;
    const out: ScheduleOutcome[] = [];
    let k = 0;
    while (k < this.waiting.length) {
      const w = this.waiting[k];
      if (w.decision.turnId === turnId && (w.decision.sentenceIndex ?? 0) === idx) {
        this.waiting.splice(k, 1);
        if (at < now - this.lateGrace) {
          this.dropped.push({ decision: w.decision, turnId, reason: 'late' }); out.push(droppedO('late'));
        } else {
          const tt = Math.max(at, now);
          this.insert({ decision: w.decision, at: tt, hostTime: host }); out.push(scheduled(tt));
        }
      } else {
        k += 1;
      }
    }
    return out;
  }

  /// The gate stopped this turn (not for me / not understood): later decisions for it are dropped.
  gate(turnId: string): void {
    this.turns[this.turn(turnId)].gated = true;
    this.removePending(turnId, 'gated');
  }

  /// Barge-in: drop the turn's pending decisions and anything that arrives for it later.
  cancel(turnId: string): void {
    this.turns[this.turn(turnId)].cancelled = true;
    this.removePending(turnId, 'cancelled');
  }

  /// True when the turn was cancelled or gated (gate events for it are ignored).
  isClosed(turnId: string): boolean {
    const i = this.index(turnId);
    if (i < 0) return false;
    return this.turns[i].cancelled || this.turns[i].gated || this.isStale(i);
  }

  private removePending(turnId: string, why: DropReason): void {
    let i = 0;
    while (i < this.scheduled.length) {
      if (this.scheduled[i].decision.turnId === turnId) {
        this.dropped.push({ decision: this.scheduled[i].decision, turnId, reason: why }); this.scheduled.splice(i, 1);
      } else i += 1;
    }
    i = 0;
    while (i < this.waiting.length) {
      if (this.waiting[i].decision.turnId === turnId) {
        this.dropped.push({ decision: this.waiting[i].decision, turnId, reason: why }); this.waiting.splice(i, 1);
      } else i += 1;
    }
  }

  private insert(s: ScheduledDecision): void {
    let i = this.scheduled.length;
    while (i > 0 && this.scheduled[i - 1].at > s.at) i -= 1;
    this.scheduled.splice(i, 0, s);
  }

  /// The next decision due at or before `t` (removed), if any.
  popDue(t: number): ScheduledDecision | null {
    const first = this.scheduled[0];
    if (first === undefined || !(first.at <= t + 1e-9)) return null;
    return this.scheduled.shift() ?? null;
  }

  /// True when something is due at or before `t`.
  hasDue(t: number): boolean {
    const first = this.scheduled[0];
    return first !== undefined && first.at <= t + 1e-9;
  }

  /// Drops waiting tags older than `pendingExpiry`.
  expire(now: number): void {
    if (this.waiting.length === 0) return;
    let i = 0;
    while (i < this.waiting.length) {
      if (now - this.waiting[i].receivedAt > this.pendingExpiry) {
        const w = this.waiting[i];
        this.dropped.push({ decision: w.decision, turnId: w.decision.turnId, reason: 'expired' }); this.waiting.splice(i, 1);
      } else i += 1;
    }
  }

  /// Drops accumulated since the last call.
  takeDropped(): DroppedDecision[] {
    if (this.dropped.length === 0) return [];
    const out = this.dropped;
    this.dropped = [];
    return out;
  }

  get hasDropped(): boolean { return this.dropped.length > 0; }

  reset(): void {
    this.turns.length = 0; this.scheduled.length = 0; this.waiting.length = 0; this.dropped.length = 0;
  }
}
