// Port of Tests/FaceEngineTests/SquashStretchTests.swift (SquashStretchTests and ElasticityTests).
import { describe, expect, test } from 'vitest';
import { SquashStretch } from '../../src/engine/modifiers/SquashStretch';
import { Phase } from '../../src/engine';
import { Units } from '../../src/model';
import { LidsHarness, LidsProbe } from './harness';

/// Bobs the face centre vertically: amplitude in canvas units, frequency in Hz.
const bob = (amplitude: number, hz: number): LidsProbe =>
  new LidsProbe('LidsProbe', Phase.motion, (s) => {
    s.delta.setFace('centerY', s.delta.face('centerY') + Units.poseY(amplitude * Math.sin(2 * Math.PI * hz * s.time)));
  });

describe('SquashStretch', () => {
  test('fastVerticalMotionStretchesPreservingVolume', () => {
    const sq = new SquashStretch();
    const h = new LidsHarness([bob(3, 2), sq], 120);
    h.s.elasticity = 1; // neutral style for the original bounds
    let maxY = 0;
    let prev: number | null = null, prevStep: number | null = null;
    let maxStep = 0, maxAccel = 0;
    h.run(5, (h) => {
      const y = h.s.faceScaleMul.y, x = h.s.faceScaleMul.x;
      expect(Math.abs(x * Math.sqrt(y) - 1)).toBeLessThan(1e-4);
      expect(y >= 0.9 && y <= 1 + SquashStretch.maxStretch * 1.25).toBe(true);
      if (prev !== null) {
        const d = y - prev;
        if (h.elapsed > 0.1) maxStep = Math.max(maxStep, Math.abs(d));
        if (prevStep !== null && h.elapsed > 0.1) maxAccel = Math.max(maxAccel, Math.abs(d - prevStep));
        prevStep = d;
      }
      prev = y;
      maxY = Math.max(maxY, y);
    });
    expect(maxY, `peak stretch ${maxY}`).toBeGreaterThan(1.06);
    expect(maxStep, `stretch step ${maxStep}`).toBeLessThan(0.03);
    expect(maxAccel, `stretch jitter ${maxAccel}`).toBeLessThan(0.01);
  });

  test('stillFaceHasNoStretch', () => {
    const h = new LidsHarness([new SquashStretch()], 60);
    h.run(2, (h) => {
      expect(Math.abs(h.s.faceScaleMul.y - 1)).toBeLessThan(1e-5);
      expect(Math.abs(h.s.faceScaleMul.x - 1)).toBeLessThan(1e-5);
    });
  });

  test('relaxesDuringBlinks', () => {
    const sq = new SquashStretch();
    const h = new LidsHarness([
      bob(3, 2),
      new LidsProbe('LidsProbe', Phase.motion, (s) => { if (s.time > 3) s.blink = 1; }),
      sq,
    ], 120);
    h.run(3);
    h.run(0.4);
    expect(Math.abs(sq.value - 1)).toBeLessThan(0.01);
  });

  test('sixtyAndOneTwentyFpsRoughlyMatch', () => {
    const a = new LidsHarness([bob(2, 0.7), new SquashStretch()], 60);
    const b = new LidsHarness([bob(2, 0.7), new SquashStretch()], 120);
    let maxErr = 0;
    for (let i = 0; i < 60 * 10; i++) {
      a.step(); b.step(); b.step();
      if (a.elapsed > 1) maxErr = Math.max(maxErr, Math.abs(a.s.faceScaleMul.y - b.s.faceScaleMul.y));
    }
    // One-frame velocity lag differs between rates; the effect is still within 0.5 % of scale.
    expect(maxErr, `error ${maxErr}`).toBeLessThan(5e-3);
  });
});

describe('Elasticity', () => {
  test('moreElasticStretchesMore', () => {
    function peak(e: number): number {
      const h = new LidsHarness([bob(3, 2), new SquashStretch()], 120);
      h.s.elasticity = e;
      let m = 0;
      h.run(3, (h) => { m = Math.max(m, h.s.faceScaleMul.y); });
      return m;
    }
    expect(peak(1.6)).toBeGreaterThan(peak(1.0) + 0.01);
  });
});
