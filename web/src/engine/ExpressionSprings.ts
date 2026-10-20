// Port of FaceEngine/ExpressionSprings.swift.
import { ParamLayout } from '../model';
import { SpringParams, springCoefficients } from './Spring';

/// Per-parameter-group spring table for expression transitions (design Part D, H3), as lane masks.
export type ExpressionSpringGroup = 'scale' | 'lidY' | 'lidShape' | 'radii' | 'position' | 'pupilPosition' | 'pupilSize';

const GROUPS: readonly ExpressionSpringGroup[] = ['scale', 'lidY', 'lidShape', 'radii', 'position', 'pupilPosition', 'pupilSize'];
const N = ParamLayout.count;

function params(g: ExpressionSpringGroup): SpringParams {
  switch (g) {
    // Face and eye scale: underdamped, gives the "pop" (e.g. into Surprise).
    case 'scale': return new SpringParams(14, 0.55);
    // Upper/lower lid coverage.
    case 'lidY': return new SpringParams(12, 0.85);
    // Lid angles and bends (lid shape).
    case 'lidShape': return new SpringParams(10, 0.8);
    // Corner radii: critically damped, never wobble.
    case 'radii': return new SpringParams(9, 1.0);
    // Face/eye centres and angles.
    case 'position': return new SpringParams(8, 0.9);
    // Pupil position: the fastest group, so pupils lead expression changes.
    case 'pupilPosition': return new SpringParams(12, 0.75);
    // Pupil size: a small underdamped pop (e.g. dots into Surprise).
    case 'pupilSize': return new SpringParams(9, 0.6);
  }
}

function group(i: number): ExpressionSpringGroup {
  if (i < ParamLayout.leftEyeOffset) {
    const f = ParamLayout.Face.allCases[i];
    return f === 'scaleX' || f === 'scaleY' ? 'scale' : 'position';
  }
  if (i >= ParamLayout.leftPupilOffset) {
    const p = ParamLayout.Pupil.allCases[(i - ParamLayout.leftPupilOffset) % ParamLayout.pupilParamCount];
    return p === 'x' || p === 'y' ? 'pupilPosition' : p === 'size' ? 'pupilSize' : 'radii';
  }
  const e = ParamLayout.Eye.allCases[(i - ParamLayout.leftEyeOffset) % ParamLayout.eyeParamCount];
  switch (e) {
    case 'scaleX': case 'scaleY': return 'scale';
    case 'centerX': case 'centerY': case 'angle': return 'position';
    case 'upperLidY': case 'lowerLidY': return 'lidY';
    case 'upperLidAngle': case 'lowerLidAngle': case 'upperLidBend': case 'lowerLidBend': return 'lidShape';
    default: return 'radii';
  }
}

const masks: readonly Float64Array[] = GROUPS.map((g) => {
  const m = new Float64Array(N);
  for (let i = 0; i < N; i++) if (group(i) === g) m[i] = 1;
  return m;
});
const maskOf = (g: ExpressionSpringGroup): Float64Array => masks[GROUPS.indexOf(g)];
const GROUP_PARAMS = GROUPS.map(params);
const LID_MASK = (() => {
  const m = new Float64Array(N), a = maskOf('lidY'), b = maskOf('lidShape');
  for (let i = 0; i < N; i++) m[i] = a[i] + b[i];
  return m;
})();

/// Per-lane closed-form coefficients for one step of `dt`.
export class ExpressionSpringCoefficients {
  a = new Float64Array(N).fill(1);
  b = new Float64Array(N);
  c = new Float64Array(N);
  d = new Float64Array(N).fill(1);
}

export const ExpressionSprings = {
  groups: GROUPS,
  params,
  /// Lids start moving slightly after scale/position (overlapping action), in seconds at speed 1.
  lidLag: 0.045,
  group,
  /// 1 in each lane belonging to the group.
  masks,
  groupCount: GROUPS.length,
  scaleMask: maskOf('scale'),
  lidYMask: maskOf('lidY'),
  lidShapeMask: maskOf('lidShape'),
  radiiMask: maskOf('radii'),
  positionMask: maskOf('position'),
  /// Lanes that lag (lid y + lid shape).
  lidMask: LID_MASK,
  /// Lanes holding scale params (blended in log space).
  scaleIndices: ParamLayout.scaleIndices,

  /// Coefficients with speed/bounciness modulation. Writes into `into` when given (allocation-free).
  coefficients(dt: number, speed: number, bounciness: number,
    into: ExpressionSpringCoefficients = new ExpressionSpringCoefficients()): ExpressionSpringCoefficients {
    const k = into;
    k.a.fill(0); k.b.fill(0); k.c.fill(0); k.d.fill(0);
    const damp = 1 - 0.25 * Math.min(Math.max(bounciness, 0), 1);
    const sp = Math.max(speed, 0.05);
    for (let gi = 0; gi < GROUPS.length; gi++) {
      const p = GROUP_PARAMS[gi];
      const { a, b, c, d } = springCoefficients(p.omega * sp, p.zeta * damp, dt);
      const m = masks[gi];
      for (let i = 0; i < N; i++) {
        if (m[i] === 0) continue;
        k.a[i] += m[i] * a; k.b[i] += m[i] * b; k.c[i] += m[i] * c; k.d[i] += m[i] * d;
      }
    }
    return k;
  },
} as const;
