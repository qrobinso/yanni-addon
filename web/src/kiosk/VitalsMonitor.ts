// Port of FaceRuntime/VitalsMonitor.swift. Samples the vitals every 60 s and feeds the leak alarm (hardening design
// §6.6, H5). Status, Home Assistant, the ring log and the soak log read `latest`, `alarm` and `slopeMBPerHour`.
import { LeakAlarm, type LeakReasons } from './LeakAlarm';
import { ProcessVitals, type VitalsSample } from './ProcessVitals';

export class VitalsMonitor {
  static readonly interval = 60;

  latest: VitalsSample | null = null;
  /// Called after each sample (ring log, soak log).
  onSample: ((s: VitalsSample, a: LeakAlarm) => void) | null = null;
  /// Called once when `alarm.suspected` gains a reason.
  onLeakSuspected: ((added: LeakReasons) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sampling = false;

  /// `uptime`: seconds since start; `sampler`: one sample (tests feed synthetic ones).
  constructor(readonly alarm: LeakAlarm = new LeakAlarm(), private readonly uptime: () => number,
    private readonly sampler: (uptime: number) => Promise<VitalsSample> = (u) => ProcessVitals.sample(u, 0)) {}

  /// Starts the 60 s timer (and takes a first sample now).
  startSampling(interval = VitalsMonitor.interval): void {
    this.stopSampling();
    this.timer = setInterval(() => this.sampleNow(), interval * 1000);
    this.sampleNow();
  }

  stopSampling(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  sampleNow(): void {
    if (this.sampling) return;
    this.sampling = true;
    this.sampler(this.uptime()).then((s) => { this.sampling = false; this.record(s); }, () => { this.sampling = false; });
  }

  /// Records a sample.
  record(s: VitalsSample): void {
    const before = this.alarm.suspected;
    this.alarm.add(s);
    this.latest = s;
    this.onSample?.(s, this.alarm);
    const added = this.alarm.suspected & ~before;
    if (added) this.onLeakSuspected?.(added);
  }

  /// Footprint slope in MB/hour (null until the alarm has `minSpan` of data).
  get slopeMBPerHour(): number | null { return this.alarm.slope === null ? null : this.alarm.slope / 1_048_576; }
}
