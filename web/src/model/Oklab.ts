// Port of FaceModel/Oklab.swift.
import { v3, type V3 } from '../core/vec';
import { roundSwift } from '../core/vec';

/// Oklab colour space helpers (Björn Ottosson, 2020). Shared by the engine (mood colour) and the renderer (style
/// mixing). Coordinates are `{x: L, y: a, z: b}`: L ≈ perceived lightness 0...1, a/b the green–red and blue–yellow axes.
export const Oklab = {
  /// Linear sRGB → Oklab.
  fromLinear(c: V3): V3 {
    const l = 0.4122214708 * c.x + 0.5363325363 * c.y + 0.0514459929 * c.z;
    const m = 0.2119034982 * c.x + 0.6806995451 * c.y + 0.1073969566 * c.z;
    const s = 0.0883024619 * c.x + 0.2817188376 * c.y + 0.6299787005 * c.z;
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    return v3(
      0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
  },

  /// Oklab → linear sRGB (unclamped; may fall outside 0...1 for out-of-gamut colours).
  toLinear(lab: V3): V3 {
    const l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
    const m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
    const s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return v3(
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  },

  /// True when the Oklab colour maps inside the linear sRGB cube (with a small tolerance).
  isInGamut(lab: V3, tolerance = 1e-4): boolean {
    const c = Oklab.toLinear(lab);
    return Math.min(c.x, c.y, c.z) >= -tolerance && Math.max(c.x, c.y, c.z) <= 1 + tolerance;
  },

  /// Largest chroma ≤ `lab`'s own chroma that is in gamut at lightness `L`, keeping hue. Bisection.
  maxChroma(lab: V3, L: number, iterations = 18): number {
    const c = Math.sqrt(lab.y * lab.y + lab.z * lab.z);
    if (!(c > 1e-6)) return 0;
    const dx = lab.y / c, dy = lab.z / c;
    if (Oklab.isInGamut(v3(L, dx * c, dy * c))) return c;
    let lo = 0, hi = c;
    for (let i = 0; i < iterations; i++) {
      const mid = 0.5 * (lo + hi);
      if (Oklab.isInGamut(v3(L, dx * mid, dy * mid))) lo = mid; else hi = mid;
    }
    return lo;
  },

  /// Linear sRGB clamped to 0...1, with non-finite channels replaced by `fallback`.
  toLinearClamped(lab: V3, fallback: V3): V3 {
    const c = Oklab.toLinear(lab);
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) return fallback;
    return v3(Math.min(Math.max(c.x, 0), 1), Math.min(Math.max(c.y, 0), 1), Math.min(Math.max(c.z, 0), 1));
  },

  /// sRGB transfer: encoded 0...1 → linear.
  srgbToLinear: (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)),

  /// sRGB transfer: linear → encoded 0...1.
  linearToSRGB(v: number): number {
    const c = Math.min(Math.max(v, 0), 1);
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  },

  /// `0xRRGGBB` sRGB hex → linear RGB (Swift `linear(hex:)`).
  linear(hex: number): V3 {
    return v3(Oklab.srgbToLinear(((hex >>> 16) & 0xff) / 255),
      Oklab.srgbToLinear(((hex >>> 8) & 0xff) / 255),
      Oklab.srgbToLinear((hex & 0xff) / 255));
  },

  /// Linear RGB → `0xRRGGBB` sRGB hex (Swift `hex(linear:)`; for debugging and the tuning panel).
  // port-note: Swift traps on a NaN channel (UInt32(NaN)); here it becomes 0.
  hex(c: V3): number {
    const byte = (v: number): number => roundSwift(Oklab.linearToSRGB(v) * 255) | 0;
    return ((byte(c.x) << 16) | (byte(c.y) << 8) | byte(c.z)) >>> 0;
  },
};
