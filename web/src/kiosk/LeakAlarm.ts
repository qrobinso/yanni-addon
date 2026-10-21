// Port of FaceRuntime/LeakAlarm.swift. The leak alarm (hardening design §6.6, H5). Fed one `VitalsSample` a minute;
// raises `suspected` (sticky until the page reloads) when:
// - **footprint slope:** the least-squares slope over the last 24 h (samples after hour 1, spanning ≥ `minSpan`)
//   exceeds 2 MB/h;
// - **ceiling:** footprint exceeds the footprint at hour 1 plus 50 % of the memory available at launch;
// - **threads, open files or GPU memory grow:** the lowest value in the last hour exceeds the hour-2 baseline by a
//   margin. port-note: a browser reports none of the three (MAPPING.md), so samples carry 0 and these never trip.
import type { VitalsSample } from './ProcessVitals';

export type LeakReasons = number;
export const LeakReasons = {
  footprintSlope: 1 << 0, footprintCeiling: 1 << 1, threads: 1 << 2, openFiles: 1 << 3, metal: 1 << 4,
  labels(r: LeakReasons): string[] {
    const out: string[] = [];
    if (r & LeakReasons.footprintSlope) out.push('footprint slope');
    if (r & LeakReasons.footprintCeiling) out.push('footprint ceiling');
    if (r & LeakReasons.threads) out.push('threads');
    if (r & LeakReasons.openFiles) out.push('open files');
    if (r & LeakReasons.metal) out.push('GPU memory');
    return out;
  },
};

interface Lows { threads: number; files: number; metal: number }

export class LeakAlarm {
  static readonly warmup = 3600;
  static readonly window = 24 * 3600;
  static readonly minSpan = 6 * 3600;
  static readonly slopeLimit = 2 * 1_048_576;
  static readonly threadMargin = 10;
  static readonly fileMargin = 20;
  static readonly metalMargin = 64 * 1_048_576;
  /// Samples kept: 25 h at one a minute.
  static readonly capacity = 25 * 60;

  suspected: LeakReasons = 0;
  samples: VitalsSample[] = [];
  footprintAtHour1: number | null = null;
  availableAtLaunch: number | null = null;
  /// Latest footprint slope (bytes/hour) when there is enough data.
  slope: number | null = null;
  private baseline: Lows | null = null;
  private baselineAcc: Lows | null = null;

  /// `availableStandIn`: used when a sample carries no `availableMemory`.
  constructor(private readonly availableStandIn = 512 * 1_048_576) {}

  get isSuspected(): boolean { return this.suspected !== 0; }

  /// The absolute footprint ceiling, once hour 1 has passed.
  get ceiling(): number | null {
    const h1 = this.footprintAtHour1, a = this.availableAtLaunch;
    return h1 === null || a === null ? null : h1 + Math.floor(a / 2);
  }

  add(s: VitalsSample): void {
    if (this.availableAtLaunch === null) this.availableAtLaunch = s.availableMemory ?? this.availableStandIn;
    this.samples.push(s);
    if (this.samples.length > LeakAlarm.capacity) this.samples.splice(0, this.samples.length - LeakAlarm.capacity);

    if (s.uptime >= LeakAlarm.warmup) {
      if (this.footprintAtHour1 === null) this.footprintAtHour1 = s.footprint;
      // Baseline: the minimum over the second hour of uptime.
      if (s.uptime < 2 * LeakAlarm.warmup) {
        const b = this.baselineAcc ?? { threads: s.threads, files: s.openFiles, metal: s.metalBytes };
        this.baselineAcc = { threads: Math.min(b.threads, s.threads), files: Math.min(b.files, s.openFiles), metal: Math.min(b.metal, s.metalBytes) };
      } else if (this.baseline === null && this.baselineAcc !== null) {
        this.baseline = this.baselineAcc;
      }
    }
    const c = this.ceiling;
    if (c !== null && s.footprint > c) this.suspected |= LeakReasons.footprintCeiling;

    this.slope = LeakAlarm.footprintSlope(this.samples, s.uptime);
    if (this.slope !== null && this.slope > LeakAlarm.slopeLimit) this.suspected |= LeakReasons.footprintSlope;

    // Growth: compare the last hour (once it no longer overlaps the baseline hour) with the baseline.
    const b = this.baseline;
    if (b !== null && s.uptime >= 3 * LeakAlarm.warmup) {
      const lo: Lows = { threads: Infinity, files: Infinity, metal: Infinity };
      for (let i = this.samples.length - 1; i >= 0; i--) {
        const x = this.samples[i];
        if (!(x.uptime > s.uptime - LeakAlarm.warmup)) break;
        lo.threads = Math.min(lo.threads, x.threads); lo.files = Math.min(lo.files, x.openFiles); lo.metal = Math.min(lo.metal, x.metalBytes);
      }
      if (lo.threads !== Infinity) {
        if (lo.threads > b.threads + LeakAlarm.threadMargin) this.suspected |= LeakReasons.threads;
        if (lo.files > b.files + LeakAlarm.fileMargin) this.suspected |= LeakReasons.openFiles;
        if (lo.metal > b.metal + LeakAlarm.metalMargin) this.suspected |= LeakReasons.metal;
      }
    }
  }

  /// Least-squares slope (bytes/hour) of footprint over the last 24 h, ignoring the first hour; null until the data
  /// spans `minSpan`.
  static footprintSlope(samples: readonly VitalsSample[], now: number): number | null {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    let first = Infinity, last = -Infinity;
    for (const s of samples) {
      if (!(s.uptime >= LeakAlarm.warmup && s.uptime > now - LeakAlarm.window)) continue;
      const x = s.uptime / 3600, y = s.footprint;
      n += 1; sx += x; sy += y; sxx += x * x; sxy += x * y;
      first = Math.min(first, s.uptime); last = Math.max(last, s.uptime);
    }
    if (!(n >= 3 && last - first >= LeakAlarm.minSpan)) return null;
    const d = n * sxx - sx * sx;
    if (!(d > 0)) return null;
    return (n * sxy - sx * sy) / d;
  }
}
