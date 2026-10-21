// The calibration flow's wiring (Swift CalibrationState + PerceptionModel.apply*): captures fill the solvers from
// live snapshots, finish on time, and their results land in the perception settings. Web: the field of view from the
// pupil distance at a taped mark, and the measured offset's portrait-frame round trip.
import { describe, expect, test } from 'vitest';
import {
  BiasSolver, CalibrationState, CameraIntrinsics, CameraOffsetTable, EyeContact, HeadPoseFrameCheck, InterfaceOrientation,
  NRect, PerceptionSettings, makeFaceDetection, makeFrameDetections, makeHeadPose, makePerceptionSnapshot,
  makeTrackedPerson, degToRad, radToDeg, type TrackedPerson,
} from '../../src/perception';

const snap = (p: Partial<TrackedPerson>) => makePerceptionSnapshot({ people: [makeTrackedPerson(1, p)], primaryID: 1 });

describe('CalibrationTests', () => {
  test('estimator bias: 1 m then 2 m samples solve the bias, already-applied bias undone, and Apply writes it', () => {
    const clock = { t: 0 };
    const cal = new CalibrationState(() => clock.t);
    const settings = new PerceptionSettings({ estimatorBiasDegrees: { x: 1, y: 0 } });
    const required = EyeContact.direction(0.1, -0.05);
    // The estimator reads 3° right / 2° down of the truth; the 1° already applied is undone by the capture.
    const raw = EyeContact.angles(required);
    const gaze = EyeContact.direction(raw.x + (3 - 1) * degToRad, raw.y - 2 * degToRad);
    cal.start({ kind: 'biasNear' }, 3);
    while (cal.capturing.kind !== 'none') { cal.observe(snap({ gazeVector: gaze, requiredVector: required }), settings); clock.t += 0.1; }
    expect(cal.biasNearCount).toBeGreaterThan(20);
    expect(cal.message).toMatch(/samples at 1 m/);
    cal.start({ kind: 'biasFar' }, 3);
    while (cal.capturing.kind !== 'none') { cal.observe(snap({ gazeVector: gaze, requiredVector: required }), settings); clock.t += 0.1; }
    expect(cal.capturing.kind).toBe('none');
    const want = BiasSolver.solve(cal.biasSamples)!;
    expect(cal.biasResult).toEqual(want);
    const s = cal.applied('bias', settings)!;
    expect(s.estimatorBiasDegrees.x).toBeCloseTo(3, 4);
    expect(s.estimatorBiasDegrees.y).toBeCloseTo(-2, 4);
  });

  test('head-pose frame check: three positions run the check and Apply takes its recommendation', () => {
    const clock = { t: 0 };
    const cal = new CalibrationState(() => clock.t);
    const settings = new PerceptionSettings();
    const positions = [{ x: -0.8, y: 0, z: 0.95 }, { x: 0, y: 0, z: 1.2 }, { x: 0.8, y: 0, z: 0.95 }];
    // Looking into the lens from each position: composed frame (Vision's), so the pose relative to the ray is ~0.
    positions.forEach((head, i) => {
      cal.start({ kind: 'frame', index: i }, 2);
      while (cal.capturing.kind !== 'none') { cal.observe(snap({ positionMetres: head, headPose: makeHeadPose(0, 0) }), settings); clock.t += 0.25; }
    });
    expect(cal.frameSamples.size).toBe(3);
    const direct = HeadPoseFrameCheck.evaluate(positions.map((head) => ({ head, pose: makeHeadPose(0, 0) })));
    expect(cal.frameResult).toEqual(direct);
    const applied = cal.applied('frame', settings);
    if (direct.recommended) expect(applied?.headPoseFrame).toBe(direct.recommended.frame);
    else expect(applied).toBeNull();
  });

  test('eye-contact threshold: labelled samples suggest σ at 1 % false positives; precision / recall', () => {
    const clock = { t: 0 };
    const cal = new CalibrationState(() => clock.t);
    const settings = new PerceptionSettings({ faceRadius: 0.08 });
    const atan = Math.atan(0.08 / 1.5) * radToDeg;
    cal.start({ kind: 'notLooking' }, 5);
    for (let i = 0; i < 40; i++, clock.t += 0.1) cal.observe(snap({ distance: 1.5, gazeErrorDegrees: atan + 10 + i }), settings);
    cal.start({ kind: 'looking' }, 5);
    for (let i = 0; i < 30; i++, clock.t += 0.1) cal.observe(snap({ distance: 1.5, gazeErrorDegrees: atan + i * 0.3 }), settings);
    expect(cal.suggestedSigma).toBeCloseTo(10 / 1.05, 4);
    expect(cal.applied('sigma', settings)!.eyeContactSigmaEyes).toBeCloseTo(10 / 1.05, 4);
    const pr = cal.precisionRecall(9)!;   // 1.05 σ = 9.45°: every look (≤ 8.7°) in, every not-look (≥ 10°) out
    expect(pr.recall).toBe(1);
    expect(pr.precision).toBe(1);
  });

  test('field of view: the pupil distance at a taped mark recovers the lens angle (yaw corrected)', () => {
    const fov = 78;
    const k = CameraIntrinsics.fromFieldOfView(1280, 960, fov);
    const ipd = (d: number, yaw = 0) => k.focal.x * 0.063 / d * Math.cos(yaw);
    const det = (d: number, yaw = 0) => makeFrameDetections(0, { intrinsics: k, faces: [
      makeFaceDetection(NRect.make(0.4, 0.3, 0.12, 0.16), { interocularPx: ipd(d, yaw), headPose: makeHeadPose(yaw, 0) })] });
    expect(CalibrationState.fovFrom(det(1.3), 1.3)).toBeCloseTo(fov, 6);
    expect(CalibrationState.fovFrom(det(2, 0.3), 2)).toBeCloseTo(fov, 6);
    expect(CalibrationState.fovFrom(makeFrameDetections(0), 1)).toBeNull();
    const clock = { t: 0 };
    const cal = new CalibrationState(() => clock.t);
    const settings = new PerceptionSettings();
    cal.start({ kind: 'fov', distance: 1.6 }, 3);
    while (cal.capturing.kind !== 'none') { cal.observe(snap({}), settings, det(1.6)); clock.t += 0.1; }
    expect(cal.fovResult).toBeCloseTo(fov, 6);
    expect(cal.applied('fov', settings)!.horizontalFovDegrees).toBeCloseTo(fov, 6);
    // The setting survives the hub's JSON and its validation.
    const back = PerceptionSettings.decode(JSON.parse(JSON.stringify(cal.applied('fov', settings)!.toJSON()))).validated();
    expect(back.horizontalFovDegrees).toBeCloseTo(fov, 6);
    expect(new PerceptionSettings({ horizontalFovDegrees: 500 }).validated().horizontalFovDegrees).toBe(130);
  });

  test('a measured offset (as mounted) stored in the portrait frame rotates back to itself', () => {
    const o = { x: 0.031, y: -0.094 };
    for (const r of InterfaceOrientation.allCases) {
      const back = CameraOffsetTable.offset(CameraOffsetTable.toPortrait(o, r), r);
      expect(back.x).toBeCloseTo(o.x, 12);
      expect(back.y).toBeCloseTo(o.y, 12);
    }
  });
});
