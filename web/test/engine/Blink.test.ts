// Port of Tests/FaceEngineTests/BlinkTests.swift.
import { describe, expect, test } from 'vitest';
import { Blink } from '../../src/engine/modifiers/Blink';
import { FaceCommand, Phase } from '../../src/engine';
import { LidsHarness, LidsProbe } from './harness';

/// Runs Blink alone and records blink start times (changes of `lastBlinkTime`).
function recordStarts(h: LidsHarness, seconds: number, each: (h: LidsHarness) => void = () => {}): number[] {
  const starts: number[] = [];
  let last = h.s.lastBlinkTime;
  h.run(seconds, (h) => {
    each(h);
    if (h.s.lastBlinkTime !== last) {
      starts.push(h.s.lastBlinkTime);
      last = h.s.lastBlinkTime;
    }
  });
  return starts;
}

describe('Blink', () => {
  test.each([1, 2, 3])('statisticsOverTenMinutes(%i)', (seed) => {
    const blink = new Blink();
    const h = new LidsHarness([blink], 60, seed);
    let maxC = 0;
    const starts = recordStarts(h, 600, (h) => { maxC = Math.max(maxC, h.s.blink); });
    const perMinute = starts.length / 10;
    const target = 60 / Blink.medianInterval;
    expect(Math.abs(perMinute - target) / target, `rate ${perMinute}/min vs ${target}`).toBeLessThan(0.15);
    expect(maxC).toBeGreaterThan(0.9);

    // Double-blink share: second blinks / primary blinks ≈ 12 %.
    const primaries = blink.blinkCount - blink.doubleBlinkCount;
    const share = blink.doubleBlinkCount / primaries;
    expect(share > 0.05 && share < 0.2, `double share ${share}`).toBe(true);

    // Close-to-close spacing: the quick ones are exactly the doubles; nothing overlaps.
    let quick = 0;
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1];
      expect(gap, `blinks overlap: gap ${gap}`).toBeGreaterThanOrEqual(0.085);
      if (gap < 0.6) quick += 1;
    }
    expect(quick).toBe(blink.doubleBlinkCount);
    // Primary intervals respect the 0.8–10 s clamp (± double-blink offsets).
    expect(starts.length).toBe(blink.blinkCount);
  });

  test('noTwoConsecutiveBlinksIdentical', () => {
    const h = new LidsHarness([new Blink()], 120, 5);
    const shapes: [number, number][] = []; // (frames closed, peak depth)
    let onAt: number | null = null;
    let peak = 0;
    h.run(120, (h) => {
      if (h.s.blink > 0) { if (onAt === null) onAt = h.s.time; peak = Math.max(peak, h.s.blink); }
      if (h.s.blink === 0 && onAt !== null) { shapes.push([h.s.time - onAt, peak]); onAt = null; peak = 0; }
    });
    expect(shapes.length).toBeGreaterThan(20);
    for (let i = 1; i < shapes.length; i++) {
      expect(Math.abs(shapes[i][0] - shapes[i - 1][0]) > 1e-9 || shapes[i][1] !== shapes[i - 1][1]).toBe(true);
    }
  });

  test('suppressedAtZeroRate', () => {
    const h = new LidsHarness([new Blink()], 60, 2);
    h.s.modulation.blinkRate = 0;
    let maxC = 0;
    const starts = recordStarts(h, 120, (h) => {
      h.s.saccadeBlinkRequest = true; // ignored too
      maxC = Math.max(maxC, h.s.blink);
    });
    expect(starts).toEqual([]);
    expect(maxC).toBe(0);
  });

  test('inProgressBlinkFinishesSmoothlyWhenRateDropsToZero', () => {
    const h = new LidsHarness([new Blink()], 120, 3);
    // Run until a blink is half closed, then suppress.
    let guardFrames = 0;
    while (h.s.blink < 0.3 && guardFrames < 120 * 20) { h.step(); guardFrames += 1; }
    expect(h.s.blink).toBeGreaterThanOrEqual(0.3);
    h.s.modulation.blinkRate = 0;
    let prev = h.s.blink;
    let maxStep = 0;
    h.run(1, (h) => {
      maxStep = Math.max(maxStep, Math.abs(h.s.blink - prev));
      prev = h.s.blink;
    });
    expect(h.s.blink).toBe(0);
    expect(maxStep).toBeLessThan(0.2);
    const later = recordStarts(h, 60);
    expect(later).toEqual([]);
  });

  test('saccadeBlinkRequestHonouredWithRefractory', () => {
    // Without requests: no blink in 5 s at a tiny rate (natural blinks ≥ 40 s away).
    const h = new LidsHarness([new Blink()], 60, 4);
    h.s.modulation.blinkRate = 0.01;
    expect(recordStarts(h, 5)).toEqual([]);

    const requestAt = new Set([60, 78, 180]); // t = 1.0, 1.3 (refractory), 3.0
    const h2 = new LidsHarness([
      new LidsProbe('LidsProbe', Phase.attention, (s) => {
        const f = Math.round(s.time * 60);
        if (requestAt.has(f)) s.saccadeBlinkRequest = true;
      }),
      new Blink(),
    ], 60, 4);
    h2.s.modulation.blinkRate = 0.01;
    const s2 = recordStarts(h2, 5);
    expect(s2.length).toBe(2);
    expect(Math.abs(s2[0] - 1.0)).toBeLessThan(1e-6);
    expect(Math.abs(s2[1] - 3.0)).toBeLessThan(1e-6);
  });

  test('blinkCommandStartsABlink', () => {
    const h = new LidsHarness([
      new LidsProbe('LidsProbe', Phase.behaviour, (s) => {
        if (Math.abs(s.time - 2) < 1e-6) s.commands.push(FaceCommand.blink);
      }),
      new Blink(),
    ], 60, 4);
    h.s.modulation.blinkRate = 0.01;
    const starts = recordStarts(h, 4);
    expect(starts.length).toBe(1);
    expect(Math.abs(starts[0] - 2)).toBeLessThan(1e-6);
  });

  test('defersWhileOneShotOwnsClosure', () => {
    const h = new LidsHarness([
      new LidsProbe('LidsProbe', Phase.behaviour, (s) => {
        if (s.time < 20) s.oneShot.ownsClosure = true;
        s.saccadeBlinkRequest = s.time > 5 && s.time < 6;
        if (Math.abs(s.time - 8) < 1e-6) s.commands.push(FaceCommand.blink);
      }),
      new Blink(),
    ], 60, 6);
    const during = recordStarts(h, 20);
    expect(during).toEqual([]);
    const after = recordStarts(h, 2);
    expect(after.length).toBeGreaterThan(0); // overdue blink / deferred command fires soon after release
    expect(after[0]).toBeGreaterThanOrEqual(20 - 1 / 60 + Blink.releaseDelay - 1e-6);
  });

  test('oneShotBlinkCountsAsBlinkAndPushesScheduleOut', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const h = new LidsHarness([
        new LidsProbe('LidsProbe', Phase.motion, (s) => {
          // A one-shot blink sampled at t ∈ [5, 5.2).
          if (s.time >= 5 && s.time < 5.2) { s.oneShot.blink = 0.8; s.blink = Math.max(s.blink, 0.8); }
        }),
        new Blink(),
      ], 60, seed);
      h.run(4.99);
      const starts = recordStarts(h, 2);
      expect(starts.length).toBeGreaterThan(0);
      expect(Math.abs(starts[0] - 5), `seed ${seed} first start ${starts[0]}`).toBeLessThan(0.02);
      if (starts.length > 1) {
        expect(starts[1] - 5.2, 'natural blink too soon after one-shot').toBeGreaterThanOrEqual(Blink.minInterval - 0.25);
      }
    }
  });

  test('maxCombinesWithExistingBlink', () => {
    const h = new LidsHarness([
      new LidsProbe('LidsProbe', Phase.motion, (s) => { s.blink = 0.4; }),
      new Blink(),
    ], 60, 1);
    h.s.modulation.blinkRate = 0;
    h.run(1, (h) => { expect(h.s.blink).toBe(0.4); });
  });

  test('blinkDurationAndSpeedStretchTheCurve', () => {
    function meanLength(duration: number, speed: number): number {
      const h = new LidsHarness([new Blink()], 120, 8);
      h.s.modulation.blinkDuration = duration;
      h.s.modulation.speed = speed;
      const lengths: number[] = [];
      let onAt: number | null = null;
      let last = 0;
      h.run(120, (h) => {
        if (h.s.blink > 0 && last === 0) onAt = h.s.time;
        if (h.s.blink === 0 && last > 0 && onAt !== null) lengths.push(h.s.time - onAt);
        last = h.s.blink;
      });
      return lengths.reduce((a, b) => a + b, 0) / Math.max(lengths.length, 1);
    }
    const normal = meanLength(1, 1);
    const tired = meanLength(1.6, 1);
    const fast = meanLength(1, 1.35);
    expect(normal > 0.2 && normal < 0.33, `normal ${normal}`).toBe(true);
    expect(tired).toBeGreaterThan(normal * 1.5);
    expect(fast).toBeLessThan(normal * 0.9);
  });

  test('curveIsSmoothAndBounded', () => {
    const h = new LidsHarness([new Blink()], 120, 9);
    let prev = 0;
    let maxStep = 0;
    h.run(60, (h) => {
      expect(h.s.blink >= 0 && h.s.blink <= 1).toBe(true);
      maxStep = Math.max(maxStep, Math.abs(h.s.blink - prev));
      prev = h.s.blink;
    });
    // Fastest part is the end of the ease-in close: 2/(0.07·0.88) ≈ 32/s → ≈ 0.27 per 120 fps frame.
    expect(maxStep).toBeLessThan(0.35);
  });

  test.each([0.0, 1_000_000.0])('sixtyAndOneTwentyFpsMatch(%d)', (start) => {
    const a = new LidsHarness([new Blink()], 60, 11, start);
    const b = new LidsHarness([new Blink()], 120, 11, start);
    let maxErr = 0;
    let blinks = 0;
    let last = 0;
    for (let i = 0; i < 60 * 90; i++) {
      a.step(); b.step(); b.step();
      maxErr = Math.max(maxErr, Math.abs(a.s.blink - b.s.blink));
      if (a.s.blink > 0 && last === 0) blinks += 1;
      last = a.s.blink;
    }
    expect(blinks).toBeGreaterThan(10);
    expect(maxErr, `max error ${maxErr}`).toBeLessThan(1e-3);
  });
});
