// Port of FacePerception/PerceptionCounters.swift.
import { GestureKind, PerceptionEvent } from './PerceptionTypes';

/// A reflex decision as logged by the coordinator: `"<gesture> → <beat>"` when a beat (or look) played,
/// `"<gesture>: <reason>"` when rejected; the coordinator's own gates log a bare reason ("stale", "reactions off").
export type ReflexDecision =
  | { kind: 'played'; gesture: string; beat: string }
  | { kind: 'rejected'; gesture: string; reason: string };

export const ReflexDecision = {
  played: (gesture: string, beat: string): ReflexDecision => ({ kind: 'played', gesture, beat }),
  rejected: (gesture: string, reason: string): ReflexDecision => ({ kind: 'rejected', gesture, reason }),

  parse(event: string, note: string | null): ReflexDecision | null {
    if (!event.startsWith('gesture.') || note === null) return null;
    const gesture = event.slice('gesture.'.length);
    const arrow = note.indexOf(' → ');
    if (arrow >= 0) {
      let beat = note.slice(arrow + ' → '.length);
      const p = beat.indexOf(' (');
      if (p >= 0) beat = beat.slice(0, p);
      return { kind: 'played', gesture, beat };
    }
    const colon = note.indexOf(': ');
    if (colon >= 0) return { kind: 'rejected', gesture, reason: note.slice(colon + 2) };
    return { kind: 'rejected', gesture, reason: note };
  },
} as const;

const KEYS = ['seconds', 'engagements', 'falseEngagements', 'engagementsWithSpeech', 'wrongReactionReports',
  'noneSessionReactions', 'peopleEntered', 'reentries', 'engagedHandOvers', 'heapBlocksDelta', 'heapSamples'] as const;
const MAPS = ['gestureEvents', 'reactionsByGesture', 'reactionsByBeat', 'rejectionsByReason'] as const;

const bumpKey = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };

/// Perception counters for one channel (design §5.3).
export class PerceptionCounts {
  /// Seconds this channel covers.
  seconds = 0;
  engagements = 0;
  /// Engagements the conversation loop reported as "no speech".
  falseEngagements = 0;
  engagementsWithSpeech = 0;
  gestureEvents: Record<string, number> = {};
  reactionsByGesture: Record<string, number> = {};
  reactionsByBeat: Record<string, number> = {};
  rejectionsByReason: Record<string, number> = {};
  /// The owner's "Wrong reaction" button.
  wrongReactionReports = 0;
  /// Any reaction while a consented "none" or hard-negative session recorded.
  noneSessionReactions = 0;
  peopleEntered = 0;
  /// ID-switch proxies: a person back in view after dropping out, and the engaged ID moving to another person within
  /// 1 s of the previous one leaving.
  reentries = 0;
  engagedHandOvers = 0;
  /// Allocation proxy: heap gained across sampled analysis calls, and how many were sampled.
  heapBlocksDelta = 0;
  heapSamples = 0;

  copy(): PerceptionCounts {
    const c = new PerceptionCounts();
    for (const k of KEYS) c[k] = this[k];
    for (const k of MAPS) c[k] = { ...this[k] };
    return c;
  }

  equals(o: PerceptionCounts): boolean {
    const same = (a: Record<string, number>, b: Record<string, number>): boolean => {
      const ka = Object.keys(a);
      return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
    };
    return KEYS.every((k) => this[k] === o[k]) && MAPS.every((k) => same(this[k], o[k]));
  }

  get reactions(): number { return Object.values(this.reactionsByGesture).reduce((a, b) => a + b, 0); }
  get gestureFalsePositives(): number { return this.wrongReactionReports + this.noneSessionReactions; }

  /// Per hour over this channel's span (never extrapolated from less than a minute).
  perHour(n: number): number { return n * 3600 / Math.max(this.seconds, 60); }
  get heapBlocksPerFrame(): number { return this.heapSamples > 0 ? this.heapBlocksDelta / this.heapSamples : 0; }

  toJSON(): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const k of KEYS) o[k] = this[k];
    for (const k of MAPS) o[k] = this[k];
    return o;
  }

  /// Tolerant of missing keys (Swift's synthesized Codable needs them all; port-note: lenient here).
  static decode(json: unknown): PerceptionCounts {
    const c = new PerceptionCounts();
    const j = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    for (const k of KEYS) if (typeof j[k] === 'number') c[k] = j[k] as number;
    for (const k of MAPS) {
      const m = j[k];
      if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
        for (const [n, v] of Object.entries(m)) if (typeof v === 'number') c[k][n] = v;
      }
    }
    return c;
  }
}

export type PerceptionCountersChannel = 'hour' | 'day';

/// Lifetime, hour and day channels (like `FrameStats`), fed from the coordinator's event log, the conversation's
/// engagement outcomes and the owner's button.
export class PerceptionCounters {
  lifetime = new PerceptionCounts();
  hour = new PerceptionCounts();
  day = new PerceptionCounts();
  /// The last reaction that played (for "Wrong reaction").
  lastReaction: { gesture: string; beat: string; at: number } | null = null;
  /// True while a consented "none" or hard-negative session records (every reaction is then a false positive).
  noneSessionActive = false;
  private lastTick: number | null = null;
  private outOfView = new Map<number, number>();
  private lastEngaged: number | null = null;
  private lastLeftAt = -Infinity;

  private bump(f: (c: PerceptionCounts) => void): void { f(this.lifetime); f(this.hour); f(this.day); }

  /// Advances the channels' spans (call at ≥ 1 Hz with the host clock).
  tick(now: number): void {
    if (this.lastTick !== null) { const dt = Math.min(Math.max(now - this.lastTick, 0), 5); this.bump((c) => { c.seconds += dt; }); }
    this.lastTick = now;
  }

  /// One coordinator log entry: the event and what the coordinator did about it.
  note(e: PerceptionEvent, note: string | null, now: number): void {
    switch (e.kind) {
      case 'engaged':
        this.bump((c) => { c.engagements += 1; });
        if (this.lastEngaged !== null && this.lastEngaged !== e.id && now - this.lastLeftAt <= 1) this.bump((c) => { c.engagedHandOvers += 1; });
        this.lastEngaged = e.id;
        break;
      case 'disengaged':
        if (e.reason === 'left' || e.reason === 'lookedAway') this.lastLeftAt = now;
        break;
      case 'personEntered':
        this.bump((c) => { c.peopleEntered += 1; });
        this.outOfView.delete(e.id);
        break;
      case 'personOutOfView':
        this.outOfView.set(e.id, now);
        break;
      case 'personLeft':
        this.outOfView.delete(e.id);
        break;
      case 'gesture': {
        const name = GestureKind.name(e.gesture.kind);
        this.bump((c) => bumpKey(c.gestureEvents, name));
        const d = ReflexDecision.parse(PerceptionEvent.name(e), note);
        if (d?.kind === 'played') {
          this.bump((c) => { bumpKey(c.reactionsByGesture, d.gesture); bumpKey(c.reactionsByBeat, d.beat); });
          if (this.noneSessionActive) this.bump((c) => { c.noneSessionReactions += 1; });
          this.lastReaction = { gesture: d.gesture, beat: d.beat, at: now };
        } else if (d?.kind === 'rejected') {
          this.bump((c) => bumpKey(c.rejectionsByReason, d.reason));
        }
        break;
      }
      default: break;
    }
  }

  /// A tracked person seen again (the 4 Hz snapshot): back in view after dropping out counts as a re-entry.
  noteVisible(ids: readonly number[]): void {
    for (const id of ids) {
      if (!this.outOfView.has(id)) continue;
      this.outOfView.delete(id);
      this.bump((c) => { c.reentries += 1; });
    }
  }

  noteEngagementOutcome(spoke: boolean): void {
    this.bump((c) => { if (spoke) c.engagementsWithSpeech += 1; else c.falseEngagements += 1; });
  }

  /// The owner's "Wrong reaction": counts a false positive and returns the reaction it refers to.
  reportWrongReaction(): { gesture: string; beat: string; at: number } | null {
    this.bump((c) => { c.wrongReactionReports += 1; });
    return this.lastReaction;
  }

  noteHeap(blocksDelta: number, samples: number): void {
    if (!(samples > 0)) return;
    this.bump((c) => { c.heapBlocksDelta += blocksDelta; c.heapSamples += samples; });
  }

  /// Returns the channel and starts it again.
  take(c: PerceptionCountersChannel): PerceptionCounts {
    if (c === 'hour') { const h = this.hour; this.hour = new PerceptionCounts(); return h; }
    const d = this.day; this.day = new PerceptionCounts(); return d;
  }
}
