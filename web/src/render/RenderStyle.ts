// Port of FaceRendering/RenderStyle.swift and RenderStyle+Codable.swift.
import type { V3 } from '../core/vec';
import { FaceFrame } from '../model/FaceFrame';
import { Oklab } from '../model/Oklab';

/// Visual style knobs for the flat, inky cartoon eyes. All lengths in canvas units unless noted. Colours are
/// **linear** RGB 0...1; the sRGB hex each default was authored as is noted alongside.
// port-note: the deprecated alias fields (outlineColor, highlight*, glow*) are dropped; nothing uses them.
export interface RenderStyle {
  // Theme colours
  /// Sclera fill. sRGB #FBF4E4.
  scleraColor: V3;
  /// Ink: the bold line inside each eye's rim and the pupil's ink edge. sRGB #000000.
  inkColor: V3;
  /// Thin outer rim band, outside the ink. sRGB #131313.
  rimColor: V3;
  /// Pupil fill. sRGB #0B0B0D.
  pupilColor: V3;
  /// Pie-cut notch on the pupil. sRGB #FBF4E4.
  notchColor: V3;
  /// Base crescent colour at the playful baseline mood. sRGB #5BB3C4. Mood shifts it.
  crescentColor: V3;
  /// Theme background. sRGB #000000.
  backgroundColor: V3;
  // Background (mood background design)
  /// Edge darkening 0…1: background × `1 − v · smoothstep(inner, 0.95, r)`.
  backgroundVignette: number;
  /// Where the vignette ramp starts (r, 0…0.9).
  backgroundVignetteInner: number;
  /// Largest relative luminance (Y, after brightness) the background may reach.
  backgroundMaxLuminance: number;
  /// OLED power budget: largest average picture level the background may add. 0 = uncapped.
  backgroundAPLBudget: number;
  /// Mood anchor colour, linear RGB (default `FaceFrame.defaultColor`).
  color: V3;
  /// How much of the engine's mood-driven colour to use (mixed in Oklab).
  moodColorAmount: number;
  // Rim and ink
  rimWidth: number;
  /// Distance between the two eyes as a multiple of the model's spacing.
  eyeSpacing: number;
  inkWidth: number;
  // Shape
  /// Egg taper: 0 = symmetric oval; > 0 narrower top, rounder/wider bottom.
  eggTaper: number;
  /// Left / right eye size ratio.
  eyeAsymmetry: number;
  /// Tilt of the eye pair (degrees, + = counter-clockwise on screen).
  pairTilt: number;
  /// Extra lean of each eye about its own centre (degrees).
  eyeLean: number;
  /// Multiplier on corner radii.
  roundness: number;
  /// 0 = authored rounded-rect corners, 1 = full ellipse.
  ovalness: number;
  /// Lid coverage below this (fraction of eye height) doesn't cut the oval.
  lidDeadZone: number;
  eyeScale: number;
  faceScale: number;
  /// Extra multiplier in portrait orientation (limited so the envelope fits).
  portraitScale: number;
  /// Peak luminance cap for the eye colours.
  maxLuminance: number;
  // Pupil
  pupilScale: number;
  pupilAspect: number;
  pupilInkWidth: number;
  // Notch and crescent
  notchEnabled: boolean;
  notchSize: number;
  notchAngle: number;
  notchSpread: number;
  crescentWidth: number;
  crescentStrength: number;
  crescentAngle: number;
  /// Draw the mood accent on stars and hearts.
  shapeMoodAccent: boolean;
  // Eyebrows
  browsEnabled: boolean;
  browInk: boolean;
  browInkAuto: boolean;
  browLength: number;
  browThickness: number;
  browGap: number;
  browMinGap: number;
  browThickestAt: number;
  browInnerTip: number;
  browOuterTip: number;
  // Shading (off in the flat cartoon look)
  irisTint: number;
  interiorGradient: number;
  lidShadow: number;
  lidShadowWidth: number;
  /// Rounds the corners where a lid meets the eye's edge (smooth-max k). 0 = sharp.
  junctionSoftness: number;
  /// Thinnest the eye may get when fully closed (canvas units).
  minLineThickness: number;
}

const linear = (hex: number): V3 => Oklab.linear(hex);

/// Swift `RenderStyle()`.
export function makeRenderStyle(): RenderStyle {
  return {
    scleraColor: linear(0xfbf4e4), inkColor: linear(0x000000), rimColor: linear(0x131313),
    pupilColor: linear(0x0b0b0d), notchColor: linear(0xfbf4e4), crescentColor: linear(0x5bb3c4),
    backgroundColor: linear(0x000000),
    backgroundVignette: 1, backgroundVignetteInner: 0.1, backgroundMaxLuminance: 0.42, backgroundAPLBudget: 0,
    color: { ...FaceFrame.defaultColor }, moodColorAmount: 1,
    rimWidth: 0.6, eyeSpacing: 0.85, inkWidth: 0.15,
    eggTaper: 0.34, eyeAsymmetry: 1.1, pairTilt: -6, eyeLean: -5, roundness: 1.5, ovalness: 0.97, lidDeadZone: 0.05,
    eyeScale: 1.18, faceScale: 1.0, portraitScale: 1.15, maxLuminance: 0.95,
    pupilScale: 1.16, pupilAspect: 1.24, pupilInkWidth: 0.55,
    notchEnabled: true, notchSize: 0.36, notchAngle: 32, notchSpread: 46,
    crescentWidth: 0.15, crescentStrength: 1, crescentAngle: 235, shapeMoodAccent: true,
    browsEnabled: false, browInk: false, browInkAuto: true, browLength: 0.8, browThickness: 0.22, browGap: 0.0,
    browMinGap: 0.05, browThickestAt: 0.32, browInnerTip: 0.5, browOuterTip: 0.12,
    irisTint: 0, interiorGradient: 0, lidShadow: 0, lidShadowWidth: 2.4, junctionSoftness: 1.2, minLineThickness: 1.6,
  };
}

const COLOR_FIELDS = ['scleraColor', 'inkColor', 'rimColor', 'pupilColor', 'notchColor', 'crescentColor',
  'backgroundColor'] as const;
const FLOAT_FIELDS = ['moodColorAmount', 'rimWidth', 'eyeSpacing', 'inkWidth', 'eggTaper', 'eyeAsymmetry', 'pairTilt',
  'eyeLean', 'roundness', 'ovalness', 'lidDeadZone', 'eyeScale', 'faceScale', 'portraitScale', 'maxLuminance',
  'pupilScale', 'pupilAspect', 'pupilInkWidth', 'notchSize', 'notchAngle', 'notchSpread', 'crescentWidth',
  'crescentStrength', 'crescentAngle', 'irisTint', 'interiorGradient', 'lidShadow', 'lidShadowWidth',
  'junctionSoftness', 'minLineThickness', 'backgroundVignette', 'backgroundVignetteInner', 'backgroundMaxLuminance',
  'backgroundAPLBudget', 'browLength', 'browThickness', 'browGap', 'browMinGap', 'browThickestAt', 'browInnerTip',
  'browOuterTip'] as const;
const BOOL_FIELDS = ['notchEnabled', 'shapeMoodAccent', 'browInkAuto', 'browsEnabled', 'browInk'] as const;

export const RenderStyle = {
  make: makeRenderStyle,
  /// Deep copy (Swift value semantics).
  clone(s: RenderStyle): RenderStyle {
    const o = { ...s };
    for (const k of COLOR_FIELDS) o[k] = { ...s[k] };
    o.color = { ...s.color };
    return o;
  },
  /// Every proportion knob neutral: the plain PyCozmo geometry, for golden comparisons.
  get neutralGeometry(): RenderStyle {
    return { ...makeRenderStyle(), eggTaper: 0, eyeAsymmetry: 1, pairTilt: 0, eyeLean: 0, pupilScale: 1,
      pupilAspect: 1, eyeSpacing: 1 };
  },
  /// The reference artwork measured pixel by pixel; the defaults already match it.
  get referenceMeasured(): RenderStyle { return makeRenderStyle(); },
  /// Sticker variant: thin ivory outer rim around a bold black ink line.
  get ivoryRim(): RenderStyle {
    return { ...makeRenderStyle(), rimColor: linear(0xfbf4e4), rimWidth: 0.35, inkWidth: 1.3 };
  },
  /// Background Oklab lightness range over which automatic ink brows crossfade from ivory to ink.
  browInkLightness: { lowerBound: 0.28, upperBound: 0.38 },
  /// The smallest brow tip radius in pixels.
  browMinTipPixels: 0.75,
  /// Largest Oklab lightness the iris ring may reach.
  irisMaxLightness: 0.35,
  linear,

  /// Tolerant decode (Swift `init(from:)`): missing or unreadable keys keep their defaults; colours are linear
  /// `[r, g, b]`. `color` and the deprecated fields are never read.
  decode(json: unknown): RenderStyle {
    const s = makeRenderStyle();
    if (typeof json !== 'object' || json === null) return s;
    const j = json as Record<string, unknown>;
    for (const k of COLOR_FIELDS) {
      const v = j[k];
      if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        s[k] = { x: v[0], y: v[1], z: v[2] };
      }
    }
    for (const k of FLOAT_FIELDS) {
      const v = j[k];
      if (typeof v === 'number' && Number.isFinite(v)) s[k] = v;
    }
    for (const k of BOOL_FIELDS) {
      const v = j[k];
      if (typeof v === 'boolean') s[k] = v;
    }
    return s;
  },

  /// Swift `encode(to:)`.
  encode(s: RenderStyle): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const k of COLOR_FIELDS) o[k] = [s[k].x, s[k].y, s[k].z];
    for (const k of FLOAT_FIELDS) o[k] = s[k];
    for (const k of BOOL_FIELDS) o[k] = s[k];
    return o;
  },
} as const;
