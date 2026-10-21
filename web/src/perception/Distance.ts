// Port of FacePerception/Distance.swift.
import { bodyJoint, clamp, vlength2 } from './PerceptionTypes';
import type { BodyDetection, CameraIntrinsics, DistanceSource, FaceDetection } from './PerceptionTypes';

/// Distance from apparent size: `d = f_px · W / w_px`.
export const DistanceEstimator = {
  interpupillaryMetres: 0.063,
  faceWidthMetres: 0.145,
  shoulderWidthMetres: 0.40,
  /// Neck → hip-centre length of an adult torso (population constant for the torso cue).
  torsoLengthMetres: 0.52,
  /// Typical width of an upper-body human rectangle.
  upperBodyWidthMetres: 0.55,
  priorMetres: 1.5,

  /// Best available single measurement for a face and / or body (a new track's first estimate; tracked people fuse
  /// every cue through `DistanceFusion`).
  measure(face: FaceDetection | null, body: BodyDetection | null, k: CameraIntrinsics): { distance: number; source: DistanceSource } {
    const E = DistanceEstimator;
    const fx = Math.max(k.focal.x, 1);
    if (face !== null) {
      const ipd = face.interocularPx;
      if (ipd !== null && ipd > 2) {
        const yaw = face.headPose?.yaw ?? 0;
        const trueIpd = ipd / Math.max(Math.cos(yaw), 0.5);
        return { distance: E.sane(fx * E.interpupillaryMetres / trueIpd), source: 'ipd' };
      }
      const w = face.box.w * k.imageSize.x;
      if (w > 4) return { distance: E.sane(fx * E.faceWidthMetres / w), source: 'faceWidth' };
    }
    if (body !== null) {
      const l = bodyJoint(body, 'leftShoulder'), r = bodyJoint(body, 'rightShoulder');
      if (l !== null && r !== null) {
        const w = vlength2({ x: (l.x - r.x) * k.imageSize.x, y: (l.y - r.y) * k.imageSize.y });
        if (w > 4) return { distance: E.sane(fx * E.shoulderWidthMetres / w), source: 'shoulders' };
      }
      const w = body.box.w * k.imageSize.x;
      if (w > 4) return { distance: E.sane(fx * E.upperBodyWidthMetres / w), source: 'bodyBox' };
    }
    return { distance: E.priorMetres, source: 'prior' };
  },

  sane: (d: number): number => Number.isFinite(d) ? clamp(d, 0.2, 8) : DistanceEstimator.priorMetres,
};

/// Constant-velocity Kalman filter on one axis (position + velocity).
export class KalmanCV {
  /// Position, velocity.
  x: number;
  v = 0;
  p00: number; p01 = 0; p11: number;
  /// Process noise (acceleration spectral density) and measurement noise (variance).
  q: number;
  r: number;

  constructor(x0: number, q: number, r: number, initialVariance = 1, initialVelocityVariance = 1) {
    this.x = x0; this.q = q; this.r = r; this.p00 = initialVariance; this.p11 = initialVelocityVariance;
  }

  copy(): KalmanCV {
    const k = new KalmanCV(this.x, this.q, this.r, this.p00, this.p11);
    k.v = this.v; k.p01 = this.p01;
    return k;
  }

  predict(rawDt: number): void {
    const dt = Math.max(rawDt, 0);
    if (!(dt > 0)) return;
    this.x += this.v * dt;
    const dt2 = dt * dt, dt3 = dt2 * dt;
    const n00 = this.p00 + dt * (2 * this.p01 + dt * this.p11) + this.q * dt3 / 3;
    const n01 = this.p01 + dt * this.p11 + this.q * dt2 / 2;
    const n11 = this.p11 + this.q * dt;
    this.p00 = n00; this.p01 = n01; this.p11 = n11;
  }

  update(z: number): void {
    if (!Number.isFinite(z)) return;
    const s = this.p00 + this.r;
    const k0 = this.p00 / s, k1 = this.p01 / s;
    const y = z - this.x;
    this.x += k0 * y;
    this.v += k1 * y;
    const n00 = (1 - k0) * this.p00, n01 = (1 - k0) * this.p01, n11 = this.p11 - k1 * this.p01;
    this.p00 = n00; this.p01 = n01; this.p11 = n11;
    if (!(Number.isFinite(this.x) && Number.isFinite(this.v))) { this.x = z; this.v = 0; this.p00 = this.r; this.p01 = 0; this.p11 = 1; }
  }
}
