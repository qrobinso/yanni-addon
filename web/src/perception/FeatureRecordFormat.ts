// Port of FacePerception/FeatureRecordFormat.swift.
//
// Feature recorder v2 (perception upgrade design §5.2): the on-disk format. Numbers only: boxes, confidences, head
// pose, derived eye features, body and hand joints, the processor's per-person outputs and stage timings, as raw
// IEEE half floats (written by hand so every platform reads and writes them the same). Never pixels, never the motion
// grid, never the torso colour histogram, never the face landmark points.
import type { V2 } from '../core/vec';
import { StageTimings } from './HarnessTiming';
import { BodyJointName, CameraIntrinsics, HandJointName } from './PerceptionTypes';
import { RecordingConsentText, type RecordingParticipant } from './RecordingConsent';

const f32 = new DataView(new ArrayBuffer(4));

/// IEEE 754 binary16 conversion (round to nearest even; NaN and ±∞ kept).
export const Half = {
  bits(f: number): number {
    f32.setFloat32(0, f);   // Swift takes a Float: round to float32 first
    const x = f32.getUint32(0);
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) return sign | 0x7c00 | (mant !== 0 ? 0x200 : 0);      // NaN / ∞
    const e = exp - 127 + 15;
    if (e >= 0x1f) return sign | 0x7c00;                                     // overflow → ∞
    if (e <= 0) {                                                            // subnormal or zero
      if (e < -10) return sign;
      mant |= 0x800000;
      const shift = 14 - e;
      let h = mant >>> shift;
      const rem = mant & ((1 << shift) - 1), half = 1 << (shift - 1);
      if (rem > half || (rem === half && (h & 1) === 1)) h += 1;
      return sign | h;
    }
    let h = (e << 10) | (mant >>> 13);
    const rem = mant & 0x1fff;
    if (rem > 0x1000 || (rem === 0x1000 && (h & 1) === 1)) h += 1;           // may carry into the exponent: fine
    return (sign | h) & 0xffff;
  },

  float(h: number): number {
    const sign = (h & 0x8000) << 16;
    const exp = (h >>> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) {
      if (mant === 0) return sign !== 0 ? -0 : 0;
      const v = mant * Math.pow(2, -24);
      return sign !== 0 ? -v : v;
    }
    if (exp === 0x1f) { f32.setUint32(0, (sign | 0x7f800000 | (mant << 13)) >>> 0); return f32.getFloat32(0); }
    f32.setUint32(0, (sign | ((exp - 15 + 127) << 23) | (mant << 13)) >>> 0);
    return f32.getFloat32(0);
  },
} as const;

const jointFields = (names: readonly string[]): string[] => names.flatMap((n) => [`${n}.x`, `${n}.y`, `${n}.c`]);

/// The self-describing layout of a frame record: the field names of each block, so older and newer readers map
/// fields by name (a joint added later reads as missing from older files).
export class FeatureRecordLayout {
  /// Box, confidence, head pose and *derived* eye features (pupil offsets, eye width, openness, IPD) — never the
  /// 76 landmark points.
  static readonly faceFields: readonly string[] = ['x', 'y', 'w', 'h', 'conf', 'yaw', 'pitch', 'roll', 'pupilX', 'pupilY',
    'eyeWidthPx', 'eyeConf', 'openness', 'ipdPx', 'gazeYaw', 'gazePitch', 'gazeConf'];
  static get bodyFields(): string[] { return ['x', 'y', 'w', 'h', 'conf', ...jointFields(BodyJointName.allCases)]; }
  static get handFields(): string[] { return ['chirality', 'conf', ...jointFields(HandJointName.allCases)]; }
  static readonly personFields: readonly string[] = ['state', 'bodyX', 'bodyY', 'bodyW', 'bodyH', 'faceX', 'faceY',
    'faceW', 'faceH', 'posX', 'posY', 'mX', 'mY', 'mZ', 'distance', 'distanceSource', 'yaw', 'pitch', 'roll', 'facing',
    'lookingAtMe', 'gazeSource', 'gazeErrorDeg', 'toleranceDeg', 'lookingFor', 'dwell', 'dwellNeeded', 'salience',
    'engaged', 'static'];

  version = 1;
  stages: string[] = [...StageTimings.names];
  face: string[] = [...FeatureRecordLayout.faceFields];
  body: string[] = FeatureRecordLayout.bodyFields;
  hand: string[] = FeatureRecordLayout.handFields;
  /// Per tracked person (after the Int32 track ID).
  person: string[] = [...FeatureRecordLayout.personFields];
  /// Code tables for the enum-valued fields (index = code; −1 = unknown).
  // port-note: like the Swift, "torso" is missing from this table, so a torso distance source records as −1.
  distanceSources: string[] = ['ipd', 'faceWidth', 'shoulders', 'bodyBox', 'prior'];
  trackStates: string[] = ['tentative', 'confirmed', 'coasting'];
  gazeSources: string[] = ['none', 'headPose', 'eyes.vision', 'eyes.mediaPipe', 'eyes.pupilFinder'];

  static fromJSON(o: Partial<FeatureRecordLayout>): FeatureRecordLayout { return Object.assign(new FeatureRecordLayout(), o); }
}

/// What kind of session a recording is (the evaluator treats each differently).
/// scripted: prompted performances · none: ordinary household activity · hardNegatives: nothing may trigger ·
/// eyeContact: targets at the floor marks · tracking: scripted crossings and re-entries · free: development.
export type RecordingSessionType = 'scripted' | 'none' | 'hardNegatives' | 'eyeContact' | 'tracking' | 'free';
export const RecordingSessionType = {
  allCases: ['scripted', 'none', 'hardNegatives', 'eyeContact', 'tracking', 'free'] as readonly RecordingSessionType[],
  title(t: RecordingSessionType): string {
    switch (t) {
      case 'scripted': return 'Scripted gestures';
      case 'none': return '"None" (ordinary living)';
      case 'hardNegatives': return 'Hard negatives';
      case 'eyeContact': return 'Eye-contact targets';
      case 'tracking': return 'Tracking (crossings)';
      case 'free': return 'Free';
    }
  },
} as const;

/// `header.json` of a session (v2 schema).
export class FeatureRecordingHeader {
  schema = 2;
  /// "iPad" or "Mac preview" (never pooled by the evaluator).
  platform = 'unknown';
  deviceModel = '';
  osBuild = '';
  osMajor = 0;
  /// Detector revisions in use (name → revision).
  visionRevisions: Record<string, string> = {};
  captureFormat = '';
  intrinsics: CameraIntrinsics = CameraIntrinsics.typicalLandscape;
  /// Metres, relative to the drawn face centre.
  cameraOffset: V2 = { x: 0, y: 0 };
  /// Drawn face size (points) and its centre's offset from the screen centre (metres).
  faceSizePoints: V2 = { x: 0, y: 0 };
  faceCentreOffset: V2 = { x: 0, y: 0 };
  interfaceOrientation = '';
  appBuild = '';
  consentTextVersion = RecordingConsentText.version;
  tier = '';
  stagePlan = '';
  layout = new FeatureRecordLayout();
  // Filled in when the session ends.
  endDate: Date | null = null;
  framesWritten = 0;
  framesPausedUndeclared = 0;
  framesDropped = 0;
  stopReason: string | null = null;

  constructor(
    public id: string,
    public sessionType: RecordingSessionType,
    /// Declared participants (pseudonyms P1…Pn) and their consent records.
    public participants: RecordingParticipant[],
    public startDate: Date,
    /// Host-clock seconds at the start (frame times and label times are host-clock seconds).
    public startHostTime: number,
  ) {}

  copy(): FeatureRecordingHeader { return FeatureRecordingHeader.decode(this.encode()); }

  // port-note: Swift's Codable JSON (ISO 8601 dates, SIMD as arrays, nil left out); here plain JSON with ISO dates.
  encode(): string {
    return JSON.stringify(this, (_k, v: unknown) => v === null ? undefined : v, 2);
  }

  static decode(text: string): FeatureRecordingHeader {
    const o = JSON.parse(text) as Record<string, unknown>;
    const h = new FeatureRecordingHeader(o.id as string, o.sessionType as RecordingSessionType,
      ((o.participants as Record<string, unknown>[] | undefined) ?? []).map((p) => ({ ...p, consentDate: new Date(p.consentDate as string) }) as RecordingParticipant),
      new Date(o.startDate as string), o.startHostTime as number);
    const { id: _i, sessionType: _s, participants: _p, startDate: _d, startHostTime: _t, layout, endDate, ...rest } = o;
    Object.assign(h, rest);
    if (layout !== undefined) h.layout = FeatureRecordLayout.fromJSON(layout as Partial<FeatureRecordLayout>);
    if (endDate !== undefined) h.endDate = new Date(endDate as string);
    return h;
  }
}
