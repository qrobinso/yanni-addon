// Port of the app's Kiosk/KioskModel.swift (+Tick, +Watchdogs, +Health, +Export). The kiosk's resilience layer
// (hardening design §4–§9): applies the device profile, runs the resource governor, the health supervisor with its
// watchdogs and the main-thread hang monitor, writes the resume snapshot every 60 s, keeps the ring log, and
// publishes health to Status and Home Assistant.
//
// It never touches the per-frame path (the event recorder's after-frame compare aside): the governor and supervisor
// tick at 1 Hz, the snapshot every 60 s. What it changes on the face is a ceiling or a smoothed target.
import type { AppContext } from '../app/AppContext';
import type { DisplayState } from '@yanni/server/protocol';
import type { LifePhaseChange } from '../life/LifeTypes';
import { BacklightFollower, type Dimmable } from './Backlight';
import { DeviceProfile } from './DeviceProfile';
import { DiagnosticsExport, type DiagnosticsManifest } from './DiagnosticsExport';
import { FaceAccessibility } from './FaceSpokenState';
import { FrameEventRecorder } from './FrameEventRecorder';
import { MainThreadHeartbeat } from './HangMonitor';
import { HealthCard, type HealthCardModel, type HealthSnap } from './HealthCard';
import { HealthSupervisor, ProbeResult, RestartPolicy, SubsystemHealth, Watchdog } from './HealthSupervisor';
import { KioskApply, type RenderScaleControl } from './KioskApply';
import { KioskBoot } from './KioskBoot';
import { ExitKind, LaunchGuard, LaunchMode } from './LaunchGuard';
import { LeakAlarm, LeakReasons } from './LeakAlarm';
import { ProcessVitals } from './ProcessVitals';
import { makeGovernorInputs, ResourceGovernor, Thermal } from './ResourceGovernor';
import { ResumeSnapshot } from './ResumeSnapshot';
import { SoakLogger } from './SoakLog';
import { browserSystemEnv, SystemInputs, type SystemEnv } from './SystemInputs';
import { VitalsMonitor } from './VitalsMonitor';

export type KioskStatusFields = Pick<DisplayState, 'health' | 'health_degraded' | 'started_at' | 'last_restart'
  | 'last_restart_at' | 'thermal_state' | 'resource_level' | 'resource_reason' | 'battery' | 'power_plugged' | 'kiosk_lock'>;

export interface KioskOptions {
  appVersion: string;
  /// Made early by the shell (before the first frame) to restore the life phase; made here otherwise.
  boot?: KioskBoot;
  env?: SystemEnv;
  /// The element the LCD "backlight" dims (default: the face canvas `#face`).
  dimTarget?: Dimmable | null;
  /// The renderer's drawable-scale lever, when the shell has one.
  renderControl?: RenderScaleControl | null;
  /// The owner's OLED background budget (Swift `kiosk.oledBackgroundBudget`).
  oledBackgroundBudget?: number | null;
  /// Self-restart (reload) on a 15 s main-thread hang. Off by default (spec: off unless the owner turns it on).
  restartOnHang?: boolean;
  /// The conditional 03:00–05:00 maintenance reload (leak or low memory). Off by default.
  maintenanceRestart?: boolean;
  /// The sparse settings for the export (never secrets: the display holds none).
  settings?: () => unknown;
  /// The event log's last lines for the export (plain text, never transcripts).
  events?: () => string[];
  /// Render watchdog steps 1 and 2 (Swift: recreate the link, then the renderer); step 3 reloads the page.
  restartRender?: (attempt: number) => void;
  restartPerception?: () => void;
  /// A subsystem held back by careful start or safe mode may start now.
  onResume?: (subsystem: string) => void;
  /// Reloads the page (tests replace it).
  reload?: () => void;
  wall?: () => Date;
}

export class KioskModel {
  readonly boot: KioskBoot;
  readonly supervisor: HealthSupervisor;
  readonly heartbeat: MainThreadHeartbeat;
  readonly inputs: SystemInputs;
  readonly backlight: BacklightFollower;
  readonly vitals: VitalsMonitor;
  readonly recorder: FrameEventRecorder;
  readonly access = new FaceAccessibility();
  governor: ResourceGovernor;
  soak: SoakLogger | null = null;
  /// Subsystems held back by careful start or safe mode.
  skipped = new Set<string>();
  safeModeLeft = false;
  /// Set while a deliberate reload is under way: its pagehide must not mark the run clean.
  restarting = false;

  private timers: ReturnType<typeof setInterval>[] = [];
  private timeouts: ReturnType<typeof setTimeout>[] = [];
  private listeners: [EventTarget, string, EventListener][] = [];
  private lastDelivered = 0;
  private lastRequested = 0;
  private lastGPUErrors = 0;
  private lastProbedFPS: number | null = null;
  private everReady = false;
  private mqttDownSince: number | null = null;
  private lastSavedPhase: string | null = null;
  private lastKioskLock: boolean | null = null;
  private lastActivity: Date | null = null;
  private availableAtLaunch: number | null;
  private stopped = false;
  private readonly wall: () => Date;
  private readonly reload: () => void;

  constructor(readonly ctx: AppContext, public opts: KioskOptions) {
    this.wall = opts.wall ?? (() => new Date());
    this.reload = opts.reload ?? (() => location.reload());
    this.boot = opts.boot ?? new KioskBoot({ appVersion: opts.appVersion, now: () => ctx.now(), wall: this.wall,
      maxFramesPerSecond: ctx.clock.displayMaximumFramesPerSecond });
    this.supervisor = new HealthSupervisor(() => ctx.now());
    this.inputs = new SystemInputs(opts.env ?? browserSystemEnv());
    const dim = opts.dimTarget !== undefined ? opts.dimTarget
      : (typeof document !== 'undefined' ? document.getElementById('face') : null);
    this.backlight = new BacklightFollower(this.boot.defaults.backlightFollowsSleep, dim);
    this.vitals = new VitalsMonitor(new LeakAlarm(), () => this.uptime, (u) => ProcessVitals.sample(u, this.inputs.thermal));
    this.recorder = new FrameEventRecorder(ctx.engine, ctx.voice);
    this.heartbeat = new MainThreadHeartbeat({
      onHitch: (s) => this.boot.diagnostics.add('health', `main-thread hitch ${(s * 1000).toFixed(0)} ms`),
      onHang: (s) => { this.boot.diagnostics.add('health', `main-thread hang ${s.toFixed(1)} s`); this.boot.launchGuard.breadcrumb('hangEvent'); },
      onRestart: (s) => {
        // Armed only by `restartOnHang`. The worker saw the stall; the main thread is free again now.
        this.boot.diagnostics.add('health', `self-restart after a ${s.toFixed(0)} s hang`);
        this.selfRestart('hang');
      },
    });
    const now = ctx.now();
    this.governor = this.boot.restore ? ResourceGovernor.restored(this.boot.restore.snapshot.resourceLevel, now) : new ResourceGovernor();
    for (const s of ['audio', 'perception', 'mqtt', 'conversation', 'snapshots']) if (!this.boot.allows(s)) this.skipped.add(s);
    this.availableAtLaunch = ProcessVitals.availableMemory();
    this.applyBudget();
  }

  /// The owner's kiosk settings changed (Swift: the hub observer re-arms the hang restart).
  configure(o: Pick<KioskOptions, 'restartOnHang' | 'maintenanceRestart' | 'oledBackgroundBudget'>): void {
    const armed = this.hangArmed;
    this.opts = { ...this.opts, ...o };
    if (this.hangArmed !== armed) {
      this.heartbeat.arm(this.hangArmed);
      this.boot.diagnostics.add('health', `kiosk settings: self-restart on hang ${this.hangArmed}`);
    }
  }

  get uptime(): number { return this.ctx.now() - this.boot.launchUptime; }
  get hangArmed(): boolean { return this.opts.restartOnHang === true; }

  // ---- Start ----

  start(): void {
    const ctx = this.ctx;
    this.inputs.onMemoryWarning = () => this.memoryWarning();
    this.inputs.onPowerChange = () => this.tick();
    this.inputs.onKioskLockChange = (on) => this.kioskLockChanged(on);
    this.inputs.start();
    this.inputs.keepScreenOn();
    this.installWatchdogs();
    this.supervisor.start();
    this.heartbeat.start(this.hangArmed);
    this.vitals.onLeakSuspected = (r) => this.boot.diagnostics.add('health', `leak suspected: ${LeakReasons.labels(r).join(', ')}`);
    this.vitals.startSampling();
    if (SoakLogger.isRequested()) {
      this.soak = new SoakLogger(ctx.clock.stats, this.vitals, localStorage);
      this.soak.start(this.opts.appVersion, DeviceProfile.summary(this.boot.profile), this.boot.os);
    }
    // Life phase: snapshot on change, LCD backlight follows sleep.
    const previous = ctx.life.onPhaseChange;
    ctx.life.onPhaseChange = (c) => { previous?.(c); this.phaseChanged(c); };
    if (ctx.life.phase === 'asleep') this.backlight.phaseChanged(true);
    // The event recorder: per frame, cheap compares; drained into the event log at 1 Hz.
    ctx.clock.addAfterFrame((t) => { if (!this.stopped) this.recorder.noteFrame(t); });
    this.timers.push(setInterval(() => this.tick(), 1000));
    this.timers.push(setInterval(() => this.minute(), 60_000));
    this.timers.push(setInterval(() => this.pollAccessibility(), 250));
    this.on(document, 'visibilitychange', () => this.visibilityChanged(document.visibilityState === 'visible'));
    this.on(window, 'pagehide', () => this.visibilityChanged(false));
    this.on(document, 'fullscreenchange', () => this.inputs.poll());
    this.breadcrumbStaggered();
    this.tick();
    this.saveSnapshot();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const t of this.timeouts) clearTimeout(t);
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
    this.timers = []; this.timeouts = []; this.listeners = [];
    this.supervisor.stop();
    this.heartbeat.stop();
    this.vitals.stopSampling();
    this.soak?.stop();
    this.inputs.stop();
    this.backlight.restore();
    this.boot.diagnostics.flush();
    this.boot.diagnostics.stop();
  }

  private on(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }

  /// Launch breadcrumbs: each staggered subsystem is `starting:` until it has run 5 s (a crash in between blames it).
  private breadcrumbStaggered(): void {
    const g = this.boot.launchGuard;
    const steps: [string, number][] = [['render', 0], ['audio', 0.3], ['mqtt', 0.5], ['perception', 1.5]];
    for (const [name, delay] of steps) {
      if (this.skipped.has(name)) continue;
      this.timeouts.push(setTimeout(() => g.starting(name), delay * 1000));
      this.timeouts.push(setTimeout(() => g.started(name), (delay + 5) * 1000));
    }
  }

  // ---- Governor (1 Hz) ----

  tick(): void {
    const now = this.ctx.now();
    this.refreshDisplayProbe();
    this.inputs.poll();
    const drop = this.frameDropRate();
    this.inputs.noteFrameDrop(drop);
    const i = makeGovernorInputs({
      thermal: this.inputs.thermal, lowPowerMode: this.inputs.lowPowerMode, onBattery: this.inputs.plugged(now) === false,
      cameraPressure: this.ctx.perception?.stats().camera.kind === 'pressure' ? 1 : 0, frameDropRate: drop,
    });
    const before = this.governor.level;
    const level = this.governor.update(i, now);
    if (level !== null) {
      this.applyBudget();
      this.boot.diagnostics.add('resource', `level ${before} → ${level} (${this.governor.reason})`);
    }
    this.probation();
    this.noteKioskLock(this.inputs.kioskLock);
    this.drainEvents();
  }

  /// The shell measures the refresh rate from rAF (it settles after launch): re-make the profile when it moves.
  private refreshDisplayProbe(): void {
    const fps = this.ctx.clock.displayMaximumFramesPerSecond;
    if (fps === this.lastProbedFPS) return;
    this.lastProbedFPS = fps;
    if (this.boot.refreshDisplayProbe(fps, this.gpuName())) {
      this.boot.diagnostics.add('app', `display probe: ${DeviceProfile.summary(this.boot.profile)}`);
      this.applyBudget();
    }
  }

  /// Frames the face missed over the last second (1 − Δdelivered/Δrequested), only while active.
  private frameDropRate(): number {
    const s = this.ctx.clock.stats.snapshot();
    const delivered = s.frames;
    const requested = s.asleep.requested + s.awake.requested + s.burst.requested;
    const dr = requested - this.lastRequested, dd = delivered - this.lastDelivered;
    this.lastDelivered = delivered;
    this.lastRequested = requested;
    if (!this.ctx.clock.isActive || !(dr > 0)) return 0;
    return Math.max(0, 1 - dd / dr);
  }

  /// Pushes the governor's budget to the face (perception's pressure cap has no web hook yet: MAPPING.md).
  applyBudget(): void {
    KioskApply.apply(this.boot.defaults, this.boot.profile, this.governor.budget, this.ctx.clock,
      this.opts.renderControl ?? null, this.ctx.engine);
  }

  /// The renderer's style under the device caps (static per launch, plus the owner's OLED budget).
  style(s: Parameters<typeof KioskApply.style>[0]): ReturnType<typeof KioskApply.style> {
    return KioskApply.style(s, this.boot.defaults, this.opts.oledBackgroundBudget ?? null);
  }

  memoryWarning(): void {
    this.governor.noteMemoryWarning(this.ctx.now());
    this.boot.diagnostics.add('resource', 'memory warning');
    this.tick();
  }

  kioskLockChanged(on: boolean): void { this.boot.diagnostics.add('app', `kiosk lock ${on ? 'on' : 'off'}`); }

  private noteKioskLock(on: boolean): void {
    if (this.lastKioskLock === on) return;
    if (this.lastKioskLock !== null) this.kioskLockChanged(on);
    this.lastKioskLock = on;
  }

  phaseChanged(c: LifePhaseChange): void {
    this.backlight.phaseChanged(c.to === 'asleep');
    if (c.to !== this.lastSavedPhase) this.saveSnapshot();
  }

  private drainEvents(): void {
    this.recorder.drain((e) => this.ctx.logEvent('face', FrameEventRecorder.describe(e.kind)));
  }

  private pollAccessibility(): void {
    const s = this.ctx.engine.state;
    this.access.poll(s.agentState, s.engagedPersonID !== null, this.ctx.life.phase, this.ctx.now());
  }

  // ---- Every minute ----

  minute(): void {
    this.inputs.keepScreenOn();
    this.boot.launchGuard.noteAlive(this.uptime);
    this.saveSnapshot();
    this.maintenanceRestartIfDue();
    const s = this.ctx.clock.stats.snapshot();
    const v = this.vitals.latest;
    const battery = this.inputs.batteryPercent;
    this.boot.diagnostics.add('diagnostics', `vitals L${this.governor.level} ${Thermal.label(this.inputs.thermal)} · fps awake `
      + `${s.awake.deliveredFPS.toFixed(1)} p99 ${(s.awake.gapP99 * 1000).toFixed(2)} ms hitch ${s.awake.hitchMsPerSecond.toFixed(2)} ms/s `
      + `skipped ${s.skipped} · footprint ${((v?.footprint ?? 0) / 1_048_576).toFixed(1)} MB · battery `
      + `${battery !== null ? `${battery}%` : '—'}${this.inputs.pluggedRaw === false ? ' unplugged' : ''}`);
  }

  /// The conditional maintenance restart (§6.4): only when the owner armed it; 03:00–05:00, asleep, nobody in view,
  /// and only when the leak alarm is up or available memory fell below 25 % of launch.
  maintenanceRestartIfDue(): void {
    if (!this.opts.maintenanceRestart) return;
    const hour = this.wall().getHours();
    const life = this.ctx.life;
    if (!(hour >= 3 && hour < 5) || life.phase !== 'asleep' || life.isPresent || !(this.uptime > 3600)) return;
    const available = ProcessVitals.availableMemory();
    const start = this.availableAtLaunch;
    const lowMemory = available !== null && start !== null && start > 0 && available < start * 0.25;
    if (!this.vitals.alarm.isSuspected && !lowMemory) return;
    this.boot.diagnostics.add('health', `maintenance restart (leak ${LeakReasons.labels(this.vitals.alarm.suspected).join(', ')}, low memory ${lowMemory})`);
    this.selfRestart('selfRestart');
  }

  // ---- Self-restart (the browser's relaunch: a reload with a reason marker and a backoff) ----

  /// The delay before a deliberate reload: none at first, longer as quick unclean exits pile up (a reload loop
  /// would otherwise spin as fast as the page loads).
  static reloadDelay(uncleanStreak: number): number { return [0, 5, 30, 120, 600][Math.min(Math.max(uncleanStreak, 0), 4)]; }

  selfRestart(kind: 'hang' | 'selfRestart' | 'crashTest'): void {
    if (this.restarting) return;
    this.restarting = true;
    this.boot.diagnostics.add('app', `reload (${kind})`);
    this.boot.diagnostics.flush();
    this.saveSnapshot();
    this.boot.launchGuard.breadcrumb(kind);
    this.boot.launchGuard.flushNow();
    const delay = kind === 'crashTest' ? 0 : KioskModel.reloadDelay(this.boot.launchGuard.decision.uncleanStreak);
    if (delay > 0) this.timeouts.push(setTimeout(this.reload, delay * 1000)); else this.reload();
  }

  /// Status › "Crash now (test)": a reload that the next launch reads as unclean but never counts toward a loop.
  crashNow(): void { this.boot.diagnostics.add('app', 'crash now (test)'); this.selfRestart('crashTest'); }

  // ---- Resume snapshot ----

  saveSnapshot(): void {
    const state = this.ctx.life.resumeState();
    this.lastSavedPhase = state.phase;
    this.boot.resumeStore.save(ResumeSnapshot.make({ savedAt: this.wall().toISOString(), savedUptime: this.ctx.now(),
      bootTime: this.boot.bootTime, life: state, lastActivity: this.lastActivity?.toISOString() ?? null,
      resourceLevel: this.governor.level }));
    this.ctx.emotion?.saveMood();
  }

  // ---- Careful start and safe mode ----

  /// Careful start: skipped subsystems return after 10 min. Safe mode: after 30 min stable, one every 10 min.
  probation(): void {
    if (!this.skipped.size) return;
    const elapsed = this.uptime;
    const m = this.boot.launchGuard.decision.mode;
    let allowed: string[] = [];
    if (m.kind === 'normal') allowed = [...this.skipped];
    else if (m.kind === 'careful') { if (elapsed >= LaunchGuard.carefulSkip) allowed = [...this.skipped]; }
    else allowed = this.safeModeLeft ? [...this.skipped] : LaunchGuard.probationAllowed(elapsed, m.suspects);
    for (const s of allowed) if (this.skipped.has(s)) this.resumeSubsystem(s);
  }

  /// The owner pressed "Leave safe mode": everything comes back now.
  leaveSafeMode(): void {
    this.safeModeLeft = true;
    this.boot.diagnostics.add('app', 'leave safe mode (owner)');
    for (const s of [...this.skipped]) this.resumeSubsystem(s);
  }

  resumeSubsystem(s: string): void {
    this.skipped.delete(s);
    const g = this.boot.launchGuard;
    g.starting(s);
    this.timeouts.push(setTimeout(() => g.started(s), 5000));
    this.boot.diagnostics.add('app', `probation: ${s} back`);
    this.opts.onResume?.(s);
  }

  // ---- Visibility (Swift scene phase) ----

  visibilityChanged(visible: boolean): void {
    if (visible) {
      this.lastProbedFPS = null;
      this.refreshDisplayProbe();
      this.inputs.keepScreenOn();
      this.boot.launchGuard.markActive();
      this.backlight.phaseChanged(this.ctx.life.phase === 'asleep');
      this.heartbeat.start(this.hangArmed);
      this.lastActivity = this.wall();
      this.tick();
      return;
    }
    this.saveSnapshot();
    if (!this.restarting) this.boot.launchGuard.markCleanExit(this.uptime);
    this.boot.diagnostics.add('app', 'background');
    this.boot.diagnostics.flush();
    this.backlight.restore();
    this.heartbeat.stop();
  }

  private gpuName(): string | null {
    const info = (this.ctx.renderer.device as (GPUDevice & { adapterInfo?: GPUAdapterInfo }) | undefined)?.adapterInfo;
    return info ? [info.vendor, info.architecture].filter(Boolean).join(' ') || null : null;
  }

  // ---- Watchdogs (hardening design §6.1) ----

  installWatchdogs(): void {
    const ws = [
      new Watchdog('render', RestartPolicy.render, () => this.probeRender(), (a) => this.restartRender(a)),
      new Watchdog('audio', RestartPolicy.audio, () => this.probeAudio(), () => { this.ctx.audioContext.resume().catch(() => {}); }),
      new Watchdog('perception', RestartPolicy.perception, () => this.probePerception(), () => this.opts.restartPerception?.()),
      new Watchdog('mqtt', RestartPolicy.mqtt, () => this.probeMQTT(), () => this.ctx.client?.connect()),
    ];
    for (const w of ws) {
      w.onTransition = (name, h) => this.boot.diagnostics.add('health', `${name}: ${SubsystemHealth.label(h)}`);
      this.supervisor.add(w);
    }
  }

  /// Render: primary frames within 2 s while active; no new GPU errors. port-note: a renderer that never came up
  /// (no WebGPU) is `off`, not a failure: a reload can't fix it, and the page already says so.
  probeRender(): ProbeResult {
    const { clock, renderer } = this.ctx;
    if (!clock.isActive) return ProbeResult.off('not active');
    const gpu = clock.stats.snapshot().gpuErrors;
    const last = this.lastGPUErrors;
    this.lastGPUErrors = gpu;
    if (gpu > last + 2) return ProbeResult.failed('GPU errors');
    if (renderer.isReady) this.everReady = true;
    if (!this.everReady) return this.uptime < 10 ? ProbeResult.ok : ProbeResult.off('WebGPU unavailable');
    if (!renderer.isReady) return ProbeResult.failed('GPU device lost');
    const t = clock.lastPrimaryHostTime;
    if (t === undefined) return this.uptime < 10 ? ProbeResult.ok : ProbeResult.failed('no frames');
    return this.ctx.now() - t > 2 ? ProbeResult.failed('no frames for 2 s') : ProbeResult.ok;
  }

  /// Steps 1 and 2 are the shell's (recreate the frame loop, then the renderer); step 3 reloads the page (the
  /// browser's relaunch; Swift falls back to SafeFace here). Never in safe mode.
  restartRender(attempt: number): void {
    if (attempt < 2) { this.opts.restartRender?.(attempt); return; }
    if (!this.boot.isSafeMode) this.selfRestart('selfRestart');
  }

  probeAudio(): ProbeResult {
    if (this.skipped.has('audio')) return ProbeResult.off('held back (launch guard)');
    if (!this.ctx.clock.isActive) return ProbeResult.off('background');
    const state = this.ctx.audioContext.state as AudioContextState | 'interrupted';
    if (state === 'running') return ProbeResult.ok;
    if (state === 'suspended') return ProbeResult.off('waiting for a tap');
    return ProbeResult.failed(state === 'interrupted' ? 'audio interrupted' : 'audio context closed');
  }

  probePerception(): ProbeResult {
    const p = this.ctx.perception;
    const stats = p?.stats();
    const expected = stats !== undefined && (stats.camera.kind === 'running' || stats.camera.kind === 'lowRate');
    if (!expected) {
      return ProbeResult.off(this.skipped.has('perception') ? 'held back (launch guard)' : 'camera not running');
    }
    return (stats.noFramesFor ?? 0) > 5 ? ProbeResult.failed('no camera frames for 5 s') : ProbeResult.ok;
  }

  /// The add-on link has its own backoff; the watchdog only reports it and nudges a reconnect when stuck > 5 min.
  probeMQTT(): ProbeResult {
    const c = this.ctx.client;
    if (!c) { this.mqttDownSince = null; return ProbeResult.off('not paired'); }
    if (this.skipped.has('mqtt')) return ProbeResult.off('held back (launch guard)');
    const now = this.ctx.now();
    switch (c.status) {
      case 'connected': this.mqttDownSince = null; return ProbeResult.ok;
      case 'unpaired': return ProbeResult.off('unpaired');
      case 'stopped': return ProbeResult.off('stopped');
      default: {
        const since = this.mqttDownSince ?? now;
        this.mqttDownSince = since;
        return now - since > 300 ? ProbeResult.failed('disconnected > 5 min') : ProbeResult.ok;
      }
    }
  }

  // ---- Health ----

  get overall(): HealthSnap['overall'] {
    if (this.boot.isSafeMode && !this.safeModeLeft) return 'safe_mode';
    if (this.supervisor.problems.length || this.vitals.alarm.isSuspected) return 'degraded';
    return 'ok';
  }

  healthSnap(): HealthSnap {
    const g = this.boot.launchGuard;
    const d = g.decision;
    const now = this.wall().getTime();
    const unclean = g.history.filter((r) => r.exit != null && ExitKind.isUnclean(r.exit));
    const within = (s: number) => unclean.filter((r) => now - Date.parse(r.start) < s * 1000).length;
    const a = this.ctx.clock.stats.snapshot().awake;
    const v = this.vitals.latest;
    return {
      overall: this.overall,
      launchMode: this.safeModeLeft ? 'normal (safe mode left)' : LaunchMode.label(d.mode),
      uptime: this.uptime,
      lastRestart: d.previousExit ? d.previousExit + (d.previousStart ? ` · run started ${new Date(d.previousStart).toLocaleString()}` : '') : 'first launch',
      crashes24h: within(86_400), crashes7d: within(7 * 86_400),
      hangs: this.heartbeat.counters.hangs,
      resourceLevel: this.governor.level, resourceReason: this.governor.reason,
      thermal: Thermal.label(this.inputs.thermal), lowPower: this.inputs.lowPowerMode,
      battery: this.inputs.batteryPercent, plugged: this.inputs.pluggedRaw,
      footprintMB: v && v.footprint > 0 ? v.footprint / 1_048_576 : null,
      leak: LeakReasons.labels(this.vitals.alarm.suspected),
      awakeDelivery: `awake ${a.deliveredFPS.toFixed(1)} fps · delivered ${a.deliveredRatio.toFixed(3)} · hitch ${a.hitchMsPerSecond.toFixed(2)} ms/s`,
      subsystems: this.supervisor.watchdogs.map((w) => ({ name: w.name, state: SubsystemHealth.label(w.health),
        problem: SubsystemHealth.isProblem(w.health), lastError: w.lastError })),
      skipped: [...this.skipped].sort(),
      device: DeviceProfile.summary(this.boot.profile), tierHint: this.boot.defaults.tierHint, calibrated: this.boot.profile.calibrated,
      kioskLock: this.inputs.kioskLock, selfRestartOnHang: this.hangArmed, screenKeptOn: this.inputs.screenKeptOn,
    };
  }

  healthCard(): HealthCardModel { return HealthCard.model(this.healthSnap()); }

  /// Home Assistant's diagnostic entities (§9.5).
  statusFields(): KioskStatusFields {
    const d = this.boot.launchGuard.decision;
    return {
      health: this.overall,
      health_degraded: [...this.supervisor.problems, ...(this.vitals.alarm.isSuspected ? ['leak'] : [])],
      started_at: this.boot.launchedAt.toISOString(),
      last_restart: d.previousExit ? ExitKind.haValue(d.previousExit) : null,
      last_restart_at: d.previousStart,
      thermal_state: Thermal.label(this.inputs.thermal),
      resource_level: this.governor.level,
      resource_reason: this.governor.reason,
      battery: this.inputs.batteryPercent,
      power_plugged: this.inputs.plugged(this.ctx.now()),
      kiosk_lock: this.inputs.kioskLock,
    };
  }

  // ---- Diagnostics export ----

  exportDiagnostics(): Blob {
    const manifest: DiagnosticsManifest = {
      app: this.opts.appVersion, os: this.boot.os, device: this.boot.profile, uptimeSeconds: this.uptime,
      kioskLock: this.inputs.kioskLock,
      displayMode: ['fullscreen', 'standalone', 'minimal-ui', 'browser'].find((m) =>
        typeof matchMedia === 'function' && matchMedia(`(display-mode: ${m})`).matches) ?? 'browser',
      crossOriginIsolated: globalThis.crossOriginIsolated === true, exportedAt: this.wall().toISOString(),
    };
    this.boot.diagnostics.add('diagnostics', 'export started');
    this.boot.diagnostics.flush();
    const v = this.vitals;
    return DiagnosticsExport.blob({
      manifest, settings: this.opts.settings?.(), health: this.healthSnap(),
      events: (this.opts.events?.() ?? []).slice(-200),
      copies: {
        launches: this.boot.launchGuard.all(), log: this.boot.diagnostics.readAll(), resume: this.boot.resumeStore.load(),
        vitals: { latest: v.latest, slopeMBPerHour: v.slopeMBPerHour, leak: LeakReasons.labels(v.alarm.suspected),
          footprintAtHour1: v.alarm.footprintAtHour1, ceiling: v.alarm.ceiling },
        hang: this.heartbeat.counters,
        frames: SoakLogger.plain(this.ctx.clock.stats.snapshot()),
        ...(this.soak ? { soak: this.soak.lines() } : {}),
      },
    });
  }
}

