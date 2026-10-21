// Port of FacePerception/DistanceFusion.swift.
import type { V2 } from '../core/vec';
import { DistanceEstimator } from './Distance';
import type { KalmanCV } from './Distance';
import { bodyJoint, clamp, degToRad, vlength2, vlength3 } from './PerceptionTypes';
import type { BodyDetection, CameraIntrinsics, DistanceSource, FaceDetection } from './PerceptionTypes';

/// The raw size cues one observation offers (design §10). Face cues are already ranges (metres to the head); body cues
/// are pixel lengths, turned into ranges with the person's scale in `DistanceFusion.fuse`.
export interface DistanceCues {
  /// Range from the yaw-corrected interpupillary distance (only within the yaw limit).
  ipd: number | null;
  /// Range from the face box width.
  faceWidth: number | null;
  /// Shoulder width, neck → hip-centre length (pitch-corrected) and upper-body box width, in pixels.
  shoulderPx: number | null;
  torsoPx: number | null;
  boxPx: number | null;
  /// Focal length (pixels) and depth → range factor (|ray| through the head) for the body cues.
  focal: number;
  rangeFactor: number;
  /// Face landmark confidence and yaw (radians) for the per-person scale learning.
  faceConfidence: number;
  yaw: number;
}
export const makeDistanceCues = (o: Partial<DistanceCues> = {}): DistanceCues => ({
  ipd: null, faceWidth: null, shoulderPx: null, torsoPx: null, boxPx: null, focal: 1, rangeFactor: 1,
  faceConfidence: 0, yaw: 0, ...o,
});
export const distanceCuesIsEmpty = (c: DistanceCues): boolean =>
  c.ipd === null && c.faceWidth === null && c.shoulderPx === null && c.torsoPx === null && c.boxPx === null;

/// A person's own body dimensions (metres), learned while their IPD gives a confident near distance.
export class PersonScale {
  shoulder = DistanceEstimator.shoulderWidthMetres;
  torso = DistanceEstimator.torsoLengthMetres;
  box = DistanceEstimator.upperBodyWidthMetres;
  shoulderSamples = 0;
  torsoSamples = 0;
  boxSamples = 0;

  copy(): PersonScale { return Object.assign(new PersonScale(), this); }

  /// The width / length used for the cue: learned once there are enough samples, else the population constant.
  get shoulderMetres(): number { return this.shoulderSamples >= DistanceFusion.minSamples ? this.shoulder : DistanceFusion.shoulderMetres; }
  get torsoMetres(): number { return this.torsoSamples >= DistanceFusion.minSamples ? this.torso : DistanceFusion.torsoMetres; }
  get boxMetres(): number { return this.boxSamples >= DistanceFusion.minSamples ? this.box : DistanceFusion.boxMetres; }
}

const sub2 = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });

/// Multi-cue distance fusion: every cue present on a frame is a measurement in the track's 1-D constant-velocity
/// Kalman (process noise 0.3 m/s) with variance (rel · d)²; no single-cue switching.
export const DistanceFusion = {
  // Relative standard deviations.
  ipdRel: 0.08,
  faceWidthRel: 0.12,
  shoulderRel: 0.15,
  torsoRel: 0.15,
  boxRel: 0.25,
  // Population constants (adult).
  shoulderMetres: DistanceEstimator.shoulderWidthMetres,
  torsoMetres: DistanceEstimator.torsoLengthMetres,
  boxMetres: DistanceEstimator.upperBodyWidthMetres,
  /// IPD is used only while the head yaw is within this (the cos correction is unreliable beyond).
  ipdYawLimit: 45 * degToRad,
  /// Scale learning: IPD distance ≤ 1.5 m, yaw ≤ 30°, landmark confidence ≥ 0.6; EMA rate; samples before use.
  learnMaxDistance: 1.5,
  learnYawLimit: 30 * degToRad,
  learnMinConfidence: 0.6,
  learnRate: 0.1,
  minSamples: 5,

  /// The cues of one observation. `head` is the head centre (viewer frame) the body cues' depth is turned into a range
  /// through.
  cues(face: FaceDetection | null, body: BodyDetection | null, head: V2, k: CameraIntrinsics): DistanceCues {
    const c = makeDistanceCues();
    const fx = Math.max(k.focal.x, 1);
    c.focal = fx;
    c.rangeFactor = vlength3({ x: ((head.x * k.imageSize.x) - k.principal.x) / fx,
      y: ((head.y * k.imageSize.y) - k.principal.y) / Math.max(k.focal.y, 1), z: 1 });
    if (face !== null) {
      const yaw = face.headPose?.yaw ?? 0;
      c.yaw = yaw;
      c.faceConfidence = face.confidence;
      const ipd = face.interocularPx;
      if (ipd !== null && ipd > 2 && Math.abs(yaw) <= DistanceFusion.ipdYawLimit) {
        c.ipd = DistanceEstimator.sane(fx * DistanceEstimator.interpupillaryMetres / (ipd / Math.max(Math.cos(yaw), 0.5)));
      }
      const w = face.box.w * k.imageSize.x;
      if (w > 4) c.faceWidth = DistanceEstimator.sane(fx * DistanceEstimator.faceWidthMetres / w);
    }
    if (body !== null) {
      const l = bodyJoint(body, 'leftShoulder'), r = bodyJoint(body, 'rightShoulder');
      if (l !== null && r !== null) {
        const d = sub2(l, r);
        const w = vlength2({ x: d.x * k.imageSize.x, y: d.y * k.imageSize.y });
        if (w > 4) c.shoulderPx = w;
      }
      const n = bodyJoint(body, 'neck'), lh = bodyJoint(body, 'leftHip'), rh = bodyJoint(body, 'rightHip');
      if (n !== null && lh !== null && rh !== null) {
        const pitch = face?.headPose?.pitch ?? 0;
        const d = sub2(n, { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 });
        const len = vlength2({ x: d.x * k.imageSize.x, y: d.y * k.imageSize.y }) / Math.max(Math.cos(pitch), 0.8);
        if (len > 4) c.torsoPx = len;
      }
      const w = body.box.w * k.imageSize.x;
      if (w > 4) c.boxPx = w;
    }
    return c;
  },

  /// Range from a body pixel length and the person's real length.
  range: (px: number, metres: number, c: DistanceCues): number => DistanceEstimator.sane(c.focal * metres / px * c.rangeFactor),

  /// Feeds every present cue into `kf` (already predicted to this frame); returns the most precise cue's source.
  fuse(kf: KalmanCV, c: DistanceCues, scale: PersonScale): DistanceSource | null {
    let best: [DistanceSource, number] | null = null;
    const feed = (d: number | null, rel: number, s: DistanceSource): void => {
      if (d === null || !Number.isFinite(d)) return;
      const ref = Math.max(kf.x, 0.2);
      kf.r = (rel * ref) * (rel * ref);
      kf.update(d);
      if (best === null || rel < best[1]) best = [s, rel];
    };
    const F = DistanceFusion;
    feed(c.ipd, F.ipdRel, 'ipd');
    feed(c.faceWidth, F.faceWidthRel, 'faceWidth');
    feed(c.shoulderPx === null ? null : F.range(c.shoulderPx, scale.shoulderMetres, c), F.shoulderRel, 'shoulders');
    feed(c.torsoPx === null ? null : F.range(c.torsoPx, scale.torsoMetres, c), F.torsoRel, 'torso');
    feed(c.boxPx === null ? null : F.range(c.boxPx, scale.boxMetres, c), F.boxRel, 'bodyBox');
    kf.x = clamp(kf.x, 0.2, 8);
    return (best as [DistanceSource, number] | null)?.[0] ?? null;
  },

  /// Learns the person's own body dimensions from a confident near IPD range (EMA).
  learn(s: PersonScale, c: DistanceCues): void {
    const F = DistanceFusion;
    const d = c.ipd;
    if (d === null || !(d <= F.learnMaxDistance) || !(Math.abs(c.yaw) <= F.learnYawLimit) ||
      !(c.faceConfidence >= F.learnMinConfidence)) return;
    const depth = d / Math.max(c.rangeFactor, 1);
    const ema = (v: 'shoulder' | 'torso' | 'box', n: 'shoulderSamples' | 'torsoSamples' | 'boxSamples', px: number | null): void => {
      if (px === null) return;
      const m = px * depth / c.focal;
      if (!(Number.isFinite(m) && m > 0.05 && m < 1.5)) return;
      s[v] = s[n] === 0 ? m : s[v] + (m - s[v]) * F.learnRate;
      s[n] += 1;
    };
    ema('shoulder', 'shoulderSamples', c.shoulderPx);
    ema('torso', 'torsoSamples', c.torsoPx);
    ema('box', 'boxSamples', c.boxPx);
  },
};
