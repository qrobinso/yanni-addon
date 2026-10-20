// Port of ConversationAudio/TurnAudioPump.swift: the consumer side of the capture path. A 10 ms timer runs between
// `start()` and `stop()` (mic open); each tick meters the 16 kHz samples that arrived since the last one and calls
// `onTick` (the engine's timeouts). Samples arrive already at 16 kHz from the capture worklet (port-note: the Swift
// pump drains the CaptureTap ring and resamples here; on the web the AudioWorklet resamples and posts frames, so
// `push` replaces the drain and overruns can't happen: messages queue instead of lapping a ring).
import { MicLevelMeter } from './MicLevelMeter';

export type Discontinuity = 'newGeneration' | 'overrun';

export interface PumpStats { ticks: number; inputFrames: number; outputFrames: number; overruns: number; generations: number }

export interface PumpTimer { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
const browserTimer: PumpTimer = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class TurnAudioPump {
  static readonly tickIntervalMs = 10;

  /** 16 kHz mono samples and the capture host time just after the last one. */
  onAudio: ((chunk: Float32Array, endHostTime: number) => void) | null = null;
  /** A gap in the stream, with the host time it was noticed. */
  onDiscontinuity: ((d: Discontinuity, now: number) => void) | null = null;
  /** After each tick (timeouts without frames: `TurnDetectionEngine.tick`). */
  onTick: ((now: number) => void) | null = null;
  /** The level after each meter step (0…1 and dBFS). */
  onLevel: ((level: number, db: number) => void) | null = null;

  readonly stats: PumpStats = { ticks: 0, inputFrames: 0, outputFrames: 0, overruns: 0, generations: 0 };
  private timer: unknown = null;
  private pendingGap: Discontinuity | null = null;
  private readonly meter = new MicLevelMeter();
  private blockSum = 0;
  private blockCount = 0;
  private emptyTicks = 0;
  private running = false;

  constructor(private readonly now: () => number = hostNow, private readonly timers: PumpTimer = browserTimer) {}

  /** The smoothed mic level 0…1; 0 while stopped. */
  inputLevel = 0;
  /** The mic level in dBFS, null while stopped. */
  inputLevelDB: number | null = null;

  /** Starts the 10 ms timer (mic open). Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.running = true;
    this.timer = this.timers.set(() => this.tick(), TurnAudioPump.tickIntervalMs);
  }

  /** Cancels the timer (mic closed). Idempotent. */
  stop(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.running = false;
    this.meter.reset();
    this.emptyTicks = 0;
    this.blockSum = 0;
    this.blockCount = 0;
    this.inputLevel = 0;
    this.inputLevelDB = null;
  }

  /** A new capture stream (mic reopened, rate change): reported before any audio that follows it. */
  noteDiscontinuity(d: Discontinuity): void {
    this.pendingGap = d;
  }

  /** Capture frames from the worklet (16 kHz). Dropped while stopped, like a closed gate. */
  push(chunk: Float32Array, endHostTime: number, inputFrames = 0): void {
    if (!this.running) return;
    this.flushGap();
    this.stats.inputFrames += inputFrames;
    this.stats.outputFrames += chunk.length;
    for (let i = 0; i < chunk.length; i++) this.blockSum += chunk[i] * chunk[i];
    this.blockCount += chunk.length;
    this.onAudio?.(chunk, endHostTime);
  }

  /** The timer's body; tests call it directly. */
  tick(): void {
    this.stats.ticks += 1;
    this.flushGap();
    this.meterTick();
    this.onTick?.(this.now());
  }

  private flushGap(): void {
    const d = this.pendingGap;
    if (d === null) return;
    this.pendingGap = null;
    if (d === 'newGeneration') this.stats.generations += 1; else this.stats.overruns += 1;
    this.onDiscontinuity?.(d, this.now());
  }

  /** One meter step per tick: this tick's samples, or (after 50 ms without any) silence. */
  private meterTick(): void {
    if (this.blockCount > 0) {
      this.meter.update(this.blockSum / this.blockCount, this.blockCount / 16_000);
      this.emptyTicks = 0;
    } else {
      this.emptyTicks += 1;
      // Frames arrive every 32 ms (≤ 3 empty ticks between them), so 50 ms without any is a real stall.
      if (this.emptyTicks < 5) return;
      this.meter.update(0, 0.01);
    }
    this.blockSum = 0;
    this.blockCount = 0;
    this.inputLevel = this.meter.level;
    this.inputLevelDB = this.meter.db;
    this.onLevel?.(this.inputLevel, this.inputLevelDB);
  }
}

/** Host seconds (Swift `HostClock.nowSeconds`). */
export const hostNow = (): number => performance.now() / 1000;
