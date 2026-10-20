// Port of Tests/FaceEngineTests/BreathingTests.swift.
import { describe, expect, test } from 'vitest';
import { Breathing } from '../../src/engine/modifiers/Breathing';
import { Units } from '../../src/model';
import { LidsHarness } from './harness';

/// Upward zero crossings of the wave → breath periods.
function periods(b: Breathing, h: LidsHarness, seconds: number, each: (h: LidsHarness) => void = () => {}): number[] {
  const crossings: number[] = [];
  let prev = b.wave;
  h.run(seconds, (h) => {
    each(h);
    if (prev < 0 && b.wave >= 0) crossings.push(h.s.time);
    prev = b.wave;
  });
  return crossings.slice(1).map((c, i) => c - crossings[i]);
}

describe('Breathing', () => {
  test.each([0.0, 1_000_000.0])('boundedSmoothAndModulated(%d)', (start) => {
    const b = new Breathing();
    const h = new LidsHarness([b], 120, 1, start);
    const maxAmp = 1 + Breathing.amplitudeModulation;
    let prevY: number | null = null, prevC: number | null = null;
    let maxScale = 0;
    const ps = periods(b, h, 240, (h) => {
      const sy = h.s.faceScaleMul.y, cy = h.s.delta.face('centerY');
      expect(Math.abs(sy - 1)).toBeLessThanOrEqual(Breathing.scaleAmplitude * maxAmp + 1e-5);
      expect(Math.abs(cy)).toBeLessThanOrEqual(Units.poseY(Breathing.centerAmplitude * maxAmp) + 1e-4);
      expect(h.s.brightness).toBe(1); // awake: no brightness pulse
      if (prevY !== null) expect(Math.abs(sy - prevY)).toBeLessThan(4e-4); // ≈ 2.2e-4 peak per 120 fps frame
      if (prevC !== null) expect(Math.abs(cy - prevC)).toBeLessThan(0.1); // ≈ 0.06 pose units peak per 120 fps frame
      maxScale = Math.max(maxScale, sy - 1);
      prevY = sy; prevC = cy;
    });
    expect(maxScale).toBeGreaterThan(Breathing.scaleAmplitude * 0.7);
    expect(ps.length).toBeGreaterThan(40);
    for (const p of ps) expect(p > 4.5 * 0.8 && p < 4.5 * 1.2, `period ${p}`).toBe(true);
    const spread = (ps.length ? Math.max(...ps) : 0) - (ps.length ? Math.min(...ps) : 0);
    expect(spread, `period should be modulated (spread ${spread})`).toBeGreaterThan(0.1);
  });

  test('asleepIsSlowerDeeperAndPulsesBrightness', () => {
    const b = new Breathing();
    const h = new LidsHarness([b], 60);
    h.run(10);
    h.s.agentState = 'asleep';
    h.s.breathingDepth = 2.5;
    let prevWave = b.wave;
    let maxWaveStep = 0;
    h.run(10, () => {
      maxWaveStep = Math.max(maxWaveStep, Math.abs(b.wave - prevWave));
      prevWave = b.wave;
    });
    // Wave stays continuous through the transition.
    expect(maxWaveStep).toBeLessThan(0.03);
    let bmin = 2, bmax = 0, smax = 0;
    const ps = periods(b, h, 120, (h) => {
      bmin = Math.min(bmin, h.s.brightness); bmax = Math.max(bmax, h.s.brightness);
      smax = Math.max(smax, h.s.faceScaleMul.y - 1);
    });
    for (const p of ps) expect(p > 7 * 0.8 && p < 7 * 1.2, `asleep period ${p}`).toBe(true);
    expect(bmax <= 1 + Breathing.asleepBrightnessPulse + 1e-4 && bmax > 1.1).toBe(true);
    expect(bmin >= 1 - Breathing.asleepBrightnessPulse - 1e-4 && bmin < 0.9).toBe(true);
    expect(smax).toBeGreaterThan(Breathing.scaleAmplitude * 1.8);
  });

  test('sixtyAndOneTwentyFpsMatch', () => {
    const ba = new Breathing(), bb = new Breathing();
    const a = new LidsHarness([ba], 60), b = new LidsHarness([bb], 120);
    let maxErr = 0;
    for (let i = 0; i < 60 * 60; i++) {
      if (i === 60 * 20) { a.s.agentState = 'asleep'; b.s.agentState = 'asleep'; }
      a.step(); b.step(); b.step();
      maxErr = Math.max(maxErr, Math.abs(a.s.faceScaleMul.y - b.s.faceScaleMul.y) / Breathing.scaleAmplitude);
    }
    expect(maxErr, `relative error ${maxErr}`).toBeLessThan(1e-2);
  });
});
