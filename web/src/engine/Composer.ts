// Port of FaceEngine/Composer.swift.
import { log } from '../core/log';
import { v2, v4, type V2, type V3, type V4 } from '../core/vec';
import {
  BrowPose, FaceFrame, FacePose, ParamLayout, Units, makeFaceFrame, maxOf, pupilShapeClamping, PupilShape,
  type BrowLane, type EdgeGeometry, type Side,
} from '../model';
import { Ease } from './Easing';
import type { FaceState } from './FaceState';
import { LidMath } from './LidMath';
import { PupilShapeFrame } from './PupilShapeCurves';

let didLogNonFinite = false;

const fin = Number.isFinite;
const sanitizedChannel = (c: number): number => (fin(c) ? Math.min(Math.max(c, 0), 1) : 0);

/// A linear colour clamped to 0…1 (non-finite → black).
function sanitizedColor(c: V3): V3 {
  if (!(fin(c.x) && fin(c.y) && fin(c.z))) return { x: 0, y: 0, z: 0 };
  const cl = (v: number): number => Math.min(Math.max(v, 0), 1);
  return { x: cl(c.x), y: cl(c.y), z: cl(c.z) };
}

const I = {
  centerX: ParamLayout.index('centerX'), centerY: ParamLayout.index('centerY'), scaleX: ParamLayout.index('scaleX'),
  scaleY: ParamLayout.index('scaleY'), angle: ParamLayout.index('angle'),
};

/// Turns the frame's state into the final pose. Pure function of state (design C5, Part D C3/C4/H4/M6/M10).
///
/// Pipeline:
/// 1. `pose = basePose + delta` (additive), then `faceScaleMul` / `eyeScaleMul` (multiplicative).
/// 2. Per eye, lids (all fractions of the remaining opening `A = 1 − u − l`):
///    extra coverage (`lidCoverage`) → minimum opening `A ≥ 0.10` (soft knee) → `lidClose` → `blink`.
///    Closure is applied last and only ever reduces the opening, so it is monotonic for every expression.
/// 3. Soft clamp lids and radii, hard clamp everything else to `ParamLayout` ranges.
/// 4. NaN guard (falls back to the library neutral), then `FaceFrame`.
export const Composer = {
  // MARK: Tuning
  /// Minimum visible opening (fraction of eye height) outside closure (C3).
  minOpening: 0.10,
  /// Smooth-max knee width for the minimum opening.
  minOpeningKnee: 0.08,
  /// Soft-clamp knee for lids, lid bends and corner radii (M6).
  softKnee: 0.08,
  /// lidClose channel: upper lid travels this fraction of the opening at c = 1 (C4).
  lidCloseTravel: 0.85,
  /// lidClose channel: eye scale_y at c = 1.
  lidCloseSquashY: 0.9,
  /// Blink channel: lids meet at `u + blinkMeet·A`.
  blinkMeet: 0.6,
  /// Blink channel: eye scale_y / scale_x at full closure.
  blinkSquashY: 0.3,
  /// Allowed range of the combined pupil-size multiplier.
  pupilSizeMulRange: [0.65, 1.25] as const,
  blinkStretchX: 1.08,

  // Adaptive frame-rate thresholds (M10). Enter above the high value, stay while above the low value.
  /// Face / eye centre speed in canvas units per second.
  fastMoveEnter: 30, fastMoveStay: 10,
  /// Scale (and lid y) rate in units per second.
  fastScaleEnter: 0.8, fastScaleStay: 0.3,
  /// Face angle rate in degrees per second.
  fastAngleEnter: 40, fastAngleStay: 15,
  /// Approximate canvas travel of a pupil per normalised unit (for the frame-rate decision only).
  pupilTravelCanvas: 4,
  /// A blink's lid travel and squash never ask for 120 fps: the scale and lid rates are ignored this long after a blink
  /// starts.
  blinkHighRateHold: 0.45,

  // MARK: Compose

  compose(s: FaceState): void {
    const C = Composer;
    let pose = C.composedPose(s);
    if (pose.hasNonFinite) {
      if (!didLogNonFinite) {
        didLogNonFinite = true;
        log.error('face', 'Composer: non-finite pose; falling back to neutral (logged once)');
      }
      const neutral = s.library.neutral;
      pose = neutral.hasNonFinite ? FacePose.defaults : neutral.clamped();
    }

    const prevOut = s.output;
    const previous = prevOut.pose;
    const stage = C.boundedStage(s.stageOffset, s.edgeGeometry);
    const eyeStage = C.boundedEyeStage(s.eyeStageOffset, s.edgeGeometry);
    const brightness = fin(s.brightness) ? Math.min(Math.max(s.brightness, 0), 1) : Math.min(Math.max(s.targetBrightness, 0), 1);
    const fast = C.wantsHighFrameRate(pose, previous, prevOut.wantsHighFrameRate, s)
      || C.stageWantsHighFrameRate(stage, eyeStage, prevOut, prevOut.wantsHighFrameRate, s.dt);

    s.prevPose = previous;
    const c = s.eyeColor;
    const cl = (v: number): number => Math.min(Math.max(v, 0), 1);
    const color = fin(c.x) && fin(c.y) && fin(c.z) ? { x: cl(c.x), y: cl(c.y), z: cl(c.z) } : { ...FaceFrame.defaultColor };
    // The sleepy sink plays out at full rate: the asleep low-frame-rate tier waits until it has settled.
    const asleep = s.agentState === 'asleep' && !s.activeOneShots.includes('sleepySink');
    const shape = C.sanitizedPupilShape(s);
    const shapeFast = C.shapeWantsHighFrameRate(shape, prevOut, prevOut.wantsHighFrameRate, s.dt);
    const brows = C.composedBrows(s);
    const presence = fin(s.browPresence) ? Math.min(Math.max(s.browPresence, 0), 1) : 1;
    const browOffset = C.boundedBrowOffset(s.browOffset);
    const browFast = C.browsWantHighFrameRate(brows, presence, browOffset, prevOut, prevOut.wantsHighFrameRate, s.dt);
    s.composedLidClose = sanitizedChannel(s.lidClose);
    const out = makeFaceFrame(pose, {
      brightness, wantsHighFrameRate: fast || shapeFast || browFast, isAsleep: asleep, color,
      closureScale: C.closureScale(sanitizedChannel(s.blink), sanitizedChannel(s.lidClose)),
      stageOffset: stage, eyeStageOffset: eyeStage,
      pupilShape: shape.shape, pupilMorph: shape.morph, pupilShapeScale: shape.scale,
      brows, browPresence: presence, browOffset,
      backgroundColor: sanitizedColor(s.backgroundColor), backgroundStrength: sanitizedChannel(s.backgroundStrength),
      backgroundPresence: sanitizedChannel(s.backgroundPresence),
      backgroundBrightness: fin(s.baseBrightness) ? Math.min(Math.max(s.baseBrightness, 0), 1) : brightness,
    });
    out.captionInset = fin(s.captionInset) ? Math.min(Math.max(s.captionInset, 0), FaceFrame.maxCaptionInset) : 0;
    const glow = fin(s.glowLevel) && fin(s.glowHeight) ? Math.min(Math.max(s.glowLevel, 0), 1.5) : 0;
    if (glow > 0) {
      out.glowLevel = glow;
      out.glowHeight = Math.min(Math.max(s.glowHeight, 0), 0.4);
      out.glowMotion = sanitizedChannel(s.glowMotion);
      out.glowRipple = sanitizedChannel(s.glowRipple);
      out.glowColor = sanitizedColor(s.glowColor);
      out.glowColor2 = sanitizedColor(s.glowColor2);
      const p = s.glowPhase;
      out.glowPhase = fin(p.x) && fin(p.y) && fin(p.z) && fin(p.w) ? { ...p } : v4(0);
    }
    s.output = out;
  },

  sanitizedColor,
  sanitizedChannel,

  // MARK: Brows

  /// How far a brow's inner end may reach toward the nose beyond its rest place (fraction of the eye's rest width).
  maxInnerReach: 0.1,
  /// Inner-end travel per unit of extra length (half the default brow length, in eye widths).
  innerReachPerWidth: 0.4,
  /// Follow-through offsets beyond this (canvas units) are clamped.
  maxBrowOffset: 8,

  /// The frame's brows: base + delta, clamped into the lane ranges, with the inner ends kept apart. Non-finite values
  /// fall back to the library Neutral's brows.
  composedBrows(s: FaceState): BrowPose {
    let b = s.browBase.add(s.browDelta);
    if (b.hasNonFinite) {
      const n = s.library.neutralBrows;
      b = n.hasNonFinite ? BrowPose.restNeutral : n.copy();
    }
    b = b.clamped();
    for (const side of ['left', 'right'] as const) {
      const reach = -b.lane(side, 'x') + Composer.innerReachPerWidth * (b.lane(side, 'width') - 1);
      if (reach > Composer.maxInnerReach) b.setLane(side, 'x', b.lane(side, 'x') + reach - Composer.maxInnerReach);
    }
    return b;
  },

  boundedBrowOffset(v: V4): V4 {
    const m = Composer.maxBrowOffset;
    const c = (x: number): number => (fin(x) ? Math.min(Math.max(x, -m), m) : 0);
    return v4(c(v.x), c(v.y), c(v.z), c(v.w));
  },

  /// Nominal rest eye size (canvas units) for turning brow lanes into motion speeds (frame-rate decision only).
  browSpeedWidth: 34, browSpeedHeight: 48,

  /// Brows moving fast want 120 fps, with the same enter / stay thresholds as the pose.
  browsWantHighFrameRate(b: BrowPose, presence: number, offset: V4, previous: FaceFrame, wasFast: boolean, dt: number): boolean {
    const C = Composer;
    if (!(dt > 1e-5)) return false;
    const inv = 1 / dt;
    let move = 0, angle = 0, scale = Math.abs(presence - previous.browPresence) * inv;
    const p = previous.brows;
    for (const side of ParamLayout.Side.both) {
      const d = (l: BrowLane): number => Math.abs(b.lane(side, l) - p.lane(side, l));
      move = maxOf(move, d('x') * C.browSpeedWidth * inv, d('y') * C.browSpeedHeight * inv,
        d('inner') * C.browSpeedHeight * inv, d('outer') * C.browSpeedHeight * inv,
        d('curvature') * 0.5 * C.browSpeedWidth * inv);
      angle = Math.max(angle, d('rotation') * inv);
      scale = Math.max(scale, d('width') * inv, d('thickness') * inv);
    }
    const o = { x: offset.x - previous.browOffset.x, y: offset.y - previous.browOffset.y,
      z: offset.z - previous.browOffset.z, w: offset.w - previous.browOffset.w };
    move = Math.max(move, Math.sqrt(maxOf(o.x * o.x, o.y * o.y, o.z * o.z, o.w * o.w)) * inv);
    if (move > C.fastMoveEnter || scale > C.fastScaleEnter || angle > C.fastAngleEnter) return true;
    return wasFast && (move > C.fastMoveStay || scale > C.fastScaleStay || angle > C.fastAngleStay);
  },

  // MARK: Pupil silhouette

  /// Smallest pupil scale the frame carries (the coin flip's sliver is above it).
  minPupilShapeScale: 0.02,

  /// The frame's pupil silhouette: unknown shapes read as the ellipse, morph is clamped to 0…1 (0 on an ellipse), scale
  /// to `minPupilShapeScale`…1; non-finite values fall back to the identity.
  sanitizedPupilShape(s: FaceState): PupilShapeFrame {
    const f = new PupilShapeFrame();
    const shapes = [s.pupilShape.x, s.pupilShape.y];
    const morphs = [s.pupilMorph.x, s.pupilMorph.y];
    const scales = [s.pupilShapeScale.x, s.pupilShapeScale.y, s.pupilShapeScale.z, s.pupilShapeScale.w];
    const outShape = [0, 0], outMorph = [0, 0], outScale = [1, 1, 1, 1];
    for (let e = 0; e < 2; e++) {
      const shape = pupilShapeClamping(shapes[e]);
      const m = morphs[e];
      const morph = shape === PupilShape.ellipse || !fin(m) ? 0 : Math.min(Math.max(m, 0), 1);
      outShape[e] = morph > 0 ? shape : 0;
      outMorph[e] = morph;
      for (let k = 0; k < 2; k++) {
        const v = scales[2 * e + k];
        outScale[2 * e + k] = fin(v) ? Math.min(Math.max(v, Composer.minPupilShapeScale), 1) : 1;
      }
    }
    f.shape = v2(outShape[0], outShape[1]);
    f.morph = v2(outMorph[0], outMorph[1]);
    f.scale = v4(outScale[0], outScale[1], outScale[2], outScale[3]);
    return f;
  },

  /// The pupil silhouette's morph or scale changing faster than the scale thresholds (per second) wants 120 fps.
  shapeWantsHighFrameRate(f: PupilShapeFrame, previous: FaceFrame, wasFast: boolean, dt: number): boolean {
    if (!(dt > 1e-5)) return false;
    const dm = Math.max(Math.abs(f.morph.x - previous.pupilMorph.x), Math.abs(f.morph.y - previous.pupilMorph.y));
    const ps = previous.pupilShapeScale;
    const ds = maxOf(Math.abs(f.scale.x - ps.x), Math.abs(f.scale.y - ps.y), Math.abs(f.scale.z - ps.z), Math.abs(f.scale.w - ps.w));
    const flip = f.shape.x !== previous.pupilShape.x || f.shape.y !== previous.pupilShape.y;
    const v = Math.max(dm, ds) / dt;
    return flip || v > Composer.fastScaleEnter || (wasFast && v > Composer.fastScaleStay);
  },

  // MARK: Stage offsets

  /// Stage offsets may carry the eyes past the screen edges, but never further than the pair just beyond the screen
  /// plus `stageMargin` (or `stageLimitHeadless` without screen geometry).
  stageMargin: 30,
  stageLimitHeadless: 200,

  stageLimit(g: EdgeGeometry | null): V2 {
    if (g === null || !g.isValid) return v2(Composer.stageLimitHeadless);
    return v2(g.visibleHalfExtent.x + g.pairHalfWidth + Composer.stageMargin,
      g.visibleHalfExtent.y + g.pairHalfHeight + Composer.stageMargin);
  },

  boundedStage(v: V2, g: EdgeGeometry | null): V2 {
    const lim = Composer.stageLimit(g);
    const c = (x: number, l: number): number => (fin(x) ? Math.min(Math.max(x, -l), l) : 0);
    return v2(c(v.x, lim.x), c(v.y, lim.y));
  },

  boundedEyeStage(v: V4, g: EdgeGeometry | null): V4 {
    const lim = Composer.stageLimit(g);
    const c = (x: number, l: number): number => (fin(x) ? Math.min(Math.max(x, -l), l) : 0);
    return v4(c(v.x, lim.x), c(v.y, lim.y), c(v.z, lim.x), c(v.w, lim.y));
  },

  /// Stage motion (canvas units per second, per eye) uses the same enter / stay thresholds as pose motion.
  stageWantsHighFrameRate(stage: V2, eyeStage: V4, previous: FaceFrame, wasFast: boolean, dt: number): boolean {
    if (!(dt > 1e-5)) return false;
    const now = makeFaceFrame(previous.pose, { stageOffset: stage, eyeStageOffset: eyeStage });
    let v = 0;
    for (const side of ParamLayout.Side.both as readonly Side[]) {
      const a = FaceFrame.stage(now, side), b = FaceFrame.stage(previous, side);
      const dx = a.x - b.x, dy = a.y - b.y;
      v = Math.max(v, Math.sqrt(dx * dx + dy * dy) / dt);
    }
    return v > Composer.fastMoveEnter || (wasFast && v > Composer.fastMoveStay);
  },

  /// The eye-local (x, y) squash closure applies — the same factors `applyLids` multiplies into the scales.
  closureScale(blink: number, lidClose: number): V2 {
    let sy = 1, sx = 1;
    if (lidClose > 0) sy *= LidMath.mix(1, Composer.lidCloseSquashY, Ease.smoothstep(lidClose));
    if (blink > 0) {
      const e = Ease.smoothstep(blink);
      sy *= LidMath.mix(1, Composer.blinkSquashY, e);
      sx *= LidMath.mix(1, Composer.blinkStretchX, e);
    }
    return v2(sx, sy);
  },

  /// The composed, clamped pose for the current state (may contain non-finite values if inputs do).
  composedPose(s: FaceState): FacePose {
    const C = Composer;
    const pose = s.basePose.add(s.delta);
    const r = pose.raw;
    // Multiplicative scales (M6).
    r[I.scaleX] *= s.faceScaleMul.x;
    r[I.scaleY] *= s.faceScaleMul.y;
    r[ParamLayout.index('left', 'scaleX')] *= s.eyeScaleMul.x;
    r[ParamLayout.index('left', 'scaleY')] *= s.eyeScaleMul.y;
    r[ParamLayout.index('right', 'scaleX')] *= s.eyeScaleMul.z;
    r[ParamLayout.index('right', 'scaleY')] *= s.eyeScaleMul.w;
    // Pupil dilation from all modifiers, product clamped so stacked effects stay believable.
    const [lo, hi] = C.pupilSizeMulRange;
    r[ParamLayout.index('left', 'size')] *= Math.min(Math.max(s.pupilSizeMul.x, lo), hi);
    r[ParamLayout.index('right', 'size')] *= Math.min(Math.max(s.pupilSizeMul.y, lo), hi);

    const blink = sanitizedChannel(s.blink);
    const lidClose = sanitizedChannel(s.lidClose);
    C.applyLids(pose, 'left', s.lidCoverage.x, s.lidCoverage.y, blink, lidClose);
    C.applyLids(pose, 'right', s.lidCoverage.z, s.lidCoverage.w, blink, lidClose);

    C.clamp(pose);
    return pose;
  },

  /// Lid coverage, minimum opening and the two closure channels for one eye.
  applyLids(pose: FacePose, side: Side, coverUpper: number, coverLower: number, blink: number, lidClose: number): void {
    const C = Composer;
    let u = LidMath.softClamp(pose.eye(side, 'upperLidY'), 0, 1, C.softKnee);
    let l = LidMath.softClamp(pose.eye(side, 'lowerLidY'), 0, 1, C.softKnee);

    // 1. Extra coverage as a fraction of the remaining opening (C3). Positive parts may not exceed the whole opening
    //    together; negative values open the lid proportionally (never below 0).
    let hu = fin(coverUpper) ? Math.min(Math.max(coverUpper, -1), 1) : 0;
    let hl = fin(coverLower) ? Math.min(Math.max(coverLower, -1), 1) : 0;
    const positive = Math.max(hu, 0) + Math.max(hl, 0);
    if (positive > 1) {
      if (hu > 0) hu /= positive;
      if (hl > 0) hl /= positive;
    }
    const a0 = Math.max(1 - u - l, 0);
    const u1 = hu >= 0 ? u + hu * a0 : u * (1 + hu);
    const l1 = hl >= 0 ? l + hl * a0 : l * (1 + hl);
    u = u1; l = l1;

    // 2. Minimum opening with a soft knee. Applied before closure, so closure can still go below it.
    const a1 = 1 - u - l;
    const target = LidMath.smoothMax(a1, C.minOpening, C.minOpeningKnee);
    if (target > a1 && u + l > 1e-6) {
      const k = (1 - target) / (u + l);
      u *= k; l *= k;
    }

    let sy = 1, sx = 1;
    const u0 = u, a0c = Math.max(1 - u - l, 0);

    // 3. lidClose: the upper lid comes down over the opening, slight squash (C4).
    if (lidClose > 0) {
      const a = Math.max(1 - u - l, 0);
      u += lidClose * C.lidCloseTravel * a;
      sy *= LidMath.mix(1, C.lidCloseSquashY, Ease.smoothstep(lidClose));
    }

    // 4. blink: both lids meet at a line 60 % down the (pre-lidClose) opening, strong squash (C4 + H4).
    if (blink > 0) {
      const e = Ease.smoothstep(blink);
      const m = u0 + C.blinkMeet * a0c;
      u += (Math.max(m, u) - u) * e;
      l += ((1 - m) - l) * e;
      sy *= LidMath.mix(1, C.blinkSquashY, e);
      sx *= LidMath.mix(1, C.blinkStretchX, e);
    }

    pose.setEye(side, 'upperLidY', u);
    pose.setEye(side, 'lowerLidY', l);
    pose.setEye(side, 'scaleY', pose.eye(side, 'scaleY') * sy);
    pose.setEye(side, 'scaleX', pose.eye(side, 'scaleX') * sx);
  },

  /// Soft clamp lids, lid bends and radii; hard clamp everything else.
  clamp(pose: FacePose): void {
    for (let i = 0; i < ParamLayout.count; i++) {
      const r = ParamLayout.ranges[i];
      pose.raw[i] = SOFT[i]
        ? LidMath.softClamp(pose.raw[i], r.lowerBound, r.upperBound, Composer.softKnee)
        : Math.min(Math.max(pose.raw[i], r.lowerBound), r.upperBound);
    }
  },

  /// Lid y / bend and corner radii use the soft clamp. Lid y has already been soft clamped on input and kept in range
  /// by the lid maths, so here it only gets a hard safety clamp.
  isSoftClamped(i: number): boolean {
    if (i < ParamLayout.leftEyeOffset) return false;
    if (i >= ParamLayout.leftPupilOffset) return true; // all pupil lanes
    const p = ParamLayout.Eye.allCases[(i - ParamLayout.leftEyeOffset) % ParamLayout.eyeParamCount];
    switch (p) {
      case 'lowerInnerRadiusX': case 'lowerInnerRadiusY': case 'lowerOuterRadiusX': case 'lowerOuterRadiusY':
      case 'upperInnerRadiusX': case 'upperInnerRadiusY': case 'upperOuterRadiusX': case 'upperOuterRadiusY':
      case 'upperLidBend': case 'lowerLidBend':
        return true;
      default:
        return false;
    }
  },

  // MARK: Adaptive frame rate

  wantsHighFrameRate(pose: FacePose, previous: FacePose, wasFast: boolean, s: FaceState): boolean {
    const C = Composer;
    const blinking = s.blink > 0.001 || s.time - s.lastBlinkTime < C.blinkHighRateHold;
    const dt = s.dt;
    if (!(dt > 1e-5)) return wasFast;
    const inv = 1 / dt;
    const speed = (dx: number, dy: number): number => {
      const cx = Units.canvasX(dx), cy = Units.canvasY(dy);
      return Math.sqrt(cx * cx + cy * cy) * inv;
    };
    const faceV = speed(pose.raw[I.centerX] - previous.raw[I.centerX], pose.raw[I.centerY] - previous.raw[I.centerY]);
    const leftV = speed(pose.eye('left', 'centerX') - previous.eye('left', 'centerX'),
      pose.eye('left', 'centerY') - previous.eye('left', 'centerY'));
    const rightV = speed(pose.eye('right', 'centerX') - previous.eye('right', 'centerX'),
      pose.eye('right', 'centerY') - previous.eye('right', 'centerY'));
    // Pupil saccades: normalised travel → canvas (≈ pupilTravelCanvas units per normalised unit).
    const pupilSpeed = (side: Side): number => {
      const dx = pose.eye(side, 'x') - previous.eye(side, 'x'), dy = pose.eye(side, 'y') - previous.eye(side, 'y');
      return Math.sqrt(dx * dx + dy * dy) * C.pupilTravelCanvas * inv;
    };
    const moveV = maxOf(faceV, leftV, rightV, pupilSpeed('left'), pupilSpeed('right'));

    let scaleV = 0;
    for (const i of ParamLayout.scaleIndices) scaleV = Math.max(scaleV, Math.abs(pose.raw[i] - previous.raw[i]) * inv);
    for (const side of ParamLayout.Side.both as readonly Side[]) {
      // Lid travel (lidClose, lid follow) counts as scale-like motion of the eye shape.
      scaleV = Math.max(scaleV, Math.abs(pose.eye(side, 'upperLidY') - previous.eye(side, 'upperLidY')) * inv,
        Math.abs(pose.eye(side, 'lowerLidY') - previous.eye(side, 'lowerLidY')) * inv);
    }
    const angleV = Math.abs(pose.raw[I.angle] - previous.raw[I.angle]) * inv;

    if (blinking) scaleV = 0;
    if (moveV > C.fastMoveEnter || scaleV > C.fastScaleEnter || angleV > C.fastAngleEnter) return true;
    if (wasFast && (moveV > C.fastMoveStay || scaleV > C.fastScaleStay || angleV > C.fastAngleStay)) return true;
    return false;
  },
};

const SOFT: readonly boolean[] = Array.from({ length: ParamLayout.count }, (_, i) => Composer.isSoftClamped(i));
