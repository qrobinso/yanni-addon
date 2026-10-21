// Port of Tests/FaceEngineTests/BurnInTests.swift.
import { describe, expect, test } from 'vitest';
import { BurnInDrift } from '../../src/engine/modifiers/BurnInDrift';
import { Units } from '../../src/model';
import type { V2 } from '../../src/core/vec';
import { LidsHarness } from './harness';

describe('BurnIn', () => {
  test('driftStaysInBoundsAndCoversTheRange', { timeout: 30_000 }, () => {
    const d = new BurnInDrift();
    const h = new LidsHarness([d], 20);
    let maxX = 0, maxY = 0;
    let prev: V2 | null = null;
    h.run(2 * 3600, (h) => {
      const o = { ...d.offset };
      expect(Math.abs(o.x)).toBeLessThanOrEqual(BurnInDrift.awakeAmplitude + 1e-3);
      expect(Math.abs(o.y)).toBeLessThanOrEqual(BurnInDrift.awakeAmplitude * BurnInDrift.yRatio + 1e-3);
      expect(Math.abs(h.s.delta.face('centerX') - Units.poseX(o.x))).toBeLessThan(1e-3);
      if (prev) expect(Math.abs(o.x - prev.x) < 0.01 && Math.abs(o.y - prev.y) < 0.01).toBe(true);
      prev = o;
      maxX = Math.max(maxX, Math.abs(o.x)); maxY = Math.max(maxY, Math.abs(o.y));
    });
    expect(maxX > 7.5 && maxY > 3.5).toBe(true);
  });

  test('largerAndSmoothWhenAsleep', () => {
    const d = new BurnInDrift();
    // Start near the x peak (t ≈ 105 s is a quarter of the 7-minute period).
    const h = new LidsHarness([d], 30, 1, 95);
    h.run(5);
    h.s.agentState = 'asleep';
    let prev = { ...d.offset };
    let maxStep = 0;
    h.run(30, () => {
      maxStep = Math.max(maxStep, Math.abs(d.offset.x - prev.x));
      prev = { ...d.offset };
    });
    expect(maxStep).toBeLessThan(0.05);
    expect(d.offset.x > 9 && d.offset.x <= BurnInDrift.asleepAmplitude + 1e-3).toBe(true);
  });

  test('longUptimeIsContinuousAndFrameRateIndependent', () => {
    const da = new BurnInDrift(), db = new BurnInDrift();
    const a = new LidsHarness([da], 60, 1, 1_000_000);
    const b = new LidsHarness([db], 120, 1, 1_000_000);
    let prev: V2 | null = null;
    for (let i = 0; i < 60 * 60; i++) {
      a.step(); b.step(); b.step();
      expect(Math.abs(da.offset.x - db.offset.x) < 1e-4 && Math.abs(da.offset.y - db.offset.y) < 1e-4).toBe(true);
      if (prev) expect(Math.abs(da.offset.x - prev.x)).toBeLessThan(0.01);
      prev = { ...da.offset };
    }
  });
});
