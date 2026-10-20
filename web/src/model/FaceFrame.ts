// Port of FaceModel/FaceFrame.swift (FaceFrame, FaceFrameSource, Canvas, Units).
import { v2, v3, v4, type V2, type V3, type V4 } from '../core/vec';
import { BrowPose } from './BrowPose';
import type { FacePose } from './FacePose';
import type { Side } from './ParamLayout';
import { pupilShapeClamping, type PupilShape } from './PupilShape';

/// What the renderer needs for one frame. Produced by the engine, consumed by the renderer.
export interface FaceFrame {
  /// Final, clamped pose (PyCozmo units).
  pose: FacePose;
  /// Overall brightness multiplier, 0...1.
  brightness: number;
  /// True while something is moving fast enough to benefit from 120 fps.
  wantsHighFrameRate: boolean;
  /// True while asleep; the renderer drops to a low frame rate.
  isAsleep: boolean;
  /// Eye colour, linear RGB 0...1 (mood-driven). The renderer mixes it with `RenderStyle.color` by
  /// `RenderStyle.moodColorAmount`.
  color: V3;
  /// Eye-local scale (x, y) applied by blink / lid-close closure, already included in `pose`. The renderer places
  /// the pupil in the pre-closure eye frame and then applies this squash to it as a rigid body.
  closureScale: V2;
  /// Whole-face stage offset (canvas units, +y down) outside the pose, added after face scale and rotation.
  stageOffset: V2;
  /// Extra per-eye stage offset (canvas units): (left x, left y, right x, right y), on top of `stageOffset`.
  eyeStageOffset: V4;
  /// Pupil silhouette per eye (`PupilShape` raw values: x left, y right). `ellipse` almost always.
  pupilShape: V2;
  /// Per-eye morph 0…1 from the default ellipse to `pupilShape`. The switch shapes are only ever 0 or 1.
  pupilMorph: V2;
  /// Per-eye pupil scale (left x, left y, right x, right y), each 0…1, applied inside the contained pupil ellipse.
  pupilShapeScale: V4;
  /// The eyebrows (final, clamped; eye-relative units, see `BrowLayout`). Drawn only when the style turns brows on.
  brows: BrowPose;
  /// 0…1 brow presence: 1 awake, partial when drowsy or half awake, 0 asleep.
  browPresence: number;
  /// Follow-through of each brow, canvas units (left x, left y, right x, right y; +y down). Zero at rest.
  browOffset: V4;
  /// The mood background colour, linear RGB 0…1, full strength and undimmed.
  backgroundColor: V3;
  /// 0…1 mix from the theme background (black) toward `backgroundColor`, mixed in linear light.
  backgroundStrength: number;
  /// 0…1 life-cycle presence of the whole background; smoothed by the engine, the only owner of this fade.
  backgroundPresence: number;
  /// The background's brightness: the base brightness without the asleep breathing pulse or one-shot glows.
  backgroundBrightness: number;
  /// The listening glow: level (0 = off; may overshoot 1 a little), crest height as a fraction of the screen
  /// height, edge motion 0…1, its two colours (linear RGB) and the wave phases (radians: band drift, wave 1, 2, 3).
  glowLevel: number;
  glowHeight: number;
  glowMotion: number;
  /// The voice ripple 0…1 (the person's mic level × motion).
  glowRipple: number;
  glowColor: V3;
  glowColor2: V3;
  glowPhase: V4;
  /// The caption band: the share of the screen height, 0…`maxCaptionInset`, kept clear at the bottom for the
  /// caption bubbles. Sprung by the engine; 0 almost always.
  captionInset: number;
}

const DEFAULT_COLOR: Readonly<V3> = Object.freeze(v3(0.11, 0.92, 1.0));

export const FaceFrame = {
  /// The largest caption band the renderer honours.
  maxCaptionInset: 0.4,
  /// The default eye colour, linear RGB (≈ sRGB #5FF6FF). Frozen: copy before mutating.
  defaultColor: DEFAULT_COLOR,

  /// The pupil silhouette of one eye.
  shape: (f: FaceFrame, side: Side): PupilShape => pupilShapeClamping(side === 'left' ? f.pupilShape.x : f.pupilShape.y),
  /// The pupil morph (0…1) of one eye.
  morph: (f: FaceFrame, side: Side): number => (side === 'left' ? f.pupilMorph.x : f.pupilMorph.y),
  /// The pupil scale (x, y) of one eye.
  shapeScale: (f: FaceFrame, side: Side): V2 =>
    side === 'left' ? v2(f.pupilShapeScale.x, f.pupilShapeScale.y) : v2(f.pupilShapeScale.z, f.pupilShapeScale.w),
  /// The follow-through offset of one brow (canvas units).
  browOffset: (f: FaceFrame, side: Side): V2 =>
    side === 'left' ? v2(f.browOffset.x, f.browOffset.y) : v2(f.browOffset.z, f.browOffset.w),
  /// Total stage offset of one eye (face stage plus that eye's own).
  stage: (f: FaceFrame, side: Side): V2 =>
    side === 'left'
      ? v2(f.stageOffset.x + f.eyeStageOffset.x, f.stageOffset.y + f.eyeStageOffset.y)
      : v2(f.stageOffset.x + f.eyeStageOffset.z, f.stageOffset.y + f.eyeStageOffset.w),
} as const;

/// Swift `FaceFrame.init` defaults (glow fields and captionInset default to 0, as in the Swift property defaults).
export function makeFaceFrame(pose: FacePose, o: Partial<Omit<FaceFrame, 'pose'>> = {}): FaceFrame {
  return {
    pose,
    brightness: o.brightness ?? 1,
    wantsHighFrameRate: o.wantsHighFrameRate ?? false,
    isAsleep: o.isAsleep ?? false,
    color: o.color ?? { ...DEFAULT_COLOR },
    closureScale: o.closureScale ?? v2(1),
    stageOffset: o.stageOffset ?? v2(0),
    eyeStageOffset: o.eyeStageOffset ?? v4(0),
    pupilShape: o.pupilShape ?? v2(0),
    pupilMorph: o.pupilMorph ?? v2(0),
    pupilShapeScale: o.pupilShapeScale ?? v4(1),
    brows: o.brows ?? BrowPose.restNeutral,
    browPresence: o.browPresence ?? 1,
    browOffset: o.browOffset ?? v4(0),
    backgroundColor: o.backgroundColor ?? v3(0),
    backgroundStrength: o.backgroundStrength ?? 0,
    backgroundPresence: o.backgroundPresence ?? 1,
    backgroundBrightness: o.backgroundBrightness ?? 1,
    glowLevel: o.glowLevel ?? 0,
    glowHeight: o.glowHeight ?? 0,
    glowMotion: o.glowMotion ?? 0,
    glowRipple: o.glowRipple ?? 0,
    glowColor: o.glowColor ?? v3(0),
    glowColor2: o.glowColor2 ?? v3(0),
    glowPhase: o.glowPhase ?? v4(0),
    captionInset: o.captionInset ?? 0,
  };
}

/// Deep copy (Swift value semantics).
export function cloneFaceFrame(f: FaceFrame): FaceFrame {
  return {
    ...f,
    pose: f.pose.copy(),
    color: { ...f.color },
    closureScale: { ...f.closureScale },
    stageOffset: { ...f.stageOffset },
    eyeStageOffset: { ...f.eyeStageOffset },
    pupilShape: { ...f.pupilShape },
    pupilMorph: { ...f.pupilMorph },
    pupilShapeScale: { ...f.pupilShapeScale },
    brows: f.brows.copy(),
    browOffset: { ...f.browOffset },
    backgroundColor: { ...f.backgroundColor },
    glowColor: { ...f.glowColor },
    glowColor2: { ...f.glowColor2 },
    glowPhase: { ...f.glowPhase },
  };
}

/// Anything that can produce a frame for a presentation timestamp (seconds, monotonic).
/// The renderer's frame loop calls this once per frame.
export interface FaceFrameSource {
  frame(presentationTime: number): FaceFrame;
}

/// Canvas geometry constants (PyCozmo procedural face), in canvas units.
export const Canvas = {
  width: 128,
  height: 64,
  eyeWidth: 28,
  eyeHeight: 40,
  /// Horizontal distance of each eye centre from the canvas centre.
  eyeSpacing: 25,
  /// Base corner radius; radius params are fractions of this.
  cornerRadius: 12.8,
  /// Pose `center_x` → canvas units multiplier.
  xFactor: 0.55,
  /// Pose `center_y` → canvas units multiplier.
  yFactor: 0.25,
  /// Lid bend chord half-width at scale 1.
  lidBendHalfWidth: 16.8,
} as const;

/// Converts canvas-unit amplitudes into pose units. Author all modifier amplitudes in canvas units.
export const Units = {
  poseX: (canvas: number): number => canvas / Canvas.xFactor,
  poseY: (canvas: number): number => canvas / Canvas.yFactor,
  canvasX: (pose: number): number => pose * Canvas.xFactor,
  canvasY: (pose: number): number => pose * Canvas.yFactor,
} as const;
