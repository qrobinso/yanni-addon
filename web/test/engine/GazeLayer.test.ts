// Port of Tests/FaceEngineTests/GazeLayerTests.swift.
import { describe, expect, test } from 'vitest';
import type { V2 } from '../../src/core/vec';
import {
  Attention, FaceCommand, GazeTracking, OneShotLibrary, OneShotParams, makeGazeOverride, makeGazeTarget, makePersonTarget,
} from '../../src/engine';
import { GazeRig, len2, sub } from './GazeRig';

/// Three-layer gaze (pupils / eye shapes / head), VOR, eye-contact gain, calibration, convergence and
/// pupils-only overrides (sclera/pupil design §4, review H1/C1/M5/M7).
describe('GazeLayer', () => {
  const K = GazeTracking.K;

  /// Total on-screen horizontal gaze (normalised): summed canvas displacement of the left pupil, its eye shape
  /// and the head, over the total travel.
  const totalX = (r: GazeRig): number =>
    (r.tracking.debugPupilL.x * K.pupilTravel.x + r.leftEyeX + r.headX) / K.totalTravel.x;

  const settledRig = (seed = 3, p: V2 = { x: 0, y: 0 }): GazeRig => {
    const rig = new GazeRig({ seed, micro: false });
    rig.override = makeGazeOverride(p, 'saccade');
    rig.run(1.5);
    return rig;
  };

  test('layersCarryTheirSharesAtRest', () => {
    const rig = settledRig(3, { x: 0.5, y: 0.3 });
    // Head ±3 / ±2.2, eye shape ±2 / ±1.5 canvas at |gaze| = 1; pupils carry their own normalised share.
    expect(Math.abs(rig.headX - 1.5), `${rig.headX}`).toBeLessThan(0.03);
    expect(Math.abs(rig.headY - 0.66), `${rig.headY}`).toBeLessThan(0.03);
    expect(Math.abs(rig.leftEyeX - 1.0)).toBeLessThan(0.03);
    expect(Math.abs(rig.leftEyeY - 0.45)).toBeLessThan(0.03);
    expect(Math.abs(rig.tracking.debugPupilL.x - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(rig.tracking.debugPupilL.y - 0.3)).toBeLessThan(0.01);
    // Pupils carry most of the travel.
    const pupilCanvas = rig.tracking.debugPupilL.x * K.pupilTravel.x;
    expect(pupilCanvas > rig.headX && pupilCanvas > rig.leftEyeX).toBe(true);
    expect(Math.abs(totalX(rig) - 0.5)).toBeLessThan(0.01);
  });

  test('pupilsLeadThenCounterRotateAsTheHeadArrives', () => {
    const rig = settledRig();
    rig.override = makeGazeOverride({ x: 0.6, y: 0 }, 'saccade');
    let peakPupil = 0, headAtPeak = 0, peakTotal = 0;
    rig.run(1.5, (r) => {
      if (r.tracking.debugPupilL.x > peakPupil) { peakPupil = r.tracking.debugPupilL.x; headAtPeak = r.s.headGaze.x; }
      peakTotal = Math.max(peakTotal, totalX(r));
    });
    // The pupils take (more than) the whole jump while the head is still on its way…
    expect(peakPupil, `peak pupil ${peakPupil}`).toBeGreaterThan(0.75);
    expect(headAtPeak, `head at pupil peak ${headAtPeak}`).toBeLessThan(0.3);
    // …then recentre to their share as the head takes its offset.
    expect(Math.abs(rig.tracking.debugPupilL.x - 0.6)).toBeLessThan(0.01);
    expect(Math.abs(rig.s.headGaze.x - 0.6)).toBeLessThan(0.01);
    // Summed gaze reaches the target with ≤ 10 % overshoot.
    expect(peakTotal, `total overshoot ${peakTotal}`).toBeLessThanOrEqual(0.6 * 1.10);
    expect(Math.abs(totalX(rig) - 0.6)).toBeLessThan(0.006);
  });

  test('largeSaccadeOvershootStaysWithinTenPercent', () => {
    for (const target of [0.3, 0.8]) {
      const rig = settledRig(7);
      rig.override = makeGazeOverride({ x: target, y: 0 }, 'saccade');
      let peak = 0;
      rig.run(1.5, (r) => { peak = Math.max(peak, totalX(r)); });
      expect(peak, `target ${target} peak ${peak}`).toBeLessThanOrEqual(target * 1.10);
      expect(Math.abs(totalX(rig) - target), `target ${target} final ${totalX(rig)}`).toBeLessThan(0.02);
      expect(Math.abs(rig.leftPupil.x)).toBeLessThanOrEqual(1);
    }
  });

  // MARK: Eye contact (C1)

  const trackRig = (position: V2, distance = 1.5, seed = 11): GazeRig => {
    const rig = new GazeRig({ seed, micro: false });
    rig.intent = { kind: 'track' };
    rig.setPeople([makePersonTarget(1, position, distance)], 1);
    return rig;
  };

  test('centredPersonGetsCentredPupils', () => {
    const rig = trackRig({ x: 0, y: 0 });
    rig.run(4);
    let maxP = 0;
    rig.run(4, (r) => {
      maxP = Math.max(maxP, Math.abs(r.leftPupil.x), Math.abs(r.leftPupil.y), Math.abs(r.rightPupil.x), Math.abs(r.rightPupil.y));
    });
    expect(maxP, `${maxP}`).toBeLessThanOrEqual(0.05);
    expect(rig.s.gazeTarget.contact).toBe(true);
  });

  test('offAxisPersonIsCarriedByHeadAndEyeShapes', () => {
    const rig = trackRig({ x: 0.7, y: 0.3 });
    rig.run(4);
    let maxP = 0;
    rig.run(3, (r) => {
      const l = r.tracking.debugPupilL, rr = r.tracking.debugPupilR;
      maxP = Math.max(maxP, Math.abs(l.x), Math.abs(l.y), Math.abs(rr.x), Math.abs(rr.y));
    });
    expect(maxP, `pupils ${maxP}`).toBeLessThanOrEqual(0.15 + 1e-5);
    expect(rig.tracking.debugPupilL.x, 'pupils still lean toward the person').toBeGreaterThan(0.1);
    expect(rig.headX, `head ${rig.headX}`).toBeGreaterThan(1.8);
    expect(rig.leftEyeX, `eye shape ${rig.leftEyeX}`).toBeGreaterThan(1.2);
    expect(Math.abs(rig.tracking.debugContactWeight - 1)).toBeLessThan(1e-3);
  });

  test('glancesUseFullPupilGain', () => {
    const rig = trackRig({ x: 0, y: 0 });
    rig.run(3);
    rig.send(FaceCommand.glance({ x: 0.6, y: 0 }, 1.5));
    rig.run(0.8);
    expect(rig.s.gazeTarget.contact).toBe(false);
    expect(rig.tracking.debugPupilL.x, `${rig.tracking.debugPupilL.x}`).toBeGreaterThan(0.5);
    expect(rig.tracking.debugContactWeight).toBeLessThan(0.01);
    rig.run(2);
    expect(Math.abs(rig.leftPupil.x), 'back to contact').toBeLessThan(0.06);
  });

  test('gainSwitchingNeverJumps', () => {
    // Gaze held still off-axis; only the contact flag toggles, so any pupil motion is the gain blend.
    const rig = new GazeRig({ seed: 4, micro: false });
    rig.attention.isEnabled = false;
    rig.s.gazeTarget = makeGazeTarget({ x: 0.6, y: -0.4 }, 'smooth');
    rig.run(2);
    let prev = rig.leftPupil;
    let maxStep = 0, minX = 1, maxX = 0;
    for (let i = 0; i < 120 * 6; i++) {
      if (i % 90 === 0) rig.s.gazeTarget.contact = !rig.s.gazeTarget.contact;
      rig.step(1 / 120);
      const p = rig.leftPupil;
      maxStep = Math.max(maxStep, len2(sub(p, prev)));
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      prev = p;
    }
    expect(maxStep, `per-frame step ${maxStep}`).toBeLessThan(0.05);
    expect(minX < 0.2 && maxX > 0.5, `the blend actually swings: ${minX}…${maxX}`).toBe(true);
  });

  // MARK: Calibration

  test('cameraCorrectionMapping', () => {
    // atan(offset / distance), ±1 ≈ ±35° x, ±25° y.
    const c1 = Attention.cameraCorrection({ x: 0.05, y: -0.11 }, 1);
    expect(Math.abs(c1.x - Math.atan(0.05) * 180 / Math.PI / 35)).toBeLessThan(1e-5);
    expect(Math.abs(c1.y - Math.atan(-0.11) * 180 / Math.PI / 25)).toBeLessThan(1e-5);
    expect(Attention.cameraCorrection({ x: 0, y: 0 }, 1)).toEqual({ x: 0, y: 0 });
    expect(Attention.cameraCorrection({ x: NaN, y: 0 }, 1)).toEqual({ x: 0, y: 0 });
    expect(Number.isFinite(Attention.cameraCorrection({ x: 0, y: 0.1 }, NaN).y)).toBe(true);
  });

  test('calibrationShiftsTrackedGazeByTheExpectedAngle', () => {
    const aim = (offset: V2, distance: number): V2 => {
      const rig = trackRig({ x: 0.1, y: 0.05 }, distance, 21);
      rig.s.cameraOffsetMetres = offset;
      rig.run(3);
      return { ...rig.s.gazeTarget.point };
    };
    const offset: V2 = { x: 0.04, y: -0.11 };
    for (const d of [0.7, 2.0]) {
      const shift = sub(aim(offset, d), aim({ x: 0, y: 0 }, d));
      const expected = { x: Math.atan(offset.x / d) * 180 / Math.PI / 35, y: Math.atan(offset.y / d) * 180 / Math.PI / 25 };
      expect(len2(sub(shift, expected)), `d ${d}: ${JSON.stringify(shift)} vs ${JSON.stringify(expected)}`).toBeLessThan(0.004);
    }
  });

  // MARK: Convergence (M7)

  test('convergenceIsCappedAndStartsBelowPointEightMetres', () => {
    const inward = (d: number): number => {
      const rig = trackRig({ x: 0, y: 0 }, d);
      rig.run(3);
      return (rig.leftPupil.x - rig.rightPupil.x) / 2;
    };
    const values = [0.2, 0.3, 0.4, 0.6, 0.8, 1.2].map(inward);
    expect(values[0] <= 0.1 + 0.006 && values[1] <= 0.1 + 0.006, `${values}`).toBe(true);
    expect(values[2]).toBeGreaterThan(0.09);
    expect(Math.abs(values[4]) < 0.01 && Math.abs(values[5]) < 0.01).toBe(true);
    expect(values[3] > values[4] && values[2] > values[3]).toBe(true);
  });

  // MARK: Pupils-only overrides (side-eye)

  test('pupilsOnlyMovesPupilsWithoutHead', () => {
    const rig = settledRig();
    rig.override = makeGazeOverride({ x: 0.75, y: 0 }, 'smooth', true);
    rig.run(1.5);
    expect(rig.leftPupil.x, `${rig.leftPupil.x}`).toBeGreaterThan(0.8);
    expect(Math.abs(rig.headX), `head ${rig.headX}`).toBeLessThan(0.05);
    expect(Math.abs(rig.leftEyeX), `eye shape ${rig.leftEyeX}`).toBeLessThan(0.05);
    expect(Math.abs(rig.s.delta.face('angle'))).toBeLessThan(0.1);
    // Released to a normal target, the head follows again.
    rig.override = makeGazeOverride({ x: 0.5, y: 0 }, 'saccade');
    rig.run(1.5);
    expect(Math.abs(rig.headX - 1.5)).toBeLessThan(0.05);
    expect(Math.abs(rig.tracking.debugPupilL.x - 0.5)).toBeLessThan(0.02);
  });

  test('sideEyeOneShotIsPupilsOnly', () => {
    const o = OneShotLibrary.sample('sideEye', 0.8, new OneShotParams());
    expect(o.gaze?.pupilsOnly).toBe(true);
  });

  // MARK: Conjugate gaze (M5)

  test('curiosityScalingDoesNotMisalignPupils', () => {
    const rig = settledRig(3, { x: 0.7, y: 0 });
    // Pupil canvas offset ∝ eye scale · normalised x: both eyes land on the same canvas offset.
    const l = rig.leftPupil.x * rig.s.eyeScaleMul.x, r = rig.rightPupil.x * rig.s.eyeScaleMul.z;
    expect(Math.abs(l - r), `${l} vs ${r}`).toBeLessThan(1e-4);
    expect(rig.s.eyeScaleMul.z).toBeGreaterThan(rig.s.eyeScaleMul.x);
  });

  test('lidFollowUsesPupilYAndRaisesMore', () => {
    const rig = settledRig(3, { x: 0, y: -0.6 });
    // lidUp 0.15 × gaze-driven pupil y.
    expect(Math.abs(rig.s.lidCoverage.x - (-0.15 * 0.6)), `${rig.s.lidCoverage.x}`).toBeLessThan(0.01);
    // With eye contact the pupils barely move, so the lids barely follow.
    const c = trackRig({ x: 0, y: -0.6 });
    c.run(3);
    expect(Math.abs(c.s.lidCoverage.x)).toBeLessThan(0.03);
  });

  // MARK: Frame-rate equivalence with contact switching

  test('pupilsMatchAt60And120Fps', () => {
    const run = (fps: number): number[][] => {
      const rig = new GazeRig({ seed: 77 });
      rig.intent = { kind: 'track' };
      rig.setPeople([makePersonTarget(1, { x: 0.5, y: 0.1 }, 0.6)], 1);
      const per = Math.trunc(fps / 60);
      const out: number[][] = [];
      const frames = Math.trunc(10 * fps);
      let sent = false;
      for (let i = 0; i < frames; i++) {
        // Queue the glance for the frame at exactly 4 s at both rates.
        if (!sent && (i + 1) / fps >= 4 - 1e-6) {
          rig.send(FaceCommand.glance({ x: -0.6, y: 0.2 }, 0.8)); sent = true;
        }
        rig.step(1 / fps);
        if ((i + 1) % per === 0) { const l = rig.leftPupil, r = rig.rightPupil; out.push([l.x, l.y, r.x, r.y]); }
      }
      return out;
    };
    const a = run(60), b = run(120);
    expect(a.length).toBe(b.length);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) for (let k = 0; k < 4; k++) maxDiff = Math.max(maxDiff, Math.abs(a[i][k] - b[i][k]));
    expect(maxDiff, `max pupil diff ${maxDiff}`).toBeLessThan(2e-3);
  });
});
