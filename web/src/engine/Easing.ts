// Port of FaceEngine/Easing.swift.

const clamp01 = (t: number): number => Math.min(Math.max(t, 0), 1);

export const Ease = {
  clamp01,
  smoothstep(t: number): number { const x = clamp01(t); return x * x * (3 - 2 * x); },
  smootherstep(t: number): number { const x = clamp01(t); return x * x * x * (x * (x * 6 - 15) + 10); },
  inQuad(t: number): number { const x = clamp01(t); return x * x; },
  outQuad(t: number): number { const x = clamp01(t); return 1 - (1 - x) * (1 - x); },
  inCubic(t: number): number { const x = clamp01(t); return x * x * x; },
  outCubic(t: number): number { const x = 1 - clamp01(t); return 1 - x * x * x; },
  inOutCubic(t: number): number {
    const x = clamp01(t);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  },
  /// Overshoots past 1 then settles (back-out).
  outBack(t: number, overshoot = 1.70158): number {
    const s = overshoot, x = clamp01(t) - 1;
    return 1 + x * x * ((s + 1) * x + s);
  },
  /// Damped oscillation from 1 → 0: amplitude envelope × cos. Good for bounces/shakes.
  dampedOsc(t: number, frequency: number, decay: number): number {
    const x = Math.max(t, 0);
    return Math.exp(-decay * x) * Math.cos(2 * Math.PI * frequency * x);
  },
  /// Smooth 0→1→0 bump over [0,1].
  bump(t: number): number { const x = clamp01(t); return Math.sin(Math.PI * x) * Math.sin(Math.PI * x); },
} as const;

export interface TrackKey { t: number; v: number }

/// Keyframe track evaluated with cubic Hermite (Catmull-Rom tangents). Times in seconds, ascending.
/// Allocation happens once at construction; evaluation is allocation-free.
export class Track {
  readonly keys: readonly TrackKey[];
  constructor(pairs: ReadonlyArray<readonly [number, number]> | readonly TrackKey[]) {
    this.keys = (pairs as ReadonlyArray<unknown>).map((p) =>
      Array.isArray(p) ? { t: p[0] as number, v: p[1] as number } : { ...(p as TrackKey) });
  }

  get duration(): number { return this.keys.length ? this.keys[this.keys.length - 1].t : 0; }

  value(t: number): number {
    const keys = this.keys, n = keys.length;
    if (n === 0) return 0;
    const first = keys[0], last = keys[n - 1];
    if (t <= first.t) return first.v;
    if (t >= last.t) return last.v;
    let i = 0;
    while (i < n - 2 && keys[i + 1].t < t) i++;
    const k0 = keys[Math.max(i - 1, 0)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(i + 2, n - 1)];
    const span = Math.max(k2.t - k1.t, 1e-6);
    const u = (t - k1.t) / span;
    const m1 = (k2.v - k0.v) / Math.max(k2.t - k0.t, 1e-6) * span;
    const m2 = (k3.v - k1.v) / Math.max(k3.t - k1.t, 1e-6) * span;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * k1.v + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * k2.v + (u3 - u2) * m2;
  }
}
