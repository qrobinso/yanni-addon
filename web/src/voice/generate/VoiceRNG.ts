// Port of FaceVoice/Generate/VoiceRNG.swift.
import { SplitMix64 } from '../../core/random';

/// The voice's own seeded random source (SplitMix64). Deliberately independent of the face engine's RNG so
/// planning sound never perturbs the face's randomness, and every phrase sequence is reproducible per seed.
export class VoiceRNG extends SplitMix64 {
  override copy(): VoiceRNG { return new VoiceRNG(this.state); }
  /// Uniform in [a, b).
  range(a: number, b: number): number { return a + (b - a) * this.unit(); }
  /// Uniform in [−m, m).
  sym(m: number): number { return this.range(-m, m); }
  sign(): number { return this.chance(0.5) ? 1 : -1; }
  pick<T>(a: readonly T[]): T { return a[Number(this.next() % BigInt(a.length))]; }
}

export const vLerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const vClamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);
export const vClamp01 = (x: number): number => vClamp(x, 0, 1);
/// Swift `.rounded()` (schoolbook: halves away from zero).
export const roundSchool = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));
