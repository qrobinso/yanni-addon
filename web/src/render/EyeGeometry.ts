// Port of FaceRendering/EyeGeometry.swift.
import { v2, v3, v4, type V2, type V3, type V4 } from '../core/vec';
import { Canvas, FaceFrame, Units } from '../model/FaceFrame';
import { FacePose } from '../model/FacePose';
import type { Side } from '../model/ParamLayout';
import { PupilShape } from '../model/PupilShape';
import { Oklab } from '../model/Oklab';
import { brow, browClearance, arch, browProfile, smaxLift } from './BrowGeometry';
import { EyeSDF } from './EyeSDF';
import { PupilSolver, ScleraShape } from './PupilGeometry';
import { RenderStyle } from './RenderStyle';
import { EyeUniforms, FrameUniforms } from './RenderUniforms';
import { Viewport } from './Viewport';

/// Pure conversion of a `FaceFrame` + viewport + style into GPU uniforms. Unit-tested; mirrored on the CPU by
/// `EyeSDF`.
// shortcut: small temporaries (V2 objects, closures) are allocated per call; the uniform buffer itself is reused.
// Upgrade to scratch objects if a profile on the tablet shows GC pauses.

/// Rotation counter-clockwise on screen, in y-down coordinates.
const rotate = (v: V2, c: number, s: number): V2 => v2(v.x * c + v.y * s, -v.x * s + v.y * c);
const radians = (deg: number): number => deg * Math.PI / 180;
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};
const clamp01v = (c: V3): V3 => v3(Math.min(Math.max(c.x, 0), 1), Math.min(Math.max(c.y, 0), 1), Math.min(Math.max(c.z, 0), 1));
const setV4 = (o: V4, x: number, y: number, z: number, w: number): void => { o.x = x; o.y = y; o.z = z; o.w = w; };
const setRGB = (o: V4, c: V3, w = 0): void => setV4(o, c.x, c.y, c.z, w);

/// Rec. 709 relative luminance of a linear colour.
const luminance = (c: V3): number => 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;

/// `c` × brightness, scaled down if its luminance would exceed `maxLuminance` (OLED cap).
function lit(c: V3, brightness: number, maxLuminance: number): V3 {
  const k = clamp01v(c);
  const v = v3(k.x * brightness, k.y * brightness, k.z * brightness);
  const y = luminance(v);
  if (y > maxLuminance && y > 1e-6) { const s = maxLuminance / y; v.x *= s; v.y *= s; v.z *= s; }
  return v;
}

/// Sanitised closure scale (finite, positive).
const closure = (c: V2): V2 => v2(Number.isFinite(c.x) ? Math.min(Math.max(c.x, 0.05), 4) : 1,
  Number.isFinite(c.y) ? Math.min(Math.max(c.y, 0.05), 4) : 1);

/// Full frame uniforms, written into `u` (a fresh one when omitted).
function uniforms(frame: FaceFrame, viewport: Viewport, style: RenderStyle, u = new FrameUniforms()): FrameUniforms {
  const ppu = viewport.pixelsPerUnit;
  setV4(u.viewport, viewport.size.x, viewport.size.y, ppu, 1 / ppu);
  const brightness = Math.min(Math.max(Number.isFinite(frame.brightness) ? frame.brightness : 1, 0), 1);
  const cap = Math.max(style.maxLuminance, 0);
  const vignette = Number.isFinite(style.backgroundVignette) ? Math.min(Math.max(style.backgroundVignette, 0), 1) : 1;
  const bg = background(frame, style, viewport.size.x / Math.max(viewport.size.y, 1));
  setRGB(u.background, bg, vignette);
  setV4(u.vignette, vignetteInner(style), vignetteOuter, 0, 0);
  glow(frame, style, bg, viewport, u);
  setV4(u.shading, Math.max(style.interiorGradient, 0), Math.min(Math.max(style.lidShadow, 0), 1),
    Math.max(style.lidShadowWidth, 0.01), 1.0 / 255.0);
  const tint = Number.isFinite(style.irisTint) ? Math.min(Math.max(style.irisTint, 0), 1) : 0;
  const crescentStrength = Number.isFinite(style.crescentStrength) ? Math.min(Math.max(style.crescentStrength, 0), 1) : 0;
  setV4(u.misc, style.shapeMoodAccent ? 1 : 0, style.notchEnabled ? 1 : 0, tint, crescentStrength);

  setRGB(u.sclera, lit(style.scleraColor, brightness, cap));
  setRGB(u.ink, lit(style.inkColor, brightness, cap));
  setRGB(u.rim, lit(style.rimColor, brightness, cap));
  setRGB(u.notch, lit(style.notchColor, brightness, cap));
  setRGB(u.crescent, lit(style.crescentColor, brightness, cap));
  const accents = pupilAccents(style);
  Object.assign(u.notchLine1, accents.line1);
  Object.assign(u.notchLine2, accents.line2);
  Object.assign(u.crescentDisc, accents.disc);

  // Pupil and iris ring in Oklab (M3); brightness applied after converting back to linear.
  const pupil = clamp01v(style.pupilColor);
  const pupilLab = Oklab.fromLinear(pupil);
  const py = luminance(pupil);
  const pupilScale = py * brightness > cap && py > 1e-6 ? cap / py : brightness;
  setRGB(u.pupilLab, pupilLab, pupilScale);
  // Iris colour = resolved mood/style colour (M4), lightness capped, chroma limited to the gamut at that lightness.
  const src = Oklab.fromLinear(clamp01v(style.color));
  const irisL = Math.min(src.x, RenderStyle.irisMaxLightness);
  const chroma = Oklab.maxChroma(src, irisL);
  const c0 = Math.sqrt(src.y * src.y + src.z * src.z);
  const dx = c0 > 1e-6 ? src.y / c0 : 0, dy = c0 > 1e-6 ? src.z / c0 : 0;
  setV4(u.irisLab, irisL, dx * chroma, dy * chroma, 0);

  const cs = closure(frame.closureScale);
  eye('left', frame.pose, viewport, style, cs, stageOffset(frame, 'left'), shapeUniform(frame, 'left'), u.left);
  eye('right', frame.pose, viewport, style, cs, stageOffset(frame, 'right'), shapeUniform(frame, 'right'), u.right);
  // brow() resets an invisible brow when the style has brows off (the buffer is reused).
  brow('left', frame, u.left, viewport, style, u.browLeft);
  brow('right', frame, u.right, viewport, style, u.browRight);
  if (style.browsEnabled) {
    const ink = browInkAmount(style, bg);
    u.browLeft.bands.z = ink;
    u.browRight.bands.z = ink;
  }
  return u;
}

// Background (mood background design)

/// Outer radius of the vignette ramp (r = 0 at the centre, 1 in the corners).
const vignetteOuter = 0.95;

/// Sanitised start of the vignette ramp.
const vignetteInner = (style: RenderStyle): number =>
  Number.isFinite(style.backgroundVignetteInner) ? Math.min(Math.max(style.backgroundVignetteInner, 0), 0.9) : 0.1;

/// The background colour (linear, before the vignette): theme mixed toward the mood colour by `backgroundStrength`,
/// times presence and brightness, then held under `backgroundMaxLuminance` and the OLED APL budget.
function background(frame: FaceFrame, style: RenderStyle, aspect: number): V3 {
  const unit = (v: number, fallback: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : fallback);
  const colour = (c: V3) => (Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z) ? clamp01v(c) : v3(0));
  const theme = colour(style.backgroundColor);
  const mood = colour(frame.backgroundColor);
  const k = unit(frame.backgroundStrength, 0);
  let c = v3(theme.x + (mood.x - theme.x) * k, theme.y + (mood.y - theme.y) * k, theme.z + (mood.z - theme.z) * k);
  const m = unit(frame.backgroundPresence, 1) * unit(frame.backgroundBrightness, 1);
  c = v3(c.x * m, c.y * m, c.z * m);
  const cap = Number.isFinite(style.backgroundMaxLuminance) ? Math.max(style.backgroundMaxLuminance, 0) : 0.3;
  let y = luminance(c);
  if (y > cap) { c = capLuminance(c, cap); y = luminance(c); }
  const budget = Number.isFinite(style.backgroundAPLBudget) ? Math.max(style.backgroundAPLBudget, 0) : 0;
  if (budget > 0) {
    const vignette = Number.isFinite(style.backgroundVignette) ? Math.min(Math.max(style.backgroundVignette, 0), 1) : 1;
    const apl = y * vignetteMean(vignette, vignetteInner(style), aspect);
    if (apl > budget) { const s = budget / apl; c = v3(c.x * s, c.y * s, c.z * s); }
  }
  return c;
}

// Listening glow (listening glow design)

/// Peak opacity of the glow at level 1, before the luminance-step cut.
const glowOpacity = 0.9;
/// Largest relative-luminance change the glow may make anywhere.
const glowMaxLuminanceStep = 0.34;

/// Fills the glow uniforms (left zero, so the shader skips it, while the frame's glow level is 0).
function glow(frame: FaceFrame, style: RenderStyle, bg: V3, viewport: Viewport, u: FrameUniforms): void {
  setV4(u.glow, 0, 0, 0, 0);
  setV4(u.glowPhase, 0, 0, 0, 0);
  setV4(u.glowColorA, 0, 0, 0, 0);
  setV4(u.glowColorB, 0, 0, 0, 0);
  const level = Number.isFinite(frame.glowLevel) ? Math.min(Math.max(frame.glowLevel, 0), 1.5) : 0;
  const height = Number.isFinite(frame.glowHeight) ? Math.min(Math.max(frame.glowHeight, 0), 0.4) : 0;
  if (!(level > 0 && height > 0)) return;
  const b = Number.isFinite(frame.backgroundBrightness) ? Math.min(Math.max(frame.backgroundBrightness, 0), 1) : 1;
  const cap = Number.isFinite(style.maxLuminance) ? Math.max(style.maxLuminance, 0) : 0.95;
  const colour = (c: V3) => (Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z) ? lit(c, b, cap) : v3(0));
  const a = colour(frame.glowColor), c = colour(frame.glowColor2);
  const motion = Number.isFinite(frame.glowMotion) ? Math.min(Math.max(frame.glowMotion, 0), 1) : 0;
  const step = Math.max(Math.abs(luminance(a) - luminance(bg)), Math.abs(luminance(c) - luminance(bg))) * (1 + 0.22 * motion);
  const opacity = Math.min(glowOpacity * level, step > 1e-6 ? glowMaxLuminanceStep / step : glowOpacity * level);
  if (!(opacity > 0)) return;
  const ripple = Number.isFinite(frame.glowRipple) ? Math.min(Math.max(frame.glowRipple, 0), motion) : 0;
  setV4(u.glow, opacity, height * viewport.size.y, motion, ripple);
  const p = frame.glowPhase;
  if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && Number.isFinite(p.w)) setV4(u.glowPhase, p.x, p.y, p.z, p.w);
  setRGB(u.glowColorA, a);
  setRGB(u.glowColorB, c);
}

/// Lowers a colour's Oklab lightness (hue kept, chroma kept where the gamut allows) until its luminance is `cap`.
function capLuminance(c: V3, cap: number): V3 {
  const lab = Oklab.fromLinear(c);
  if (!(Number.isFinite(lab.x) && Number.isFinite(lab.y) && Number.isFinite(lab.z) && cap > 0)) return v3(0);
  const at = (l: number): V3 => {
    const fit = Oklab.maxChroma(lab, l, 12);
    const n = Math.sqrt(lab.y * lab.y + lab.z * lab.z);
    const k = n > 1e-6 ? fit / n : 0;
    return Oklab.toLinearClamped(v3(l, lab.y * k, lab.z * k), v3(0));
  };
  let lo = 0, hi = lab.x;
  for (let i = 0; i < 14; i++) {
    const mid = 0.5 * (lo + hi);
    if (luminance(at(mid)) > cap) hi = mid; else lo = mid;
  }
  return at(lo);
}

/// Mean of the vignette factor over a screen of this aspect (w / h): 8 × 8 midpoint quadrature over one quadrant.
function vignetteMean(v: number, inner = 0.1, aspect: number): number {
  if (!(v > 0)) return 1;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 4.0 / 3.0;
  const hx = a, hy = 1;
  const diag = Math.sqrt(hx * hx + hy * hy);
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const x = (i + 0.5) / 8 * hx, y = (j + 0.5) / 8 * hy;
      sum += smoothstep(inner, vignetteOuter, Math.sqrt(x * x + y * y) / diag);
    }
  }
  return 1 - v * sum / 64;
}

/// The brow fill's ink amount 0…1.
function browInkAmount(style: RenderStyle, c: V3): number {
  if (style.browInk) return 1;
  if (!style.browInkAuto) return 0;
  const l = Oklab.fromLinear(c).x;
  const r = RenderStyle.browInkLightness;
  return Number.isFinite(l) ? smoothstep(r.lowerBound, r.upperBound, l) : 0;
}

/// Sanitised pupil transformation of one eye: (shape id, morph, scale x, scale y). An ellipse always has morph 0.
function shapeUniform(frame: FaceFrame, side: Side): V4 {
  const shape = FaceFrame.shape(frame, side);
  const m = FaceFrame.morph(frame, side);
  const morph = shape === PupilShape.ellipse || !Number.isFinite(m) ? 0 : Math.min(Math.max(m, 0), 1);
  const sc = FaceFrame.shapeScale(frame, side);
  const c = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0.02), 1) : 1);
  return v4(morph > 0 ? shape : 0, morph, c(sc.x), c(sc.y));
}

/// Sanitised total stage offset of one eye (canvas units).
function stageOffset(frame: FaceFrame, side: Side): V2 {
  const v = FaceFrame.stage(frame, side);
  const c = (x: number) => (Number.isFinite(x) ? Math.min(Math.max(x, -1000), 1000) : 0);
  return v2(c(v.x), c(v.y));
}

/// Offset-shape lid blend ranges.
const shapeLidCoverage = { lowerBound: 0.06, upperBound: 0.25 };
const shapeLidAngle = { lowerBound: 3, upperBound: 12 };
const shapeLidBend = { lowerBound: 0.03, upperBound: 0.15 };

/// Eye-local unit direction for a screen angle in degrees (counter-clockwise from +x, screen-up positive).
function direction(deg: number): V2 {
  const r = radians(Number.isFinite(deg) ? deg : 0);
  return v2(Math.cos(r), -Math.sin(r));
}

/// Notch apex turn: the apex sits this many notch spreads further round than the rim arc's centre.
const notchApexTurn = 0.7;
/// Crescent span control.
const crescentSpan = 1.8;
/// The retracted notch clears a disc this much larger than the pupil's ink-inset ellipse.
const notchRetractClear = 1.06;
const retractCircle: readonly V2[] = Array.from({ length: 192 }, (_, i) => {
  const t = i / 192 * 2 * Math.PI;
  return v2(Math.cos(t) * notchRetractClear, Math.sin(t) * notchRetractClear);
});

/// Notch wedge lines and crescent disc, in pupil-normalised coordinates. Style-only, so the same for both eyes.
function pupilAccents(style: RenderStyle): { line1: V4; line2: V4; disc: V4 } {
  const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
  const spread = Math.min(Math.max(finite(style.notchSpread, 42), 1), 120);
  const centre = finite(style.notchAngle, 32);
  const size = Math.min(Math.max(finite(style.notchSize, 0.4), 0.02), 0.95);
  const p1 = direction(centre + spread / 2), p2 = direction(centre - spread / 2);
  const ad = direction(centre + notchApexTurn * spread);
  const apex = v2(ad.x * (1 - size), ad.y * (1 - size));
  // Line through the apex and a rim point, oriented so the other rim point is on its inside (n·q − c < 0).
  const line = (p: V2, other: V2): V4 => {
    const dx = p.x - apex.x, dy = p.y - apex.y;
    const l = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-6);
    let nx = -dy / l, ny = dx / l;
    let c = nx * apex.x + ny * apex.y;
    if (nx * other.x + ny * other.y - c > 0) { nx = -nx; ny = -ny; c = -c; }
    return v4(nx, ny, c, 0);
  };
  const w = Math.min(Math.max(finite(style.crescentWidth, 0.15), 0), 0.6);
  const k = crescentSpan * w;
  const dirC = direction(finite(style.crescentAngle, 235));
  // The disc's edge sits w inside the rim along dirC; elsewhere the crescent thins to nothing.
  const centreC = v2(-dirC.x * (k + w), -dirC.y * (k + w));
  const l1 = line(p1, p2), l2 = line(p2, p1);
  // Retraction: slide the wedge out along its axis (the bisector of its two sides) until it clears the disc.
  const a1x = p1.x - apex.x, a1y = p1.y - apex.y, a2x = p2.x - apex.x, a2y = p2.y - apex.y;
  const n1 = Math.max(Math.sqrt(a1x * a1x + a1y * a1y), 1e-6), n2 = Math.max(Math.sqrt(a2x * a2x + a2y * a2y), 1e-6);
  let axx = a1x / n1 + a2x / n2, axy = a1y / n1 + a2y / n2;
  const an = Math.max(Math.sqrt(axx * axx + axy * axy), 1e-6);
  axx /= an; axy /= an;
  const axis = v2(axx, axy);
  const dist = notchRetractDistance(l1, l2, axis);
  l1.w = (l1.x * axis.x + l1.y * axis.y) * dist;
  l2.w = (l2.x * axis.x + l2.y * axis.y) * dist;
  return { line1: l1, line2: l2, disc: v4(centreC.x, centreC.y, 1 + k, 0) };
}

/// Smallest slide along `axis` after which the wedge no longer touches the disc of radius `notchRetractClear`.
function notchRetractDistance(l1: V4, l2: V4, axis: V2): number {
  const k1 = l1.x * axis.x + l1.y * axis.y, k2 = l2.x * axis.x + l2.y * axis.y;
  const clear = (d: number): boolean => {
    const c1 = l1.z + k1 * d, c2 = l2.z + k2 * d;
    for (const q of retractCircle) {
      if (l1.x * q.x + l1.y * q.y - c1 < 0 && l2.x * q.x + l2.y * q.y - c2 < 0) return false;
    }
    return true;
  };
  let lo = 0, hi = 4;
  if (!clear(hi)) return hi;
  for (let i = 0; i < 18; i++) {
    const mid = 0.5 * (lo + hi);
    if (clear(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

/// Egg taper used for the geometry (clamped to `ScleraShape.maxTaper`).
const taper = (style: RenderStyle): number =>
  Number.isFinite(style.eggTaper) ? Math.min(Math.max(style.eggTaper, 0), ScleraShape.maxTaper) : 0;

/// The part of a bent lid's boundary that lies inside the eye box: the arc's tip angles (ψ right, ψ left) and the
/// chord segments beyond the ellipse on each side.
function lidClip(pivotY: number, c: number, s: number, L: number, a: number, b: number, box: V2): { psi: V2; rays: V4 } {
  const toEye = (qx: number, qy: number): V2 => v2(qx * c + qy * s, pivotY - qx * s + qy * c);
  const inside = (p: V2) => Math.abs(p.x) <= box.x + 1e-4 && Math.abs(p.y) <= box.y + 1e-4;
  const arcPt = (psi: number) => toEye(a * Math.cos(psi), L + b * Math.sin(psi));
  const top = Math.PI / 2;
  // Bisect for the first angle (from the chord end towards the top) whose arc point is inside.
  const tip = (end: number): number => {
    if (inside(arcPt(end))) return end;
    if (!inside(arcPt(top))) return top;
    let out = end, inn = top;
    for (let i = 0; i < 24; i++) {
      const mid = (out + inn) / 2;
      if (inside(arcPt(mid))) inn = mid; else out = mid;
    }
    return inn;
  };
  const psi = b > 1e-3 ? v2(tip(0), tip(Math.PI)) : v2(0, Math.PI);

  // Chord line P(t) = P0 + t·d, slab-clipped to the box.
  const p0 = toEye(0, L);
  const d = v2(c, -s);
  let tMin = -Number.MAX_VALUE, tMax = Number.MAX_VALUE;
  for (const i of ['x', 'y'] as const) {
    if (Math.abs(d[i]) < 1e-6) {
      if (Math.abs(p0[i]) > box[i]) { tMin = 1; tMax = 0; }
    } else {
      const t1 = (-box[i] - p0[i]) / d[i], t2 = (box[i] - p0[i]) / d[i];
      tMin = Math.max(tMin, Math.min(t1, t2)); tMax = Math.min(tMax, Math.max(t1, t2));
    }
  }
  const rays = v4(0, 0, 0, 0);
  if (tMax > tMin) {
    const ps = Math.max(a, tMin), pe = tMax;
    if (pe > ps) { rays.x = ps; rays.y = pe; }
    const ns = Math.max(a, -tMax), ne = -tMin;
    if (ne > ns) { rays.z = ns; rays.w = ne; }
  }
  return { psi, rays };
}

/// The sclera rounded box for eye scale (sx, sy) (style scale included).
function sclera(side: Side, pose: FacePose, style: RenderStyle, sx: number, sy: number): ScleraShape {
  const minHalf = Math.max(style.minLineThickness, 0) / 2;
  const hx = Math.max(Canvas.eyeWidth / 2 * sx, minHalf), hy = Math.max(Canvas.eyeHeight / 2 * sy, minHalf);
  const radii = (fx: number, fy: number): V2 => {
    const k = Canvas.cornerRadius * Math.max(style.roundness, 0);
    const rx = fx * k * sx;
    const ryRaw = fy * k;
    const ry = Math.max(ryRaw * sy, Math.min(ryRaw * sx, hy));
    // Ovalness blends every corner toward the half-extents (soft ovals, per-expression corners still show).
    const o = Math.min(Math.max(style.ovalness, 0), 1);
    const r0x = Math.min(rx, hx), r0y = Math.min(ry, hy);
    return v2(Math.max(r0x + (hx - r0x) * o, 1e-3), Math.max(r0y + (hy - r0y) * o, 1e-3));
  };
  // Inner = side facing the other eye: +x for the left eye, −x for the right eye.
  const upperInner = radii(pose.eye(side, 'upperInnerRadiusX'), pose.eye(side, 'upperInnerRadiusY'));
  const upperOuter = radii(pose.eye(side, 'upperOuterRadiusX'), pose.eye(side, 'upperOuterRadiusY'));
  const lowerInner = radii(pose.eye(side, 'lowerInnerRadiusX'), pose.eye(side, 'lowerInnerRadiusY'));
  const lowerOuter = radii(pose.eye(side, 'lowerOuterRadiusX'), pose.eye(side, 'lowerOuterRadiusY'));
  const [ul, ur, ll, lr] = side === 'left'
    ? [upperOuter, upperInner, lowerOuter, lowerInner]
    : [upperInner, upperOuter, lowerInner, lowerOuter];
  return new ScleraShape(v2(hx, hy), v4(ul.x, ul.y, ur.x, ur.y), v4(ll.x, ll.y, lr.x, lr.y), taper(style));
}

/// Where the visible opening starts and ends along column `x` (eye-local, actual frame). `top > bottom` when shut.
function opening(e: EyeUniforms, x: number): { top: number; bottom: number } {
  const shape = ScleraShape.of(e);
  const cx = Math.min(Math.max(x, -e.box.x * 0.999), e.box.x * 0.999);
  const ext = shape.verticalExtent(cx);
  if (!ext) return { top: 0, bottom: 0 };
  const edge = (upper: boolean): number => {
    // f < 0 inside the lid region. The upper lid covers from the top, the lower from the bottom.
    const f = (y: number) => EyeSDF.lidField(v2(cx, y), e, upper) + e.box.z;
    const covered = upper ? ext.top : ext.bottom, open = upper ? ext.bottom : ext.top;
    if (f(covered) >= 0) return covered;
    if (f(open) < 0) return open;
    let inLid = covered, outLid = open;
    for (let i = 0; i < 22; i++) {
      const mid = 0.5 * (inLid + outLid);
      if (f(mid) < 0) inLid = mid; else outLid = mid;
    }
    return 0.5 * (inLid + outLid);
  };
  return { top: edge(true), bottom: edge(false) };
}

/// Lid keep-visible band (H2), in pupil y-radii (plus the outline width) inside the lid edges.
const lidKeepInset = 0.25;

/// Soft clamp of `x` into [lo, hi] with an exponential knee: C¹, monotone, never leaves the band.
function softBand(x: number, lo: number, hi: number, knee: number): number {
  if (!(hi > lo)) return 0.5 * (lo + hi);
  const k = Math.min(Math.max(knee, 1e-4), 0.5 * (hi - lo));
  if (x > hi - k) return hi - k * Math.exp(-(x - (hi - k)) / k);
  if (x < lo + k) return lo + k * Math.exp((x - (lo + k)) / k);
  return x;
}

/// Uniforms for one eye (written into `e`, a fresh one when omitted). `closureScale` is the blink / lid-close
/// squash already included in `pose`; `stage` the eye's total stage offset (canvas units).
function eye(side: Side, pose: FacePose, viewport: Viewport, style: RenderStyle, closureScale: V2 = v2(1),
  stage: V2 = v2(0), shape: V4 = v4(0, 0, 1, 1), e = new EyeUniforms()): EyeUniforms {
  const fcx = pose.face('centerX'), fcy = pose.face('centerY');
  const fsx = pose.face('scaleX'), fsy = pose.face('scaleY');
  // The style's pair tilt acts like an extra face angle: both eye positions and shapes turn with it.
  const fa = radians(pose.face('angle') + (Number.isFinite(style.pairTilt) ? style.pairTilt : 0));

  // Eye centre: canvas centre + face offset + face rotation ∘ face scale of the eye's rest position.
  const sign = side === 'left' ? -1 : 1;
  const relX = sign * Canvas.eyeSpacing * Math.min(Math.max(style.eyeSpacing, 0.5), 1.5) + Units.canvasX(pose.eye(side, 'centerX'));
  const relY = Units.canvasY(pose.eye(side, 'centerY'));
  const rotated = rotate(v2(relX * fsx, relY * fsy), Math.cos(fa), Math.sin(fa));
  const cc = Viewport.canvasCenter;
  const centerPx = viewport.pixel(v2(cc.x + Units.canvasX(fcx) + rotated.x + stage.x,
    cc.y + Units.canvasY(fcy) + rotated.y + stage.y));

  const phi = fa + radians(pose.eye(side, 'angle') + (Number.isFinite(style.eyeLean) ? style.eyeLean : 0));
  Object.assign(e.shape, shape);
  setV4(e.placement, centerPx.x, centerPx.y, Math.cos(phi), Math.sin(phi));

  // Scaled eye box (H9). Asymmetry: the left eye is √ratio larger, the right √ratio smaller.
  const ratio = Number.isFinite(style.eyeAsymmetry) ? Math.min(Math.max(style.eyeAsymmetry, 0.5), 2) : 1;
  const asym = side === 'left' ? Math.sqrt(ratio) : 1 / Math.sqrt(ratio);
  const sx = Math.max(pose.eye(side, 'scaleX') * fsx * style.eyeScale * asym, 1e-3);
  const sy = Math.max(pose.eye(side, 'scaleY') * fsy * style.eyeScale * asym, 1e-3);
  const tp = taper(style);
  const hy0 = Canvas.eyeHeight / 2 * sy;
  const sc = sclera(side, pose, style, sx, sy);
  const hx = sc.half.x, hy = sc.half.y;
  Object.assign(e.radiiTop, sc.top);
  Object.assign(e.radiiBottom, sc.bottom);

  // Lids (H9), in the scaled eye box. Angles are corrected for non-uniform scale.
  const bendHalf = Canvas.lidBendHalfWidth * sx;
  // The egg's bottom reaches out to hx·(1 + taper/2): lid boundary there can border the visible eye.
  const box = v2(hx * (1 + 0.5 * tp), hy);
  const lid = (y: number, angleDeg: number, bend: number, lower: boolean) => {
    // Soft dead zone: below 2·lidDeadZone coverage eases in as f(y) = 2dz·g(y/2dz), g(t) = t²(2 − t).
    const dz = Math.min(Math.max(style.lidDeadZone, 0), 0.2);
    const yRaw = Math.min(Math.max(y, 0), 1);
    const knee = 2 * dz;
    const yy = knee > 0 && yRaw < knee ? (() => { const t = yRaw / knee; return knee * t * t * (2 - t); })() : yRaw;
    const th = radians(angleDeg);
    let slope = Math.atan2(Math.sin(th) * sy, Math.cos(th) * sx);
    if (lower) slope += Math.PI;
    const c = Math.cos(slope), s = Math.sin(slope);
    const pivotY = lower ? hy0 : -hy0;
    const L = Canvas.eyeHeight * sy * yy;
    // The same soft ease for bends.
    const bRaw = Math.min(Math.max(bend, 0), 1);
    const bk = 2 * Math.min(Math.max(style.lidDeadZone, 0), 0.2);
    const bb = bk > 0 && bRaw < bk ? (() => { const t = bRaw / bk; return bk * t * t * (2 - t); })() : bRaw;
    const depth = Canvas.eyeHeight * sy * (1 - yy) * bb;
    // Deepest point of the lid region along x = 0 of the lid frame, in eye-local coordinates.
    const deepest = v2((L + depth) * s, pivotY + (L + depth) * c);
    const clip = lidClip(pivotY, c, s, L, bendHalf, depth, box);
    // Small, level, unbent lids follow the sclera's own outline; the straight lid takes over as they grow.
    const weight = Math.max(smoothstep(shapeLidCoverage.lowerBound, shapeLidCoverage.upperBound, yRaw),
      smoothstep(shapeLidAngle.lowerBound, shapeLidAngle.upperBound, Math.abs(Number.isFinite(angleDeg) ? angleDeg : 90)),
      smoothstep(shapeLidBend.lowerBound, shapeLidBend.upperBound, bRaw));
    return { lid: v4(pivotY, c, s, L), bend: v4(bendHalf, depth, clip.psi.x, clip.psi.y), clip: clip.rays, deepest, weight };
  };
  const upper = lid(pose.eye(side, 'upperLidY'), pose.eye(side, 'upperLidAngle'), pose.eye(side, 'upperLidBend'), false);
  const lower = lid(pose.eye(side, 'lowerLidY'), pose.eye(side, 'lowerLidAngle'), pose.eye(side, 'lowerLidBend'), true);
  Object.assign(e.upperLid, upper.lid); Object.assign(e.upperBend, upper.bend); Object.assign(e.upperClip, upper.clip);
  Object.assign(e.lowerLid, lower.lid); Object.assign(e.lowerBend, lower.bend); Object.assign(e.lowerClip, lower.clip);
  setV4(e.lidBlend, upper.weight, lower.weight, upper.weight ** 3, lower.weight ** 3);

  // Closure guarantee (C4): erode both lids equally so a thin line remains. Continuous in the gap.
  const minLine = Math.max(style.minLineThickness, 0);
  const gap = lower.deepest.y - upper.deepest.y;
  const erosion = Math.max(0, (minLine - gap) / 2);

  // Cull: the shape lies inside the box; 2 px covers the anti-aliasing (L1).
  const hxMax = hx * (1 + 0.5 * tp);
  const halfDiag = Math.sqrt(hxMax * hxMax + hy * hy);
  setV4(e.box, hx, hy, erosion, halfDiag * viewport.pixelsPerUnit + 2);
  e.accent.x = tp;

  placePupil(e, side, pose, style, sx, sy, closure(closureScale), gap);

  // Junction rounding per lid (smooth-max k), faded in with how far the lid has come down into the eye.
  const descent = (l: V4, bend: V4, lowerLid: boolean): number => {
    const c = l.y, s = l.z, L = l.w;
    const p0x = L * s, p0y = l.x + L * c;
    let deepest = lowerLid ? -(p0y + bend.y * c) : p0y + bend.y * c;
    if (Math.abs(c) > 1e-4) {
      const yl = p0y - s * (-hx - p0x) / c, yr = p0y - s * (hx - p0x) / c;
      deepest = Math.max(deepest, lowerLid ? Math.max(-yl, -yr) : Math.max(yl, yr));
    }
    // Distance the lid edge reaches past its pivot edge.
    return deepest + hy0;
  };
  const k = Math.max(style.junctionSoftness, 0);
  // k also scales with the straight-lid weight (the offset-shape lid has no corner to round).
  e.outline.y = k * smoothstep(0, 2 * k, descent(e.upperLid, e.upperBend, false)) * e.lidBlend.x;
  e.outline.z = k * smoothstep(0, 2 * k, descent(e.lowerLid, e.lowerBend, true)) * e.lidBlend.y;
  return e;
}

/// Rim and ink widths for an opening of `aperture` units.
function bands(rim: number, ink: number, aperture: number): { rim: number; ink: number } {
  const a = Math.max(aperture, 0);
  const r = Math.min(rim, 0.25 * a);
  return { rim: r, ink: Math.min(ink, Math.max(0.5 * a - r, 0)) };
}

/// Pupil, effective rim / ink widths and pupil accents for an eye whose sclera and lids are already set.
function placePupil(e: EyeUniforms, side: Side, pose: FacePose, style: RenderStyle, sx: number, sy: number,
  cs: V2, gap: number): void {
  const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
  const rimW = Math.max(finite(style.rimWidth, 0), 0);
  const inkW = Math.max(finite(style.inkWidth, 0), 0);
  const band = rimW + inkW;
  const minLine = Math.max(style.minLineThickness, 0);

  // 1. Pre-closure sclera (H9): undo the closure squash and place the pupil there.
  const pre = sclera(side, pose, style, Math.max(sx / cs.x, 1e-3), Math.max(sy / cs.y, 1e-3));
  const size = Math.min(Math.max(finite(pose.eye(side, 'size'), 0.5), 0.05), 0.9) *
    Math.min(Math.max(finite(style.pupilScale, 1), 0.1), 2);
  const squash = Math.min(Math.max(finite(pose.eye(side, 'squash'), 0), 0), 0.6);
  const aspect = Math.min(Math.max(finite(style.pupilAspect, 1), 0.5), 2);
  const a = size * pre.half.x;
  const b = a * aspect * (1 - squash);
  const wCont = Math.min(band, 0.5 * Math.min(pre.half.x, pre.half.y));
  const v = v2(finite(pose.eye(side, 'x'), 0), finite(pose.eye(side, 'y'), 0));
  const placed = PupilSolver.place(pre, v, a, b, wCont);
  let c = placed.center;
  const r = placed.radii;

  // 2. Lid keep-visible (H2): softly keep the centre within the lid edges; not for closure.
  const weight = 1 - smoothstep(0, 0.06, 1 - cs.y);
  if (weight > 0) {
    const o = opening(e, c.x);
    // The lid edges carry the rim + ink band too, so the band starts below it.
    const inset = lidKeepInset * r.y + wCont;
    const lo = o.top + inset, hi = o.bottom - inset;
    const target = hi > lo ? softBand(c.y, lo, hi, 0.3 * r.y) : 0.5 * (o.top + o.bottom);
    if (Math.abs(target - c.y) > 1e-6) {
      const moved = v2(c.x, c.y + (target - c.y) * weight);
      const clearance = wCont + PupilSolver.margin(r.x);
      c = PupilSolver.keepInside(pre, moved, r, clearance).center;
    }
  }

  // 3. Closure as a rigid body (H9).
  let center = v2(c.x * cs.x, c.y * cs.y);
  let radii = v2(r.x * cs.x, r.y * cs.y);

  // 4. Effective rim and ink (C6) from the opening at the pupil's column.
  const o = opening(e, center.x);
  const aperture = Math.max(o.bottom - o.top, 0);
  const eff = bands(rimW, inkW, aperture);
  const kept = PupilSolver.keepInside(ScleraShape.of(e), center, radii, eff.rim + eff.ink);
  center = kept.center;
  radii = kept.radii;
  setV4(e.pupil, center.x, center.y, radii.x, radii.y);
  setV4(e.outline, eff.ink, 0, 0, eff.rim);

  // 5. Visibility (C6): closed eyes show no pupil, notch or crescent.
  const wv = Math.max(band, 1.65);
  const visibility = smoothstep(minLine + wv, minLine + 3 * wv, Math.min(gap, aperture));

  // 6. The pupil's own ink edge: thinned on small (startled, squashed) pupils.
  const pupilInk = Math.min(Math.max(finite(style.pupilInkWidth, 0), 0), 0.2 * Math.min(radii.x, radii.y));
  setV4(e.accent, e.accent.x, pupilInk, cs.y, visibility);
}

export const EyeGeometry = {
  rotate, radians, smoothstep, luminance, lit, closure, uniforms, vignetteOuter, vignetteInner, background,
  glowOpacity, glowMaxLuminanceStep, glow, capLuminance, vignetteMean, browInkAmount, shapeUniform, stageOffset,
  shapeLidCoverage, shapeLidAngle, shapeLidBend, direction, notchApexTurn, crescentSpan, pupilAccents,
  notchRetractDistance, notchRetractClear, retractCircle, taper, lidClip, sclera, opening, lidKeepInset, softBand, eye,
  bands, placePupil,
  // BrowGeometry.swift extends EyeGeometry; re-exported here so callers keep the Swift spelling.
  brow, browClearance, arch, browProfile, smaxLift,
} as const;
