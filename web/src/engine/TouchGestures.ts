// Port of FaceEngine/TouchGestures.swift.
import type { V2 } from '../core/vec';

export class TouchGestureConfig {
  /// Seconds still before a hold fires.
  holdDuration = 0.5;
  /// Points from the start a tap or hold may wander.
  slop = 12;
  /// Points of total travel a hold may have (the finger's jitter, not a rub).
  stillPath = 30;
  /// Points a stroke must travel before turning back counts as a reversal.
  minStroke = 8;
  /// Reversals within `reversalWindow` that make a scratch.
  reversals = 2;
  reversalWindow = 1;
  /// Seconds without a reversal that end a scratch.
  scratchTimeout = 0.6;
  /// Reversals per second that read as intensity 1 (`minIntensity` at the slowest).
  fullRate = 7;
  minIntensity = 0.35;
  copy(): TouchGestureConfig { return Object.assign(new TouchGestureConfig(), this); }
}

export type TouchGestureEvent =
  | { kind: 'tap'; at: V2 }
  /// Where the hold started.
  | { kind: 'hold'; at: V2 }
  /// The finger's position, 0…1 intensity from the stroke rate, and whether this is the scratch's first stroke.
  | { kind: 'scratch'; at: V2; intensity: number; began: boolean };

type GesturePhase = 'idle' | 'pending' | 'held' | 'moving' | 'scratching' | 'excluded';

const dist = (a: V2, b: V2): number => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

/// Classifies one finger (or one mouse press) on the face: **tap**, **hold** (talk), **scratch** (tickle) or a drag
/// (nothing). Pure and deterministic: feed it positions (points) with timestamps (seconds, any monotonic base) and a
/// regular `tick` while the finger is down.
///
/// - **Tap:** released before `holdDuration` within `slop` of where it started.
/// - **Hold:** still for `holdDuration` (within `slop` and at most `stillPath` of travel). Fires once.
/// - **Scratch:** `reversals` direction reversals within `reversalWindow`, on either axis. Each reversal from then on
///   emits `.scratch` until no reversal comes for `scratchTimeout`. A scratch never becomes a hold.
/// - **Drag:** moved beyond the slop without enough reversals: nothing.
///
/// A touch that starts in an excluded region (the owner corner) can only tap.
export class TouchGestureRecognizer {
  config: TouchGestureConfig;
  private phase: GesturePhase = 'idle';
  private start: V2 = { x: 0, y: 0 };
  private last: V2 = { x: 0, y: 0 };
  private startTime = 0;
  private path = 0;
  /// The touch has been further than the slop from its start at some point.
  private strayed = false;
  // Per axis (x, y): current stroke direction (−1, 0, +1) and its extreme.
  private dir = [0, 0];
  private extreme = [0, 0];
  /// Reversal times within the window (touch events only).
  private times: number[] = [];
  private lastReversal = -Infinity;

  constructor(config: TouchGestureConfig = new TouchGestureConfig()) { this.config = config; }

  /// A touch is down (began and not yet ended or cancelled).
  get isTracking(): boolean { return this.phase !== 'idle'; }
  /// The current touch is scratching.
  get isScratching(): boolean { return this.phase === 'scratching'; }

  begin(at: V2, time: number, excluded = false): void {
    this.phase = excluded ? 'excluded' : 'pending';
    this.start = { ...at }; this.last = { ...at }; this.startTime = time; this.path = 0; this.strayed = false;
    this.dir = [0, 0]; this.extreme = [at.x, at.y];
    this.clearReversals();
  }

  move(to: V2, time: number): TouchGestureEvent | null {
    if (this.phase === 'idle') return null;
    const p = { ...to }, t = time;
    this.path += dist(p, this.last);
    this.last = p;
    if (dist(p, this.start) > this.config.slop) this.strayed = true;
    if (this.phase === 'excluded' || this.phase === 'held') return null;
    if (this.phase === 'pending' && (this.strayed || this.path > this.config.stillPath)) this.phase = 'moving';
    const reversed = this.trackReversals(p, t);
    switch (this.phase) {
      case 'pending': case 'moving':
        if (!(reversed && this.reversalCount(t) >= this.config.reversals)) return null;
        this.phase = 'scratching';
        return { kind: 'scratch', at: p, intensity: this.intensity(t), began: true };
      case 'scratching':
        return reversed ? { kind: 'scratch', at: p, intensity: this.intensity(t), began: false } : null;
      default:
        return null;
    }
  }

  /// Call regularly (e.g. 30 Hz) while tracking: fires the hold and ends a stalled scratch.
  tick(time: number): TouchGestureEvent | null {
    if (this.phase === 'pending' && time - this.startTime >= this.config.holdDuration) {
      this.phase = 'held';
      return { kind: 'hold', at: { ...this.start } };
    }
    if (this.phase === 'scratching' && time - this.lastReversal >= this.config.scratchTimeout) {
      this.phase = 'moving';
      this.clearReversals();
    }
    return null;
  }

  end(at: V2, time: number): TouchGestureEvent | null {
    if (this.phase !== 'idle' && this.phase !== 'excluded' && this.phase !== 'held') this.move(at, time);
    const phase = this.phase;
    this.phase = 'idle';
    switch (phase) {
      case 'pending':
        return time - this.startTime >= this.config.holdDuration ? { kind: 'hold', at: { ...this.start } } : { kind: 'tap', at: { ...at } };
      case 'excluded':
        return this.strayed || dist(at, this.start) > this.config.slop ? null : { kind: 'tap', at: { ...at } };
      default:
        return null;
    }
  }

  /// The touch was cancelled (a second finger, the system, the corner menu opening): nothing more from it.
  cancel(): void { this.phase = 'idle'; }

  private trackReversals(p: V2, t: number): boolean {
    let turned = false;
    const c = this.config;
    for (let a = 0; a < 2; a++) {
      const v = a === 0 ? p.x : p.y;
      if (this.dir[a] === 0) {
        if (Math.abs(v - this.extreme[a]) >= c.minStroke) { this.dir[a] = v > this.extreme[a] ? 1 : -1; this.extreme[a] = v; }
      } else if ((v - this.extreme[a]) * this.dir[a] > 0) {
        this.extreme[a] = v;
      } else if ((this.extreme[a] - v) * this.dir[a] >= c.minStroke) {
        this.dir[a] = -this.dir[a];
        this.extreme[a] = v;
        turned = true;
      }
    }
    if (!(turned && t - this.lastReversal >= 0.08)) return false;
    this.lastReversal = t;
    this.times = this.times.filter((x) => !(t - x > c.reversalWindow));
    this.times.push(t);
    return true;
  }

  private reversalCount(t: number): number {
    return this.times.filter((x) => t - x <= this.config.reversalWindow).length;
  }

  private intensity(t: number): number {
    const rate = this.reversalCount(t) / Math.max(this.config.reversalWindow, 0.01);
    return Math.min(Math.max(rate / this.config.fullRate, this.config.minIntensity), 1);
  }

  private clearReversals(): void {
    this.times = [];
    this.lastReversal = -Infinity;
  }
}
