// The kiosk model end to end with a real engine, clock and life cycle and fake browser parts: Home Assistant's
// diagnostic fields, the governor's tick, the watchdog probes, self-restart markers, probation, the resume snapshot
// (port of ResumeTests.roundTripAndAgeLimit) and the export.
import { describe, expect, test } from 'vitest';
import { STATE_CHECKS } from '@yanni/server/protocol';
import type { AppContext } from '../../src/app/AppContext';
import { FaceEngine } from '../../src/engine/FaceEngine';
import { LifeCycleController } from '../../src/life/LifeCycleController';
import { makeLifeResumeState } from '../../src/life/LifeResume';
import { FrameClock } from '../../src/render/FrameClock';
import { KioskBoot } from '../../src/kiosk/KioskBoot';
import { KioskModel, type KioskOptions } from '../../src/kiosk/KioskModel';
import { LaunchGuard } from '../../src/kiosk/LaunchGuard';
import { ResumeSnapshot, ResumeStore } from '../../src/kiosk/ResumeSnapshot';
import type { SystemEnv } from '../../src/kiosk/SystemInputs';
import { iPadEnv, memoryStore } from './support';

function rig(o: { storage?: ReturnType<typeof memoryStore>; session?: ReturnType<typeof memoryStore>; wall?: Date;
  opts?: Partial<KioskOptions>; pressure?: string } = {}) {
  const storage = o.storage ?? memoryStore();
  const session = o.session ?? memoryStore();
  let now = 100;
  let wall = o.wall ?? new Date('2026-10-20T12:00:00Z');
  const engine = new FaceEngine();
  const clock = new FrameClock(engine, undefined, () => now);
  const life = new LifeCycleController(engine);
  const renderer = { isReady: true, device: undefined };
  const audio = { state: 'running' as string, resumed: 0, resume() { this.resumed += 1; return Promise.resolve(); } };
  const events: string[] = [];
  const ctx = { engine, life, clock, renderer, audioContext: audio, voice: null, emotion: null, conversation: null,
    perception: null, client: null, logEvent: (c: string, m: string) => events.push(`${c}: ${m}`), now: () => now } as unknown as AppContext;
  const env: SystemEnv = { kioskLock: () => true, heap: () => null, visible: () => true,
    PressureObserver: o.pressure ? class { constructor(cb: (r: { state: string }[]) => void) { cb([{ state: o.pressure! }]); } async observe() {} disconnect() {} } : undefined };
  const boot = new KioskBoot({ appVersion: '1.0', storage, session, browser: iPadEnv(834, 1210), maxFramesPerSecond: 120,
    wall: () => wall, now: () => now });
  let reloads = 0;
  const m = new KioskModel(ctx, { appVersion: '1.0', boot, env, dimTarget: null, reload: () => { reloads += 1; }, wall: () => wall, ...o.opts });
  return { m, ctx, clock, life, engine, renderer, audio, storage, session, events, boot,
    advance: (s: number) => { now += s; wall = new Date(wall.getTime() + s * 1000); }, reloads: () => reloads };
}

describe('KioskModel', () => {
  test('status fields are the add-on\'s diagnostic sensors, valid by its protocol', () => {
    const { m } = rig();
    const f = m.statusFields();
    expect(Object.keys(f).sort()).toEqual(['battery', 'health', 'health_degraded', 'kiosk_lock', 'last_restart', 'last_restart_at',
      'power_plugged', 'resource_level', 'resource_reason', 'started_at', 'thermal_state']);
    for (const [k, v] of Object.entries(f)) expect(STATE_CHECKS[k as keyof typeof STATE_CHECKS](v), k).toBe(true);
    expect(f).toMatchObject({ health: 'ok', last_restart: null, thermal_state: 'nominal', resource_level: 0, battery: null,
      power_plugged: null, kiosk_lock: true });
  });

  test('the tick feeds the governor and applies its budget', () => {
    const { m, clock } = rig({ pressure: 'critical' });
    m.inputs.start();
    expect(clock.rateCeiling).toBe(120);
    m.tick();
    expect(m.governor.level).toBe(4);
    expect(m.statusFields()).toMatchObject({ thermal_state: 'critical', resource_level: 4, resource_reason: 'thermal critical' });
    expect(clock.rateCeiling).toBe(60);
    expect(m.boot.diagnostics.readAll().length).toBe(0);   // batched
    m.boot.diagnostics.flush();
    expect(m.boot.diagnostics.readAll().some((l) => l.c === 'resource' && l.m === 'level 0 → 4 (thermal critical)')).toBe(true);
  });

  test('configure re-arms the hang restart', () => {
    const { m } = rig();
    expect(m.hangArmed).toBe(false);
    m.configure({ restartOnHang: true });
    expect(m.hangArmed).toBe(true);
    expect(m.healthSnap().selfRestartOnHang).toBe(true);
  });

  test('the measured refresh rate re-makes the profile', () => {
    const { m, clock } = rig();
    clock.displayMaximumFramesPerSecond = 120;
    m.tick();
    expect(clock.rateCeiling).toBe(120);
    clock.displayMaximumFramesPerSecond = 60;   // e.g. a 60 Hz cap
    m.tick();
    expect(m.boot.profile.maxFramesPerSecond).toBe(60);
    expect(m.boot.defaults.burstCeilingFPS).toBe(60);
    expect(clock.rateCeiling).toBe(60);
  });

  test('render probe: never-ready is off, a stall fails, step 3 reloads', () => {
    const r = rig();
    r.renderer.isReady = false;
    r.clock.isActive = true;
    expect(r.m.probeRender()).toEqual({ kind: 'ok' });            // starting grace
    r.advance(11);
    expect(r.m.probeRender()).toEqual({ kind: 'off', reason: 'WebGPU unavailable' });
    r.renderer.isReady = true;
    r.clock.step(0);
    r.clock.lastPrimaryHostTime = r.ctx.now();
    expect(r.m.probeRender()).toEqual({ kind: 'ok' });
    r.advance(3);
    expect(r.m.probeRender()).toEqual({ kind: 'failed', reason: 'no frames for 2 s' });
    r.m.restartRender(0);
    r.m.restartRender(1);
    expect(r.reloads()).toBe(0);
    r.m.restartRender(2);
    expect(r.reloads()).toBe(1);
    r.clock.isActive = false;
  });

  test('audio and Home Assistant probes', () => {
    const r = rig();
    r.clock.isActive = true;
    expect(r.m.probeAudio()).toEqual({ kind: 'ok' });
    r.audio.state = 'suspended';
    expect(r.m.probeAudio().kind).toBe('off');
    r.audio.state = 'interrupted';
    expect(r.m.probeAudio()).toEqual({ kind: 'failed', reason: 'audio interrupted' });
    expect(r.m.probeMQTT()).toEqual({ kind: 'off', reason: 'not paired' });
    (r.ctx as { client: unknown }).client = { status: 'disconnected', connect() {} };
    expect(r.m.probeMQTT().kind).toBe('ok');
    r.advance(301);
    expect(r.m.probeMQTT()).toEqual({ kind: 'failed', reason: 'disconnected > 5 min' });
    r.clock.isActive = false;
  });

  test('a self-restart is never read as clean, and backs off in a loop', () => {
    const storage = memoryStore(), session = memoryStore();
    const a = rig({ storage, session });
    a.m.selfRestart('selfRestart');
    a.m.visibilityChanged(false);           // the reload's pagehide
    expect(a.reloads()).toBe(1);
    const b = rig({ storage, session, wall: new Date('2026-10-20T12:00:30Z') });
    expect(b.boot.launchGuard.decision.previousExit).toBe('selfRestart');
    expect(b.m.statusFields().last_restart).toBe('self_restart');
    expect(KioskModel.reloadDelay(0)).toBe(0);
    expect(KioskModel.reloadDelay(2)).toBe(30);
    expect(KioskModel.reloadDelay(9)).toBe(600);
    // A hidden page (no reload under way) is a clean exit; a new browser session reads as a reboot.
    b.m.visibilityChanged(false);
    expect(rig({ storage, session, wall: new Date('2026-10-20T12:01:00Z') }).boot.launchGuard.decision.previousExit).toBe('clean');
    const c = rig({ storage, wall: new Date('2026-10-20T12:01:30Z') });
    expect(c.boot.launchGuard.decision.previousExit).toBe('reboot');
  });

  test('crash test is unclean but never a loop', () => {
    const storage = memoryStore(), session = memoryStore();
    let t = new Date('2026-10-20T12:00:00Z');
    for (let i = 0; i < 3; i++) { rig({ storage, session, wall: t }).m.crashNow(); t = new Date(t.getTime() + 20_000); }
    const r = rig({ storage, session, wall: t });
    expect(r.boot.launchGuard.decision.previousExit).toBe('crashTest');
    expect(r.boot.launchGuard.decision.mode).toEqual({ kind: 'normal' });
    expect(r.m.statusFields().last_restart).toBe('crash');
  });

  test('careful start holds the suspect back for 10 min, then resumes it', () => {
    const storage = memoryStore(), session = memoryStore();
    let t = new Date('2026-10-20T12:00:00Z');
    for (let i = 0; i < 2; i++) {
      const r = rig({ storage, session, wall: t });
      r.boot.launchGuard.starting('perception');
      t = new Date(t.getTime() + 20_000);
    }
    const resumed: string[] = [];
    const r = rig({ storage, session, wall: t, opts: { onResume: (s) => resumed.push(s) } });
    expect(r.boot.launchGuard.decision.mode).toEqual({ kind: 'careful', skip: ['perception'] });
    expect(r.boot.allows('perception')).toBe(false);
    expect(r.m.skipped.has('perception')).toBe(true);
    r.m.probation();
    expect(resumed).toEqual([]);
    r.advance(LaunchGuard.carefulSkip + 1);
    r.m.probation();
    expect(resumed).toEqual(['perception']);
    expect(r.m.skipped.size).toBe(0);
    expect(r.m.healthCard().banners[0].text).toContain('Careful start');
    r.m.stop();
  });

  test('resume snapshot: round trip, ≤ 2 KB, age limit; the governor level comes back', () => {
    const store = new ResumeStore(memoryStore());
    const now = new Date(1_000_000_000);
    const snap = ResumeSnapshot.make({ savedAt: now.toISOString(), savedUptime: 10, bootTime: 5,
      life: makeLifeResumeState('asleep', { isBedtime: true }), resourceLevel: 2 });
    store.save(snap);
    const back = store.load()!;
    expect(back).toEqual(snap);
    expect(JSON.stringify(back).length).toBeLessThanOrEqual(2048);
    expect(ResumeSnapshot.restorableElapsed(back, new Date(now.getTime() + 599_000))).not.toBeNull();
    expect(ResumeSnapshot.restorableElapsed(back, new Date(now.getTime() + 601_000))).toBeNull();
    expect(ResumeSnapshot.restorableElapsed(back, new Date(now.getTime() - 60_000))).toBeNull();   // from the future

    const storage = memoryStore(), session = memoryStore();
    const a = rig({ storage, session });
    a.m.governor.update({ thermal: 3, lowPowerMode: false, onBattery: false, cameraPressure: 0, frameDropRate: 0 }, 0);
    a.m.saveSnapshot();
    a.m.visibilityChanged(false);
    const b = rig({ storage, session, wall: new Date('2026-10-20T12:01:00Z') });
    expect(b.boot.restore?.snapshot.resourceLevel).toBe(4);
    expect(b.m.governor.level).toBe(4);
    expect(b.m.governor.reason).toBe('restored');
  });

  test('export: launches, ring log and health, never a secret', async () => {
    const r = rig({ opts: { settings: () => ({ room: 'Den', token: 'nope' }), events: () => ['state idle → engaged'] } });
    r.m.boot.diagnostics.add('app', 'hello');
    const bundle = JSON.parse(await r.m.exportDiagnostics().text());
    expect(Object.keys(bundle)).toEqual(expect.arrayContaining(['manifest', 'health', 'events', 'launches', 'log', 'vitals', 'frames']));
    expect(bundle.settings).toBeUndefined();
    expect(bundle.log.some((l: { m: string }) => l.m === 'hello')).toBe(true);
    expect(bundle.manifest.device.name).toBe('iPad Pro 11 (M4/M5)');
    expect(bundle.health.overall).toBe('ok');
  });
});
