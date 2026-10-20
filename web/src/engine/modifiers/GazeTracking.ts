// Port of FaceEngine/Modifiers/GazeTracking.swift.
import type { V2 } from '../../core/vec';
import { ParamLayout, Units } from '../../model';
import { Ease } from '../Easing';
import type { FaceState } from '../FaceState';
import { GazeLaggedSpring, gazeClamp, gazeLength } from '../GazeSupport';
import { LidMath } from '../LidMath';
import { Phase, type Modifier } from '../Modifier';
import { Spring1, SpringParams } from '../Spring';

const pupilTravel = { x: 4.5, y: 9 };
const eyeTravel = { x: 2, y: 1.5 };
const headTravel = { x: 3, y: 2.2 };
const totalTravel = { x: pupilTravel.x + eyeTravel.x + headTravel.x, y: pupilTravel.y + eyeTravel.y + headTravel.y };

/// Tuning (canvas units unless noted).
export const GazeTrackingK = {
  /// Canvas displacement of a pupil per normalised pupil unit for a default eye.
  pupilTravel,
  /// Eye-shape (sclera centre) travel at |gaze| = 1.
  eyeTravel,
  /// Face-centre travel at |gaze| = 1.
  headTravel,
  /// Total on-screen gaze displacement at |gaze| = 1 (9.5 x, 12.7 y).
  totalTravel,
  /// Head share of the total travel (curiosity uses the overall gaze direction).
  headShare: { x: headTravel.x / totalTravel.x, y: headTravel.y / totalTravel.y },
  /// Gaze-driven pupils ease into ±pupilLimit (soft knee), leaving room for drift and accents.
  pupilLimit: 0.9,
  pupilKnee: 0.15,
  // Eye contact (C1).
  contactGain: 0.25,
  contactCap: 0.15,
  contactKnee: 0.05,
  contactSpring: new SpringParams(20, 1),
  // Pupils-only overrides: how fast the head/eye-shape hold blends in and out.
  pupilsOnlySpring: new SpringParams(14, 1),
  // Saccades.
  saccadeOmegaBase: 70,
  saccadeOmegaAmp: 0.6,
  saccadeZetaSmall: 0.75,
  saccadeZetaBig: 0.6,
  saccadeBigAmp: 1.2,
  /// Arc bow as a fraction of the total canvas path length (carried by the pupils).
  arcGain: 0.08,
  lagRange: [0.025, 0.045] as const,
  headDelay: 0.06,
  retargetEpsilon: 0.005,
  minSaccadeAmp: 0.004,
  blinkAmp: 0.5,
  blinkP: 0.3,
  arcFadeRate: 25,
  // Pursuit.
  pursuitOmega: 9,
  // Head.
  headOmega: 7,
  headZeta: 0.7,
  maxTilt: 4, // degrees
  // Convergence on the pupils (M7): 0 at ≥ 0.8 m, rising smoothly to 0.1 inward at ≤ 0.4 m.
  convergenceMax: 0.1,
  convergenceStart: 0.8,
  convergenceFull: 0.4,
  convergenceSpring: new SpringParams(5, 1),
  // Curiosity.
  curiosityGrow: 0.15,
  curiosityShrink: 0.05,
  // Lid-follow (fraction of remaining opening; negative raises the lid), from gaze-driven pupil y.
  lidUp: 0.15,
  lidDown: 0.12,
  lidSpring: new SpringParams(18, 1),
  // Saccade smear (L2): vertical pupil squash ≤ smearMax at horizontal pupil speed ≥ smearSpeed canvas/s.
  smearMax: 0.08,
  smearSpeed: 150,
} as const;
const K = GazeTrackingK;

const I = {
  lcx: ParamLayout.index('left', 'centerX'), lcy: ParamLayout.index('left', 'centerY'),
  rcx: ParamLayout.index('right', 'centerX'), rcy: ParamLayout.index('right', 'centerY'),
  cx: ParamLayout.index('centerX'), cy: ParamLayout.index('centerY'), angle: ParamLayout.index('angle'),
  lx: ParamLayout.index('left', 'x'), ly: ParamLayout.index('left', 'y'),
  rx: ParamLayout.index('right', 'x'), ry: ParamLayout.index('right', 'y'),
  lsq: ParamLayout.index('left', 'squash'), rsq: ParamLayout.index('right', 'squash'),
};

const ZERO: Readonly<V2> = Object.freeze({ x: 0, y: 0 });

/// Executes `s.gazeTarget` with three layers: eye rotation (saccade / pursuit springs, one per eye, with a trailing
/// eye and an arc), the head (a slower underdamped spring ≈60 ms behind, plus a small tilt), eye shapes (each sclera
/// centre follows its eye spring), and the pupils carrying the remainder:
/// `pupil = softClamp((eye·T − shape·S − head·H) / P)`.
///
/// Eye contact (C1): while `s.gazeTarget.contact` the pupils use `0.25·pupil`, capped at ±0.15, blended in with a
/// spring. Also: convergence, curiosity eye scaling, lid-follow, saccade smear, `s.isSaccading`, the saccade-blink
/// request, and `GazeOverride.pupilsOnly` (side-eye).
export class GazeTracking implements Modifier {
  readonly name = 'GazeTracking';
  readonly phase = Phase.attention;
  isEnabled = true;

  static readonly K = GazeTrackingK;

  // MARK: State

  private started = false;
  private left = new GazeLaggedSpring(ZERO);
  private right = new GazeLaggedSpring(ZERO);
  private head = new GazeLaggedSpring(ZERO);
  private eyeParams = new SpringParams(K.pursuitOmega, 1);
  private commanded: V2 = { x: 0, y: 0 };
  private saccadeUntil = -1;
  // Arc.
  private leftStart: V2 = { x: 0, y: 0 };
  private rightStart: V2 = { x: 0, y: 0 };
  private saccadeDelta: V2 = { x: 0, y: 0 };
  private arcPerp: V2 = { x: 0, y: 0 };
  private arcK = 0;
  private arcFade = 0;
  // Secondary.
  private vergence = new Spring1(0);
  private lidGaze = new Spring1(0);
  private contactWeight = new Spring1(0);
  private contactTarget = 0;
  // Pupils-only (side-eye) hold.
  private pupilsOnlyWeight = new Spring1(0);
  private wasPupilsOnly = false;
  private shapeHoldL: V2 = { x: 0, y: 0 };
  private shapeHoldR: V2 = { x: 0, y: 0 };
  private lastShapeL: V2 = { x: 0, y: 0 };
  private lastShapeR: V2 = { x: 0, y: 0 };

  /// Gaze-driven pupil positions (normalised, before the conjugate correction, convergence and drift).
  debugPupilL: V2 = { x: 0, y: 0 };
  debugPupilR: V2 = { x: 0, y: 0 };
  /// Current contact-gain blend weight 0…1.
  get debugContactWeight(): number { return this.contactWeight.value; }

  // MARK: Update

  update(s: FaceState): void {
    const now = s.time, dt = s.dt;
    const t0 = s.gazeTarget;
    let point = Number.isFinite(t0.point.x) && Number.isFinite(t0.point.y) ? t0.point : this.commanded;
    point = gazeClamp(point, 1.2);
    let velocity = Number.isFinite(t0.velocity.x) && Number.isFinite(t0.velocity.y) ? t0.velocity : ZERO;
    velocity = gazeClamp(velocity, 8);
    const distance = t0.distance, contact = t0.contact;
    const pupilsOnly = s.oneShot.gaze?.pupilsOnly === true;

    if (!this.started) {
      this.started = true;
      this.left = new GazeLaggedSpring(point);
      this.right = new GazeLaggedSpring(point);
      this.head = new GazeLaggedSpring(point);
      this.commanded = { ...point };
      this.vergence = new Spring1(this.vergenceTarget(distance));
      this.contactTarget = contact ? 1 : 0;
      this.contactWeight = new Spring1(this.contactTarget);
      this.lastShapeL = { ...point };
      this.lastShapeR = { ...point };
      const p0 = this.pupilFromLayers(point, point, point, ZERO, this.contactWeight.value);
      this.lidGaze = new Spring1(p0.y);
    }

    const bounce = Math.min(Math.max(s.modulation.bounciness, 0), 2);
    const speed = Math.sqrt(Math.min(Math.max(s.modulation.speed, 0.3), 2));
    const headParams = new SpringParams(K.headOmega * speed, Math.max(K.headZeta * (1 - 0.25 * bounce), 0.4));

    // 1. Advance over (now − dt, now] with the targets set so far (new targets apply from `now`).
    this.left.step(now, dt, this.eyeParams);
    this.right.step(now, dt, this.eyeParams);
    this.head.step(now, dt, headParams);
    this.arcFade *= Math.exp(-K.arcFadeRate * dt * (now < this.saccadeUntil ? 0 : 1));
    // Blend weights step toward last frame's flags; this frame's flags apply from `now` (fps-independent).
    this.contactWeight.step(this.contactTarget, K.contactSpring, dt);
    this.pupilsOnlyWeight.step(this.wasPupilsOnly ? 1 : 0, K.pupilsOnlySpring, dt);
    this.contactTarget = contact ? 1 : 0;

    // Pupils-only: freeze the eye shapes where they are and stop steering the head; on release the head
    // resumes toward the commanded point.
    if (pupilsOnly && !this.wasPupilsOnly) {
      this.shapeHoldL = { ...this.lastShapeL };
      this.shapeHoldR = { ...this.lastShapeR };
    } else if (!pupilsOnly && this.wasPupilsOnly) {
      this.head.retarget(this.commanded, now + K.headDelay);
    }
    this.wasPupilsOnly = pupilsOnly;

    // 2. Accept this frame's target.
    switch (t0.mode) {
      case 'saccade':
        if (gazeLength({ x: point.x - this.commanded.x, y: point.y - this.commanded.y }) > K.retargetEpsilon) {
          this.startSaccade(s, point, speed, bounce, !pupilsOnly);
        }
        break;
      case 'smooth': {
        const pursuit = new SpringParams(K.pursuitOmega * speed, 1);
        this.eyeParams = pursuit;
        const k = 2 / pursuit.omega;
        const eyeAim = { x: point.x + velocity.x * k, y: point.y + velocity.y * k };
        this.left.set(eyeAim);
        this.right.set(eyeAim);
        if (!pupilsOnly) {
          const kh = 2 * headParams.zeta / headParams.omega;
          this.head.set({ x: point.x + velocity.x * kh, y: point.y + velocity.y * kh });
        }
        this.commanded = { ...point };
        this.saccadeUntil = Math.min(this.saccadeUntil, now);
        break;
      }
    }

    // 3. Outputs.
    const lv = this.left.value, rv = this.right.value, hv = this.head.value;
    const eyeGaze = { x: (lv.x + rv.x) * 0.5, y: (lv.y + rv.y) * 0.5 };
    s.eyeGaze = eyeGaze;
    s.headGaze = { ...hv };
    s.isSaccading = now < this.saccadeUntil;

    let arcL: V2 = ZERO, arcR: V2 = ZERO;
    if (this.arcFade > 1e-4) {
      const kl = this.arcK * this.arcFade * this.arcShape(lv, this.leftStart);
      const kr = this.arcK * this.arcFade * this.arcShape(rv, this.rightStart);
      arcL = { x: this.arcPerp.x * kl, y: this.arcPerp.y * kl };
      arcR = { x: this.arcPerp.x * kr, y: this.arcPerp.y * kr };
    }

    // Eye-shape layer (held during pupils-only).
    const po = Math.min(Math.max(this.pupilsOnlyWeight.value, 0), 1);
    const shapeL = { x: lv.x + (this.shapeHoldL.x - lv.x) * po, y: lv.y + (this.shapeHoldL.y - lv.y) * po };
    const shapeR = { x: rv.x + (this.shapeHoldR.x - rv.x) * po, y: rv.y + (this.shapeHoldR.y - rv.y) * po };
    this.lastShapeL = shapeL;
    this.lastShapeR = shapeR;
    const d = s.delta.raw;
    d[I.lcx] += Units.poseX(shapeL.x * K.eyeTravel.x);
    d[I.lcy] += Units.poseY(shapeL.y * K.eyeTravel.y);
    d[I.rcx] += Units.poseX(shapeR.x * K.eyeTravel.x);
    d[I.rcy] += Units.poseY(shapeR.y * K.eyeTravel.y);

    // Head layer.
    d[I.cx] += Units.poseX(hv.x * K.headTravel.x);
    d[I.cy] += Units.poseY(hv.y * K.headTravel.y);
    d[I.angle] += -K.maxTilt * Math.min(Math.max(hv.x, -1), 1);

    // Curiosity: the eye on the gaze side grows, the far eye shrinks a little.
    const gx = Math.min(Math.max((1 - K.headShare.x) * eyeGaze.x + K.headShare.x * hv.x, -1), 1);
    const ax = Math.abs(gx);
    const near = 1 + K.curiosityGrow * ax * Math.sqrt(ax);
    const far = 1 - K.curiosityShrink * ax;
    const mulL = gx >= 0 ? far : near;
    const mulR = gx >= 0 ? near : far;
    const m = s.eyeScaleMul;
    s.eyeScaleMul = { x: m.x * mulL, y: m.y * mulL, z: m.z * mulR, w: m.w * mulR };

    // Pupil layer: the remainder of each eye's rotation after its shape and the head.
    const w = Math.min(Math.max(this.contactWeight.value, 0), 1);
    const pL = this.pupilFromLayers(lv, shapeL, hv, arcL, w);
    const pR = this.pupilFromLayers(rv, shapeR, hv, arcR, w);
    this.debugPupilL = pL;
    this.debugPupilR = pR;

    // Conjugate gaze (M5): undo the curiosity scaling so both pupils share one travel reference.
    const ref = (mulL + mulR) * 0.5;
    const kL = ref / mulL, kR = ref / mulR;

    this.vergence.step(this.vergenceTarget(distance), K.convergenceSpring, dt);
    const conv = this.vergence.value;
    // Left eye sits on the viewer's left: inward is +x for it, −x for the right eye.
    d[I.lx] += pL.x * kL + conv;
    d[I.ly] += pL.y * kL;
    d[I.rx] += pR.x * kR - conv;
    d[I.ry] += pR.y * kR;

    // Playful smear: a fast horizontal saccade squashes the pupils a little.
    const vx = Math.abs((this.left.velocity.x + this.right.velocity.x) * 0.5) * K.totalTravel.x * (1 - 0.75 * w);
    const smear = K.smearMax * Ease.smoothstep(vx / K.smearSpeed);
    d[I.lsq] += smear;
    d[I.rsq] += smear;

    // Lid-follow: upper lids track the gaze-driven vertical pupil position, lagging slightly.
    this.lidGaze.step(Math.min(Math.max((pL.y + pR.y) * 0.5, -1), 1), K.lidSpring, dt);
    const gy = this.lidGaze.value;
    const lid = -K.lidUp * Math.max(-gy, 0) + K.lidDown * Math.max(gy, 0);
    const lc = s.lidCoverage;
    s.lidCoverage = { x: lc.x + lid, y: lc.y, z: lc.z + lid, w: lc.w };
  }

  /// Normalised pupil position for one eye from the layer values (gaze units) and the arc (canvas units).
  private pupilFromLayers(eye: V2, shape: V2, head: V2, arc: V2, w: number): V2 {
    const rx = (eye.x * K.totalTravel.x - shape.x * K.eyeTravel.x - head.x * K.headTravel.x + arc.x) / K.pupilTravel.x;
    const ry = (eye.y * K.totalTravel.y - shape.y * K.eyeTravel.y - head.y * K.headTravel.y + arc.y) / K.pupilTravel.y;
    let px = LidMath.softClamp(rx, -K.pupilLimit, K.pupilLimit, K.pupilKnee);
    let py = LidMath.softClamp(ry, -K.pupilLimit, K.pupilLimit, K.pupilKnee);
    if (w > 0) {
      const cx = LidMath.softClamp(K.contactGain * px, -K.contactCap, K.contactCap, K.contactKnee);
      const cy = LidMath.softClamp(K.contactGain * py, -K.contactCap, K.contactCap, K.contactKnee);
      px += (cx - px) * w;
      py += (cy - py) * w;
    }
    return { x: px, y: py };
  }

  // MARK: Saccades

  private startSaccade(s: FaceState, point: V2, speed: number, bounce: number, moveHead: boolean): void {
    const now = s.time;
    const lv = this.left.value, rv = this.right.value;
    const current = { x: (lv.x + rv.x) * 0.5, y: (lv.y + rv.y) * 0.5 };
    const delta = { x: point.x - current.x, y: point.y - current.y };
    const amp = gazeLength(delta);
    this.commanded = { ...point };
    if (!(amp > K.minSaccadeAmp)) {
      this.left.set(point); this.right.set(point);
      if (moveHead) this.head.set(point);
      return;
    }
    const omega = K.saccadeOmegaBase / (1 + K.saccadeOmegaAmp * amp) * speed;
    const zBase = K.saccadeZetaSmall + (K.saccadeZetaBig - K.saccadeZetaSmall) * Ease.smoothstep(amp / K.saccadeBigAmp);
    const zeta = Math.max(zBase * (1 - 0.25 * bounce), 0.45);
    this.eyeParams = new SpringParams(omega, zeta);

    // Events: which eye trails, by how long.
    const leftLeads = s.rng.chance(0.5);
    const lag = Math.fround(s.rng.uniform(K.lagRange[0], K.lagRange[1])); // f32: a Swift Float
    if (leftLeads) {
      this.left.retarget(point, now);
      this.right.retarget(point, now + lag);
    } else {
      this.right.retarget(point, now);
      this.left.retarget(point, now + lag);
    }
    if (moveHead) this.head.retarget(point, now + K.headDelay);

    // Arc perpendicular to the motion in total-gaze canvas space, bowing upward (carried by the pupils).
    this.leftStart = { ...this.left.value };
    this.rightStart = { ...this.right.value };
    this.saccadeDelta = delta;
    const dC = { x: delta.x * K.totalTravel.x, y: delta.y * K.totalTravel.y };
    const lenC = gazeLength(dC);
    const inv = Math.max(lenC, 1e-6);
    let perp = { x: -dC.y / inv, y: dC.x / inv };
    if (perp.y > 0) perp = { x: -perp.x, y: -perp.y };
    if (Math.abs(dC.x) < 0.3 * lenC && s.rng.chance(0.5)) perp = { x: -perp.x, y: -perp.y };
    this.arcPerp = perp;
    this.arcK = K.arcGain * lenC;
    this.arcFade = 1;

    const settle = Math.fround(Math.min(Math.max(4 / (zeta * omega), 0.06), 0.3)); // f32: clamp bounds tie
    this.saccadeUntil = now + lag + settle;

    if (amp > K.blinkAmp && s.rng.chance(K.blinkP)) s.saccadeBlinkRequest = true;
  }

  /// 4p(1−p) for this eye's progress along the current saccade (0 outside [0, 1]).
  private arcShape(value: V2, start: V2): number {
    const sd = this.saccadeDelta;
    const d2 = sd.x * sd.x + sd.y * sd.y;
    if (!(d2 > 1e-8)) return 0;
    const p = ((value.x - start.x) * sd.x + (value.y - start.y) * sd.y) / d2;
    if (!(p > 0 && p < 1)) return 0;
    return 4 * p * (1 - p);
  }

  /// Inward pupil offset (normalised) for a target at `distance` metres.
  private vergenceTarget(distance: number): number {
    const d = Number.isFinite(distance) ? Math.max(distance, 0.1) : 1.5;
    return K.convergenceMax * Ease.smoothstep((K.convergenceStart - d) / (K.convergenceStart - K.convergenceFull));
  }
}
