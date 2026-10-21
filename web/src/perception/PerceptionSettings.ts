// Port of FacePerception/PerceptionSettings.swift.
import type { V2 } from '../core/vec';
import { makeEngagementParams } from './Engagement';
import type { EngagementParams } from './Engagement';
import { HeadPoseFrame, makeEyeContactParams } from './EyeContact';
import type { EyeContactParams } from './EyeContact';
import { GestureParams } from './Gestures';
import { GestureKind, PerceptionTier, degToRad } from './PerceptionTypes';

export type TierOverride = 'auto' | 'full' | 'standard' | 'reduced';
export const TierOverride = { allCases: ['auto', 'full', 'standard', 'reduced'] as readonly TierOverride[] } as const;

type Range = readonly [number, number];
const c = (x: number, r: Range, f: number): number => Number.isFinite(x) ? Math.min(Math.max(x, r[0]), r[1]) : f;

/// Perception settings. Decoding is tolerant (missing or unreadable keys keep their defaults, unknown keys are
/// ignored) and `validated()` range-checks everything, like `LifeSettings`.
export class PerceptionSettings {
  enabled = true;
  tierOverride: TierOverride = 'auto';
  /// 1…6 (the tier's own limit still applies).
  maxPeople = 6;
  /// Eye-contact estimator spread (degrees): eyes, head-pose fallback.
  eyeContactSigmaEyes = 8;
  eyeContactSigmaHead = 12;
  /// Eye-contact hysteresis levels.
  eyeContactEnter = 0.6;
  eyeContactExit = 0.35;
  /// Dwell to engage (seconds).
  engageDwell = 1.0;
  engageDwellHeadOnly = 1.4;
  /// "A few feet" (metres).
  engageMaxDistance = 1.6;
  /// Release after not looking this long (seconds, outside a conversation).
  releaseAfter = 2.5;
  /// Half the drawn face width (metres); the app updates it from the viewport.
  faceRadius = 0.08;
  gesturesEnabled = true;
  waveEnabled = true;
  thumbsUpEnabled = true;
  openPalmEnabled = true;
  pointEnabled = true;
  /// Other gestures switched off, by `GestureKind.name` (the four above have their own switches).
  disabledGestures: string[] = [];
  /// The face reacts to gestures (the reflex table); off → events only.
  gestureReactionsEnabled = true;
  /// Zoomed wrist hand passes (design §6.3). A candidate stage: off until phase A measures it.
  wristROIPasses = false;
  /// Manual camera offset from the screen centre (metres, portrait device frame, x + right, y + down); beats the table.
  cameraOffsetOverride: V2 | null = null;
  /// Calibrated estimator bias (degrees, yaw / pitch).
  estimatorBiasDegrees: V2 = { x: 0, y: 0 };
  /// Head-pose frame and sign corrections (from the on-device frame check).
  headPoseFrame: HeadPoseFrame = 'composed';
  headYawSign = 1;
  headPitchSign = 1;
  /// Stop the camera while asleep at bedtime with wake-on-motion off.
  cameraOffWhenAsleepAtBedtime = false;
  /// Until the conversation loop lands: engaged → `.engaged`, released → `.noticing`.
  lookToTalkDryRun = true;

  /// Defaults with `fields` overridden (not validated, like assigning the Swift struct's vars).
  constructor(fields: Partial<PerceptionSettingsFields> = {}) { Object.assign(this, fields); }

  static readonly sigmaRange: Range = [3, 25];
  static readonly dwellRange: Range = [0.4, 3];
  static readonly distanceRange: Range = [0.5, 3];
  static readonly releaseRange: Range = [1, 10];
  static readonly offsetRange: Range = [-0.3, 0.3];
  static readonly biasRange: Range = [-15, 15];
  static readonly levelRange: Range = [0.05, 0.95];
  static readonly faceRadiusRange: Range = [0.02, 0.3];

  copy(): PerceptionSettings {
    const s = new PerceptionSettings(this);
    s.disabledGestures = [...this.disabledGestures];
    s.cameraOffsetOverride = this.cameraOffsetOverride === null ? null : { ...this.cameraOffsetOverride };
    s.estimatorBiasDegrees = { ...this.estimatorBiasDegrees };
    return s;
  }

  /// A copy with `fields` changed (Swift: `var s = settings; s.x = …`).
  with(fields: Partial<PerceptionSettingsFields>): PerceptionSettings { return Object.assign(this.copy(), fields); }

  equals(o: PerceptionSettings): boolean {
    return KEYS.every((k) => {
      const a = this[k] as unknown, b = o[k] as unknown;
      if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
      if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
        const p = a as V2, q = b as V2;
        return p.x === q.x && p.y === q.y;
      }
      return a === b;
    });
  }

  /// Every value clamped to its range (non-finite values fall back to the defaults).
  validated(): PerceptionSettings {
    const d = new PerceptionSettings();
    const v = this.copy();
    const P = PerceptionSettings;
    v.maxPeople = Math.min(Math.max(this.maxPeople, 1), 6);
    v.eyeContactSigmaEyes = c(this.eyeContactSigmaEyes, P.sigmaRange, d.eyeContactSigmaEyes);
    v.eyeContactSigmaHead = c(this.eyeContactSigmaHead, P.sigmaRange, d.eyeContactSigmaHead);
    v.eyeContactEnter = c(this.eyeContactEnter, P.levelRange, d.eyeContactEnter);
    v.eyeContactExit = Math.min(c(this.eyeContactExit, P.levelRange, d.eyeContactExit), v.eyeContactEnter);
    v.engageDwell = c(this.engageDwell, P.dwellRange, d.engageDwell);
    v.engageDwellHeadOnly = c(this.engageDwellHeadOnly, P.dwellRange, d.engageDwellHeadOnly);
    v.engageMaxDistance = c(this.engageMaxDistance, P.distanceRange, d.engageMaxDistance);
    v.releaseAfter = c(this.releaseAfter, P.releaseRange, d.releaseAfter);
    v.faceRadius = c(this.faceRadius, P.faceRadiusRange, d.faceRadius);
    const o = this.cameraOffsetOverride;
    if (o !== null) {
      v.cameraOffsetOverride = Number.isFinite(o.x) && Number.isFinite(o.y)
        ? { x: c(o.x, P.offsetRange, 0), y: c(o.y, P.offsetRange, 0) } : null;
    }
    v.estimatorBiasDegrees = { x: c(this.estimatorBiasDegrees.x, P.biasRange, 0), y: c(this.estimatorBiasDegrees.y, P.biasRange, 0) };
    v.headYawSign = this.headYawSign < 0 ? -1 : 1;
    v.headPitchSign = this.headPitchSign < 0 ? -1 : 1;
    return v;
  }

  // MARK: Derived parameters

  get eyeContactParams(): EyeContactParams {
    return makeEyeContactParams({
      faceRadius: this.faceRadius, sigmaEyesDegrees: this.eyeContactSigmaEyes, sigmaHeadDegrees: this.eyeContactSigmaHead,
      bias: { x: this.estimatorBiasDegrees.x * degToRad, y: this.estimatorBiasDegrees.y * degToRad },
      frame: this.headPoseFrame, yawSign: this.headYawSign, pitchSign: this.headPitchSign,
    });
  }

  get engagementParams(): EngagementParams {
    return makeEngagementParams({
      enter: this.eyeContactEnter, exit: this.eyeContactExit, dwell: this.engageDwell,
      dwellHeadOnly: this.engageDwellHeadOnly, maxDistance: this.engageMaxDistance, releaseAfter: this.releaseAfter,
    });
  }

  gestureParams(tier: PerceptionTier): GestureParams {
    const p = new GestureParams();
    p.waveEnabled = this.gesturesEnabled && this.waveEnabled;
    p.thumbsUpEnabled = this.gesturesEnabled && this.thumbsUpEnabled;
    p.openPalmEnabled = this.gesturesEnabled && this.openPalmEnabled;
    p.pointEnabled = this.gesturesEnabled && this.pointEnabled;
    p.engageMaxDistance = this.engageMaxDistance;
    GestureKind.allNames.forEach((name, i) => {
      if (this.disabledGestures.includes(name) || !this.gesturesEnabled) p.setEnabled(i, false);
    });
    if (tier <= PerceptionTier.reduced) p.waveMaxDistance = 2;
    return p;
  }

  // MARK: Tolerant decoding

  /// Swift's synthesized encoding: optionals left out when nil, SIMD2 as `[x, y]`.
  toJSON(): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const k of KEYS) {
      const v = this[k] as unknown;
      if (v === null) continue;
      o[k] = k === 'cameraOffsetOverride' || k === 'estimatorBiasDegrees' ? [(v as V2).x, (v as V2).y] : v;
    }
    return o;
  }

  /// Missing or unreadable keys keep their defaults (not validated, like the Swift decoder).
  static decode(json: unknown): PerceptionSettings {
    const j = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    const s = new PerceptionSettings();
    const w = s as unknown as Record<string, unknown>;
    const vec = (v: unknown): V2 | null =>
      Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') ? { x: v[0], y: v[1] } : null;
    for (const k of KEYS) {
      const v = j[k];
      if (v === undefined || v === null) continue;
      switch (k) {
        case 'tierOverride': if (TierOverride.allCases.includes(v as TierOverride)) w[k] = v; break;
        case 'headPoseFrame': if (HeadPoseFrame.allCases.includes(v as HeadPoseFrame)) w[k] = v; break;
        case 'disabledGestures': if (Array.isArray(v) && v.every((x) => typeof x === 'string')) w[k] = [...v]; break;
        case 'cameraOffsetOverride': case 'estimatorBiasDegrees': { const p = vec(v); if (p !== null) w[k] = p; break; }
        case 'maxPeople': if (Number.isInteger(v)) w[k] = v; break;
        default: if (typeof v === typeof w[k]) w[k] = v;
      }
    }
    return s;
  }
}

export type PerceptionSettingsFields = Omit<{
  [K in keyof PerceptionSettings as PerceptionSettings[K] extends (...a: never[]) => unknown ? never : K]: PerceptionSettings[K];
}, 'eyeContactParams' | 'engagementParams'>;

const KEYS: readonly (keyof PerceptionSettingsFields)[] = [
  'enabled', 'tierOverride', 'maxPeople', 'eyeContactSigmaEyes', 'eyeContactSigmaHead', 'eyeContactEnter',
  'eyeContactExit', 'engageDwell', 'engageDwellHeadOnly', 'engageMaxDistance', 'releaseAfter', 'faceRadius',
  'gesturesEnabled', 'waveEnabled', 'thumbsUpEnabled', 'openPalmEnabled', 'pointEnabled', 'gestureReactionsEnabled',
  'disabledGestures', 'wristROIPasses', 'cameraOffsetOverride', 'estimatorBiasDegrees', 'headPoseFrame', 'headYawSign',
  'headPitchSign', 'cameraOffWhenAsleepAtBedtime', 'lookToTalkDryRun',
];
