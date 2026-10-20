// Port of Tests/FaceEngineTests/GazeTrackingTests.swift (the shared GazeRig lives in ./GazeRig.ts).
import { describe, expect, test } from 'vitest';
import type { V2 } from '../../src/core/vec';
import { Units } from '../../src/model';
import { makeGazeOverride, makeGazeTarget, makePersonTarget } from '../../src/engine';
import { GazeRig } from './GazeRig';

describe('GazeTracking', () => {
  /// Starts settled at the centre (override holds), then jumps the override to `to`.
  const saccadeRig = (to: V2, seed = 3): GazeRig => {
    const rig = new GazeRig({ seed, micro: false });
    rig.override = makeGazeOverride({ x: 0, y: 0 }, 'saccade');
    rig.run(1.0);
    rig.override = makeGazeOverride(to, 'saccade');
    return rig;
  };

  test('saccadePeakTimeAndOvershoot', () => {
    const rig = saccadeRig({ x: 1, y: 0 });
    let peak = -1, peakT = 0, t = 0;
    rig.run(0.6, (r) => {
      t += 1.0 / 120;
      if (r.s.eyeGaze.x > peak) { peak = r.s.eyeGaze.x; peakT = t; }
    });
    // Fast (sub-~140 ms to peak, incl. per-eye lag) with a slight playful overshoot that settles.
    expect(peakT, `peak at ${peakT}s`).toBeLessThan(0.14);
    expect(peakT).toBeGreaterThan(0.04);
    expect(peak > 1.02 && peak < 1.15, `peak ${peak}`).toBe(true);
    expect(Math.abs(rig.s.eyeGaze.x - 1)).toBeLessThan(0.01);
  });

  test('smallSaccadeIsFasterAndLessBouncy', () => {
    const rig = saccadeRig({ x: 0.1, y: 0 });
    let peak = -1, peakT = 0, t = 0;
    rig.run(0.5, (r) => {
      t += 1.0 / 120;
      if (r.s.eyeGaze.x > peak) { peak = r.s.eyeGaze.x; peakT = t; }
    });
    expect(peakT).toBeLessThan(0.125);
    expect(peak).toBeLessThan(0.1 * 1.06);
  });

  test('eyesLeadHead', () => {
    const rig = saccadeRig({ x: 0.8, y: 0 });
    rig.run(0.09);
    expect(rig.s.eyeGaze.x).toBeGreaterThan(0.6);
    expect(rig.s.headGaze.x).toBeLessThan(0.3);
    expect(rig.s.eyeGaze.x).toBeGreaterThan(rig.s.headGaze.x + 0.3);
    rig.run(1.5);
    expect(Math.abs(rig.s.headGaze.x - 0.8)).toBeLessThan(0.02);
  });

  test('headStartsLater', () => {
    const rig = saccadeRig({ x: 0.8, y: 0 });
    rig.run(0.05);
    expect(Math.abs(rig.s.headGaze.x)).toBeLessThan(0.01);
    expect(rig.s.eyeGaze.x).toBeGreaterThan(0.2);
  });

  test('perEyeLagVariesBySaccade', () => {
    let leftLed = 0, rightLed = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rig = saccadeRig({ x: 0.9, y: 0 }, seed);
      const l0 = rig.leftEyeX, r0 = rig.rightEyeX;
      let leader: number | null = null;
      rig.run(0.25, (r) => {
        const dl = r.leftEyeX - l0, dr = r.rightEyeX - r0;
        if (leader === null && Math.abs(dl - dr) > 0.3) leader = dl > dr ? 0 : 1;
      });
      if (leader !== null) { if (leader === 0) leftLed++; else rightLed++; }
    }
    expect(leftLed + rightLed, 'every saccade should show a trailing eye').toBe(12);
    expect(leftLed > 0 && rightLed > 0, `left ${leftLed} right ${rightLed}`).toBe(true);
  });

  test('perEyeLagIsTimeBased', () => {
    // The lag is in time: the eyes' separation curve matches at both frame rates.
    const sep = (fps: number): number[] => {
      const rig = new GazeRig({ seed: 5, micro: false });
      rig.override = makeGazeOverride({ x: 0, y: 0 }, 'saccade');
      rig.run(1.0, undefined, fps);
      // Queue the change for the frame at 1 + 1/60 s at both rates, then sample on the 60 fps grid.
      if (fps === 120) rig.step(1 / 120);
      rig.override = makeGazeOverride({ x: 0.9, y: 0 }, 'saccade');
      const out: number[] = [];
      let i = 0;
      rig.run(0.2, (r) => {
        i++;
        if (fps === 60 || i % 2 === 1) out.push(r.leftEyeX - r.rightEyeX);
      }, fps);
      return out;
    };
    const a = sep(60), b = sep(120);
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(1);
    const maxSep = Math.max(0, ...a.map(Math.abs));
    const baseline = a[0] ?? 0;
    expect(maxSep - Math.abs(baseline), 'eyes should separate during the saccade').toBeGreaterThan(0.4);
    for (let k = 0; k < Math.min(a.length, b.length); k++) expect(Math.abs(a[k] - b[k])).toBeLessThan(0.02);
  });

  test('arcBowsDuringHorizontalSaccade', () => {
    const rig = saccadeRig({ x: 1, y: 0 }, 9);
    let minY = 0;
    rig.run(0.2, (r) => { minY = Math.min(minY, r.leftPupil.y); });
    // Purely horizontal move, but the pupil travels on a slight upward arc (≈ 0.08 · 9.5 / 9 ≈ 0.084 max).
    expect(minY).toBeLessThan(-0.03);
    expect(minY).toBeGreaterThan(-0.12);
    rig.run(0.5);
    expect(Math.abs(rig.leftPupil.y)).toBeLessThan(0.005);
  });

  test('saccadingFlagAndBlinkRequest', () => {
    let requests = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rig = saccadeRig({ x: 0.9, y: 0.2 }, seed);
      let sawSaccading = false;
      rig.run(0.05, (r) => {
        if (r.s.isSaccading) sawSaccading = true;
        if (r.s.saccadeBlinkRequest) requests++;
      });
      expect(sawSaccading).toBe(true);
      rig.run(0.6);
      expect(rig.s.isSaccading).toBe(false);
    }
    // p ≈ 0.3 per large saccade.
    expect(requests >= 4 && requests <= 22, `${requests}`).toBe(true);
  });

  test('noBlinkRequestForSmallSaccades', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rig = saccadeRig({ x: 0.3, y: 0 }, seed);
      let requests = 0;
      rig.run(0.3, (r) => { if (r.s.saccadeBlinkRequest) requests++; });
      expect(requests, `seed ${seed}`).toBe(0);
    }
  });

  test('curiositySign', () => {
    const rig = new GazeRig({ micro: false });
    rig.override = makeGazeOverride({ x: 1, y: 0 }, 'saccade');
    rig.run(2);
    expect(rig.s.eyeScaleMul.z).toBeGreaterThan(1.1); // right eye (gaze side) grows
    expect(rig.s.eyeScaleMul.x).toBeLessThan(0.97); // left eye shrinks
    rig.override = makeGazeOverride({ x: -1, y: 0 }, 'saccade');
    rig.run(2);
    expect(rig.s.eyeScaleMul.x).toBeGreaterThan(1.1);
    expect(rig.s.eyeScaleMul.z).toBeLessThan(0.97);
  });

  test('convergenceSign', () => {
    const inward = (distance: number): { pupils: number; shapes: number } => {
      const rig = new GazeRig({ micro: false });
      rig.intent = { kind: 'track' };
      rig.setPeople([makePersonTarget(1, { x: 0, y: 0 }, distance)], 1);
      rig.run(3);
      // > 0 = pupils closer together.
      return { pupils: rig.leftPupil.x - rig.rightPupil.x, shapes: rig.leftEyeX - rig.rightEyeX };
    };
    const near = inward(0.5), far = inward(3), mid = inward(0.8);
    // Convergence lives on the pupils (≤ 0.1 each), starting below 0.8 m; the eye shapes don't converge.
    expect(Math.abs(far.pupils)).toBeLessThan(0.02);
    expect(Math.abs(mid.pupils)).toBeLessThan(0.02);
    expect(near.pupils > 0.12 && near.pupils < 0.205, `${near.pupils}`).toBe(true);
    expect(Math.abs(near.shapes)).toBeLessThan(0.05);
  });

  test('lidFollowSign', () => {
    const rig = new GazeRig({ micro: false });
    rig.override = makeGazeOverride({ x: 0, y: -0.9 }, 'saccade');
    rig.run(1.5);
    expect(rig.s.lidCoverage.x).toBeLessThan(-0.05);
    expect(rig.s.lidCoverage.z).toBeLessThan(-0.05);
    rig.override = makeGazeOverride({ x: 0, y: 0.9 }, 'saccade');
    rig.run(1.5);
    expect(rig.s.lidCoverage.x).toBeGreaterThan(0.08);
    expect(rig.s.lidCoverage.z).toBeGreaterThan(0.08);
  });

  test('headTiltBounded', () => {
    const rig = new GazeRig({ micro: false });
    let maxAngle = 0;
    for (const x of [1, -1, 1, -1]) {
      rig.override = makeGazeOverride({ x, y: 0.5 }, 'saccade');
      rig.run(0.8, (r) => { maxAngle = Math.max(maxAngle, Math.abs(r.s.delta.face('angle'))); });
    }
    expect(maxAngle).toBeLessThanOrEqual(4.0001);
    // Looking right tilts clockwise (negative angle).
    rig.override = makeGazeOverride({ x: 1, y: 0 }, 'saccade');
    rig.run(2);
    expect(rig.s.delta.face('angle')).toBeLessThan(-3.5);
  });

  test('totalTravelStaysInEnvelope', () => {
    const rig = new GazeRig({ micro: true });
    let maxX = 0, maxY = 0;
    for (const p of [{ x: 1, y: 1 }, { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }]) {
      rig.override = makeGazeOverride(p, 'saccade');
      rig.run(1.0, (r) => {
        const d = r.s.delta;
        maxX = Math.max(maxX, Math.abs(Units.canvasX(d.face('centerX') + d.eye('left', 'centerX'))));
        maxY = Math.max(maxY, Math.abs(Units.canvasY(d.face('centerY') + d.eye('left', 'centerY'))));
      });
    }
    expect(maxX).toBeLessThan(19);
    expect(maxY).toBeLessThan(13);
  });

  test('pursuitFeedForwardKeepsUp', () => {
    // Smooth target moving at 0.8 units/s with its velocity supplied: eyes keep up with tiny lag.
    const rig = new GazeRig({ micro: false });
    rig.override = makeGazeOverride({ x: -0.8, y: 0 }, 'saccade');
    rig.run(1);
    rig.override = null;
    rig.attention.isEnabled = false;
    let x = -0.8, maxErr = 0;
    for (let i = 0; i < 192; i++) {
      x += 0.8 / 120;
      rig.s.gazeTarget = makeGazeTarget({ x, y: 0 }, 'smooth', { x: 0.8, y: 0 });
      rig.step(1 / 120);
      if (i > 60) maxErr = Math.max(maxErr, Math.abs(rig.s.eyeGaze.x - x));
    }
    expect(maxErr, `${maxErr}`).toBeLessThan(0.03);
  });
});
