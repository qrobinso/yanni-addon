// Port of FaceEngine/Noise.swift.

/// The shared lattice hash of Noise1D and LidNoise: a gradient in [-1, 1] for lattice point `i` (Int32).
export function latticeGradient(i: number, seed: number): number {
  // Swift: UInt32(bitPattern: i) &* 0x27D4_EB2D ^ seed (multiplication binds tighter than ^).
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ seed) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h & 0xffff) / 32767.5 - 1;
}

/// Smooth 1-D gradient noise in roughly [-1, 1], continuous in value and first derivative.
///
/// Used for sub-perceptual drift and slow modulation of periods/amplitudes so nothing loops.
export class Noise1D {
  private readonly seed: number;
  constructor(seed: number) { this.seed = seed >>> 0; }

  value(x: number): number {
    const fl = Math.floor(x);
    const i = fl | 0; // Swift Int32(floorf(x))
    const f = x - fl;
    const g0 = latticeGradient(i, this.seed) * f;
    const g1 = latticeGradient((i + 1) | 0, this.seed) * (f - 1);
    const u = f * f * f * (f * (f * 6 - 15) + 10); // quintic fade
    return (g0 + (g1 - g0) * u) * 2;
  }

  /// Sum of two octaves for a slightly richer signal.
  fbm(x: number): number {
    return (this.value(x) + 0.5 * this.value(x * 2.13 + 17.7)) / 1.5;
  }
}
