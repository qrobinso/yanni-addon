// Port of FaceModel/PupilShape.swift.
/// The silhouette a pupil is drawn as (pupil transformations design). `ellipse` is the everyday inky pupil with
/// its notch and crescent; the others are brief cartoon transformations. Discrete: never blended with the pose.
/// Raw values (UInt8 in Swift) are kept: FaceFrame.pupilShape carries them.
export const PupilShape = {
  /// The default pupil: a tall ink oval with the ivory pie-cut notch and the mood crescent.
  ellipse: 0,
  /// A four-point star (delight). Morphs from the ellipse.
  star: 1,
  /// A heart (affection). Morphs from the ellipse.
  heart: 2,
  /// An eighth note (music for Yanni). Switched in with a coin flip.
  note: 3,
  /// A question mark (playful curiosity). Switched in with a coin flip.
  question: 4,
  /// An exclamation mark (a reveal, a shared success). Switched in with a coin flip.
  exclaim: 5,
} as const;
export type PupilShape = (typeof PupilShape)[keyof typeof PupilShape];

export const pupilShapeAllCases: readonly PupilShape[] = [0, 1, 2, 3, 4, 5];

/// True for the shapes that blend from the ellipse by signed distance (star, heart); the others have separate
/// parts (a dot, a stem) and swap at the sliver of a coin flip.
export const pupilShapeMorphs = (s: PupilShape): boolean => s === PupilShape.star || s === PupilShape.heart;

/// True for the shapes that carry the mood accent (an offset cut-out along the lower-left edge).
export const pupilShapeHasMoodAccent = (s: PupilShape): boolean => s === PupilShape.star || s === PupilShape.heart;

/// Raw value, or `ellipse` for anything unknown.
export const pupilShapeClamping = (raw: number): PupilShape =>
  Number.isInteger(raw) && raw >= 0 && raw <= 5 ? (raw as PupilShape) : PupilShape.ellipse;
