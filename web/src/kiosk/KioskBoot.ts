// Port of the app's Kiosk/KioskBoot.swift. What the kiosk decides before anything starts (hardening design §4.2, §6.2,
// §6.3): the device profile and its defaults, the launch guard's verdict on how the last run ended (normal, careful
// start, safe mode), and whether this launch restores the saved state. Build it before audio, perception or Home
// Assistant start and before the first frame (`restoreLife` must run before the first frame).
import type { KeyValue } from '../app/OwnerAccess';
import type { LifeCycleController } from '../life/LifeCycleController';
import { DeviceDefaults } from './DeviceDefaults';
import { browserProfile, DeviceProbe, DeviceProfile, treatAsOLED, type BrowserEnv, type DeviceOverrides } from './DeviceProfile';
import { DiagnosticsLog } from './DiagnosticsLog';
import { LaunchGuard, LaunchMode } from './LaunchGuard';
import { ResumeSnapshot, ResumeStore } from './ResumeSnapshot';

export interface KioskBootOptions {
  appVersion: string;
  storage?: KeyValue;
  session?: KeyValue;
  browser?: BrowserEnv;
  overrides?: DeviceOverrides;
  /// The owner's backlight choice (null: the device default).
  backlightFollowsSleep?: boolean | null;
  /// The refresh-rate probe, if one exists yet (main.ts measures it from rAF).
  maxFramesPerSecond?: number | null;
  wall?: () => Date;
  /// Monotonic seconds (the AppContext clock).
  now?: () => number;
}

export class KioskBoot {
  profile: DeviceProfile;
  defaults: DeviceDefaults;
  readonly launchGuard: LaunchGuard;
  readonly resumeStore: ResumeStore;
  /// The snapshot and its age when this launch restores (≤ 10 min old), else null.
  readonly restore: { snapshot: ResumeSnapshot; elapsed: number } | null;
  readonly diagnostics: DiagnosticsLog;
  readonly bootTime: number | null;
  readonly launchedAt: Date;
  readonly launchUptime: number;
  readonly os: string;
  private gpu: string | null = null;
  private readonly browser: BrowserEnv;
  private readonly overrides: DeviceOverrides;
  private readonly backlightOverride: boolean | null;

  constructor(o: KioskBootOptions) {
    const storage = o.storage ?? localStorage;
    const session = o.session ?? sessionStorage;
    const wall = o.wall ?? (() => new Date());
    this.launchedAt = wall();
    this.launchUptime = (o.now ?? (() => performance.now() / 1000))();
    this.bootTime = LaunchGuard.sessionStamp(session, this.launchedAt.getTime() / 1000);
    this.browser = o.browser ?? DeviceProbe.env();
    this.overrides = o.overrides ?? {};
    this.backlightOverride = o.backlightFollowsSleep ?? null;
    this.profile = browserProfile(this.browser, { maxFramesPerSecond: o.maxFramesPerSecond, overrides: this.overrides });
    this.defaults = KioskBoot.defaultsFor(this.profile, this.backlightOverride);
    this.os = this.browser.userAgent;

    this.launchGuard = new LaunchGuard(storage, { now: this.launchedAt, uptime: this.launchUptime, bootTime: this.bootTime,
      app: o.appVersion, os: this.os });
    this.diagnostics = new DiagnosticsLog(storage, undefined, undefined, wall);
    this.resumeStore = new ResumeStore(storage);
    // A safe-mode launch never restores (the saved state may be what crashes); otherwise ≤ 10 min restores.
    const s = this.isSafeMode ? null : this.resumeStore.load();
    const e = s ? ResumeSnapshot.restorableElapsed(s, this.launchedAt) : null;
    this.restore = s && e !== null ? { snapshot: s, elapsed: e } : null;

    const mode = LaunchMode.label(this.launchGuard.decision.mode);
    const previous = this.launchGuard.decision.previousExit ?? 'first launch';
    this.diagnostics.add('app', `launch ${o.appVersion} · ${mode} · previous ${previous} · ${DeviceProfile.summary(this.profile)}`);
    if (this.restore) this.diagnostics.add('app', `restoring ${this.restore.snapshot.life.phase} (saved ${this.restore.elapsed.toFixed(0)} s ago)`);
    this.diagnostics.start();
  }

  private static defaultsFor(p: DeviceProfile, backlight: boolean | null): DeviceDefaults {
    const d = DeviceDefaults.for(p);
    if (backlight !== null) d.backlightFollowsSleep = backlight && !treatAsOLED(p.display);
    return d;
  }

  /// The refresh-rate probe or the GPU adapter is known now: re-make the profile and defaults if they differ.
  /// Returns whether anything changed.
  refreshDisplayProbe(fps: number | null, gpu: string | null = this.gpu): boolean {
    this.gpu = gpu;
    if (fps === null || !(fps > 0)) return false;
    const p = browserProfile(this.browser, { maxFramesPerSecond: fps, gpu, overrides: this.overrides });
    if (JSON.stringify(p) === JSON.stringify(this.profile)) return false;
    this.profile = p;
    this.defaults = KioskBoot.defaultsFor(p, this.backlightOverride);
    return true;
  }

  /// Whether a subsystem may start on this launch (careful start skips the suspects; safe mode keeps only the face,
  /// life cycle, touch, Settings, Status and the Home Assistant link unless it is the suspect).
  allows(subsystem: string): boolean {
    const m = this.launchGuard.decision.mode;
    switch (m.kind) {
      case 'normal': return true;
      case 'careful': return !m.skip.includes(subsystem);
      case 'safe': return subsystem === 'mqtt' && !m.suspects.includes('mqtt');
    }
  }

  /// A launch-time `starting:` breadcrumb, for a step that could crash right away (writes are synchronous).
  starting(subsystem: string): void { this.launchGuard.starting(subsystem); }

  get isSafeMode(): boolean { return this.launchGuard.decision.mode.kind === 'safe'; }

  /// Restores the life cycle's saved phase (before the first frame). No activity, no greeting, no chirp.
  restoreLife(life: LifeCycleController): void {
    if (this.restore) life.restore(this.restore.snapshot.life, this.restore.elapsed);
  }
}
