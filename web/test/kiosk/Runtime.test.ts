// Port of FaceRuntimeTests/RuntimeTests.swift: the event recorder, the leak alarm, the vitals monitor and the soak
// verdict and logger. (The allocation tests and the warped soak cover the engine, not the kiosk.)
import { describe, expect, test } from 'vitest';
import { FaceCommand } from '../../src/engine/Commands';
import { FaceEngine } from '../../src/engine/FaceEngine';
import { FrameClock } from '../../src/render/FrameClock';
import { FrameStats, FrameStatsSnapshot, StatsTier } from '../../src/render/FrameStats';
import { FrameEventRecorder, type FrameEventKind } from '../../src/kiosk/FrameEventRecorder';
import { LeakAlarm, LeakReasons } from '../../src/kiosk/LeakAlarm';
import { makeVitalsSample, ProcessVitals } from '../../src/kiosk/ProcessVitals';
import { SoakLogger, SoakVerdict } from '../../src/kiosk/SoakLog';
import { VitalsMonitor } from '../../src/kiosk/VitalsMonitor';
import { memoryStore } from './support';

const MB = 1_048_576;

describe('FrameEventRecorder', () => {
  test('records state changes and one-shots as raw events', () => {
    const engine = new FaceEngine();
    const clock = new FrameClock(engine);
    const rec = new FrameEventRecorder(engine, null);
    let t = 0;
    const step = () => { t += 1 / 60; clock.step(t); rec.noteFrame(t); };
    for (let i = 0; i < 30; i++) step();
    rec.drain(() => {});
    engine.setAgentState('engaged');
    step();
    engine.send(FaceCommand.playOneShot('perkUp'));
    for (let i = 0; i < 30; i++) step();
    const kinds: FrameEventKind[] = [];
    rec.drain((e) => kinds.push(e.kind));
    expect(kinds.some((k) => k.kind === 'agentState' && k.to === 'engaged')).toBe(true);
    expect(kinds.some((k) => k.kind === 'oneShot' && k.oneShot === 'perkUp')).toBe(true);
    expect(rec.count).toBe(0);
    const text = kinds.map(FrameEventRecorder.describe);
    expect(text.some((s) => s.startsWith('state idle → engaged'))).toBe(true);
    expect(text.some((s) => s.startsWith('one-shot perkUp (rate'))).toBe(true);
  });

  test('ring is bounded and counts drops', () => {
    const engine = new FaceEngine();
    const rec = new FrameEventRecorder(engine, null);
    for (let i = 0; i < FrameEventRecorder.capacity + 40; i++) {
      engine.setAgentState(i % 2 === 0 ? 'engaged' : 'idle');
      rec.noteFrame(i);
    }
    expect(rec.count).toBe(FrameEventRecorder.capacity);
    expect(rec.dropped).toBe(40);
    const serials: number[] = [];
    rec.drain((e) => serials.push(e.serial));
    expect(serials).toEqual([...serials].sort((a, b) => a - b));
    expect(serials[serials.length - 1]).toBe(rec.serial);
  });

  test('chirp wording', () => {
    expect(FrameEventRecorder.describe({ kind: 'chirp', reaction: 'greeting', notes: 3, seconds: 0.456, isAuto: true, paired: 'perkUp', audible: false }))
      .toBe('chirp greeting · 3 notes · 0.46 s · auto · +perkUp · silent');
  });
});

describe('LeakAlarm', () => {
  /// Seeded noise (Swift uses the system RNG; any uniform jitter does).
  const lcg = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  function run(hours: number, perHour: number, o: { threads?: (h: number) => number; files?: (h: number) => number;
    available?: number; jitter?: number } = {}): { alarm: LeakAlarm; raisedAt: number | null } {
    const a = new LeakAlarm();
    const rnd = lcg(42);
    let raised: number | null = null;
    for (let t = 0; t <= hours * 3600; t += 60) {
      const noise = o.jitter ? (rnd() * 2 - 1) * o.jitter : 0;
      const fp = 200 * MB + perHour * t / 3600 + noise;
      a.add(makeVitalsSample({ uptime: t, footprint: Math.max(Math.trunc(fp), 0), threads: o.threads?.(t / 3600) ?? 30,
        openFiles: o.files?.(t / 3600) ?? 40, metalBytes: 50_000_000, availableMemory: o.available ?? 2_000_000_000 }));
      if (raised === null && a.isSuspected) raised = t / 3600;
    }
    return { alarm: a, raisedAt: raised };
  }

  test('3 MB/h raises within 24 hours', () => {
    const r = run(24, 3 * MB, { jitter: 2 * MB });
    expect(r.alarm.suspected & LeakReasons.footprintSlope).toBeTruthy();
    expect(r.raisedAt ?? 99).toBeLessThanOrEqual(24);
  });

  test('1 MB/h does not', () => {
    const r = run(48, 1 * MB, { jitter: 2 * MB });
    expect(r.alarm.isSuspected).toBe(false);
    expect(Math.abs((r.alarm.slope ?? 0) / MB - 1)).toBeLessThan(0.3);
  });

  test('flat is quiet', () => { expect(run(30, 0, { jitter: 4 * MB }).alarm.isSuspected).toBe(false); });

  test('ceiling trips', () => {
    const a = new LeakAlarm();
    for (let m = 0; m <= 4 * 60; m++) {
      const t = m * 60;
      a.add(makeVitalsSample({ uptime: t, footprint: t >= 3 * 3600 ? 520 * MB : 200 * MB, threads: 30, openFiles: 40, availableMemory: 500 * MB }));
    }
    expect(a.ceiling).toBe(200 * MB + 250 * MB);
    expect(a.suspected & LeakReasons.footprintCeiling).toBeTruthy();
  });

  test('growing threads and files trip; a spike does not', () => {
    const r = run(8, 0, { threads: (h) => 30 + Math.trunc(h * 3), files: (h) => 40 + Math.trunc(h * 5) });
    expect(r.alarm.suspected & LeakReasons.threads).toBeTruthy();
    expect(r.alarm.suspected & LeakReasons.openFiles).toBeTruthy();
    const spike = run(8, 0, { threads: (h) => (Math.abs(h - 5) < 0.01 ? 80 : 30) });
    expect(spike.alarm.suspected & LeakReasons.threads).toBeFalsy();
  });

  test('stand-in for available memory', () => {
    const a = new LeakAlarm(1000);
    a.add(makeVitalsSample({ uptime: 0, footprint: 1 }));
    expect(a.availableAtLaunch).toBe(1000);
  });

  test('monitor records and reports new reasons', () => {
    const m = new VitalsMonitor(new LeakAlarm(), () => 0, async (u) => makeVitalsSample({ uptime: u, footprint: 0 }));
    const reasons: number[] = [];
    m.onLeakSuspected = (r) => reasons.push(r);
    for (let minute = 0; minute <= 8 * 60; minute++) {
      const t = minute * 60;
      m.record(makeVitalsSample({ uptime: t, footprint: Math.trunc(200 * MB + 10 * MB * t / 3600), threads: 30, openFiles: 40, availableMemory: 4_000_000_000 }));
    }
    expect(reasons.length).toBe(1);
    expect(reasons[0] & LeakReasons.footprintSlope).toBeTruthy();
    expect(m.slopeMBPerHour ?? 0).toBeGreaterThan(9);
  });

  test('browser vitals: Chromium heap, else zero', async () => {
    const perf = { memory: { usedJSHeapSize: 50 * MB, jsHeapSizeLimit: 2000 * MB } } as unknown as Performance;
    const s = await ProcessVitals.sample(10, 1, perf);
    expect(s.footprint).toBe(50 * MB);
    expect(s.availableMemory).toBe(1950 * MB);
    expect(s.thermal).toBe(1);
    const precise = { measureUserAgentSpecificMemory: async () => ({ bytes: 77 }) } as unknown as Performance;
    expect(await ProcessVitals.footprint(precise, true)).toBe(77);
    expect(await ProcessVitals.footprint(precise, false)).toBe(0);
    expect(ProcessVitals.availableMemory({} as Performance)).toBeNull();
  });
});

describe('Soak', () => {
  const day = (p99: number, hitchMs: number, delivered = 5_184_000, requested = 5_184_000) => {
    const s = new FrameStatsSnapshot();
    s.awake.delivered = delivered;
    s.awake.requested = requested;
    s.awake.seconds = 86_400;
    s.awake.gapP99 = p99;
    s.awake.hitchSeconds = hitchMs / 1000 * 86_400;
    return s;
  };

  test('verdict rules', () => {
    const d1 = day(0.0170, 0.5);
    expect(SoakVerdict.evaluate(d1, day(0.0172, 0.52), 0.4 * MB, 1, 0, 0).pass).toBe(true);
    const worse = SoakVerdict.evaluate(d1, day(0.0190, 0.5), 0, 0, 0, 0);
    expect(worse.pass).toBe(false);
    expect(worse.failures[0]).toContain('p99');
    expect(SoakVerdict.evaluate(d1, day(0.017, 0.8), 0, 0, 0, 0).pass).toBe(false);
    expect(SoakVerdict.evaluate(d1, d1, 1.5 * MB, 0, 0, 0).pass).toBe(false);
    expect(SoakVerdict.evaluate(d1, d1, 0, 6, 0, 0).pass).toBe(false);
    expect(SoakVerdict.evaluate(d1, d1, 0, 0, 0, LeakReasons.footprintSlope).pass).toBe(false);
    expect(SoakVerdict.evaluate(d1, day(0.017, 0.5, 97, 100), 0, 0, 0, 0).pass).toBe(false);
  });

  test('logger writes hours and a day with its verdict', () => {
    const stats = new FrameStats();
    const vitals = new VitalsMonitor(new LeakAlarm(), () => 0);
    const store = memoryStore();
    const log = new SoakLogger(stats, vitals, store, 3600);
    log.start('test', 'desktop', 'test');
    log.stop();
    let t = 0;
    for (let h = 1; h <= 24; h++) {
      for (let i = 0; i < 600; i++) { t += 1 / 60; stats.recordFrame(t, StatsTier.awake, 1 / 60, 0.001, true); }
      vitals.record(makeVitalsSample({ uptime: h * 3600, footprint: 200_000_000, threads: 30, openFiles: 40 }));
      log.hourElapsed();
    }
    const lines = log.lines();
    expect(lines.length).toBe(1 + 24 + 1);
    expect(lines[0]).toContain('"kind":"start"');
    expect(lines[lines.length - 1]).toContain('"kind":"day"');
    expect(log.lastVerdict?.pass).toBe(true);
    const hour = JSON.parse(lines[1]);
    expect(hour.frames.awake.delivered).toBe(600);
    expect(hour.meetsFrameCriteria).toBe(true);
    expect(SoakLogger.isRequested('?soak')).toBe(true);
    expect(SoakLogger.isRequested('?debug')).toBe(false);
  });
});
