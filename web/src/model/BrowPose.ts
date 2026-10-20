// Port of FaceModel/BrowPose.swift.
import { ParamLayout, type ClosedRange, type Side } from './ParamLayout';

/// Index layout of the eyebrow parameters (eyebrows design §2).
///
/// Nine lanes per brow, left at offset 0, right at 16 (lanes 9…15 and 25…31 are padding and always zero). Every
/// lane is authored in **eye-relative units**: lengths across the eye are fractions of the eye's rest width,
/// heights fractions of its rest height.
///
/// Lanes: x (sideways, + outward), y (+ up), rotation (degrees, + inner end up), width and thickness (multipliers,
/// log-space blending), curvature (−1…1 arch), inner / outer (extra end heights), peak (0 inner … 1 outer).
export type BrowLane = 'x' | 'y' | 'rotation' | 'width' | 'thickness' | 'curvature' | 'inner' | 'outer' | 'peak';

const LANES: readonly BrowLane[] = ['x', 'y', 'rotation', 'width', 'thickness', 'curvature', 'inner', 'outer', 'peak'];
const LANE_RAW = Object.fromEntries(LANES.map((l, i) => [l, i])) as Record<BrowLane, number>;
const r = (lowerBound: number, upperBound: number): ClosedRange => Object.freeze({ lowerBound, upperBound });

const Lane = {
  allCases: LANES,
  rawValue: LANE_RAW,
  /// JSON key inside a brow object.
  key: (l: BrowLane): string => l,
  defaultValue: (l: BrowLane): number => (l === 'width' || l === 'thickness' ? 1 : l === 'peak' ? 0.5 : 0),
  /// Soft authoring range; the composer clamps the final brows into it.
  range(l: BrowLane): ClosedRange {
    switch (l) {
      case 'x': return r(-0.25, 0.25);
      case 'y': return r(-0.3, 0.6);
      case 'rotation': return r(-40, 40);
      case 'width': return r(0.6, 1.4);
      case 'thickness': return r(0.4, 1.6);
      case 'curvature': return r(-1, 1);
      case 'inner': case 'outer': return r(-0.4, 0.5);
      case 'peak': return r(0.15, 0.85);
    }
  },
  /// True for the multiplicative lanes (blend in log space).
  isScale: (l: BrowLane): boolean => l === 'width' || l === 'thickness',
};

const RAW_COUNT = 32;
const leftOffset = 0, rightOffset = 16;
const offset = (side: Side): number => (side === 'left' ? leftOffset : rightOffset);
const index = (side: Side, lane: BrowLane): number => offset(side) + LANE_RAW[lane];
const SIDES = ParamLayout.Side.allCases;

const bounds = (pick: (rg: ClosedRange) => number): Float64Array => {
  const v = new Float64Array(RAW_COUNT);
  for (const side of SIDES) for (const l of LANES) v[index(side, l)] = pick(Lane.range(l));
  return v;
};

export const BrowLayout = {
  laneCount: 9,
  leftOffset,
  rightOffset,
  /// Used lanes (both brows).
  count: 18,
  Lane,
  offset,
  index,
  /// Flat indices of the used lanes.
  usedIndices: SIDES.flatMap((side) => LANES.map((l) => index(side, l))) as readonly number[],
  /// Flat indices of the multiplicative lanes (width and thickness of both brows).
  scaleIndices: SIDES.flatMap((s) => [index(s, 'width'), index(s, 'thickness')]) as readonly number[],
  /// Per-lane range bounds (padding lanes 0…0), for one-pass clamping.
  lowerBounds: bounds((rg) => rg.lowerBound) as Readonly<Float64Array>,
  upperBounds: bounds((rg) => rg.upperBound) as Readonly<Float64Array>,
  /// Human-readable name per used index, e.g. "left.brow.rotation" (same order as `usedIndices`).
  names: SIDES.flatMap((side) => LANES.map((l) => `${side}.brow.${l}`)) as readonly string[],
} as const;

/// Both eyebrows: nine lanes per brow in 32 lanes beside `FacePose`.
// A class (not a struct): copy with `copy()` wherever the Swift relies on value semantics.
export class BrowPose {
  readonly raw: Float64Array;

  constructor(raw?: ArrayLike<number>) {
    this.raw = new Float64Array(RAW_COUNT);
    if (raw) for (let i = 0; i < Math.min(raw.length, RAW_COUNT); i++) this.raw[i] = raw[i];
  }

  /// All zeros: an additive delta. Fresh each access.
  static get zero(): BrowPose { return new BrowPose(); }
  /// Identity brows: no offset, tilt or arch, unit length and thickness, peak in the middle. Fresh each access.
  static get defaults(): BrowPose { return new BrowPose(DEFAULTS); }
  /// The reference's neutral brows (low, relaxed, a shallow arch, the inner end a little higher), with a touch of
  /// natural asymmetry. The bundled library's Neutral carries the same values; this is the compiled-in fallback.
  static get restNeutral(): BrowPose { return new BrowPose(REST_NEUTRAL); }

  copy(): BrowPose { return new BrowPose(this.raw); }
  copyFrom(o: BrowPose): this { this.raw.set(o.raw); return this; }

  lane(side: Side, lane: BrowLane): number { return this.raw[index(side, lane)]; }
  setLane(side: Side, lane: BrowLane, v: number): void { this.raw[index(side, lane)] = v; }
  get(i: number): number { return this.raw[i]; }
  set(i: number, v: number): void { this.raw[i] = v; }

  /// Adds `value` to the same lane of both brows.
  addBoth(lane: BrowLane, value: number): void {
    this.raw[index('left', lane)] += value;
    this.raw[index('right', lane)] += value;
  }

  add(b: BrowPose): BrowPose { return this.copy().addInPlace(b); }
  sub(b: BrowPose): BrowPose { const o = this.copy(); for (let i = 0; i < RAW_COUNT; i++) o.raw[i] -= b.raw[i]; return o; }
  mul(s: number): BrowPose { const o = this.copy(); for (let i = 0; i < RAW_COUNT; i++) o.raw[i] *= s; return o; }
  addInPlace(b: BrowPose): this { for (let i = 0; i < RAW_COUNT; i++) this.raw[i] += b.raw[i]; return this; }

  /// Every used lane clamped into its range; padding lanes zeroed.
  // port-note: Swift's SIMD clamped may treat NaN differently (pointwise min/max); here NaN stays NaN.
  clamped(): BrowPose {
    const o = new BrowPose();
    const lo = BrowLayout.lowerBounds, hi = BrowLayout.upperBounds;
    for (let i = 0; i < RAW_COUNT; i++) o.raw[i] = Math.min(Math.max(this.raw[i], lo[i]), hi[i]);
    return o;
  }

  /// True if any used lane is NaN or infinite.
  get hasNonFinite(): boolean {
    for (const i of BrowLayout.usedIndices) if (!Number.isFinite(this.raw[i])) return true;
    return false;
  }

  /// The brow of one side, mirrored onto the other (authoring helper).
  mirrored(from: Side): BrowPose {
    const out = this.copy();
    const other: Side = from === 'left' ? 'right' : 'left';
    for (const l of LANES) out.setLane(other, l, this.lane(from, l));
    return out;
  }

  /// Swift `==` (lane-wise).
  equals(o: BrowPose): boolean {
    for (let i = 0; i < RAW_COUNT; i++) if (this.raw[i] !== o.raw[i]) return false;
    return true;
  }
}

const DEFAULTS: Float64Array = (() => {
  const b = new BrowPose();
  for (const side of SIDES) for (const l of LANES) b.setLane(side, l, Lane.defaultValue(l));
  return b.raw;
})();

const REST_NEUTRAL: Float64Array = (() => {
  const b = new BrowPose(DEFAULTS);
  for (const side of SIDES) {
    b.setLane(side, 'x', 0.05);
    b.setLane(side, 'rotation', 12);
    b.setLane(side, 'curvature', 0.34);
    b.setLane(side, 'peak', 0.48);
  }
  b.setLane('right', 'y', 0.012);
  b.setLane('right', 'curvature', 0.31);
  b.setLane('right', 'rotation', 11);
  return b.raw;
})();
