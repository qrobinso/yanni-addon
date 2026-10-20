// Port of FaceRenderingTests/FrameRateCeilingTests.swift. The frame-rate ceiling (hardening design §4.3): it caps the
// 120 Hz burst only; awake never drops below 60 and asleep stays at 30.
import { describe, expect, test } from 'vitest';
import { makeFaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { FrameRatePolicy, FrameRateTier } from '../../src/render/FrameRatePolicy';

const fast = makeFaceFrame(FacePose.defaults, { wantsHighFrameRate: true });
const calm = makeFaceFrame(FacePose.defaults);
const asleep = makeFaceFrame(FacePose.defaults, { isAsleep: true });
const { low, normal, high } = FrameRateTier;

describe('FrameRateCeiling', () => {
  test('ceilingClampsDesired', () => {
    expect(FrameRatePolicy.desiredUnder(fast, high)).toBe(high);
    expect(FrameRatePolicy.desiredUnder(fast, normal)).toBe(normal);
    expect(FrameRatePolicy.desiredUnder(calm, normal)).toBe(normal);
  });

  test('neverBelowNormalAwake', () => {
    const p = new FrameRatePolicy();
    p.ceiling = low;
    expect(p.ceiling).toBe(normal);
    expect(FrameRatePolicy.desiredUnder(fast, low)).toBe(normal);
    p.update(fast, 0);
    expect(p.tier).toBe(normal);
  });

  test('asleepUnaffected', () => {
    const p = new FrameRatePolicy();
    p.ceiling = normal;
    p.update(asleep, 0);
    p.update(asleep, 1);
    expect(p.tier).toBe(low);
  });

  test('proMotionVersusSixty', () => {
    const pro = new FrameRatePolicy(), sixty = new FrameRatePolicy();
    sixty.ceiling = normal;
    pro.update(fast, 0);
    sixty.update(fast, 0);
    expect(pro.tier === high && sixty.tier === normal).toBe(true);
  });

  /// Calm (drowsy, or nobody in view): the still face at 30, fast motion at 60 (never the burst), asleep unchanged.
  test('calmRendersAtThirtyAndCapsFastMotionAtSixty', () => {
    expect(FrameRatePolicy.desiredUnder(calm, high, true)).toBe(low);
    expect(FrameRatePolicy.desiredUnder(fast, high, true)).toBe(normal);
    expect(FrameRatePolicy.desiredUnder(asleep, high, true)).toBe(low);
    const p = new FrameRatePolicy();
    p.calm = true;
    p.update(calm, 0);
    expect(p.tier, 'slowing down waits the hold-down').toBe(normal);
    p.update(calm, 0.6);
    expect(p.tier).toBe(low);
    // A saccade lifts it to 60 at once, then back to 30 after the hold-down.
    expect(p.update(fast, 1)).toBe(normal);
    p.update(calm, 1.1);
    expect(p.update(calm, 1.7)).toBe(low);
    // No longer calm (someone came in): fast motion bursts again.
    p.calm = false;
    expect(p.update(fast, 2)).toBe(high);
  });
});
