// Port of FaceEngine/LidMath.swift.
import { latticeGradient } from './Noise';

/// Small numeric helpers shared by the Composer and the lid / body modifiers
/// (Blink, LidHeaviness, Breathing, SquashStretch, BurnInDrift, Brightness).
export const LidMath = {
  /// Soft clamp into `lo...hi` with a quadratic knee of total width `k` centred on each bound.
  ///
  /// Identity on `[lo + k/2, hi − k/2]`, constant beyond `lo − k/2` / `hi + k/2`, C¹ everywhere and
  /// monotonic non-decreasing. A value exactly on a bound maps `k/8` inside it (0.01 for the default knee).
  softClamp(x: number, lo: number, hi: number, k: number): number {
    const h = k * 0.5;
    if (!(k > 0 && hi - lo > 2 * k)) return Math.min(Math.max(x, lo), hi);
    if (x <= lo - h) return lo;
    if (x < lo + h) { const d = x - lo + h; return lo + d * d / (2 * k); }
    if (x >= hi + h) return hi;
    if (x > hi - h) { const d = hi + h - x; return hi - d * d / (2 * k); }
    return x;
  },

  /// Polynomial smooth maximum: ≥ max(a, b), equal to it once |a − b| ≥ k.
  smoothMax(a: number, b: number, k: number): number {
    const m = b >= a ? b : a; // Swift max(a, b)
    if (!(k > 0)) return m;
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return m + h * h * k * 0.25;
  },

  mix: (a: number, b: number, t: number): number => a + (b - a) * t,

  /// Exact exponential smoothing factor for time constant `tau` over `dt` (frame-rate independent).
  expAlpha: (dt: number, tau: number): number => (tau <= 0 ? 1 : 1 - Math.exp(-Math.max(dt, 0) / tau)),

  /// Wraps a non-negative Double phase into [0, 1).
  wrap01(x: number): number {
    const r = x - Math.floor(x);
    return r >= 1 ? 0 : r;
  },
} as const;

/// Smooth 1-D gradient noise on a periodic lattice, sampled at wrapped coordinates so it stays
/// precise and continuous at any uptime. Output roughly −1...1, clamped.
export class LidNoise {
  /// Lattice period in noise cells.
  static readonly period = 256;
  readonly seed: number;
  constructor(seed: number) { this.seed = seed >>> 0; }

  /// Noise at time `t` (seconds) scrolling at `rate` cells per second.
  at(t: number, rate: number): number {
    const p = LidNoise.period;
    let x = (t * rate) % p;
    if (x < 0) x += p;
    return this.value(x);
  }

  /// Noise at lattice coordinate `x` (wrapped into the period).
  value(x: number): number {
    const fl = Math.floor(x);
    const f = x - fl;
    const p = LidNoise.period;
    let i0 = (fl | 0) % p;
    if (i0 < 0) i0 += p;
    const i1 = (i0 + 1) % p;
    const g0 = latticeGradient(i0, this.seed) * f;
    const g1 = latticeGradient(i1, this.seed) * (f - 1);
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    return Math.min(Math.max((g0 + (g1 - g0) * u) * 2, -1), 1);
  }
}
