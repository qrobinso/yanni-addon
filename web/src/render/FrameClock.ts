// Port of FaceRendering/FrameClock.swift.
import { makeFaceFrame, type FaceFrame, type FaceFrameSource } from '../model/FaceFrame';
import { FacePose } from '../model/FacePose';
import { FrameRatePolicy, FrameRateTier } from './FrameRatePolicy';
import { FrameStats, StatsTier } from './FrameStats';

export type FrameHook = (time: number) => void;
export type FrameConsumer = (frame: FaceFrame, time: number) => void;
export type FrameDriver = 'primary' | 'backup' | 'manual';

/// The app-owned frame clock (hardening design §6.6, H2): it, not a renderer, drives the face. Every refresh one
/// driver calls `beginFrame(at)` with the frame's target presentation time; the clock asks the source for the frame,
/// runs the after-frame hooks in order, updates the frame-rate policy and hands the frame to its consumers. The driver
/// renders `frame`, then calls `endFrame(presented)`. If no primary frame arrives for `backupAfter` while active, a
/// backup timer takes over until a primary frame arrives again.
// port-note: the backup link is a `setInterval` at the tier's rate (the Swift macOS path), target time one interval ahead.
export class FrameClock {
  /// No primary frame for this long while active → the backup link drives.
  static readonly backupAfter = 0.25;
  /// How often the backup watchdog looks (s).
  static readonly watchdogInterval = 0.1;

  readonly policy = new FrameRatePolicy();
  /// The latest frame (what renderers draw).
  frame: FaceFrame;
  /// Presentation time of the latest frame.
  time = -Infinity;
  ticks = 0;
  /// The display's maximum refresh rate: caps the expected rate per tier.
  displayMaximumFramesPerSecond = 60;
  lastDriver: FrameDriver = 'manual';
  /// Host time of the last primary frame.
  lastPrimaryHostTime: number | undefined;
  isBackupRunning = false;
  backupTakeovers = 0;
  /// Time of the latest `beginFrame` (source + hooks), seconds.
  lastTickSeconds = 0;

  private hooks: FrameHook[] = [];
  private consumers: [object, FrameConsumer][] = [];
  private frameStart = 0;
  private frameTier: StatsTier = StatsTier.awake;
  private inFrame = false;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private backup: ReturnType<typeof setInterval> | undefined;
  private _isActive = false;

  /// `hostClock`: host seconds (performance.now() / 1000); injectable for tests.
  constructor(readonly source: FaceFrameSource, readonly stats = new FrameStats(),
    private readonly now: () => number = () => performance.now() / 1000) {
    this.frame = makeFaceFrame(FacePose.defaults);
  }

  /// Frame-rate ceiling: caps the 120 Hz burst only.
  get rateCeiling(): FrameRateTier { return this.policy.ceiling; }
  set rateCeiling(t: FrameRateTier) { this.policy.ceiling = t; }
  /// Calm (drowsy, or nobody in view while awake): 30 fps while still, 60 while moving fast.
  get calmRate(): boolean { return this.policy.calm; }
  set calmRate(v: boolean) { this.policy.calm = v; }

  // Wiring (at startup, not per frame)

  addAfterFrame(hook: FrameHook): void { this.hooks.push(hook); }

  /// Adds (or replaces) a frame consumer for `owner`; it runs after the hooks on every frame.
  addConsumer(owner: object, consumer: FrameConsumer): void {
    this.consumers = this.consumers.filter(([o]) => o !== owner);
    this.consumers.push([owner, consumer]);
  }

  removeConsumer(owner: object): void { this.consumers = this.consumers.filter(([o]) => o !== owner); }
  get hasConsumers(): boolean { return this.consumers.length > 0; }

  // Per frame

  /// Starts a frame for `presentationTime`: frame, hooks, policy, consumers. Returns the frame to render.
  beginFrame(presentationTime: number, driver: FrameDriver = 'primary'): FaceFrame {
    const start = this.now();
    if (driver === 'primary') {
      this.lastPrimaryHostTime = start;
      if (this.isBackupRunning) this.stopBackup();
    }
    if (!(presentationTime > this.time)) return this.frame;
    this.frameStart = start;
    this.frameTier = StatsTier.from(this.policy.tier);
    this.inFrame = true;
    this.frame = this.source.frame(presentationTime);
    this.time = presentationTime;
    this.ticks += 1;
    this.lastDriver = driver;
    for (const hook of this.hooks) hook(presentationTime);
    this.policy.update(this.frame, presentationTime);
    for (const [, consumer] of this.consumers) consumer(this.frame, presentationTime);
    this.lastTickSeconds = this.now() - start;
    return this.frame;
  }

  /// Ends the frame begun by `beginFrame`: records its gap, main-thread time and whether it was presented.
  endFrame(presented: boolean): void {
    if (!this.inFrame) return;
    this.inFrame = false;
    this.stats.recordFrame(this.time, this.frameTier, this.expectedInterval(this.frameTier),
      this.now() - this.frameStart, presented);
  }

  /// Expected gap for a tier on this display.
  expectedInterval(tier: StatsTier): number {
    return 1 / Math.max(Math.min(StatsTier.targetFPS(tier), this.displayMaximumFramesPerSecond), 1);
  }

  // Activity and the backup link

  /// Active (page visible): the backup watchdog runs. Inactive: nothing drives the clock.
  get isActive(): boolean { return this._isActive; }
  set isActive(v: boolean) {
    if (v === this._isActive) return;
    this._isActive = v;
    // Becoming active starts the 250 ms grace afresh.
    if (v) { this.lastPrimaryHostTime = this.now(); this.startWatchdog(); } else { this.stopWatchdog(); this.stopBackup(); }
    this.stats.notePause();
  }

  /// The watchdog's check (also called directly by tests): starts the backup link if the primary has been silent.
  checkPrimary(): void {
    if (!this._isActive || this.isBackupRunning) return;
    const silent = this.lastPrimaryHostTime !== undefined ? this.now() - this.lastPrimaryHostTime : Infinity;
    if (silent >= FrameClock.backupAfter) this.startBackup();
  }

  private startBackup(): void {
    this.isBackupRunning = true;
    this.backupTakeovers += 1;
    this.stats.notePause();
    this.applyBackup(this.policy.tier);
  }

  private applyBackup(tier: FrameRateTier): void {
    if (this.backup !== undefined) clearInterval(this.backup);
    const interval = 1 / FrameRateTier.range(tier).preferred;
    this.backup = setInterval(() => this.backupTick(this.now() + interval), interval * 1000);
  }

  /// One backup-link tick (tests drive it by hand).
  backupTickForTesting(time: number): void { this.backupTick(time); }

  private backupTick(time: number): void {
    if (!this.isBackupRunning) return;
    const before = this.policy.tier;
    this.beginFrame(time, 'backup');
    this.endFrame(this.hasConsumers);
    if (this.policy.tier !== before && this.backup !== undefined) this.applyBackup(this.policy.tier);
  }

  private stopBackup(): void {
    if (this.backup !== undefined) clearInterval(this.backup);
    this.backup = undefined;
    if (this.isBackupRunning) this.stats.notePause();
    this.isBackupRunning = false;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => this.checkPrimary(), FrameClock.watchdogInterval * 1000);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  /// Drives one frame by hand (tests, tools): begin + end, presented.
  step(presentationTime: number): FaceFrame {
    const f = this.beginFrame(presentationTime, 'manual');
    this.endFrame(true);
    return f;
  }
}
