// Port of FaceModel/FacePose.swift.
import { ParamLayout, type EyeParam, type FaceParam, type PupilParam, type Side } from './ParamLayout';

const N = ParamLayout.count;
const LOWER = Float64Array.from(ParamLayout.ranges, (r) => r.lowerBound);
const UPPER = Float64Array.from(ParamLayout.ranges, (r) => r.upperBound);

/// One complete face: 51 parameters (43 PyCozmo + 8 pupil) in ParamLayout order.
// port-note: Swift stores a SIMD64<Float> (lanes 51..<64 padding, float32). Here exactly 51 float64 lanes.
// A class (not a struct): copy with `copy()` wherever the Swift relies on value semantics.
export class FacePose {
  readonly raw: Float64Array;

  constructor(raw?: ArrayLike<number>) {
    this.raw = new Float64Array(N);
    if (raw) for (let i = 0; i < Math.min(raw.length, N); i++) this.raw[i] = raw[i];
  }

  /// All zeros. Useful as an additive delta. A fresh instance each access.
  static get zero(): FacePose { return new FacePose(); }

  /// PyCozmo defaults: scales 1, radii 0.5, everything else 0. A fresh instance each access.
  static get defaults(): FacePose { return new FacePose(DEFAULTS); }

  static fromArray(a: ArrayLike<number>): FacePose { return new FacePose(a); }
  /// The 51 params in ParamLayout order (what golden traces record).
  toArray(): number[] { return Array.from(this.raw); }

  copy(): FacePose { return new FacePose(this.raw); }
  copyFrom(o: FacePose): this { this.raw.set(o.raw); return this; }

  get(i: number): number { return this.raw[i]; }
  set(i: number, v: number): void { this.raw[i] = v; }

  face(p: FaceParam): number { return this.raw[ParamLayout.index(p)]; }
  setFace(p: FaceParam, v: number): void { this.raw[ParamLayout.index(p)] = v; }

  /// An eye or pupil parameter of one side (Swift `pose[side, p]`).
  eye(side: Side, p: EyeParam | PupilParam): number { return this.raw[ParamLayout.index(side, p)]; }
  setEye(side: Side, p: EyeParam | PupilParam, v: number): void { this.raw[ParamLayout.index(side, p)] = v; }

  /// Adds `value` to the same eye parameter on both eyes.
  addBoth(p: EyeParam, value: number): void {
    this.raw[ParamLayout.index('left', p)] += value;
    this.raw[ParamLayout.index('right', p)] += value;
  }

  // Vector math (returns new poses; the *InPlace variants mutate `this`).
  add(b: FacePose): FacePose { const o = this.copy(); return o.addInPlace(b); }
  sub(b: FacePose): FacePose { const o = this.copy(); return o.subInPlace(b); }
  mul(s: number): FacePose { const o = this.copy(); for (let i = 0; i < N; i++) o.raw[i] *= s; return o; }
  addInPlace(b: FacePose): this { for (let i = 0; i < N; i++) this.raw[i] += b.raw[i]; return this; }
  subInPlace(b: FacePose): this { for (let i = 0; i < N; i++) this.raw[i] -= b.raw[i]; return this; }

  lerp(other: FacePose, t: number): FacePose {
    const o = new FacePose();
    for (let i = 0; i < N; i++) o.raw[i] = this.raw[i] + (other.raw[i] - this.raw[i]) * t;
    return o;
  }

  /// Clamps every parameter into its soft range.
  clamped(): FacePose {
    const o = new FacePose();
    for (let i = 0; i < N; i++) o.raw[i] = Math.min(Math.max(this.raw[i], LOWER[i]), UPPER[i]);
    return o;
  }

  /// True if any used lane is NaN or infinite.
  get hasNonFinite(): boolean {
    for (let i = 0; i < N; i++) if (!Number.isFinite(this.raw[i])) return true;
    return false;
  }

  /// Swift `==` (lane-wise, so NaN != NaN and 0 == -0).
  equals(o: FacePose): boolean {
    for (let i = 0; i < N; i++) if (this.raw[i] !== o.raw[i]) return false;
    return true;
  }
}

const DEFAULTS: Float64Array = (() => {
  const p = new FacePose();
  for (const f of ParamLayout.Face.allCases) p.setFace(f, ParamLayout.Face.defaultValue(f));
  for (const side of ParamLayout.Side.allCases) {
    for (const e of ParamLayout.Eye.allCases) p.setEye(side, e, ParamLayout.Eye.defaultValue(e));
    for (const q of ParamLayout.Pupil.allCases) p.setEye(side, q, ParamLayout.Pupil.defaultValue(q));
  }
  return p.raw;
})();
