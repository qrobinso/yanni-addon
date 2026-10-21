// Port of Tests/FacePerceptionTests/GeometryTests.swift: synthetic, exact eye-contact geometry.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import type { V2, V3 } from '../../src/core/vec';
import { Attention } from '../../src/engine/modifiers/Attention';
import { CameraGeometry, CameraOffsetTable } from '../../src/perception/CameraGeometry';
import { DistanceEstimator } from '../../src/perception/Distance';
import {
  AsymmetricSmoother, BiasSolver, EyeContact, HeadPoseFrame, m3mul, m3mulv, m3transpose, makeEyeContactParams,
} from '../../src/perception/EyeContact';
import { HeadPoseFrameCheck } from '../../src/perception/EyeContact';
import type { BiasSample, EyeContactParams, EyeContactReading, HeadPoseFrameCheckSample } from '../../src/perception/EyeContact';
import {
  CameraIntrinsics, GazeSource, NRect, makeEyeObservation, makeFaceDetection, makeHeadPose, vlength2, vlength3,
  vnormalize3,
} from '../../src/perception/PerceptionTypes';
import type { HeadPose } from '../../src/perception/PerceptionTypes';
import { approx } from './TestSupport';

const geo = new CameraGeometry(CameraIntrinsics.typicalLandscape, { x: 0, y: -0.11 });
const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const neg3 = (a: V3): V3 => ({ x: -a.x, y: -a.y, z: -a.z });
const eqV2 = (a: V2, b: V2): boolean => a.x === b.x && a.y === b.y;   // -0 == 0, like Swift

/// The pose (in `frame`) for a head at `head` whose gaze is `g` (head only, eyes centred).
function pose(head: V3, g: V3, frame: HeadPoseFrame): HeadPose {
  const local = frame === 'composed'
    ? EyeContact.angles(m3mulv(m3transpose(EyeContact.rayFrame(head)), g))
    : EyeContact.angles(g);
  return makeHeadPose(local.x, local.y);
}

function reading(head: V3, target: V3, frame: HeadPoseFrame = 'composed', g: CameraGeometry = geo,
  params: EyeContactParams = makeEyeContactParams()): EyeContactReading {
  const dir = vnormalize3(sub3(target, head));
  const f = makeFaceDetection(NRect.make(0.4, 0.4, 0.1, 0.1), { headPose: pose(head, dir, frame) });
  return EyeContact.evaluate(f, head, g, { ...params, frame })!;
}

describe('GeometryTests', () => {
  test('lookingAtTheDrawnEyesGivesZero', () => {
    for (const offset of [{ x: 0, y: -0.11 }, { x: -0.087, y: 0 }, { x: 0.096, y: 0 }, { x: 0, y: 0 }]) {
      const g = new CameraGeometry(undefined, offset);
      for (const [x, y, z] of [[0, 0, 1], [0.6, 0.1, 1.2], [-0.9, -0.2, 2], [0.3, 0.4, 0.7]]) {
        for (const frame of HeadPoseFrame.allCases) {
          const r = reading({ x, y, z }, g.faceTarget, frame, g);
          expect(r.thetaDegrees, `θ at ${x},${y},${z} ${frame}`).toBeLessThan(0.05);
          expect(r.level).toBe(1);
          expect(r.facing).toBeGreaterThan(0.99);
        }
      }
    }
  });

  test('lookingAtTheLensIsOffByTheOffsetAngle', () => {
    // A person on the axis through the face centre, looking into the lens 0.11 m above it.
    let last = Infinity;
    for (const d of [0.5, 1, 1.5, 2, 3]) {
      const r = reading({ x: 0, y: 0.11, z: d }, { x: 0, y: 0, z: 0 });
      const expected = Math.atan(0.11 / d) * 180 / Math.PI;
      expect(Math.abs(r.thetaDegrees - expected), `d ${d}`).toBeLessThan(0.05);
      expect(r.thetaDegrees, 'shrinks with distance').toBeLessThan(last);
      last = r.thetaDegrees;
    }
  });

  test('wrongFrameIsWrongOffAxis', () => {
    const a = 40 * Math.PI / 180;
    const head = { x: Math.sin(a) * 1.2, y: 0, z: Math.cos(a) * 1.2 };
    const g = vnormalize3(sub3(geo.faceTarget, head));
    const f = makeFaceDetection(NRect.make(0.7, 0.4, 0.1, 0.1), { headPose: pose(head, g, 'composed') });
    const r = EyeContact.evaluate(f, head, geo, makeEyeContactParams({ frame: 'cameraRelative' }))!;
    expect(r.thetaDegrees).toBeGreaterThan(30);
    expect(r.level).toBe(0);
  });

  test('eyeOffsetsCarryTheResidual', () => {
    // Head turned 70 % of the way, the Vision pupil offset carries the rest: θ ≈ 0.
    const head = { x: 0.5, y: 0.05, z: 1.1 };
    const g = vnormalize3(sub3(geo.faceTarget, head));
    const rRay = EyeContact.rayFrame(head);
    const local = EyeContact.angles(m3mulv(m3transpose(rRay), g));
    const p = makeHeadPose(local.x * 0.7, local.y * 0.7);
    const eye = EyeContact.angles(m3mulv(m3transpose(m3mul(rRay, EyeContact.rotation(p))), g));
    const gain = makeEyeContactParams().visionEyeGainDegrees;
    const gx = gain.x * Math.PI / 180, gy = gain.y * Math.PI / 180;
    const f = makeFaceDetection(NRect.make(0.6, 0.4, 0.1, 0.1), {
      headPose: p, eyes: makeEyeObservation({ x: eye.x / gx, y: eye.y / gy }, 30, 0.9),
    });
    const r = EyeContact.evaluate(f, head, geo, makeEyeContactParams())!;
    expect(r.thetaDegrees).toBeLessThan(0.1);
    expect(GazeSource.equals(r.source, GazeSource.eyes('vision'))).toBe(true);
    // Without readable eyes it falls back to the head and sees the residual.
    const small = { ...f, eyes: { ...f.eyes!, eyeWidthPx: 6 } };
    const h = EyeContact.evaluate(small, head, geo, makeEyeContactParams())!;
    expect(h.source.kind).toBe('headPose');
    expect(h.thetaDegrees).toBeGreaterThan(1);
  });

  test('toleranceAndLevel', () => {
    const t = EyeContact.tolerance(1, 0.08, 8);
    expect(Math.abs(t - 12.57), `≈ 12.6° at 1 m with eyes (${t})`).toBeLessThan(0.05);
    expect(EyeContact.tolerance(2, 0.08, 8)).toBeLessThan(t);
    expect(EyeContact.level(0.79 * t, t)).toBe(1);
    expect(EyeContact.level(1.31 * t, t)).toBe(0);
    const mid = EyeContact.level(1.05 * t, t);
    expect(mid > 0.4 && mid < 0.6).toBe(true);
  });

  test('biasRemoved', () => {
    const k = makeEyeContactParams({ bias: { x: 5 * Math.PI / 180, y: -3 * Math.PI / 180 } });
    // An estimator that reads 5° right and 3° up of the truth.
    const head = { x: 0.2, y: 0, z: 1.2 };
    const g = vnormalize3(sub3(geo.faceTarget, head));
    const a = EyeContact.angles(g);
    const biased = EyeContact.direction(a.x + k.bias.x, a.y + k.bias.y);
    const local = EyeContact.angles(m3mulv(m3transpose(EyeContact.rayFrame(head)), biased));
    const f = makeFaceDetection(NRect.make(0.5, 0.4, 0.1, 0.1), { headPose: makeHeadPose(local.x, local.y) });
    const r = EyeContact.evaluate(f, head, geo, k)!;
    expect(r.thetaDegrees).toBeLessThan(0.1);
  });

  test('smoothingTimeConstants', () => {
    const s = new AsymmetricSmoother();
    let t = 0;
    while (s.value < 0.6) { s.step(1, 1 / 30); t += 1 / 30; }
    expect(t > 0.08 && t < 0.15, `reaches the enter level in ≈ 0.11 s (${t})`).toBe(true);
    let down = 0;
    while (s.value > 0.35) { s.step(0, 1 / 30); down += 1 / 30; }
    expect(down > 0.1 && down < 0.25, `falls to the exit level in ≈ 0.14 s (${down})`).toBe(true);
  });

  /// Swift `Float.random(in: lo...hi, using: &rng)`: `next(upperBound: 2^24 + 1)` on the low 32 bits (Lemire), so
  /// the sampled cases are the Swift test's own.
  function floatRandom(rng: SplitMix64, lo: number, hi: number): number {
    const bound = (1n << 24n) + 1n;
    let m = (rng.next() & 0xffffffffn) * bound;
    if ((m & 0xffffffffn) < bound) {
      const t = ((1n << 32n) - bound) % bound;
      while ((m & 0xffffffffn) < t) m = (rng.next() & 0xffffffffn) * bound;
    }
    const rand = m >> 32n;
    if (rand === 1n << 24n) return hi;
    const f = Math.fround;
    return f(f(f(hi - lo) * f(Number(rand) * 2 ** -24)) + lo);
  }

  test.each(Array.from({ length: 20 }, (_, i) => i + 1))('biasSolverRecoversPlantedBias(%i)', (seed) => {
    const rng = new SplitMix64(seed);
    const planted = { x: 4 * Math.PI / 180, y: -2.5 * Math.PI / 180 };
    const samples: BiasSample[] = [];
    for (let i = 0; i < 120; i++) {
      const d = i < 60 ? 1 : 2;
      const head = { x: floatRandom(rng, -0.3, 0.3), y: 0, z: d };
      const req = vnormalize3(sub3(geo.faceTarget, head));
      const a = EyeContact.angles(req);
      let ax = a.x + planted.x, ay = a.y + planted.y;
      ax += floatRandom(rng, -0.02, 0.02); ay += floatRandom(rng, -0.02, 0.02);
      if (i % 17 === 0) ax += 0.4;   // the odd glance away
      samples.push({ gaze: EyeContact.direction(ax, ay), required: req });
    }
    const r = BiasSolver.solve(samples)!;
    expect(r).not.toBeNull();
    expect(Math.abs(r.bias.x - planted.x)).toBeLessThan(0.3 * Math.PI / 180);
    expect(Math.abs(r.bias.y - planted.y)).toBeLessThan(0.3 * Math.PI / 180);
    expect(BiasSolver.solve(samples.slice(0, 3))).toBeNull();
  });

  // MARK: Head-pose frame check

  function checkSamples(frame: HeadPoseFrame, yawSign = 1, spread = 40): HeadPoseFrameCheckSample[] {
    return [-spread, 0, spread].map((deg) => {
      const a = deg * Math.PI / 180;
      const head = { x: Math.sin(a) * 1.2, y: 0.05, z: Math.cos(a) * 1.2 };
      const p = pose(head, vnormalize3(neg3(head)), frame);
      return { head, pose: { yaw: p.yaw * yawSign, pitch: p.pitch + 0.01, roll: p.roll } };
    });
  }

  test('frameCheckRecognisesComposed', () => {
    const r = HeadPoseFrameCheck.evaluate(checkSamples('composed'));
    expect(r.spreadOK).toBe(true);
    expect(r.recommended?.frame).toBe('composed');
    expect(r.recommended?.yawSign).toBe(1);
  });

  test('frameCheckRecognisesCameraRelativeAndSign', () => {
    const r = HeadPoseFrameCheck.evaluate(checkSamples('cameraRelative'));
    expect(r.recommended?.frame).toBe('cameraRelative');
    expect(r.recommended?.yawSign).toBe(1);
    const flipped = HeadPoseFrameCheck.evaluate(checkSamples('cameraRelative', -1));
    expect(flipped.recommended?.frame).toBe('cameraRelative');
    expect(flipped.recommended?.yawSign).toBe(-1);
  });

  test('frameCheckNeedsSpread', () => {
    const r = HeadPoseFrameCheck.evaluate(checkSamples('cameraRelative', 1, 10));
    expect(r.spreadOK).toBe(false);
    expect(r.recommended, 'inconclusive → keep the composed default').toBeNull();
  });

  // MARK: Coordinates

  test('screenCentreRayEndsAtZeroAfterEngineCorrection', () => {
    for (const o of [{ x: 0, y: -0.11 }, { x: -0.087, y: 0 }, { x: 0.05, y: -0.08 }]) {
      for (const d of [0.6, 1.2, 2.5]) {
        const p = { x: -o.x, y: -o.y, z: d };
        const cameraRelative = CameraGeometry.gazePosition(p);
        const c = Attention.cameraCorrection(o, vlength3(p));
        expect(vlength2({ x: cameraRelative.x + c.x, y: cameraRelative.y + c.y }), `offset ${o.x},${o.y} d ${d}`).toBeLessThan(0.01);
        const g = new CameraGeometry(undefined, o);
        expect(vlength2(g.screenRelative(cameraRelative, vlength3(p)))).toBeLessThan(0.01);
      }
    }
  });

  test('gazeSpaceUsesTrueAngles', () => {
    const g = new CameraGeometry(CameraIntrinsics.fromFieldOfView(1920, 1440, 100));
    expect(vlength2(g.gazePosition({ x: 0.5, y: 0.5 }))).toBeLessThan(1e-5);
    // The right image edge is 50° → clamped to 1; a point at 17.5° is 0.5.
    expect(g.gazePosition({ x: 1, y: 0.5 }).x).toBe(1);
    const k = g.intrinsics;
    const u = (k.principal.x + Math.tan(17.5 * Math.PI / 180) * k.focal.x) / k.imageSize.x;
    expect(Math.abs(g.gazePosition({ x: u, y: 0.5 }).x - 0.5)).toBeLessThan(1e-4);
    const v = (k.principal.y + Math.tan(-12.5 * Math.PI / 180) * k.focal.y) / k.imageSize.y;
    expect(Math.abs(g.gazePosition({ x: 0.5, y: v }).y + 0.5)).toBeLessThan(1e-4);
  });

  test('viewerFrameMirrorsVision', () => {
    // Vision: origin lower-left, unmirrored. A face on the camera's left (x 0.2) high up (y 0.8) appears on the
    // viewer's right, near the top.
    const p = CameraGeometry.viewerPoint({ x: 0.2, y: 0.8 }, true);
    expect(approx(p.x, 0.8, 1e-6) && approx(p.y, 0.2, 1e-6)).toBe(true);
    const r = CameraGeometry.viewerRect(0.1, 0.7, 0.2, 0.1, true);
    expect(approx(r.x, 0.7, 1e-6) && approx(r.y, 0.2, 1e-6) && approx(r.w, 0.2, 1e-6)).toBe(true);
    expect(CameraGeometry.viewerPoint({ x: 0.2, y: 0.8 }, false).x).toBe(0.2);
  });

  test('offsetRotatesWithOrientation', () => {
    const mini = { x: 0, y: -0.096 };   // short-edge camera, above the screen in portrait
    expect(eqV2(CameraOffsetTable.offset(mini, 'portrait'), mini)).toBe(true);
    expect(eqV2(CameraOffsetTable.offset(mini, 'portraitUpsideDown'), { x: 0, y: 0.096 })).toBe(true);
    expect(eqV2(CameraOffsetTable.offset(mini, 'landscapeLeft'), { x: 0.096, y: 0 }), 'top edge on the right').toBe(true);
    expect(eqV2(CameraOffsetTable.offset(mini, 'landscapeRight'), { x: -0.096, y: 0 })).toBe(true);
    expect(CameraOffsetTable.entry('iPad16,3')?.edge).toBe('longEdge');
    expect(CameraOffsetTable.entry('iPad99,1')).toBeNull();
    expect(CameraOffsetTable.unknownIPadOffset(0.24).y).toBeLessThan(-0.12);
  });

  test('distanceFromSize', () => {
    const k = CameraIntrinsics.typicalLandscape;
    for (const d of [0.5, 1, 2, 3]) {
      const ipd = k.focal.x * 0.063 * Math.cos(0.3) / d;
      const f = makeFaceDetection(NRect.make(0.4, 0.4, 0.05, 0.06), { headPose: makeHeadPose(0.3, 0), interocularPx: ipd });
      const m = DistanceEstimator.measure(f, null, k);
      expect(m.source).toBe('ipd');
      expect(Math.abs(m.distance - d) / d).toBeLessThan(0.02);
      const w = k.focal.x * 0.145 / d / k.imageSize.x;
      const fw = DistanceEstimator.measure(makeFaceDetection(NRect.make(0.4, 0.4, w, w)), null, k);
      expect(fw.source === 'faceWidth' && Math.abs(fw.distance - d) / d < 0.02).toBe(true);
    }
    expect(DistanceEstimator.measure(null, null, k).source).toBe('prior');
  });
});
