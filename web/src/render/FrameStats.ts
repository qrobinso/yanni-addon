// Port of FaceRendering/FrameStats.swift.
import type { FrameRateTier } from './FrameRatePolicy';

/// Stats tier: asleep 30, awake 60, burst 120 (raw values are slot indices).
export type StatsTier = 0 | 1 | 2;
export const StatsTier = {
  asleep: 0 as StatsTier, awake: 1 as StatsTier, burst: 2 as StatsTier,
  allCases: [0, 1, 2] as readonly StatsTier[],
  from: (t: FrameRateTier): StatsTier => (t === 30 ? 0 : t === 60 ? 1 : 2),
  /// The tier's nominal rate (before the display's own ceiling).
  targetFPS: (t: StatsTier): number => (t === 0 ? 30 : t === 1 ? 60 : 120),
  label: (t: StatsTier): string => (['asleep', 'awake', 'burst'] as const)[t],
} as const;

/// Per-tier totals for one channel.
export class TierStats {
  delivered = 0;
  requested = 0;
  skipped = 0;
  hitches = 0;
  hitchSeconds = 0;
  /// Time covered by accounted gaps in this tier (s).
  seconds = 0;
  gapP50 = 0;
  gapP99 = 0;
  gapMax = 0;
  mainMean = 0;
  mainP50 = 0;
  mainP99 = 0;
  mainMax = 0;
  gpuSamples = 0;
  gpuMean = 0;
  gpuMax = 0;
  gpuErrors = 0;

  /// Delivered / requested (1 when nothing was requested).
  get deliveredRatio(): number { return this.requested > 0 ? this.delivered / this.requested : 1; }
  /// Hitch time per second in the tier (ms/s).
  get hitchMsPerSecond(): number { return this.seconds > 0 ? this.hitchSeconds * 1000 / this.seconds : 0; }
  /// Frames shown per second while in the tier.
  get deliveredFPS(): number { return this.seconds > 0 ? this.delivered / this.seconds : 0; }
  /// The per-tier pass criteria (§6.6): delivered/requested ≥ 0.98 and hitch time < 2 ms/s.
  get meetsCriteria(): boolean { return this.requested === 0 || (this.deliveredRatio >= 0.98 && this.hitchMsPerSecond < 2); }
}

export class FrameStatsSnapshot {
  asleep = new TierStats();
  awake = new TierStats();
  burst = new TierStats();
  /// Gaps longer than `pauseGap` (not counted as hitches).
  pauses = 0;
  /// Seconds since the channel started.
  span = 0;

  tier(t: StatsTier): TierStats { return t === 0 ? this.asleep : t === 1 ? this.awake : this.burst; }
  setTier(t: StatsTier, s: TierStats): void { if (t === 0) this.asleep = s; else if (t === 1) this.awake = s; else this.burst = s; }
  get frames(): number { return this.asleep.delivered + this.awake.delivered + this.burst.delivered; }
  get skipped(): number { return this.asleep.skipped + this.awake.skipped + this.burst.skipped; }
  get hitches(): number { return this.asleep.hitches + this.awake.hitches + this.burst.hitches; }
  get gpuErrors(): number { return this.asleep.gpuErrors + this.awake.gpuErrors + this.burst.gpuErrors; }
  get meetsCriteria(): boolean { return this.asleep.meetsCriteria && this.awake.meetsCriteria && this.burst.meetsCriteria; }
}

/// The resettable channels (lifetime is channel 0 and never resets).
export type StatsChannel = 1 | 2;
export const StatsChannel = { hour: 1 as StatsChannel, day: 2 as StatsChannel } as const;

const CHANNELS = 3, TIERS = 3;
// Accumulator layout per slot (Float64Array): one record of these fields.
const A = { delivered: 0, requested: 1, skipped: 2, hitches: 3, hitchSeconds: 4, seconds: 5, gapMax: 6, mainSum: 7,
  mainCount: 8, mainMax: 9, gpuSamples: 10, gpuSum: 11, gpuMax: 12, gpuErrors: 13 } as const;
const AN = 14;

/// Frame delivery, measured (hardening design §6.6, C1). Per tier: a gap histogram (0.25 ms bins to 100 ms) with the
/// maximum, main-thread time (0.05 ms bins to 20 ms), delivered vs requested frames and hitches, skipped frames,
/// sampled GPU time. Three channels: lifetime, hour and day. Everything is preallocated; recording never allocates.
export class FrameStats {
  static readonly gapBinWidth = 0.000_25;
  static readonly gapBinCount = 400;
  static readonly mainBinWidth = 0.000_05;
  static readonly mainBinCount = 400;
  /// A gap longer than this many expected intervals is a hitch.
  static readonly hitchFactor = 1.5;
  /// A gap longer than this (s) is a pause, not a hitch.
  static readonly pauseGap = 1.0;
  /// GPU time is sampled on every n-th presented frame.
  static readonly gpuSampleInterval = 60;

  private accums = new Float64Array(CHANNELS * TIERS * AN);
  private gapHist = new Uint32Array(CHANNELS * TIERS * (FrameStats.gapBinCount + 1));
  private mainHist = new Uint32Array(CHANNELS * TIERS * (FrameStats.mainBinCount + 1));
  private pauses = [0, 0, 0];
  private firstTime = [NaN, NaN, NaN];
  private lastTime: number | undefined;
  private lastTier: StatsTier | undefined;
  private pausePending = false;
  private presentedCount = 0;

  /// Frames recorded (presented or skipped) since launch.
  recordedFrames = 0;
  /// Host time of the last recorded frame (the render watchdog's liveness signal).
  lastFrameTime: number | undefined;

  /// Records one frame-timestamp tick.
  recordFrame(time: number, tier: StatsTier, expectedInterval: number, mainSeconds: number, presented: boolean): void {
    this.recordedFrames += 1;
    this.lastFrameTime = time;
    let gap: number | undefined;
    if (this.lastTime !== undefined && !this.pausePending && time > this.lastTime) {
      const g = time - this.lastTime;
      if (g > FrameStats.pauseGap) { for (let c = 0; c < CHANNELS; c++) this.pauses[c] += 1; } else gap = g;
    }
    const transition = this.lastTier !== undefined && this.lastTier !== tier;
    const a = this.accums;
    for (let channel = 0; channel < CHANNELS; channel++) {
      const slot = channel * TIERS + tier;
      const o = slot * AN;
      if (Number.isNaN(this.firstTime[channel])) this.firstTime[channel] = time;
      if (presented) a[o + A.delivered] += 1; else a[o + A.skipped] += 1;
      if (gap !== undefined && expectedInterval > 0) {
        a[o + A.seconds] += gap;
        if (gap > a[o + A.gapMax]) a[o + A.gapMax] = gap;
        this.gapHist[slot * (FrameStats.gapBinCount + 1) + FrameStats.bin(gap, FrameStats.gapBinWidth, FrameStats.gapBinCount)] += 1;
        // The first gap after a tier change belongs to the link's adaptation, not to either tier's pacing.
        if (transition) {
          a[o + A.requested] += 1;
        } else {
          const q = gap / expectedInterval;
          a[o + A.requested] += Math.max(1, Math.sign(q) * Math.round(Math.abs(q)));
          if (gap > FrameStats.hitchFactor * expectedInterval) {
            a[o + A.hitches] += 1;
            a[o + A.hitchSeconds] += gap - expectedInterval;
          }
        }
      } else {
        a[o + A.requested] += 1;
      }
      const m = Math.max(mainSeconds, 0);
      a[o + A.mainSum] += m;
      a[o + A.mainCount] += 1;
      if (m > a[o + A.mainMax]) a[o + A.mainMax] = m;
      this.mainHist[slot * (FrameStats.mainBinCount + 1) + FrameStats.bin(m, FrameStats.mainBinWidth, FrameStats.mainBinCount)] += 1;
    }
    if (presented) this.presentedCount += 1;
    this.lastTime = time;
    this.lastTier = tier;
    this.pausePending = false;
  }

  /// True when the frame about to be presented should have its GPU time sampled.
  get shouldSampleGPUNext(): boolean { return (this.presentedCount + 1) % FrameStats.gpuSampleInterval === 0; }

  /// One sampled GPU time (or its error).
  recordGPU(seconds: number, error: boolean, tier: StatsTier): void {
    for (let channel = 0; channel < CHANNELS; channel++) {
      const o = (channel * TIERS + tier) * AN;
      if (error) {
        this.accums[o + A.gpuErrors] += 1;
      } else if (Number.isFinite(seconds) && seconds >= 0) {
        this.accums[o + A.gpuSamples] += 1;
        this.accums[o + A.gpuSum] += seconds;
        if (seconds > this.accums[o + A.gpuMax]) this.accums[o + A.gpuMax] = seconds;
      }
    }
  }

  /// The next gap is a pause (backgrounded, link stopped or recreated), not a hitch.
  notePause(): void { this.pausePending = true; }

  /// Lifetime totals.
  snapshot(): FrameStatsSnapshot { return this.make(0); }
  /// A channel since it was last taken (or launch), without resetting it.
  peek(channel: StatsChannel): FrameStatsSnapshot { return this.make(channel); }

  /// A channel since it was last taken (or launch); then resets it.
  take(channel: StatsChannel): FrameStatsSnapshot {
    const s = this.make(channel);
    for (let t = 0; t < TIERS; t++) {
      const slot = channel * TIERS + t;
      this.accums.fill(0, slot * AN, (slot + 1) * AN);
      this.gapHist.fill(0, slot * (FrameStats.gapBinCount + 1), (slot + 1) * (FrameStats.gapBinCount + 1));
      this.mainHist.fill(0, slot * (FrameStats.mainBinCount + 1), (slot + 1) * (FrameStats.mainBinCount + 1));
    }
    this.pauses[channel] = 0;
    this.firstTime[channel] = NaN;
    return s;
  }

  private make(channel: number): FrameStatsSnapshot {
    const s = new FrameStatsSnapshot();
    s.pauses = this.pauses[channel];
    const first = this.firstTime[channel];
    if (!Number.isNaN(first) && this.lastTime !== undefined) s.span = Math.max(this.lastTime - first, 0);
    for (const tier of StatsTier.allCases) {
      const slot = channel * TIERS + tier;
      const o = slot * AN, a = this.accums;
      const t = new TierStats();
      t.delivered = a[o + A.delivered];
      t.requested = a[o + A.requested];
      t.skipped = a[o + A.skipped];
      t.hitches = a[o + A.hitches];
      t.hitchSeconds = a[o + A.hitchSeconds];
      t.seconds = a[o + A.seconds];
      t.gapMax = a[o + A.gapMax];
      const gb = slot * (FrameStats.gapBinCount + 1), mb = slot * (FrameStats.mainBinCount + 1);
      t.gapP50 = FrameStats.percentile(this.gapHist, gb, FrameStats.gapBinCount, FrameStats.gapBinWidth, 0.5, t.gapMax);
      t.gapP99 = FrameStats.percentile(this.gapHist, gb, FrameStats.gapBinCount, FrameStats.gapBinWidth, 0.99, t.gapMax);
      const count = a[o + A.mainCount];
      t.mainMean = count > 0 ? a[o + A.mainSum] / count : 0;
      t.mainMax = a[o + A.mainMax];
      t.mainP50 = FrameStats.percentile(this.mainHist, mb, FrameStats.mainBinCount, FrameStats.mainBinWidth, 0.5, t.mainMax);
      t.mainP99 = FrameStats.percentile(this.mainHist, mb, FrameStats.mainBinCount, FrameStats.mainBinWidth, 0.99, t.mainMax);
      t.gpuSamples = a[o + A.gpuSamples];
      t.gpuMean = t.gpuSamples > 0 ? a[o + A.gpuSum] / t.gpuSamples : 0;
      t.gpuMax = a[o + A.gpuMax];
      t.gpuErrors = a[o + A.gpuErrors];
      s.setTier(tier, t);
    }
    return s;
  }

  private static bin(v: number, width: number, count: number): number {
    if (!(Number.isFinite(v) && v > 0)) return 0;
    const i = v / width;
    return i >= count ? count : Math.trunc(i);
  }

  /// The upper edge of the bin that crosses `p` (the overflow bin reports the maximum seen).
  private static percentile(hist: Uint32Array, base: number, count: number, width: number, p: number, max: number): number {
    let total = 0;
    for (let i = 0; i <= count; i++) total += hist[base + i];
    if (total <= 0) return 0;
    const target = Math.ceil(total * p);
    let run = 0;
    for (let i = 0; i <= count; i++) {
      run += hist[base + i];
      if (run >= target) return i === count ? max : Math.min((i + 1) * width, max);
    }
    return max;
  }
}
