// Port of FaceEngine/BrowSprings.swift.
import { BrowLayout, ParamLayout, type BrowLane } from '../model';
import { SpringParams, springCoefficients } from './Spring';

/// Spring table for the eyebrow lanes (eyebrows design §4), as lane masks. Slightly underdamped so brows arrive with a
/// subtle overshoot and settle a beat after the eyes; the right brow runs 6 % faster than the left so the pair never
/// moves in mechanical lockstep.
export type BrowSpringGroup = 'position' | 'shape' | 'size' | 'peak';
const GROUPS: readonly BrowSpringGroup[] = ['position', 'shape', 'size', 'peak'];
const RAW = 32;

function params(g: BrowSpringGroup): SpringParams {
  switch (g) {
    // Offsets and end heights (x, y, inner, outer): a little overshoot.
    case 'position': return new SpringParams(11, 0.6);
    // Tilt and arch.
    case 'shape': return new SpringParams(9, 0.65);
    // Length and thickness: barely any wobble.
    case 'size': return new SpringParams(8, 0.8);
    // Arch peak position.
    case 'peak': return new SpringParams(9, 0.8);
  }
}

function group(lane: BrowLane): BrowSpringGroup {
  switch (lane) {
    case 'x': case 'y': case 'inner': case 'outer': return 'position';
    case 'rotation': case 'curvature': return 'shape';
    case 'width': case 'thickness': return 'size';
    case 'peak': return 'peak';
  }
}

/// 1 in each lane of the group on one side: index `side · groupCount + group`.
const masks: readonly Float64Array[] = ParamLayout.Side.allCases.flatMap((side) =>
  GROUPS.map((g) => {
    const m = new Float64Array(RAW);
    for (const lane of BrowLayout.Lane.allCases) if (group(lane) === g) m[BrowLayout.index(side, lane)] = 1;
    return m;
  }));
const GROUP_PARAMS = GROUPS.map(params);

export class BrowSpringCoefficients {
  a = new Float64Array(RAW).fill(1);
  b = new Float64Array(RAW);
  c = new Float64Array(RAW);
  d = new Float64Array(RAW).fill(1);
}

export const BrowSprings = {
  groups: GROUPS,
  params,
  /// The right brow's ω relative to the left's.
  rightOmegaRatio: 1.06,
  /// Bounciness never takes a brow spring's damping below this (no wobbly brows).
  minZeta: 0.5,
  group,
  groupCount: GROUPS.length,
  masks,

  /// Per-lane closed-form coefficients for one step of `dt`. Padding lanes get zeros (they stay 0).
  coefficients(dt: number, speed: number, bounciness: number,
    into: BrowSpringCoefficients = new BrowSpringCoefficients()): BrowSpringCoefficients {
    const k = into;
    k.a.fill(0); k.b.fill(0); k.c.fill(0); k.d.fill(0);
    const damp = 1 - 0.25 * Math.min(Math.max(bounciness, 0), 1);
    const sp = Math.max(speed, 0.05);
    for (let si = 0; si < 2; si++) {
      const ratio = si === 0 ? 1 : BrowSprings.rightOmegaRatio;
      for (let gi = 0; gi < GROUPS.length; gi++) {
        const p = GROUP_PARAMS[gi];
        const { a, b, c, d } = springCoefficients(p.omega * sp * ratio, Math.max(p.zeta * damp, BrowSprings.minZeta), dt);
        const m = masks[si * GROUPS.length + gi];
        for (let i = 0; i < RAW; i++) {
          if (m[i] === 0) continue;
          k.a[i] += m[i] * a; k.b[i] += m[i] * b; k.c[i] += m[i] * c; k.d[i] += m[i] * d;
        }
      }
    }
    return k;
  },
};
