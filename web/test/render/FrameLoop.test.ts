// Port of FaceRenderingTests/FrameLoopTests.swift (FrameRatePolicyTests; the FrameLoopTests suite needs Metal).
import { describe, expect, test } from 'vitest';
import { makeFaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { FrameRatePolicy, FrameRateTier } from '../../src/render/FrameRatePolicy';

const frame = (o: Parameters<typeof makeFaceFrame>[1] = {}) => makeFaceFrame(FacePose.defaults, o);

describe('FrameRatePolicy', () => {
  test('defaultsTo60', () => {
    expect(new FrameRatePolicy().tier).toBe(FrameRateTier.normal);
    expect(FrameRatePolicy.desired(frame())).toBe(FrameRateTier.normal);
  });

  test('speedsUpImmediately', () => {
    const p = new FrameRatePolicy();
    expect(p.update(frame({ wantsHighFrameRate: true }), 0)).toBe(FrameRateTier.high);
    expect(p.tier).toBe(FrameRateTier.high);
  });

  test('slowsDownAfterHoldDown', () => {
    const p = new FrameRatePolicy();
    p.update(frame({ wantsHighFrameRate: true }), 0);
    const calm = frame();
    expect(p.update(calm, 0.1)).toBeUndefined();
    expect(p.update(calm, 0.4)).toBeUndefined();
    expect(p.tier).toBe(FrameRateTier.high);
    expect(p.update(calm, 0.61)).toBe(FrameRateTier.normal);
  });

  test('burstResetsHoldDown', () => {
    const p = new FrameRatePolicy();
    p.update(frame({ wantsHighFrameRate: true }), 0);
    p.update(frame(), 0.1);
    p.update(frame({ wantsHighFrameRate: true }), 0.45);
    expect(p.update(frame(), 0.7)).toBeUndefined();
    expect(p.tier).toBe(FrameRateTier.high);
  });

  test('asleepDropsTo30', () => {
    const p = new FrameRatePolicy();
    const asleep = frame({ brightness: 0.12, isAsleep: true });
    expect(p.update(asleep, 0)).toBeUndefined();
    expect(p.update(asleep, 0.6)).toBe(FrameRateTier.low);
    expect(FrameRateTier.range(p.tier).preferred).toBe(30);
    // Asleep wins over a high-rate request.
    expect(FrameRatePolicy.desired(frame({ wantsHighFrameRate: true, isAsleep: true }))).toBe(FrameRateTier.low);
  });
});
