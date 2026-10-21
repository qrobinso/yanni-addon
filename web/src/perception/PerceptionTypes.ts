// Port of FacePerception/PerceptionTypes.swift.
//
// Coordinates: everything in FacePerception uses one **viewer frame**: the camera image made upright and mirrored so
// it looks the way the room looks to someone standing in front of the screen (x toward the viewer's right, y down,
// normalised 0…1 with the origin top-left). The capture adapter (or a replay) does the orientation and mirror once,
// through `CameraGeometry`; nothing downstream knows about sensor orientation.
//
// Camera space (metres) is the same frame in 3-D: origin at the lens, x toward the viewer's right, y down, z out of
// the screen toward the room. Gaze space is the engine's: x −1…1 ↔ −35°…+35°, y −1…1 ↔ −25°…+25°, camera-relative
// (the engine's Attention adds the camera-offset correction).
//
// Port conventions for this folder: Swift `T?` → `T | null`; data structs → interfaces plus a `make…()` factory
// carrying the Swift init defaults; payload enums → `{ kind: … }` unions; `[Enum: V]` → `Partial<Record<Enum, V>>`.
import type { V2, V3 } from '../core/vec';

// MARK: - NRect

/// A rectangle in normalised viewer-frame coordinates (origin top-left, y down).
export interface NRect { x: number; y: number; w: number; h: number }

export const NRect = {
  make: (x: number, y: number, w: number, h: number): NRect => ({ x, y, w, h }),
  fromCenter: (c: V2, s: V2): NRect => ({ x: c.x - s.x / 2, y: c.y - s.y / 2, w: s.x, h: s.y }),
  center: (r: NRect): V2 => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 }),
  size: (r: NRect): V2 => ({ x: r.w, y: r.h }),
  maxX: (r: NRect): number => r.x + r.w,
  maxY: (r: NRect): number => r.y + r.h,
  area: (r: NRect): number => Math.max(r.w, 0) * Math.max(r.h, 0),
  diagonal: (r: NRect): number => Math.sqrt(r.w * r.w + r.h * r.h),
  contains: (r: NRect, p: V2): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h,
  intersection(a: NRect, o: NRect): number {
    const ix = Math.max(0, Math.min(a.x + a.w, o.x + o.w) - Math.max(a.x, o.x));
    const iy = Math.max(0, Math.min(a.y + a.h, o.y + o.h) - Math.max(a.y, o.y));
    return ix * iy;
  },
  iou(a: NRect, o: NRect): number {
    const i = NRect.intersection(a, o);
    const u = NRect.area(a) + NRect.area(o) - i;
    return u > 0 ? i / u : 0;
  },
  insetBy: (r: NRect, f: number): NRect => ({ x: r.x - r.w * f, y: r.y - r.h * f, w: r.w * (1 + 2 * f), h: r.h * (1 + 2 * f) }),
  equals: (a: NRect | null, b: NRect | null): boolean =>
    a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h),
} as const;

// MARK: - Camera intrinsics

/// Camera intrinsics for the upright image (pixels).
export interface CameraIntrinsics {
  /// Upright image size (pixels).
  imageSize: V2;
  /// Focal length (pixels, x and y).
  focal: V2;
  /// Principal point (pixels, upright, viewer frame).
  principal: V2;
}

export const CameraIntrinsics = {
  /// From the horizontal field of view (degrees) with square pixels and a centred principal point.
  fromFieldOfView(width: number, height: number, horizontalDegrees: number): CameraIntrinsics {
    const f = (width / 2) / Math.tan(horizontalDegrees * Math.PI / 360);
    return { imageSize: { x: width, y: height }, focal: { x: f, y: f }, principal: { x: width / 2, y: height / 2 } };
  },
  /// A typical iPad front ultra-wide in landscape (4:3, 1920×1440, ≈ 106° horizontal). A fresh copy per call.
  get typicalLandscape(): CameraIntrinsics { return CameraIntrinsics.fromFieldOfView(1920, 1440, 106); },
  /// The same camera rotated a quarter turn (width ↔ height).
  transposed: (k: CameraIntrinsics): CameraIntrinsics => ({
    imageSize: { x: k.imageSize.y, y: k.imageSize.x }, focal: { x: k.focal.y, y: k.focal.x },
    principal: { x: k.principal.y, y: k.principal.x },
  }),
  equals: (a: CameraIntrinsics, b: CameraIntrinsics): boolean =>
    a.imageSize.x === b.imageSize.x && a.imageSize.y === b.imageSize.y && a.focal.x === b.focal.x &&
    a.focal.y === b.focal.y && a.principal.x === b.principal.x && a.principal.y === b.principal.y,
} as const;

// MARK: - Detections

/// Head rotation (radians) as reported in the configured head-pose frame (see `HeadPoseFrame`).
/// yaw + turns the face toward the viewer frame's +x (the person's own right), pitch + tips it down, roll + tilts it
/// clockwise as seen in the viewer frame.
export interface HeadPose { yaw: number; pitch: number; roll: number }
export const makeHeadPose = (yaw: number, pitch: number, roll = 0): HeadPose => ({ yaw, pitch, roll });

export type EyeGazeSource = 'vision' | 'mediaPipe' | 'pupilFinder';

/// Eye-in-head direction from a dedicated estimator (e.g. the MediaPipe Face Landmarker adapter): radians,
/// yaw + toward the viewer frame's +x, pitch + down, relative to the head.
export interface EyeGazeEstimate { yaw: number; pitch: number; confidence: number; source: EyeGazeSource }

/// What the landmarks say about the eyes (both eyes averaged).
export interface EyeObservation {
  /// Pupil position inside the eye contour, normalised to the contour's half-width / half-height (−1…1, viewer frame).
  pupilOffset: V2;
  /// Eye contour width in pixels (mean of both eyes): how readable the eyes are.
  eyeWidthPx: number;
  /// Landmark confidence 0…1.
  confidence: number;
  /// Lid opening relative to eye width (blinks drop it); the static-face check watches it change.
  openness: number;
}
export const makeEyeObservation = (pupilOffset: V2, eyeWidthPx: number, confidence: number, openness = 0.3): EyeObservation =>
  ({ pupilOffset, eyeWidthPx, confidence, openness });

/// One detected face.
export interface FaceDetection {
  box: NRect;
  confidence: number;
  headPose: HeadPose | null;
  eyes: EyeObservation | null;
  /// Distance between the pupils in pixels (landmarks), if measured.
  interocularPx: number | null;
  /// An external eye-gaze estimate (MediaPipe adapter, pupil finder); preferred over `eyes` when present.
  gaze: EyeGazeEstimate | null;
}
export const makeFaceDetection = (box: NRect, o: Partial<Omit<FaceDetection, 'box'>> = {}): FaceDetection =>
  ({ box, confidence: 0.9, headPose: null, eyes: null, interocularPx: null, gaze: null, ...o });

/// A 2-D joint (viewer frame) with its confidence.
export interface Joint { p: V2; c: number }
export const joint = (p: V2, c = 0.9): Joint => ({ p, c });

/// Vision body-pose joints Yanni reads (raw values match Vision's joint names). Hips feed dancing, the torso-length
/// distance cue and the skeleton (OKS) association cost; knees and ankles are never used.
export type BodyJointName = 'nose' | 'neck' | 'leftShoulder' | 'rightShoulder' | 'leftElbow' | 'rightElbow' |
  'leftWrist' | 'rightWrist' | 'root' | 'leftHip' | 'rightHip';
export const BodyJointName = {
  allCases: ['nose', 'neck', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
    'root', 'leftHip', 'rightHip'] as readonly BodyJointName[],
} as const;

/// One upper-body human rectangle (Vision `upperBodyOnly`), optionally with 2-D body joints.
export interface BodyDetection {
  box: NRect;
  confidence: number;
  /// Joints (person's own left / right).
  joints: Partial<Record<BodyJointName, Joint>>;
  /// A coarse torso colour histogram (computed in memory, never stored with pixels), for association.
  appearance: number[] | null;
}
export const makeBodyDetection = (box: NRect, o: Partial<Omit<BodyDetection, 'box'>> = {}): BodyDetection =>
  ({ box, confidence: 0.9, joints: {}, appearance: null, ...o });

export function bodyJoint(b: BodyDetection, n: BodyJointName, minConfidence = 0.3): V2 | null {
  const j = b.joints[n];
  return j !== undefined && j.c >= minConfidence ? j.p : null;
}

/// The person's own hand.
export type Chirality = 'left' | 'right';

export type HandJointName = 'wrist' |
  'thumbCMC' | 'thumbMP' | 'thumbIP' | 'thumbTip' |
  'indexMCP' | 'indexPIP' | 'indexDIP' | 'indexTip' |
  'middleMCP' | 'middlePIP' | 'middleDIP' | 'middleTip' |
  'ringMCP' | 'ringPIP' | 'ringDIP' | 'ringTip' |
  'littleMCP' | 'littlePIP' | 'littleDIP' | 'littleTip';
export const HandJointName = {
  allCases: ['wrist', 'thumbCMC', 'thumbMP', 'thumbIP', 'thumbTip', 'indexMCP', 'indexPIP', 'indexDIP', 'indexTip',
    'middleMCP', 'middlePIP', 'middleDIP', 'middleTip', 'ringMCP', 'ringPIP', 'ringDIP', 'ringTip', 'littleMCP',
    'littlePIP', 'littleDIP', 'littleTip'] as readonly HandJointName[],
} as const;

/// One detected hand (21 joints).
export interface HandDetection {
  joints: Partial<Record<HandJointName, Joint>>;
  chirality: Chirality | null;
  confidence: number;
}
export const makeHandDetection = (joints: Partial<Record<HandJointName, Joint>>, chirality: Chirality | null = null,
  confidence = 0.9): HandDetection => ({ joints, chirality, confidence });

export function handJoint(h: HandDetection, n: HandJointName, minConfidence = 0.3): V2 | null {
  const j = h.joints[n];
  return j !== undefined && j.c >= minConfidence ? j.p : null;
}

/// A coarse luma grid for the motion map (numbers only, never kept).
export interface MotionGrid {
  cols: number; rows: number;
  /// Row-major luma 0…1.
  luma: number[];
  /// The camera's exposure or white balance changed this frame (motion is suppressed briefly).
  exposureChanged: boolean;
}
export const makeMotionGrid = (cols: number, rows: number, luma: number[], exposureChanged = false): MotionGrid =>
  ({ cols, rows, luma, exposureChanged });

/// Everything one analysed frame produced, in the viewer frame. Produced by the MediaPipe adapter or a replay.
export interface FrameDetections {
  /// Capture time, host-clock seconds.
  time: number;
  intrinsics: CameraIntrinsics;
  faces: FaceDetection[];
  bodies: BodyDetection[];
  hands: HandDetection[];
  motion: MotionGrid | null;
  /// Whether the hand / body-pose stages ran on this frame (they alternate); a stage that didn't run says nothing.
  handsRan: boolean;
  bodyPoseRan: boolean;
}
export const makeFrameDetections = (time: number, o: Partial<Omit<FrameDetections, 'time'>> = {}): FrameDetections => ({
  time, intrinsics: CameraIntrinsics.typicalLandscape, faces: [], bodies: [], hands: [], motion: null,
  handsRan: true, bodyPoseRan: true, ...o,
});

// MARK: - Outputs

export type TrackState = 'tentative' | 'confirmed' | 'coasting';

export type DistanceSource = 'ipd' | 'faceWidth' | 'shoulders' | 'torso' | 'bodyBox' | 'prior';

/// Which signal the eye-contact estimate rests on.
export type GazeSource = { kind: 'eyes'; source: EyeGazeSource } | { kind: 'headPose' } | { kind: 'none' };
export const GazeSource = {
  eyes: (source: EyeGazeSource): GazeSource => ({ kind: 'eyes', source }),
  headPose: { kind: 'headPose' } as GazeSource,
  none: { kind: 'none' } as GazeSource,
  label: (g: GazeSource): string => g.kind === 'eyes' ? `eyes (${g.source})` : g.kind === 'headPose' ? 'head pose' : 'none',
  equals: (a: GazeSource, b: GazeSource): boolean =>
    a.kind === b.kind && (a.kind !== 'eyes' || a.source === (b as { source: EyeGazeSource }).source),
} as const;

/// One person as perception sees them.
export interface TrackedPerson {
  /// Monotonic, never reused in a session.
  id: number;
  state: TrackState;
  bodyBox: NRect | null;
  faceBox: NRect | null;
  /// Normalised gaze space, camera-relative, clamped ±1.
  position: V2;
  /// Camera space (metres): head centre.
  positionMetres: V3;
  /// Gaze units per second.
  velocity: V2;
  distance: number;
  distanceSource: DistanceSource;
  headPose: HeadPose | null;
  /// 0…1: the head is turned toward the eyes on screen.
  facing: number;
  /// 0…1: eye-contact confidence (smoothed).
  lookingAtMe: number;
  gazeSource: GazeSource;
  /// Angle (degrees) between the estimated gaze and the eyes on screen, bias removed.
  gazeErrorDegrees: number | null;
  /// Current tolerance θ_max (degrees).
  toleranceDegrees: number | null;
  /// Estimated gaze (bias removed) and the direction to the drawn eyes, camera space (calibration read-outs).
  gazeVector: V3 | null;
  requiredVector: V3 | null;
  /// Seconds of continuous eye contact (dropout tolerant).
  lookingFor: number;
  /// Engagement dwell accumulated (seconds) and the dwell this person currently needs.
  dwell: number;
  dwellNeeded: number;
  salience: number;
  engaged: boolean;
  /// A face that never moves or blinks (poster, photo): excluded from the people list and engagement.
  isStatic: boolean;
  firstSeen: number;
  lastSeen: number;
}
export const makeTrackedPerson = (id: number, o: Partial<Omit<TrackedPerson, 'id'>> = {}): TrackedPerson => ({
  id, state: 'confirmed', bodyBox: null, faceBox: null, position: { x: 0, y: 0 }, positionMetres: { x: 0, y: 0, z: 1.5 },
  velocity: { x: 0, y: 0 }, distance: 1.5, distanceSource: 'prior', headPose: null, facing: 0, lookingAtMe: 0,
  gazeSource: GazeSource.none, gazeErrorDegrees: null, toleranceDegrees: null, gazeVector: null, requiredVector: null,
  lookingFor: 0, dwell: 0, dwellNeeded: 1, salience: 0, engaged: false, isStatic: false, firstSeen: 0, lastSeen: 0, ...o,
});

/// The curated gestures (perception upgrade design §6.1). Every one has its own reaction in `PerceptionReflexes`.
export type GestureKind =
  /** Hello wave. */
  | { kind: 'wave' }
  /** Waving while leaving; `side` is the person's exit side (−1 viewer's left, +1 right). */
  | { kind: 'byeWave'; side: number }
  | { kind: 'clap' }
  /** Both arms up ("yay!"). */
  | { kind: 'armsUp' }
  /** Pointing; `direction` is a unit vector in the viewer frame (x right, y down). */
  | { kind: 'point'; direction: V2 }
  /** The person nodding (mirrored only in follow-up). */
  | { kind: 'nod' }
  | { kind: 'thumbsUp' }
  | { kind: 'thumbsDown' }
  /** Open palm held still ("hi"). */
  | { kind: 'openPalm' }
  /** Peace / V sign. */
  | { kind: 'peace' }
  /** Two-hand heart. */
  | { kind: 'heartHands' }
  /** Hands over the face after a look, then the reveal (the observation is the reveal). */
  | { kind: 'peekaboo' }
  /** Sustained dancing (`GestureObservation.phase` started / ended). */
  | { kind: 'dancing' }
  /** An aimed open palm approaching the screen (`started`: the touch window armed) or a tap in that window (`instant`). */
  | { kind: 'highFive' };

export type GestureName = GestureKind['kind'];

const GESTURE_NAMES: readonly GestureName[] = ['wave', 'byeWave', 'clap', 'armsUp', 'point', 'nod', 'thumbsUp',
  'thumbsDown', 'openPalm', 'peace', 'heartHands', 'peekaboo', 'dancing', 'highFive'];
const HA_NAMES: Record<GestureName, string> = {
  wave: 'wave', byeWave: 'bye_wave', clap: 'clap', armsUp: 'arms_up', point: 'point', nod: 'nod', thumbsUp: 'thumbs_up',
  thumbsDown: 'thumbs_down', openPalm: 'open_palm', peace: 'peace', heartHands: 'heart_hands', peekaboo: 'peekaboo',
  dancing: 'dance', highFive: 'high_five',
};

export const GestureKind = {
  wave: { kind: 'wave' } as GestureKind,
  byeWave: (side: number): GestureKind => ({ kind: 'byeWave', side }),
  clap: { kind: 'clap' } as GestureKind,
  armsUp: { kind: 'armsUp' } as GestureKind,
  point: (direction: V2): GestureKind => ({ kind: 'point', direction }),
  nod: { kind: 'nod' } as GestureKind,
  thumbsUp: { kind: 'thumbsUp' } as GestureKind,
  thumbsDown: { kind: 'thumbsDown' } as GestureKind,
  openPalm: { kind: 'openPalm' } as GestureKind,
  peace: { kind: 'peace' } as GestureKind,
  heartHands: { kind: 'heartHands' } as GestureKind,
  peekaboo: { kind: 'peekaboo' } as GestureKind,
  dancing: { kind: 'dancing' } as GestureKind,
  highFive: { kind: 'highFive' } as GestureKind,
  name: (g: GestureKind): GestureName => g.kind,
  /// Home Assistant `last_gesture` event type.
  homeAssistantName: (g: GestureKind): string => HA_NAMES[g.kind],
  /// Dense index for fixed per-gesture tables.
  index: (g: GestureKind): number => GESTURE_NAMES.indexOf(g.kind),
  count: 14,
  /// Every gesture name (settings, the panel).
  allNames: GESTURE_NAMES,
  equals(a: GestureKind, b: GestureKind): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'byeWave') return a.side === (b as { side: number }).side;
    if (a.kind === 'point') { const d = (b as { direction: V2 }).direction; return a.direction.x === d.x && a.direction.y === d.y; }
    return true;
  },
} as const;

/// Which detector produced a gesture: the joint rules, a learned model (`HandShapeNet` vN), or a touch (high-five).
export type GestureSource = { kind: 'rules' } | { kind: 'model'; version: number } | { kind: 'touch' };
export const GestureSource = {
  rules: { kind: 'rules' } as GestureSource,
  model: (version: number): GestureSource => ({ kind: 'model', version }),
  touch: { kind: 'touch' } as GestureSource,
} as const;

/// Instant gestures fire once; dancing is sustained (started, then ended).
export type GesturePhase = 'instant' | 'started' | 'ended';

/// A gesture that completed this frame.
export interface GestureObservation {
  kind: GestureKind;
  personID: number | null;
  hand: Chirality | null;
  confidence: number;
  /// The aimed-at gate passed and the directed score `D ≥ 0.5` (design §6.5).
  directedAtYanni: boolean;
  /// Gaze-space position of the hand.
  at: V2;
  /// Distance of the person (metres).
  distance: number;
  /// Completion time: capture host time of the frame that completed it.
  time: number;
  source: GestureSource;
  /// The hand-set directed score (0…1; facing, hand raised in front of the torso, onset, distance, others).
  directedScore: number;
  phase: GesturePhase;
}
export function makeGestureObservation(o: Omit<GestureObservation, 'source' | 'directedScore' | 'phase'> &
  { source?: GestureSource; directedScore?: number | null; phase?: GesturePhase }): GestureObservation {
  return {
    ...o, source: o.source ?? GestureSource.rules,
    directedScore: o.directedScore ?? (o.directedAtYanni ? 1 : 0), phase: o.phase ?? 'instant',
  };
}

/// One gesture-layer decision for the People log (fired, or why a candidate was dropped).
export interface GestureDecision { kind: string; personID: number; reason: string; time: number }

export type ExitEdge = 'left' | 'right' | 'top' | 'bottom';

/// lookedAway: not looking for `releaseAfter` s · outOfRange: out of range for 2 s · left: gone from view (or turned
/// static) · released: the conversation loop released the turn · reset: perception switched off, reset or re-sourced.
export type DisengageReason = 'lookedAway' | 'outOfRange' | 'left' | 'released' | 'reset';

/// Camera and pipeline status.
export type CameraStatus =
  | { kind: 'starting' } | { kind: 'running' } | { kind: 'lowRate' } | { kind: 'denied' } | { kind: 'restricted' }
  | { kind: 'unavailable'; reason: string } | { kind: 'interrupted'; reason: string }
  | { kind: 'pressure'; reason: string } | { kind: 'stopped' } | { kind: 'offAtBedtime' };

export const CameraStatus = {
  starting: { kind: 'starting' } as CameraStatus,
  running: { kind: 'running' } as CameraStatus,
  lowRate: { kind: 'lowRate' } as CameraStatus,
  denied: { kind: 'denied' } as CameraStatus,
  restricted: { kind: 'restricted' } as CameraStatus,
  unavailable: (reason: string): CameraStatus => ({ kind: 'unavailable', reason }),
  interrupted: (reason: string): CameraStatus => ({ kind: 'interrupted', reason }),
  pressure: (reason: string): CameraStatus => ({ kind: 'pressure', reason }),
  stopped: { kind: 'stopped' } as CameraStatus,
  offAtBedtime: { kind: 'offAtBedtime' } as CameraStatus,
  label(s: CameraStatus): string {
    switch (s.kind) {
      case 'starting': return 'starting';
      case 'running': return 'running';
      case 'lowRate': return 'low rate (asleep)';
      case 'denied': return 'camera denied · open Settings';
      case 'restricted': return 'camera restricted';
      case 'unavailable': return `camera unavailable (${s.reason})`;
      case 'interrupted': return `interrupted (${s.reason})`;
      case 'pressure': return `system pressure (${s.reason})`;
      case 'stopped': return 'stopped';
      case 'offAtBedtime': return 'off at bedtime';
    }
  },
  equals: (a: CameraStatus, b: CameraStatus): boolean =>
    a.kind === b.kind && (a as { reason?: string }).reason === (b as { reason?: string }).reason,
} as const;

/// Analysis tier: what runs, how often. Raw values order them (critical < reduced < standard < full).
export type PerceptionTier = 0 | 1 | 2 | 3;
export const PerceptionTier = {
  critical: 0 as PerceptionTier, reduced: 1 as PerceptionTier, standard: 2 as PerceptionTier, full: 3 as PerceptionTier,
  allCases: [0, 1, 2, 3] as readonly PerceptionTier[],
  label: (t: PerceptionTier): string => (['critical', 'reduced', 'standard', 'full'] as const)[t],
} as const;

/// Everything perception tells the rest of the app.
export type PerceptionEvent =
  | { kind: 'personEntered'; id: number; at: V2; distance: number }
  /** The person dropped out of the visible list (coasting past the visible limit). `exitEdge` null = faded in place. */
  | { kind: 'personOutOfView'; id: number; lastPosition: V2; distance: number; exitEdge: ExitEdge | null }
  /** Gone for good: fires once the re-entry window has closed without them coming back. */
  | { kind: 'personLeft'; id: number; lastPosition: V2; exitEdge: ExitEdge | null }
  /** At 0.5, 1, 2 and 5 s of continuous eye contact. */
  | { kind: 'lookingAtMe'; id: number; seconds: number }
  | { kind: 'engaged'; id: number }
  | { kind: 'disengaged'; id: number; reason: DisengageReason }
  /** Met the engagement rule while someone else holds the turn (once per turn). */
  | { kind: 'wantsTurn'; id: number }
  | { kind: 'primaryChanged'; from: number | null; to: number | null }
  | { kind: 'gesture'; gesture: GestureObservation }
  /** Motion not explained by a tracked person (gaze space). */
  | { kind: 'motion'; at: V2; strength: number }
  | { kind: 'staticFaceSuppressed'; id: number }
  | { kind: 'cameraStatus'; status: CameraStatus }
  | { kind: 'tierChanged'; from: PerceptionTier; to: PerceptionTier; reason: string };

/// Swift `String(format: "%.Nf")` / `"%+.Nf"`.
export const fmt = (v: number, digits: number, plus = false): string => (plus && v >= 0 ? '+' : '') + v.toFixed(digits);
/// Swift `"%g"`.
export const fmtG = (v: number): string => String(Number(v.toPrecision(6)));

export const PerceptionEvent = {
  /// A short type name (event logs, golden comparisons).
  name: (e: PerceptionEvent): string => e.kind === 'gesture' ? `gesture.${e.gesture.kind.kind}` : e.kind,
  /// One log line.
  text(e: PerceptionEvent): string {
    const pt = (p: V2): string => `(${fmt(p.x, 2, true)}, ${fmt(p.y, 2, true)})`;
    const id = (i: number | null): string => i === null ? 'none' : String(i);
    switch (e.kind) {
      case 'personEntered': return `person ${e.id} entered at ${pt(e.at)}, ${fmt(e.distance, 1)} m`;
      case 'personOutOfView': return `person ${e.id} out of view at ${pt(e.lastPosition)}` + (e.exitEdge !== null ? ` (${e.exitEdge} edge)` : '');
      case 'personLeft': return `person ${e.id} left` + (e.exitEdge !== null ? ` (${e.exitEdge} edge)` : '');
      case 'lookingAtMe': return `person ${e.id} looking at me ${fmtG(e.seconds)} s`;
      case 'engaged': return `person ${e.id} engaged`;
      case 'disengaged': return `person ${e.id} disengaged (${e.reason})`;
      case 'wantsTurn': return `person ${e.id} wants a turn`;
      case 'primaryChanged': return `primary ${id(e.from)} → ${id(e.to)}`;
      case 'gesture': {
        const g = e.gesture;
        return `gesture ${g.kind.kind}${g.phase === 'instant' ? '' : ` (${g.phase})`} · person ${id(g.personID)} · ` +
          `${fmt(g.confidence, 2)} · D ${fmt(g.directedScore, 2)}${g.directedAtYanni ? ' · directed' : ''}`;
      }
      case 'motion': return `motion at ${pt(e.at)} · ${fmt(e.strength, 2)}`;
      case 'staticFaceSuppressed': return `person ${e.id} is a static face (suppressed)`;
      case 'cameraStatus': return `camera ${CameraStatus.label(e.status)}`;
      case 'tierChanged': return `tier ${PerceptionTier.label(e.from)} → ${PerceptionTier.label(e.to)} (${e.reason})`;
    }
  },
} as const;

/// Pipeline statistics for the status page.
export interface PerceptionStats {
  tier: PerceptionTier;
  lowMode: boolean;
  /// Awake with nobody seen for the room-empty delay: perception runs its vacancy plan, the face renders at 30.
  vacant: boolean;
  analysisFPS: number;
  /// Per-stage milliseconds (rects, landmarks, hands, body, motion, logic).
  stageMs: Record<string, number>;
  faces: number;
  facesWithEyes: number;
  bodies: number;
  hands: number;
  thermal: string;
  camera: CameraStatus;
  /// False engagements (engaged without speech) per hour, from the conversation loop's outcomes.
  falseEngagementsPerHour: number;
}
export const makePerceptionStats = (): PerceptionStats => ({
  tier: PerceptionTier.standard, lowMode: false, vacant: false, analysisFPS: 0, stageMs: {}, faces: 0, facesWithEyes: 0,
  bodies: 0, hands: 0, thermal: 'nominal', camera: CameraStatus.stopped, falseEngagementsPerHour: 0,
});

export function detectionsSummary(s: PerceptionStats): string {
  if (s.faces === 0 && s.bodies === 0 && s.hands === 0) return 'nothing detected';
  const n = (v: number, one: string, many: string): string => `${v} ${v === 1 ? one : many}`;
  const parts = [n(s.bodies, 'body', 'bodies'), n(s.faces, 'face', 'faces')];
  if (s.faces > 0) parts[1] += ` (${s.facesWithEyes} eyes, ${s.faces - s.facesWithEyes} head-only)`;
  parts.push(n(s.hands, 'hand', 'hands'));
  return parts.join(', ');
}

/// One analysed frame's result.
export interface PerceptionSnapshot {
  time: number;
  /// Confirmed people plus those coasting within the visible limit (static faces excluded).
  people: TrackedPerson[];
  primaryID: number | null;
  engagedID: number | null;
  /// IDs waiting for a turn (FIFO order).
  waitingIDs: number[];
  turnPinned: boolean;
  gestures: GestureObservation[];
  stats: PerceptionStats;
  /// Gesture-layer decisions made this frame (fired, or why a candidate was dropped), for the People log.
  gestureDecisions: GestureDecision[];
  /// Wrist regions (viewer frame) worth a zoomed hand pass on the next analysed frame (design §6.3).
  wristROIs: NRect[];
}
export const makePerceptionSnapshot = (o: Partial<PerceptionSnapshot> = {}): PerceptionSnapshot => ({
  time: 0, people: [], primaryID: null, engagedID: null, waitingIDs: [], turnPinned: false, gestures: [],
  stats: makePerceptionStats(), gestureDecisions: [], wristROIs: [], ...o,
});

/// A snapshot and the events of the same frame.
export interface PerceptionOutput { snapshot: PerceptionSnapshot; events: PerceptionEvent[] }

// MARK: - Small maths

export const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export const vlength2 = (v: V2): number => Math.sqrt(v.x * v.x + v.y * v.y);
export const vlength3 = (v: V3): number => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
export function vnormalize3(v: V3): V3 { const l = vlength3(v); return l > 0 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { ...v }; }
export function vnormalize2(v: V2): V2 { const l = vlength2(v); return l > 0 ? { x: v.x / l, y: v.y / l } : { ...v }; }
export const vdot3 = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const vdot2 = (a: V2, b: V2): number => a.x * b.x + a.y * b.y;

export const radToDeg = 180 / Math.PI;
export const degToRad = Math.PI / 180;
