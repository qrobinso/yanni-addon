// Port of FaceVoice/DSP/VoiceDSP.swift. Small, allocation-free DSP building blocks used on the audio thread.

/// Sine lookup table: one cycle in `size` entries plus one guard entry for interpolation.
export const SineTable = {
  size: 2048,

  /// Allocates and fills the table (call at init, never on the audio thread). Float32 like the Swift table.
  make(): Float32Array {
    const n = SineTable.size;
    const t = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) t[i] = Math.sin(2 * Math.PI * i / n);
    return t;
  },

  /// sin(2π·p) for `p` already in [0, 1) (no wrap), by linear interpolation.
  sin01(table: Float32Array, p: number): number {
    const x = p * 2048;
    const i = Math.min(Math.trunc(x), 2047);
    const f = x - i;
    const a = table[i];
    return a + (table[i + 1] - a) * f;
  },

  /// sin(2π·p) for any real `p` (cycles), by linear interpolation.
  sin(table: Float32Array, p: number): number {
    let frac = p - Math.floor(p);
    if (frac >= 1) frac = 0;                       // guards rounding of tiny negatives
    const x = frac * 2048;
    const i = Math.min(Math.trunc(x), 2047);
    const f = x - i;
    const a = table[i];
    return a + (table[i + 1] - a) * f;
  },
};

/// PolyBLEP residual for a unit step at phase 0 (phase `t` and increment `dt` in cycles).
export function polyBLEP(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  } else if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/// Band-limited square (±1) from phase `t` ∈ [0, 1) and increment `dt`.
export function polyBLEPSquare(t: number, dt: number): number {
  const dtc = Math.min(Math.max(dt, 1e-6), 0.5);
  let t2 = t + 0.5;
  if (t2 >= 1) t2 -= 1;
  return (t < 0.5 ? 1 : -1) + polyBLEP(t, dtc) - polyBLEP(t2, dtc);
}

/// Topology-preserving-transform (Zavalishin) state-variable filter. Unconditionally stable for g > 0, k > 0.
/// port-note: `tick` returns the low-pass and leaves the band-pass in `bp` (no tuple allocation).
export class SVF {
  ic1 = 0;
  ic2 = 0;
  g = 0.1;
  k = 1.414;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  /// Band-pass (raw v1, peak gain Q) of the last tick.
  bp = 0;

  /// `g = tan(π·fc/fs)`, `k = 1/Q`.
  setCoefficients(g: number, k: number): void {
    this.g = g; this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /// One sample; returns the low-pass (band-pass in `bp`).
  tick(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.bp = v1;
    return v2;
  }

  /// High-pass output for input `x` given the last tick (`lp` its return value).
  highPass(x: number, lp: number): number { return x - this.k * this.bp - lp; }

  /// Flushes denormals / tiny values and resets non-finite state. Returns false if the state was non-finite.
  sanitize(): boolean {
    if (!(Number.isFinite(this.ic1) && Number.isFinite(this.ic2))) { this.ic1 = 0; this.ic2 = 0; return false; }
    if (Math.abs(this.ic1) < 1e-20) this.ic1 = 0;
    if (Math.abs(this.ic2) < 1e-20) this.ic2 = 0;
    return true;
  }

  reset(): void { this.ic1 = 0; this.ic2 = 0; }

  copyFrom(o: SVF): void {
    this.ic1 = o.ic1; this.ic2 = o.ic2; this.g = o.g; this.k = o.k; this.a1 = o.a1; this.a2 = o.a2; this.a3 = o.a3; this.bp = o.bp;
  }
}

/// `tan(π·fc/fs)` with fc clamped to [20 Hz, 0.45·fs].
export function svfG(fc: number, fs: number): number {
  const f = Math.min(Math.max(fc, 20), 0.45 * fs);
  return Math.tan(Math.PI * f / fs);
}

/// xorshift32 step: the next state (unsigned 32-bit).
export function xorshiftNext(s: number): number {
  let x = s >>> 0;
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ (x << 5)) >>> 0;
  return x;
}

/// White noise in [-1, 1) for a state from `xorshiftNext` (the Swift `xorshiftNoise` value).
export function noiseValue(x: number): number { return (x | 0) * (1 / 2147483648); }

/// Soft limiter: linear below 0.7, then 0.7 + 0.3·tanh((|x| − 0.7)/0.3). Output magnitude < 1.
export function softLimit(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.7) return x;
  const y = 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3);
  return x < 0 ? -y : y;
}

/// User volume 0…1 → linear gain via −40 dB + 40·v (0 → silence).
export function volumeGain(v: number): number {
  if (!(v > 0)) return 0;
  return Math.pow(10, (-40 + 40 * Math.min(v, 1)) / 20);
}

/// Formant centre frequencies for a vowel position 0 ("oo") … 0.5 ("ah") … 1 ("ee").
/// F1 rises toward "ah" (350 → 700 → 350 Hz); F2 rises with the vowel (1100 → 2400 Hz).
export function formantFrequencies(vowel: number): { f1: number; f2: number } {
  const v = Math.min(Math.max(vowel, 0), 1);
  return { f1: 350 + 350 * 4 * v * (1 - v), f2: 1100 + 1300 * v };
}
