// Port of FacePerception/HarnessTiming.swift.
//
// Measurement harness (perception upgrade design §5.1): per-stage timings as a fixed struct, a 5 s window with
// p50 / p90 / p99 for the live HUD, and on-demand isolated timings. `StagePlan.summary` lives in TierPolicy.ts.

/// One analysed frame's stage timings (milliseconds). A stage that did not run on the frame is 0.
export class StageTimings {
  rects = 0;
  landmarks = 0;
  hands = 0;
  body = 0;
  motion = 0;
  /// The processor (tracker, eye contact, engagement, gestures) and everything else in the analysis call.
  logic = 0;

  /// Stage names in recording / HUD order.
  static readonly names: readonly string[] = ['rects', 'landmarks', 'hands', 'body', 'motion', 'logic'];

  /// Swift `StageTimings(values:)`: missing or non-finite values are 0.
  static fromValues(v: readonly number[]): StageTimings {
    const t = new StageTimings();
    const at = (i: number): number => i < v.length && Number.isFinite(v[i]) ? v[i] : 0;
    t.rects = at(0); t.landmarks = at(1); t.hands = at(2); t.body = at(3); t.motion = at(4); t.logic = at(5);
    return t;
  }

  copy(): StageTimings { return StageTimings.fromValues(this.values); }
  equals(o: StageTimings): boolean { return this.values.every((v, i) => v === o.values[i]); }

  get values(): number[] { return [this.rects, this.landmarks, this.hands, this.body, this.motion, this.logic]; }
  /// Name → ms for the stages that ran (the Status card's line).
  get dictionary(): Record<string, number> {
    const d: Record<string, number> = {};
    this.values.forEach((v, i) => { if (v > 0) d[StageTimings.names[i]] = v; });
    return d;
  }
  get total(): number { return this.rects + this.landmarks + this.hands + this.body + this.motion + this.logic; }

  toJSON(): Record<string, number> {
    return { rects: this.rects, landmarks: this.landmarks, hands: this.hands, body: this.body, motion: this.motion, logic: this.logic };
  }
}

/// Percentiles of one stage over a window.
export interface StagePercentiles {
  p50: number; p90: number; p99: number;
  /// Frames in the window where the stage ran (> 0 ms).
  count: number;
}
export const StagePercentiles = {
  make: (o: Partial<StagePercentiles> = {}): StagePercentiles => ({ p50: 0, p90: 0, p99: 0, count: 0, ...o }),
  /// Nearest-rank percentiles of `samples` (unsorted).
  of(samples: readonly number[]): StagePercentiles {
    if (samples.length === 0) return StagePercentiles.make();
    const s = [...samples].sort((a, b) => a - b);
    const q = (p: number): number => s[Math.min(Math.max(Math.ceil(p * s.length) - 1, 0), s.length - 1)];
    return { p50: q(0.5), p90: q(0.9), p99: q(0.99), count: s.length };
  },
} as const;

export interface StageTimingSummary {
  /// In `StageTimings.names` order.
  stages: StagePercentiles[];
  total: StagePercentiles;
  fps: number;
}
export const makeStageTimingSummary = (o: Partial<StageTimingSummary> = {}): StageTimingSummary =>
  ({ stages: [], total: StagePercentiles.make(), fps: 0, ...o });

/// The live HUD's window: the last `seconds` of analysed frames (a fixed ring; nothing grows).
export class StageTimingWindow {
  readonly seconds: number;
  times: number[];
  samples: StageTimings[];
  next = 0;
  filled = 0;

  constructor(seconds = 5, capacity = 256) {
    this.seconds = seconds;
    this.times = new Array<number>(capacity).fill(-Infinity);
    this.samples = Array.from({ length: capacity }, () => new StageTimings());
  }

  add(t: StageTimings, time: number): void {
    this.times[this.next] = time;
    this.samples[this.next] = t.copy();
    this.next = (this.next + 1) % this.times.length;
    this.filled = Math.min(this.filled + 1, this.times.length);
  }

  /// Frames inside the window ending at `now`.
  recent(now: number): StageTimings[] {
    const out: StageTimings[] = [];
    for (let i = 0; i < this.filled; i++) if (now - this.times[i] <= this.seconds && this.times[i] <= now) out.push(this.samples[i]);
    return out;
  }

  /// Per-stage percentiles (stages that didn't run on a frame are left out of that stage's distribution), the total's
  /// percentiles and the analysis rate over the window.
  summary(now: number): StageTimingSummary {
    const r = this.recent(now);
    const stages = StageTimings.names.map((_, i) => StagePercentiles.of(r.map((t) => t.values[i]).filter((v) => v > 0)));
    return { stages, total: StagePercentiles.of(r.map((t) => t.total)), fps: r.length / this.seconds };
  }
}

/// Shared between the analysis loop (writer) and the HUD (4 Hz reader). Also carries the HUD's "isolated timing"
/// request and its result. port-note: single-threaded here, so the Swift mutex is dropped.
export class PerceptionTimingMonitor {
  static readonly binWidth = 0.25;
  static readonly binCount = 400;
  /// Every `heapSampleEvery`-th analysis call is bracketed by a heap probe (the allocation proxy).
  static readonly heapSampleEvery = 30;

  private window = new StageTimingWindow();
  private isolatedRequested = false;
  private isolatedTimings: StageTimings | null = null;
  private isolatedAt: number | null = null;
  private heapDelta = 0;
  private heapSamples = 0;
  /// Per stage, 0.25 ms bins up to 100 ms (the soak log's hourly p90s).
  private bins: number[][] = StageTimings.names.map(() => new Array<number>(PerceptionTimingMonitor.binCount).fill(0));

  /// Per-stage p90 (ms) since the last call, from the histogram (null for a stage that never ran); starts again.
  takeP90s(): (number | null)[] {
    const r = this.bins.map((b) => PerceptionTimingMonitor.percentile(0.9, b));
    for (const b of this.bins) b.fill(0);
    return r;
  }

  static percentile(q: number, bins: readonly number[]): number | null {
    let total = 0;
    for (const n of bins) total += n;
    if (total <= 0) return null;
    const target = Math.ceil(q * total);
    let run = 0;
    for (let i = 0; i < bins.length; i++) {
      run += bins[i];
      if (run >= target) return (i + 1) * PerceptionTimingMonitor.binWidth;
    }
    return PerceptionTimingMonitor.binCount * PerceptionTimingMonitor.binWidth;
  }

  /// Analysis loop: heap blocks gained across one sampled analysis call.
  noteHeap(blocksDelta: number): void { this.heapDelta += blocksDelta; this.heapSamples += 1; }

  /// HUD (1 Hz): the samples since the last call.
  takeHeap(): { blocksDelta: number; samples: number } {
    const r = { blocksDelta: this.heapDelta, samples: this.heapSamples };
    this.heapDelta = 0; this.heapSamples = 0;
    return r;
  }

  /// Process-wide heap blocks in use. port-note: browsers expose no malloc statistics; Chrome's non-standard
  /// `performance.memory.usedJSHeapSize` (bytes, not blocks) stands in where present, else 0.
  static heapBlocksInUse(): number {
    const m = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    return m?.usedJSHeapSize ?? 0;
  }

  /// Analysis loop: one frame's timings.
  note(t: StageTimings, time: number): void {
    this.window.add(t, time);
    t.values.forEach((v, i) => {
      if (v > 0) this.bins[i][Math.min(Math.floor(v / PerceptionTimingMonitor.binWidth), PerceptionTimingMonitor.binCount - 1)] += 1;
    });
  }

  summary(now: number): StageTimingSummary { return this.window.summary(now); }

  /// HUD button: time each stage on a canned input with the camera paused (≈ 2 s).
  requestIsolated(): void { this.isolatedRequested = true; }
  /// Analysis loop: takes the request (once).
  takeIsolatedRequest(): boolean { const r = this.isolatedRequested; this.isolatedRequested = false; return r; }
  noteIsolated(t: StageTimings, time: number): void { this.isolatedTimings = t.copy(); this.isolatedAt = time; }
  get isolated(): { timings: StageTimings; at: number } | null {
    return this.isolatedTimings !== null && this.isolatedAt !== null ? { timings: this.isolatedTimings, at: this.isolatedAt } : null;
  }
  get isolatedPending(): boolean { return this.isolatedRequested; }

  /// Medians per stage over several isolated runs (each stage over the runs where it ran: hands and body pose
  /// alternate frames).
  static median(runs: readonly StageTimings[]): StageTimings {
    if (runs.length === 0) return new StageTimings();
    const out = StageTimings.names.map((_, i) => {
      const v = runs.map((r) => r.values[i]).filter((x) => x > 0).sort((a, b) => a - b);
      return v.length === 0 ? 0 : v[Math.floor(v.length / 2)];
    });
    return StageTimings.fromValues(out);
  }
}
