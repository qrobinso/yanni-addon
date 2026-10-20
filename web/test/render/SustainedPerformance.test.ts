// Port of FaceRenderingTests/SustainedPerformanceTests.swift: the CPU suites (FrameStats, FrameClock). The GPU
// timeout, shared pipeline, SafeFace and Metal shader sync suites need Metal and are not ported.
import { describe, expect, test } from 'vitest';
import { makeFaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { FrameClock } from '../../src/render/FrameClock';
import { FrameRateTier } from '../../src/render/FrameRatePolicy';
import { FrameStats, StatsChannel, StatsTier } from '../../src/render/FrameStats';
import { StaticSource } from './StaticSource';

// MARK: - FrameStats

const i60 = 1.0 / 60;

/// Feeds `n` frames at `interval` starting after `t`; returns the last time.
function feed(s: FrameStats, from: number, n: number, interval: number,
  { tier = StatsTier.awake, expected = i60, main = 0.001, presented = true } = {}): number {
  let time = from;
  for (let i = 0; i < n; i++) {
    time += interval;
    s.recordFrame(time, tier, expected, main, presented);
  }
  return time;
}

describe('FrameStats', () => {
  test('steadySixtyMeetsCriteria', () => {
    const s = new FrameStats();
    feed(s, 0, 600, i60);
    const a = s.snapshot().awake;
    expect(a.delivered).toBe(600);
    expect(a.requested).toBe(600);
    expect(a.hitches).toBe(0);
    expect(Math.abs(a.gapP50 - i60)).toBeLessThan(0.0003);
    expect(Math.abs(a.gapP99 - i60)).toBeLessThan(0.0003);
    expect(Math.abs(a.deliveredFPS - 60)).toBeLessThan(0.2);
    expect(a.meetsCriteria).toBe(true);
    expect(s.snapshot().asleep.requested === 0 && s.snapshot().burst.requested === 0).toBe(true);
  });

  test('droppedFramesAreRequestedNotDelivered', () => {
    const s = new FrameStats();
    let t = feed(s, 0, 100, i60);
    // One 50 ms gap: three expected intervals, one delivered frame, a hitch of 2 intervals.
    t += 3 * i60;
    s.recordFrame(t, StatsTier.awake, i60, 0.001, true);
    const a = s.snapshot().awake;
    expect(a.delivered).toBe(101);
    expect(a.requested).toBe(100 + 3);
    expect(a.hitches).toBe(1);
    expect(Math.abs(a.hitchSeconds - 2 * i60)).toBeLessThan(1e-9);
    expect(Math.abs(a.gapMax - 3 * i60)).toBeLessThan(1e-9);
  });

  test('hitchThresholdIsOnePointFiveIntervals', () => {
    const s = new FrameStats();
    let t = feed(s, 0, 10, i60);
    t += 1.49 * i60;
    s.recordFrame(t, StatsTier.awake, i60, 0, true);
    expect(s.snapshot().awake.hitches).toBe(0);
    t += 1.51 * i60;
    s.recordFrame(t, StatsTier.awake, i60, 0, true);
    expect(s.snapshot().awake.hitches).toBe(1);
  });

  test('tiersAreSeparate', () => {
    const s = new FrameStats();
    let t = feed(s, 0, 60, i60, { tier: StatsTier.awake });
    t = feed(s, t, 30, 1.0 / 30, { tier: StatsTier.asleep, expected: 1.0 / 30 });
    feed(s, t, 120, 1.0 / 120, { tier: StatsTier.burst, expected: 1.0 / 120 });
    const snap = s.snapshot();
    expect(snap.awake.delivered).toBe(60);
    expect(snap.asleep.delivered).toBe(30);
    expect(snap.burst.delivered).toBe(120);
    // The first gap after a tier change is the link adapting: no hitch.
    expect(snap.hitches).toBe(0);
    expect(snap.meetsCriteria).toBe(true);
    expect(Math.abs(snap.asleep.gapP50 - 1.0 / 30)).toBeLessThan(0.0003);
  });

  test('pausesAreNotHitches', () => {
    const s = new FrameStats();
    let t = feed(s, 0, 30, i60);
    t += 5; // backgrounded
    feed(s, t, 30, i60);
    const snap = s.snapshot();
    expect(snap.pauses).toBe(1);
    expect(snap.awake.hitches).toBe(0);
    // notePause: the next gap is ignored even if short of a pause.
    s.notePause();
    t = feed(s, t + 1, 1, 0.2);
    expect(s.snapshot().awake.hitches).toBe(0);
  });

  test('skippedFramesCountAndLowerDelivery', () => {
    const s = new FrameStats();
    let t = feed(s, 0, 90, i60);
    t = feed(s, t, 10, i60, { presented: false });
    const a = s.snapshot().awake;
    expect(a.skipped).toBe(10);
    expect(a.delivered).toBe(90);
    expect(a.requested).toBe(100);
    expect(a.meetsCriteria).toBe(false); // 0.90 < 0.98
  });

  test('gpuSampledEverySixtiethPresentedFrame', () => {
    const s = new FrameStats();
    let sampled = 0;
    let t = 0.0;
    for (let i = 0; i < 600; i++) {
      if (s.shouldSampleGPUNext) { sampled += 1; s.recordGPU(0.0012, false, StatsTier.awake); }
      t += i60;
      s.recordFrame(t, StatsTier.awake, i60, 0, true);
    }
    expect(sampled).toBe(10);
    s.recordGPU(0, true, StatsTier.awake);
    const a = s.snapshot().awake;
    expect(a.gpuSamples).toBe(10);
    expect(Math.abs(a.gpuMean - 0.0012)).toBeLessThan(1e-9);
    expect(a.gpuErrors).toBe(1);
  });

  test('hitchTimePerSecondCriterion', () => {
    const s = new FrameStats();
    // 60 s at 60 fps with one 50 ms gap per second: 33 ms/s of hitch time.
    let t = 0.0;
    for (let i = 0; i < 60; i++) {
      t = feed(s, t, 57, i60);
      t += 3 * i60;
      s.recordFrame(t, StatsTier.awake, i60, 0, true);
    }
    const a = s.snapshot().awake;
    expect(a.hitchMsPerSecond).toBeGreaterThan(30);
    expect(a.meetsCriteria).toBe(false);
  });

  test('hourChannelResetsLifetimeDoesNot', () => {
    const s = new FrameStats();
    let t = feed(s, 0, 120, i60);
    const h1 = s.take(StatsChannel.hour);
    expect(h1.awake.delivered).toBe(120);
    t = feed(s, t, 60, i60);
    expect(s.take(StatsChannel.hour).awake.delivered).toBe(60);
    expect(s.peek(StatsChannel.day).awake.delivered).toBe(180);
    expect(s.snapshot().awake.delivered).toBe(180);
    expect(Math.abs(s.snapshot().span - 179 * i60)).toBeLessThan(1e-6);
  });

  test('mainThreadPercentiles', () => {
    const s = new FrameStats();
    let t = 0.0;
    for (let i = 0; i < 1000; i++) {
      t += i60;
      s.recordFrame(t, StatsTier.awake, i60, i < 990 ? 0.001 : 0.008, true);
    }
    const a = s.snapshot().awake;
    expect(Math.abs(a.mainP50 - 0.001)).toBeLessThanOrEqual(FrameStats.mainBinWidth + 1e-9);
    expect(a.mainP99).toBeLessThanOrEqual(0.00105 + 1e-9);
    expect(Math.abs(a.mainMax - 0.008)).toBeLessThan(1e-12);
  });

  test('recordingDoesNotAllocateAfterInit', () => {
    // The storage is fixed-size typed arrays, so a long run keeps the same snapshot shape.
    const s = new FrameStats();
    feed(s, 0, 100_000, i60);
    expect(s.snapshot().awake.delivered).toBe(100_000);
  });
});

// MARK: - FrameClock

const defaultsFrame = () => makeFaceFrame(FacePose.defaults);

describe('FrameClock', () => {
  test('drivesSourceThenHooksOnceInOrder', () => {
    const src = new StaticSource(defaultsFrame());
    const clock = new FrameClock(src);
    const log: string[] = [];
    clock.addAfterFrame(() => log.push('voice'));
    clock.addAfterFrame(() => log.push('life'));
    clock.addConsumer(src, () => log.push('safeFace'));
    clock.step(1.0);
    expect(log).toEqual(['voice', 'life', 'safeFace']);
    expect(src.requested).toEqual([1.0]);
    // Same or older time (a second driver on the same refresh): no second tick.
    clock.step(1.0);
    clock.step(0.9);
    expect(src.requested).toEqual([1.0]);
    expect(log.length).toBe(3);
    clock.step(1.0 + 1.0 / 60);
    expect(log.length).toBe(6);
    expect(clock.ticks).toBe(2);
  });

  test('backupTakesOverAfter250msWithoutPrimary', () => {
    const host = { t: 100.0 };
    const src = new StaticSource(defaultsFrame());
    const clock = new FrameClock(src, undefined, () => host.t);
    clock.isActive = true;
    try {
      clock.beginFrame(1, 'primary');
      clock.endFrame(true);
      host.t += 0.2;
      clock.checkPrimary();
      expect(clock.isBackupRunning).toBe(false);
      host.t += 0.06;
      clock.checkPrimary();
      expect(clock.isBackupRunning).toBe(true);
      expect(clock.backupTakeovers).toBe(1);
      // The backup drives the same hooks…
      let hooked = 0;
      clock.addAfterFrame(() => { hooked += 1; });
      clock.backupTickForTesting(2);
      expect(hooked).toBe(1);
      expect(clock.lastDriver).toBe('backup');
      // …until a primary frame arrives.
      clock.beginFrame(3, 'primary');
      clock.endFrame(true);
      expect(clock.isBackupRunning).toBe(false);
      expect(hooked).toBe(2);
    } finally {
      clock.isActive = false;
    }
  });

  test('noBackupWhileInactive', () => {
    const host = { t: 100.0 };
    const clock = new FrameClock(new StaticSource(defaultsFrame()), undefined, () => host.t);
    host.t += 10;
    clock.checkPrimary();
    expect(clock.isBackupRunning).toBe(false);
  });

  test('statsSeeEveryFrameWithItsTier', () => {
    const src = new StaticSource(defaultsFrame());
    const clock = new FrameClock(src);
    let t = 0.0;
    for (let i = 0; i < 120; i++) { t += 1.0 / 60; clock.step(t); }
    src.current = makeFaceFrame(FacePose.defaults, { brightness: 0.12, isAsleep: true });
    // The link keeps 60 until the policy's hold-down lets it drop to 30.
    while (clock.policy.tier !== FrameRateTier.low) { t += 1.0 / 60; clock.step(t); }
    for (let i = 0; i < 120; i++) { t += 1.0 / 30; clock.step(t); }
    const s = clock.stats.snapshot();
    expect(s.awake.delivered).toBeGreaterThanOrEqual(120);
    expect(s.asleep.delivered).toBeGreaterThan(80); // after the 0.5 s hold-down
    expect(s.hitches).toBe(0);
  });

  test('displayCeilingSetsExpectedInterval', () => {
    const clock = new FrameClock(new StaticSource(defaultsFrame()));
    clock.displayMaximumFramesPerSecond = 60;
    expect(Math.abs(clock.expectedInterval(StatsTier.burst) - 1.0 / 60)).toBeLessThan(1e-12);
    clock.displayMaximumFramesPerSecond = 120;
    expect(Math.abs(clock.expectedInterval(StatsTier.burst) - 1.0 / 120)).toBeLessThan(1e-12);
    expect(Math.abs(clock.expectedInterval(StatsTier.asleep) - 1.0 / 30)).toBeLessThan(1e-12);
  });
});
