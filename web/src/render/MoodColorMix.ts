// Port of FaceRendering/MoodColorMix.swift.
import { v3, type V3 } from '../core/vec';
import type { FaceFrame } from '../model/FaceFrame';
import { Oklab } from '../model/Oklab';
import { RenderStyle } from './RenderStyle';

const clamp01 = (c: V3): V3 => v3(Math.min(Math.max(c.x, 0), 1), Math.min(Math.max(c.y, 0), 1), Math.min(Math.max(c.z, 0), 1));
const eq3 = (a: V3, b: V3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/// Oklab distance from the anchor below which the mood colour counts as the playful baseline.
export const baselineTolerance = 1e-3;

/// The mood colour for `frame`: `style.color` mixed toward `frame.color` by `moodColorAmount` in Oklab, lightness
/// kept at `color`'s.
export function resolvedEyeColor(style: RenderStyle, frame: FaceFrame): V3 {
  const amount = Number.isFinite(style.moodColorAmount) ? Math.min(Math.max(style.moodColorAmount, 0), 1) : 0;
  const fc = frame.color;
  if (!(amount > 0 && Number.isFinite(fc.x) && Number.isFinite(fc.y) && Number.isFinite(fc.z))) return style.color;
  if (amount >= 1) return clamp01(fc);
  const a = Oklab.fromLinear(clamp01(style.color));
  const b = Oklab.fromLinear(clamp01(fc));
  const m = v3(a.x, a.y + (b.y - a.y) * amount, a.z + (b.z - a.z) * amount); // lightness stays the style colour's
  return Oklab.toLinearClamped(m, style.color);
}

/// The crescent colour for `frame`: `crescentColor` carried along (Oklab LCh) by the mood's shift away from the
/// anchor `color`. Exactly `crescentColor` at the playful baseline or with `moodColorAmount` 0.
export function resolvedCrescentColor(style: RenderStyle, frame: FaceFrame): V3 {
  const target = resolvedEyeColor(style, frame);
  const base = clamp01(style.crescentColor);
  const anchor = clamp01(style.color);
  if (eq3(target, anchor) || eq3(target, style.color)) return style.crescentColor;
  const b = Oklab.fromLinear(base), a = Oklab.fromLinear(anchor), t = Oklab.fromLinear(target);
  // Float noise from the engine's springs (far below one 8-bit step) still counts as the baseline.
  const dx = t.x - a.x, dy = t.y - a.y, dz = t.z - a.z;
  if (dx * dx + dy * dy + dz * dz < baselineTolerance * baselineTolerance) return style.crescentColor;
  const polar = (v: V3) => ({ c: Math.sqrt(v.y * v.y + v.z * v.z), h: Math.atan2(v.z, v.y) });
  const pb = polar(b), pa = polar(a), pt = polar(t);
  const L = Math.min(Math.max(b.x + (t.x - a.x), 0.25), 0.95);
  // Chroma follows the mood's saturation relative to the anchor's; hue rotates by the same angle.
  const ratio = pa.c > 1e-4 ? pt.c / pa.c : 1;
  const h = pb.h + (pt.h - pa.h);
  const lab = v3(L, Math.cos(h) * pb.c * ratio, Math.sin(h) * pb.c * ratio);
  const maxC = Oklab.maxChroma(lab, L);
  const c = Math.sqrt(lab.y * lab.y + lab.z * lab.z);
  if (c > maxC && c > 1e-6) { lab.y *= maxC / c; lab.z *= maxC / c; }
  return Oklab.toLinearClamped(lab, style.crescentColor);
}

/// A copy of the style with `color` and `crescentColor` replaced by the resolved colours for `frame`. Writes into
/// `out` when given (the per-frame path reuses one).
export function resolvedStyle(style: RenderStyle, frame: FaceFrame, out?: RenderStyle): RenderStyle {
  const crescent = resolvedCrescentColor(style, frame);
  const color = resolvedEyeColor(style, frame);
  const s = out ? Object.assign(out, style) : RenderStyle.clone(style);
  s.crescentColor = crescent;
  s.color = color;
  return s;
}
