// Port of YanniKioskTests/SupervisorTests.swift (with HangMonitorTests) and the main-thread heartbeat relay.
import { describe, expect, test } from 'vitest';
import { HangMonitor, MainThreadHeartbeat, type HangWorkerIn } from '../../src/kiosk/HangMonitor';
import { HealthSupervisor, ProbeResult, RestartPolicy, SubsystemHealth, Watchdog } from '../../src/kiosk/HealthSupervisor';

describe('Supervisor', () => {
  test('backoff and jitter bounds', () => {
    const p = RestartPolicy.audio;
    for (let attempt = 0; attempt < 12; attempt++) {
      const raw = Math.min(0.5 * Math.pow(2, attempt), 30);
      expect(Math.abs(p.delay(attempt, 0.5) - raw)).toBeLessThan(1e-9);
      expect(Math.abs(p.delay(attempt, 0) - raw * 0.8)).toBeLessThan(1e-9);
      expect(Math.abs(p.delay(attempt, 1) - raw * 1.2)).toBeLessThan(1e-9);
    }
    const r = RestartPolicy.render;
    expect([0, 1, 2, 3].map((a) => r.delay(a, 0.5))).toEqual([0, 1, 5, 600]);
  });

  test('restarts with backoff then recovers', () => {
    let alive = false;
    const restarts: number[] = [];
    const w = new Watchdog('audio', RestartPolicy.audio, () => (alive ? ProbeResult.ok : ProbeResult.failed('engine stopped')),
      (a) => restarts.push(a), () => 0.5);
    w.tick(0);
    expect(w.health).toEqual(SubsystemHealth.restarting(1, 0.5));
    w.tick(0.4);
    expect(restarts).toEqual([]);
    w.tick(0.5);
    expect(restarts).toEqual([0]);
    w.tick(1);                              // settling, no probe
    w.tick(2.6);                            // probe fails again → next delay 1 s
    expect(w.health).toEqual(SubsystemHealth.restarting(2, 3.6));
    alive = true;
    w.tick(3.6);
    expect(restarts).toEqual([0, 1]);
    w.tick(6);
    expect(w.health).toEqual(SubsystemHealth.ok);
    expect(w.lastError).toBe('engine stopped');
  });

  test('circuit trips then cools down to one probe start', () => {
    let restarts = 0;
    const p = RestartPolicy.make({ base: 1, cap: 1, trip: 3, cooldown: 100, settle: 0 });
    const w = new Watchdog('perception', p, () => ProbeResult.failed('no frames'), () => { restarts += 1; }, () => 0.5);
    let t = 0;
    while (t < 30) { w.tick(t); t += 0.5; }
    expect(w.health).toEqual(SubsystemHealth.degraded('no frames'));
    const afterTrip = restarts;
    w.tick(60);
    expect(restarts).toBe(afterTrip);
    w.tick(t + 101);
    expect(restarts).toBe(afterTrip + 1);
  });

  test('off is not a failure', () => {
    let restarts = 0;
    const w = new Watchdog('mqtt', RestartPolicy.mqtt, () => ProbeResult.off('disabled'), () => { restarts += 1; });
    for (let t = 0; t < 100; t++) w.tick(t);
    expect(restarts).toBe(0);
    expect(w.health).toEqual(SubsystemHealth.off('disabled'));
    expect(SubsystemHealth.isProblem(w.health)).toBe(false);
  });

  /// Render escalation with a fake driver: two shell steps, then a reload; nothing for 10 min, then again.
  test('render escalation with a fake driver', () => {
    const steps: string[] = [];
    let healthy = false;
    const w = new Watchdog('render', RestartPolicy.render, () => (healthy ? ProbeResult.ok : ProbeResult.failed('no frames 2 s')),
      (a) => steps.push(a === 0 ? 'link' : a === 1 ? 'renderer' : 'reload'), () => 0.5);
    let t = 0;
    while (t < 20) { w.tick(t); t += 0.25; }
    expect(steps).toEqual(['link', 'renderer', 'reload']);
    while (t < 20 + 590) { w.tick(t); t += 1; }
    expect(steps.length).toBe(3);
    while (t < 20 + 700) { w.tick(t); t += 1; }
    expect(steps.length).toBe(4);
    healthy = true;
    for (let i = 0; i < 10; i++) { w.tick(t); t += 1; }
    expect(w.health).toEqual(SubsystemHealth.ok);
  });

  test('supervisor ticks every watchdog', () => {
    let now = 0;
    const s = new HealthSupervisor(() => now);
    let probes = 0;
    s.add(new Watchdog('audio', RestartPolicy.audio, () => { probes += 1; return ProbeResult.ok; }, () => {}));
    s.add(new Watchdog('mqtt', RestartPolicy.mqtt, () => { probes += 1; return ProbeResult.failed('x'); }, () => {}));
    s.tick(); now = 1; s.tick();
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(s.problems).toEqual(['mqtt']);
    expect(s.watchdog('audio')?.health).toEqual(SubsystemHealth.ok);
  });
});

describe('HangMonitor', () => {
  const make = () => {
    const box = { now: 0, pending: [] as (() => void)[], hitches: [] as number[], hangs: [] as number[], restarts: 0 };
    const m = new HangMonitor(() => box.now, (a) => box.pending.push(a));
    m.onHitch = (l) => box.hitches.push(l);
    m.onHang = (s) => box.hangs.push(s);
    m.onRestart = () => { box.restarts += 1; };
    const answer = () => { const p = box.pending; box.pending = []; for (const b of p) b(); };
    return { box, m, answer };
  };

  test('quick answers are quiet', () => {
    const { box, m, answer } = make();
    for (let i = 0; i < 20; i++) { m.check(); box.now += 0.05; answer(); box.now += 0.45; }
    expect(box.hitches).toEqual([]);
    expect(box.hangs).toEqual([]);
    expect(m.counters.hitches).toBe(0);
  });

  test('stalls give hitch then hang events', () => {
    const { box, m, answer } = make();
    m.check(); box.now += 0.3; answer();
    expect(box.hitches.length).toBe(1);
    m.check();
    for (let i = 0; i < 12; i++) { box.now += 0.25; m.check(); }
    expect(box.hangs.length).toBe(1);       // once per stall
    answer();
    expect(box.hitches.length).toBe(1);     // a hang isn't also a hitch
    expect(box.restarts).toBe(0);
  });

  test.each([false, true])('self-restart only when armed (%s)', (armed) => {
    const { box, m } = make();
    m.restartArmed = armed;
    m.check();
    for (let i = 0; i < 80; i++) { box.now += 0.25; m.check(); }
    expect(box.restarts).toBe(armed ? 1 : 0);
    expect(m.counters.longestStall).toBeGreaterThan(15);
  });

  test('the main thread answers pings at once and relays events', () => {
    const got: string[] = [];
    const hb = new MainThreadHeartbeat({ onHitch: () => got.push('hitch'), onHang: (s) => got.push(`hang ${s}`), onRestart: () => got.push('restart') });
    const sent: HangWorkerIn[] = [];
    const w = { postMessage: (m: HangWorkerIn) => sent.push(m) };
    hb.receive(w, { kind: 'ping', id: 7 });
    expect(sent).toEqual([{ kind: 'pong', id: 7 }]);
    hb.receive(w, { kind: 'hang', seconds: 3, counters: { hitches: 0, hangs: 1, longestStall: 3 } });
    hb.receive(w, { kind: 'restart', seconds: 16, counters: { hitches: 0, hangs: 1, longestStall: 16 } });
    expect(got).toEqual(['hang 3', 'restart']);
    expect(hb.counters.longestStall).toBe(16);
  });
});
