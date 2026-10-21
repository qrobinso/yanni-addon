// Port of FaceRuntime/SoakLog.swift. The soak's pass/fail rules (hardening design §6.6, §11.4) and the real-time soak
// logger: every hour it appends the hour's FrameStats, the latest vitals and the leak alarm as a JSON line; every 24 h
// a day record with the verdict against day 1.
//
// Browser mapping: the launch argument `-YanniSoak` is the URL flag `?soak`; the JSON-lines file is a localStorage key
// (capped, oldest lines dropped), included in the diagnostics export.
import type { KeyValue } from '../app/OwnerAccess';
import { FrameStats, FrameStatsSnapshot, StatsChannel, StatsTier } from '../render/FrameStats';
import { LeakReasons } from './LeakAlarm';
import type { VitalsSample } from './ProcessVitals';
import type { VitalsMonitor } from './VitalsMonitor';

export interface SoakVerdict { pass: boolean; failures: string[] }

export const SoakVerdict = {
  /// p99 gap and hitch time may differ from day 1 by this fraction…
  tolerance: 0.05,
  /// …or by at least this much (one histogram bin; a 5 % change of a near-zero hitch time is noise).
  gapFloor: 0.000_25,
  hitchFloorMsPerSecond: 0.1,
  /// Memory growth allowed per day after hour 1.
  memoryPerDay: 1_048_576,
  /// Threads and open files count as flat within this many.
  flatMargin: 3,

  evaluate(day1: FrameStatsSnapshot, day: FrameStatsSnapshot, memoryGrowthPerDay: number | null, threadsDelta: number,
    filesDelta: number, leak: LeakReasons): SoakVerdict {
    const f: string[] = [];
    for (const tier of StatsTier.allCases) {
      const a = day1.tier(tier), b = day.tier(tier), label = StatsTier.label(tier);
      if (b.requested > 0 && !b.meetsCriteria) {
        f.push(`${label}: delivered ${b.deliveredRatio.toFixed(3)}, hitch ${b.hitchMsPerSecond.toFixed(2)} ms/s`);
      }
      if (!(a.delivered > 0 && b.delivered > 0)) continue;
      if (b.gapP99 > a.gapP99 + Math.max(a.gapP99 * SoakVerdict.tolerance, SoakVerdict.gapFloor)) {
        f.push(`${label}: p99 gap ${(b.gapP99 * 1000).toFixed(2)} ms vs ${(a.gapP99 * 1000).toFixed(2)} ms on day 1`);
      }
      if (b.hitchMsPerSecond > a.hitchMsPerSecond + Math.max(a.hitchMsPerSecond * SoakVerdict.tolerance, SoakVerdict.hitchFloorMsPerSecond)) {
        f.push(`${label}: hitch ${b.hitchMsPerSecond.toFixed(2)} ms/s vs ${a.hitchMsPerSecond.toFixed(2)} on day 1`);
      }
    }
    if (memoryGrowthPerDay !== null && memoryGrowthPerDay >= SoakVerdict.memoryPerDay) {
      f.push(`memory +${(memoryGrowthPerDay / 1_048_576).toFixed(2)} MB/day`);
    }
    if (threadsDelta > SoakVerdict.flatMargin) f.push(`threads +${threadsDelta}`);
    if (filesDelta > SoakVerdict.flatMargin) f.push(`open files +${filesDelta}`);
    if (leak) f.push('leak suspected: ' + LeakReasons.labels(leak).join(', '));
    return { pass: f.length === 0, failures: f };
  },
};

/// Real-time soak mode (`?soak`).
export class SoakLogger {
  static readonly key = 'yanni.kiosk.soak';
  /// Lines kept (a week of hours plus days, with room).
  static readonly maxLines = 400;
  static isRequested(search = globalThis.location?.search ?? ''): boolean { return new URLSearchParams(search).has('soak'); }

  hours = 0;
  days = 0;
  day1: FrameStatsSnapshot | null = null;
  lastVerdict: SoakVerdict | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private baseline: { threads: number; files: number } | null = null;

  constructor(readonly stats: FrameStats, readonly vitals: VitalsMonitor, private readonly store: KeyValue,
    readonly hourLength = 3600, private readonly wall: () => Date = () => new Date()) {}

  /// Writes the header and starts the hourly timer.
  start(app: string, device: string, os: string): void {
    this.stats.take(StatsChannel.hour);
    this.stats.take(StatsChannel.day);
    this.store.removeItem(SoakLogger.key);
    this.write({ kind: 'start', wall: this.wall().toISOString(), app, device, os });
    this.stop();
    this.timer = setInterval(() => this.hourElapsed(), this.hourLength * 1000);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /// One hour passed: log it; every 24th hour also log the day and its verdict.
  hourElapsed(): void {
    this.hours += 1;
    const alarm = this.vitals.alarm, latest = this.vitals.latest;
    const hour = this.stats.take(StatsChannel.hour);
    this.write({ kind: 'hour', hour: this.hours, wall: this.wall().toISOString(), uptime: latest?.uptime ?? this.hours * this.hourLength,
      frames: hour, vitals: latest, slopeMBPerHour: this.vitals.slopeMBPerHour, leak: LeakReasons.labels(alarm.suspected),
      meetsFrameCriteria: hour.meetsCriteria });
    if (this.hours === 2 && latest) this.baseline = { threads: latest.threads, files: latest.openFiles };
    if (this.hours % 24 !== 0) return;
    this.days += 1;
    const day = this.stats.take(StatsChannel.day);
    if (this.day1 === null) this.day1 = day;
    let growth: number | null = null;
    const h1 = alarm.footprintAtHour1;
    if (h1 !== null && latest && this.hours > 1) growth = (latest.footprint - h1) / ((this.hours - 1) / 24);
    const lows = SoakLogger.lastHourLows(alarm.samples);
    const threadsDelta = this.baseline ? lows.threads - this.baseline.threads : 0;
    const filesDelta = this.baseline ? lows.files - this.baseline.files : 0;
    const verdict = SoakVerdict.evaluate(this.day1, day, growth, threadsDelta, filesDelta, alarm.suspected);
    this.lastVerdict = verdict;
    this.write({ kind: 'day', day: this.days, wall: this.wall().toISOString(), frames: day, footprint: latest?.footprint ?? null,
      memoryGrowthPerDayMB: growth === null ? null : growth / 1_048_576, threadsDelta, filesDelta, verdict });
  }

  /// The JSON lines so far.
  lines(): string[] { return (this.store.getItem(SoakLogger.key) ?? '').split('\n').filter(Boolean); }

  private static lastHourLows(samples: readonly VitalsSample[]): { threads: number; files: number } {
    const last = samples[samples.length - 1];
    if (!last) return { threads: 0, files: 0 };
    let t = Infinity, f = Infinity;
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i];
      if (!(s.uptime > last.uptime - 3600)) break;
      t = Math.min(t, s.threads); f = Math.min(f, s.openFiles);
    }
    return { threads: t === Infinity ? 0 : t, files: f === Infinity ? 0 : f };
  }

  private write(record: object): void {
    const lines = this.lines();
    lines.push(JSON.stringify(record, (_k, v) => (v instanceof FrameStatsSnapshot ? SoakLogger.plain(v) : v)));
    if (lines.length > SoakLogger.maxLines) lines.splice(1, lines.length - SoakLogger.maxLines);   // keep the header
    try { this.store.setItem(SoakLogger.key, lines.join('\n') + '\n'); } catch { /* quota */ }
  }

  /// A snapshot as plain numbers (the class's getters are not own properties).
  static plain(s: FrameStatsSnapshot): object {
    const t = (x: ReturnType<FrameStatsSnapshot['tier']>) => ({ ...x, deliveredRatio: x.deliveredRatio,
      hitchMsPerSecond: x.hitchMsPerSecond, deliveredFPS: x.deliveredFPS, meetsCriteria: x.meetsCriteria });
    return { asleep: t(s.asleep), awake: t(s.awake), burst: t(s.burst), pauses: s.pauses, span: s.span };
  }
}
