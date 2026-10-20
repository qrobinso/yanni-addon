// Port of FaceModel/ParamLayout.swift.
/// Index layout of the 51 face parameters.
///
/// Face: 5 parameters at offset 0. Each eye: 19 parameters in PyCozmo order, left at offset 5, right at 24.
/// Pupils (appended so the PyCozmo layout is untouched): 4 per eye, left at 43, right at 47.

export interface ClosedRange {
  readonly lowerBound: number;
  readonly upperBound: number;
}
const range = (lowerBound: number, upperBound: number): ClosedRange => Object.freeze({ lowerBound, upperBound });

export type Side = 'left' | 'right';
export type FaceParam = 'centerX' | 'centerY' | 'scaleX' | 'scaleY' | 'angle';
export type EyeParam =
  | 'centerX' | 'centerY' | 'scaleX' | 'scaleY' | 'angle'
  | 'lowerInnerRadiusX' | 'lowerInnerRadiusY' | 'lowerOuterRadiusX' | 'lowerOuterRadiusY'
  | 'upperInnerRadiusX' | 'upperInnerRadiusY' | 'upperOuterRadiusX' | 'upperOuterRadiusY'
  | 'upperLidY' | 'upperLidAngle' | 'upperLidBend'
  | 'lowerLidY' | 'lowerLidAngle' | 'lowerLidBend';
/// Per-eye pupil parameters. `x`, `y` are normalised to the pupil's available travel inside the sclera
/// (±1 = touching the contained boundary; +y down). `size` = pupil diameter ÷ sclera width.
/// `squash` flattens the pupil vertically (radius_y × (1 − squash)).
export type PupilParam = 'x' | 'y' | 'size' | 'squash';

const FACE_CASES: readonly FaceParam[] = ['centerX', 'centerY', 'scaleX', 'scaleY', 'angle'];
const EYE_CASES: readonly EyeParam[] = [
  'centerX', 'centerY', 'scaleX', 'scaleY', 'angle',
  'lowerInnerRadiusX', 'lowerInnerRadiusY', 'lowerOuterRadiusX', 'lowerOuterRadiusY',
  'upperInnerRadiusX', 'upperInnerRadiusY', 'upperOuterRadiusX', 'upperOuterRadiusY',
  'upperLidY', 'upperLidAngle', 'upperLidBend',
  'lowerLidY', 'lowerLidAngle', 'lowerLidBend',
];
const PUPIL_CASES: readonly PupilParam[] = ['x', 'y', 'size', 'squash'];
const SIDE_CASES: readonly Side[] = ['left', 'right'];

const rawValues = <T extends string>(cases: readonly T[]): Record<T, number> =>
  Object.fromEntries(cases.map((c, i) => [c, i])) as Record<T, number>;

const camelToSnake = (s: string): string => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

const EYE_KEYS: Record<EyeParam, string> = Object.fromEntries(
  EYE_CASES.map((e) => {
    const lid = /^(upper|lower)Lid(Y|Angle|Bend)$/.exec(e);
    return [e, lid ? `${lid[1]}_lid.${lid[2].toLowerCase()}` : camelToSnake(e)];
  }),
) as Record<EyeParam, string>;

const isRadius = (e: EyeParam): boolean => e.includes('RadiusX') || e.includes('RadiusY');

const Face = {
  allCases: FACE_CASES,
  rawValue: rawValues(FACE_CASES),
  key: (p: FaceParam): string => camelToSnake(p),
  defaultValue: (p: FaceParam): number => (p === 'scaleX' || p === 'scaleY' ? 1 : 0),
  range(p: FaceParam): ClosedRange {
    switch (p) {
      case 'centerX': case 'centerY': return range(-200, 200);
      case 'scaleX': case 'scaleY': return range(0.01, 3);
      case 'angle': return range(-90, 90);
    }
  },
};

const Eye = {
  allCases: EYE_CASES,
  rawValue: rawValues(EYE_CASES),
  /// Flat JSON key. Lid params are nested in JSON (`upper_lid.y`); see `lidKey`.
  key: (p: EyeParam): string => EYE_KEYS[p],
  /// For lid params: (group, field), e.g. ("upper_lid", "y"). Undefined for flat params.
  lidKey(p: EyeParam): { group: string; field: string } | undefined {
    const parts = EYE_KEYS[p].split('.');
    return parts.length === 2 ? { group: parts[0], field: parts[1] } : undefined;
  },
  defaultValue: (p: EyeParam): number => (p === 'scaleX' || p === 'scaleY' ? 1 : isRadius(p) ? 0.5 : 0),
  range(p: EyeParam): ClosedRange {
    switch (p) {
      case 'centerX': case 'centerY': return range(-200, 200);
      case 'scaleX': case 'scaleY': return range(0.01, 3);
      case 'angle': case 'upperLidAngle': case 'lowerLidAngle': return range(-90, 90);
      default: return range(0, 1); // radii, lid y and bend
    }
  },
};

const Pupil = {
  allCases: PUPIL_CASES,
  rawValue: rawValues(PUPIL_CASES),
  /// Field name inside the eye's `"pupil": {…}` JSON object.
  key: (p: PupilParam): string => p,
  defaultValue: (p: PupilParam): number => (p === 'size' ? 0.5 : 0),
  range(p: PupilParam): ClosedRange {
    switch (p) {
      case 'x': case 'y': return range(-1, 1);
      case 'size': return range(0.15, 0.85);
      case 'squash': return range(0, 0.4);
    }
  },
};

const leftEyeOffset = 5, rightEyeOffset = 24, leftPupilOffset = 43, rightPupilOffset = 47;

const SideNS = {
  allCases: SIDE_CASES,
  /// Both sides, left first.
  both: SIDE_CASES,
  rawValue: rawValues(SIDE_CASES),
  pupilOffset: (s: Side): number => (s === 'left' ? leftPupilOffset : rightPupilOffset),
  offset: (s: Side): number => (s === 'left' ? leftEyeOffset : rightEyeOffset),
  key: (s: Side): string => s,
};

// One lookup per side covering eye and pupil params (their names don't collide).
type SideParam = EyeParam | PupilParam;
const sideTable = (s: Side): Record<SideParam, number> => {
  const t = {} as Record<SideParam, number>;
  EYE_CASES.forEach((e, i) => (t[e] = SideNS.offset(s) + i));
  PUPIL_CASES.forEach((q, i) => (t[q] = SideNS.pupilOffset(s) + i));
  return t;
};
const LEFT_INDEX = sideTable('left');
const RIGHT_INDEX = sideTable('right');
const FACE_INDEX = rawValues(FACE_CASES); // faceOffset is 0

/// Flat index of a face parameter, or of an eye / pupil parameter of one side.
function index(p: FaceParam): number;
function index(side: Side, p: SideParam): number;
function index(a: FaceParam | Side, p?: SideParam): number {
  if (p === undefined) return FACE_INDEX[a as FaceParam];
  return (a === 'left' ? LEFT_INDEX : RIGHT_INDEX)[p];
}

const names: readonly string[] = [
  ...FACE_CASES.map((f) => `face.${Face.key(f)}`),
  ...SIDE_CASES.flatMap((s) => EYE_CASES.map((e) => `${s}.${Eye.key(e)}`)),
  ...SIDE_CASES.flatMap((s) => PUPIL_CASES.map((q) => `${s}.pupil.${q}`)),
];

const ranges: readonly ClosedRange[] = [
  ...FACE_CASES.map(Face.range),
  ...SIDE_CASES.flatMap(() => EYE_CASES.map(Eye.range)),
  ...SIDE_CASES.flatMap(() => PUPIL_CASES.map(Pupil.range)),
];

export const ParamLayout = {
  count: 51,
  leftPupilOffset,
  rightPupilOffset,
  pupilParamCount: 4,
  faceOffset: 0,
  leftEyeOffset,
  rightEyeOffset,
  eyeParamCount: 19,
  Face,
  Eye,
  Pupil,
  Side: SideNS,
  index,
  /// Human-readable name for each flat index, e.g. "face.scale_x", "left.upper_lid.y".
  names,
  /// Flat indices of every multiplicative parameter: face and eye scales plus pupil sizes. These blend in log
  /// space, spring in the pop groups, and count as "scale" motion for the adaptive frame rate.
  scaleIndices: [
    index('scaleX'), index('scaleY'),
    index('left', 'scaleX'), index('left', 'scaleY'),
    index('right', 'scaleX'), index('right', 'scaleY'),
    index('left', 'size'), index('right', 'size'),
  ] as readonly number[],
  ranges,
} as const;
