// Port of FaceEngine/Random.swift. Seedable SplitMix64; one instance lives in FaceState so a single seed makes the
// engine deterministic. Reproduces the Swift sequence bit for bit (bigint only here).
const M64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const MUL1 = 0xbf58476d1ce4e5b9n;
const MUL2 = 0x94d049bb133111ebn;

export class SplitMix64 {
  state: bigint;
  constructor(seed: bigint | number) {
    this.state = BigInt.asUintN(64, BigInt(seed));
  }

  copy(): SplitMix64 {
    return new SplitMix64(this.state);
  }

  next(): bigint {
    this.state = (this.state + GOLDEN) & M64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * MUL1) & M64;
    z = ((z ^ (z >> 27n)) * MUL2) & M64;
    return z ^ (z >> 31n);
  }

  /** Uniform in [0, 1): the top 24 bits, exactly representable in float32 as in Swift. */
  unit(): number {
    return Number(this.next() >> 40n) / 16777216;
  }

  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.unit();
  }

  chance(p: number): boolean {
    return this.unit() < p;
  }

  /** Standard normal via Box–Muller. */
  gaussian(): number {
    const u1 = Math.max(this.unit(), 1e-7);
    const u2 = this.unit();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Lognormal with the given median and log-space sigma, clamped to [lo, hi] when given. */
  lognormal(median: number, sigma: number, clamp?: readonly [number, number]): number {
    const v = median * Math.exp(sigma * this.gaussian());
    if (!clamp) return v;
    return Math.min(Math.max(v, clamp[0]), clamp[1]);
  }

  /** Random point in an axis-aligned ellipse with semi-axes (rx, ry). */
  inEllipse(rx: number, ry: number): { x: number; y: number } {
    const r = Math.sqrt(this.unit());
    const a = this.unit() * 2 * Math.PI;
    return { x: Math.cos(a) * rx * r, y: Math.sin(a) * ry * r };
  }

  /** Picks an index according to non-negative weights. */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (!(total > 0)) return 0;
    let x = this.unit() * total;
    for (let i = 0; i < weights.length; i++) {
      x -= weights[i];
      if (x < 0) return i;
    }
    return weights.length - 1;
  }
}
