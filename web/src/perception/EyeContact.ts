// Port of FacePerception/EyeContact.swift.
import type { V2, V3 } from '../core/vec';
import type { CameraGeometry } from './CameraGeometry';
import {
  GazeSource, clamp, degToRad, radToDeg, smoothstep, vdot3, vlength3, vnormalize3,
} from './PerceptionTypes';
import type { EyeGazeSource, FaceDetection, HeadPose } from './PerceptionTypes';

/// How the detector's head angles relate to the camera.
/// - `composed`: relative to the line from the face to the camera, so the world direction is `R_ray(face) · R_head`.
/// - `cameraRelative`: relative to the camera's optical axis.
/// Checked on the device (the 3-position check); `composed` is the default.
export type HeadPoseFrame = 'composed' | 'cameraRelative';
export const HeadPoseFrame = { allCases: ['composed', 'cameraRelative'] as readonly HeadPoseFrame[] } as const;

/// Eye-contact tunables (from `PerceptionSettings`).
export interface EyeContactParams {
  /// Half the drawn face width in metres (≈ 0.08 on an 11-inch iPad).
  faceRadius: number;
  /// Estimator spread (degrees): eyes, head-pose fallback.
  sigmaEyesDegrees: number;
  sigmaHeadDegrees: number;
  /// Eye-in-head gain for the Vision pupil offset (degrees per unit offset), horizontal / vertical.
  visionEyeGainDegrees: V2;
  /// Eye readability ramp on the eye contour width in pixels.
  eyeWidthLoPx: number;
  eyeWidthHiPx: number;
  /// Landmark confidence below this → head-pose fallback.
  minLandmarkConfidence: number;
  /// Calibrated estimator bias (radians, yaw / pitch), subtracted from the estimated gaze.
  bias: V2;
  frame: HeadPoseFrame;
  /// Sign corrections applied to the detector's yaw / pitch.
  yawSign: number;
  pitchSign: number;
  /// Facing ramp (degrees between the head direction and the drawn eyes).
  facingFullDegrees: number;
  facingZeroDegrees: number;
}
export const makeEyeContactParams = (o: Partial<EyeContactParams> = {}): EyeContactParams => ({
  faceRadius: 0.08, sigmaEyesDegrees: 8, sigmaHeadDegrees: 12, visionEyeGainDegrees: { x: 35, y: 25 },
  eyeWidthLoPx: 10, eyeWidthHiPx: 22, minLandmarkConfidence: 0.5, bias: { x: 0, y: 0 }, frame: 'composed',
  yawSign: 1, pitchSign: 1, facingFullDegrees: 15, facingZeroDegrees: 40, ...o,
});

/// One face's eye-contact reading.
export interface EyeContactReading {
  /// Angle between the estimated gaze and the direction to the drawn eyes (degrees, bias removed).
  thetaDegrees: number;
  /// Tolerance at this distance (degrees).
  thetaMaxDegrees: number;
  /// Unsmoothed eye-contact level 0…1.
  level: number;
  /// 0…1 head turned toward the drawn eyes.
  facing: number;
  /// Angle between the head direction and the direction to the camera (degrees): face-quality gate.
  headToCameraDegrees: number;
  source: GazeSource;
  /// Estimated gaze and required direction (camera space, unit).
  gaze: V3;
  required: V3;
}

// MARK: - 3×3 matrices (simd_float3x3 stand-in): row-major [r0c0, r0c1, r0c2, r1c0, …].

export type M3 = number[];
export const m3rows = (a: V3, b: V3, c: V3): M3 => [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z];
export function m3mul(a: M3, b: M3): M3 {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o;
}
export const m3mulv = (m: M3, v: V3): V3 => ({
  x: m[0] * v.x + m[1] * v.y + m[2] * v.z, y: m[3] * v.x + m[4] * v.y + m[5] * v.z, z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
});
export const m3transpose = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

const FORWARD: V3 = { x: 0, y: 0, z: -1 };
const neg3 = (v: V3): V3 => ({ x: -v.x, y: -v.y, z: -v.z });

/// Pure eye-contact geometry. Camera space: x right, y down, z toward the room; "forward" for a face is −z.
export const EyeContact = {
  /// Unit direction for yaw (toward +x) and pitch (toward +y, down), starting from −z.
  direction: (yaw: number, pitch: number): V3 =>
    ({ x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) }),

  /// Inverse of `direction` (yaw, pitch).
  angles(d: V3): V2 {
    const n = vnormalize3(d);
    return { x: Math.atan2(n.x, -n.z), y: Math.asin(clamp(n.y, -1, 1)) };
  },

  rx(a: number): M3 {
    const c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, c, -s, 0, s, c];
  },
  ry(a: number): M3 {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, 0, -s, 0, 1, 0, s, 0, c];
  },
  rz(a: number): M3 {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, -s, 0, s, c, 0, 0, 0, 1];
  },

  /// Head rotation (yaw, then pitch, then roll about the facing axis): `R · (0,0,−1)` is the facing direction.
  rotation: (p: HeadPose): M3 => m3mul(m3mul(EyeContact.ry(p.yaw), EyeContact.rx(p.pitch)), EyeContact.rz(p.roll)),

  /// The rotation taking "looking along −z" to "looking from `head` into the lens".
  rayFrame(head: V3): M3 {
    const a = EyeContact.angles(vnormalize3(neg3(head)));
    return m3mul(EyeContact.ry(a.x), EyeContact.rx(a.y));
  },

  /// Angle between two directions (degrees).
  angleDegrees: (a: V3, b: V3): number =>
    Math.acos(clamp(vdot3(vnormalize3(a), vnormalize3(b)), -1, 1)) * radToDeg,

  /// Head pose with the sign corrections applied.
  corrected: (p: HeadPose, k: EyeContactParams): HeadPose =>
    ({ yaw: p.yaw * k.yawSign, pitch: p.pitch * k.pitchSign, roll: p.roll }),

  /// World (camera-space) head rotation for a pose reported in `frame`, for a head at `head`.
  worldHeadRotation: (pose: HeadPose, head: V3, frame: HeadPoseFrame): M3 =>
    frame === 'composed' ? m3mul(EyeContact.rayFrame(head), EyeContact.rotation(pose)) : EyeContact.rotation(pose),

  /// Tolerance θ_max(d) = atan(r_face / d) + σ (degrees).
  tolerance: (distance: number, faceRadius: number, sigmaDegrees: number): number =>
    Math.atan(faceRadius / Math.max(distance, 0.1)) * radToDeg + sigmaDegrees,

  /// Eye-contact level from θ and θ_max: 1 below 0.8·θ_max, 0 above 1.3·θ_max, smooth between.
  level: (theta: number, thetaMax: number): number => 1 - smoothstep(0.8 * thetaMax, 1.3 * thetaMax, theta),

  /// The eye-in-head estimate for a face (external estimator first, then the Vision pupil offset), with its
  /// readability weight; null → head-pose fallback.
  eyeEstimate(f: FaceDetection, k: EyeContactParams): { yaw: number; pitch: number; weight: number; source: EyeGazeSource } | null {
    const g = f.gaze;
    if (g !== null && g.confidence >= k.minLandmarkConfidence) return { yaw: g.yaw, pitch: g.pitch, weight: 1, source: g.source };
    const e = f.eyes;
    if (e === null || !(e.confidence >= k.minLandmarkConfidence)) return null;
    const w = smoothstep(k.eyeWidthLoPx, k.eyeWidthHiPx, e.eyeWidthPx);
    if (!(w > 0.01)) return null;
    return {
      yaw: clamp(e.pupilOffset.x, -1, 1) * k.visionEyeGainDegrees.x * degToRad,
      pitch: clamp(e.pupilOffset.y, -1, 1) * k.visionEyeGainDegrees.y * degToRad,
      weight: w, source: 'vision',
    };
  },

  /// Full reading for a face whose head centre is at `head` (camera space).
  evaluate(f: FaceDetection, head: V3, geometry: CameraGeometry, k: EyeContactParams): EyeContactReading | null {
    if (f.headPose === null) return null;
    const pose = EyeContact.corrected(f.headPose, k);
    const rHead = EyeContact.worldHeadRotation(pose, head, k.frame);
    const headDir = m3mulv(rHead, FORWARD);
    const t = geometry.faceTarget;
    const required = vnormalize3({ x: t.x - head.x, y: t.y - head.y, z: t.z - head.z });
    const distance = vlength3(head);

    let gaze = headDir;
    let source = GazeSource.headPose;
    let sigma = k.sigmaHeadDegrees;
    const eye = EyeContact.eyeEstimate(f, k);
    if (eye !== null) {
      gaze = m3mulv(rHead, EyeContact.direction(eye.yaw * eye.weight, eye.pitch * eye.weight));
      source = GazeSource.eyes(eye.source);
      sigma = k.sigmaEyesDegrees + (1 - eye.weight) * (k.sigmaHeadDegrees - k.sigmaEyesDegrees);
    }
    // Remove the calibrated bias in angle space.
    const ga = EyeContact.angles(gaze);
    gaze = EyeContact.direction(ga.x - k.bias.x, ga.y - k.bias.y);

    const theta = EyeContact.angleDegrees(gaze, required);
    const thetaMax = EyeContact.tolerance(distance, k.faceRadius, sigma);
    const headTheta = EyeContact.angleDegrees(headDir, required);
    const facing = 1 - smoothstep(k.facingFullDegrees, k.facingZeroDegrees, headTheta);
    return {
      thetaDegrees: theta, thetaMaxDegrees: thetaMax, level: EyeContact.level(theta, thetaMax), facing,
      headToCameraDegrees: EyeContact.angleDegrees(headDir, neg3(head)), source, gaze, required,
    };
  },
} as const;

/// Asymmetric first-order smoother (rise and fall time constants).
export class AsymmetricSmoother {
  value = 0;
  constructor(public riseTau = 0.12, public fallTau = 0.25) {}
  copy(): AsymmetricSmoother { const s = new AsymmetricSmoother(this.riseTau, this.fallTau); s.value = this.value; return s; }
  step(target: number, dt: number): number {
    const tau = target > this.value ? this.riseTau : this.fallTau;
    const a = 1 - Math.exp(-Math.max(dt, 0) / Math.max(tau, 1e-4));
    this.value += (target - this.value) * a;
    return this.value;
  }
}

// MARK: - Calibration maths

export interface BiasSample { gaze: V3; required: V3 }
export interface BiasResult {
  /// Radians (yaw, pitch).
  bias: V2;
  /// RMS angular error (degrees) after removing the bias.
  residualDegrees: number;
  samples: number;
}

/// Solves the constant estimator bias (yaw, pitch) from samples taken while the person looks at the drawn eyes.
/// The camera offset itself comes from the table or the manual override, never from this solve.
export const BiasSolver = {
  /// Median per-axis angle difference (robust to blinks and glances), with the RMS residual.
  solve(samples: readonly BiasSample[]): BiasResult | null {
    if (samples.length < 5) return null;
    const dy: number[] = [], dp: number[] = [];
    for (const s of samples) {
      const g = EyeContact.angles(s.gaze), r = EyeContact.angles(s.required);
      dy.push(g.x - r.x); dp.push(g.y - r.y);
    }
    const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const bias = { x: median(dy), y: median(dp) };
    let sq = 0;
    for (const s of samples) {
      const a = EyeContact.angles(s.gaze);
      const e = EyeContact.angleDegrees(EyeContact.direction(a.x - bias.x, a.y - bias.y), s.required);
      sq += e * e;
    }
    return { bias, residualDegrees: Math.sqrt(sq / samples.length), samples: samples.length };
  },
} as const;

export interface HeadPoseFrameCheckSample { head: V3; pose: HeadPose }
export interface HeadPoseFrameCheckCandidate {
  frame: HeadPoseFrame;
  yawSign: number;
  pitchSign: number;
  /// Mean angle (degrees) between the head direction and the direction to the lens.
  meanErrorDegrees: number;
}
export interface HeadPoseFrameCheckResult {
  /// The best candidate, or null when the check is inconclusive (keep the default: composed, signs +1).
  recommended: HeadPoseFrameCheckCandidate | null;
  candidates: HeadPoseFrameCheckCandidate[];
  /// Whether the samples spread wide enough across the view (≥ 50° between the outer positions).
  spreadOK: boolean;
}

/// The on-device head-pose frame check: the person stands at about −40°, 0°, +40° across the view and looks **into
/// the lens**. Under the right frame and signs the head direction points at the camera at every position.
export const HeadPoseFrameCheck = {
  /// Accept a candidate when its mean error is ≤ `maxError` and it beats the runner-up by ≥ `margin` degrees.
  evaluate(samples: readonly HeadPoseFrameCheckSample[], maxError = 12, margin = 5): HeadPoseFrameCheckResult {
    const yaws = samples.map((s) => Math.atan2(s.head.x, s.head.z) * radToDeg);
    const spreadOK = (yaws.length ? Math.max(...yaws) : 0) - (yaws.length ? Math.min(...yaws) : 0) >= 50;
    const cands: HeadPoseFrameCheckCandidate[] = [];
    for (const frame of HeadPoseFrame.allCases) {
      for (const ys of [1, -1]) {
        for (const ps of [1, -1]) {
          let sum = 0;
          for (const s of samples) {
            const pose = { yaw: s.pose.yaw * ys, pitch: s.pose.pitch * ps, roll: s.pose.roll };
            const r = EyeContact.worldHeadRotation(pose, s.head, frame);
            sum += EyeContact.angleDegrees(m3mulv(r, FORWARD), neg3(s.head));
          }
          cands.push({ frame, yawSign: ys, pitchSign: ps, meanErrorDegrees: samples.length === 0 ? Infinity : sum / samples.length });
        }
      }
    }
    cands.sort((a, b) => a.meanErrorDegrees - b.meanErrorDegrees);
    const err = (f: HeadPoseFrame, ys: number, ps: number): number =>
      cands.find((c) => c.frame === f && c.yawSign === ys && c.pitchSign === ps)?.meanErrorDegrees ?? Infinity;
    const bestError = (f: HeadPoseFrame): number => cands.find((c) => c.frame === f)?.meanErrorDegrees ?? Infinity;
    let rec: HeadPoseFrameCheckCandidate | null = null;
    const composed = bestError('composed'), relative = bestError('cameraRelative');
    const frame: HeadPoseFrame = composed <= relative ? 'composed' : 'cameraRelative';
    const winner = Math.min(composed, relative), loser = Math.max(composed, relative);
    if (spreadOK && winner <= maxError && loser - winner >= margin) {
      // A sign flip only when observably better (a looking-into-the-lens pose near 0 says nothing about the sign).
      const ys = err(frame, -1, 1) + margin <= err(frame, 1, 1) ? -1 : 1;
      const ps = err(frame, ys, -1) + margin <= err(frame, ys, 1) ? -1 : 1;
      rec = { frame, yawSign: ys, pitchSign: ps, meanErrorDegrees: err(frame, ys, ps) };
    }
    return { recommended: rec, candidates: cands, spreadOK };
  },
} as const;
