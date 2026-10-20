// Port of FaceEngine/PupilReactionTypes.swift.
import type { OneShotKind } from './Commands';
import { clampOr, decodeField, isRecord, type ClosedRangeF } from './SettingsSupport';

// MARK: - Reaction cues

/// What kind of moment a reaction cue reports. The first five are the decision model's `reaction` answers;
/// `music` is perception's (someone dancing toward Yanni, once per dancing episode).
export type ReactionCueKind = 'delight' | 'affection' | 'reveal' | 'curiosity' | 'success' | 'music';

export const ReactionCueKind = {
  allCases: ['delight', 'affection', 'reveal', 'curiosity', 'success', 'music'] as readonly ReactionCueKind[],
  /// The transformation this cue asks for.
  oneShot(k: ReactionCueKind): OneShotKind {
    switch (k) {
      case 'delight': return 'starEyes';
      case 'affection': return 'heartEyes';
      case 'reveal': case 'success': return 'exclaimEyes';
      case 'curiosity': return 'questionEyes';
      case 'music': return 'noteEyes';
    }
  },
  /// Affection and music only count when they are aimed at Yanni.
  needsDirected: (k: ReactionCueKind): boolean => k === 'affection' || k === 'music',
} as const;

/// Where a cue came from.
export type ReactionCueSource = 'conversation' | 'perception' | 'debug';

/// A semantic "this moment calls for a playful reaction beat" signal; the `PupilReactions` arbiter decides.
export interface ReactionCue {
  kind: ReactionCueKind;
  /// Calibrated top probability of the decision model's `reaction` answer (0…1).
  confidence: number;
  source: ReactionCueSource;
  /// Aimed at Yanni.
  directedAtYanni: boolean;
  /// Pleasure of the moment's appraisal (−1…1).
  valence: number;
  /// Host seconds the moment belongs to. Null: now.
  hostTime: number | null;
  /// Topic key for the repeat window, e.g. "affection:speaker-2".
  key: string;
  /// Producer-assigned identity (0 = none), echoed in the arbiter's events.
  id: number;
}

export function makeReactionCue(kind: ReactionCueKind, confidence: number,
  o: Partial<Omit<ReactionCue, 'kind' | 'confidence'>> = {}): ReactionCue {
  return {
    kind, confidence, source: 'conversation', directedAtYanni: true, valence: 0.4, hostTime: null, key: '', id: 0, ...o,
  };
}

export const reactionCueEquals = (a: ReactionCue, b: ReactionCue): boolean =>
  a.kind === b.kind && a.confidence === b.confidence && a.source === b.source && a.directedAtYanni === b.directedAtYanni &&
  a.valence === b.valence && a.hostTime === b.hostTime && a.key === b.key && a.id === b.id;

// MARK: - Settings

/// One transformation's switch, hold and cooldown.
export interface PupilShapeSettings {
  enabled: boolean;
  /// Hold length (seconds) at full intensity.
  hold: number;
  /// Minimum seconds between two accepted cues for this transformation (at full intensity).
  cooldown: number;
}

const shape = (hold: number, cooldown: number): PupilShapeSettings => ({ enabled: true, hold, cooldown });
type ShapeKey = 'star' | 'heart' | 'note' | 'question' | 'exclaim';
const SHAPE_KEYS: readonly ShapeKey[] = ['star', 'heart', 'note', 'question', 'exclaim'];
function shapeKey(kind: OneShotKind): ShapeKey | undefined {
  switch (kind) {
    case 'starEyes': return 'star';
    case 'heartEyes': return 'heart';
    case 'noteEyes': return 'note';
    case 'questionEyes': return 'question';
    case 'exclaimEyes': return 'exclaim';
    default: return undefined;
  }
}

/// Pupil transformation tunables (engine-side; the app persists them). Decoding is tolerant and `validated()`
/// range-checks everything; the engine facade applies it on assignment. `reduceMotion` mirrors the system setting and
/// is not persisted. A class standing in for a Swift struct: `copy()` where the Swift copies.
export class PupilReactionSettings {
  /// Master switch for cue-driven transformations (manual triggers still play).
  enabled = true;
  /// 0…1. 0 disables cue-driven transformations; lower values make them rarer, drop the bounce below 0.5 and shorten
  /// holds. Size never changes.
  intensity = 1;
  /// Minimum cue confidence.
  minConfidence = 0.7;
  /// Minimum seconds between any two accepted cues (at full intensity).
  globalCooldown = 50;
  /// A cue whose topic key was seen within this many seconds is ignored (sliding).
  repeatWindow = 60;
  /// Draw the mood accent on stars and hearts.
  moodAccent = true;
  /// Honour Reduce Motion (set by the app from the system setting; not persisted).
  reduceMotion = false;
  star = shape(1.0, 90);
  heart = shape(1.3, 120);
  note = shape(1.5, 90);
  question = shape(1.0, 75);
  exclaim = shape(0.6, 75);

  static readonly intensityRange: ClosedRangeF = [0, 1];
  static readonly confidenceRange: ClosedRangeF = [0.3, 1];
  static readonly globalCooldownRange: ClosedRangeF = [10, 180];
  static readonly repeatWindowRange: ClosedRangeF = [0, 600];
  static readonly holdRange: ClosedRangeF = [0.5, 1.5];
  static readonly cooldownRange: ClosedRangeF = [0, 600];

  copy(): PupilReactionSettings {
    const s = Object.assign(new PupilReactionSettings(), this);
    for (const k of SHAPE_KEYS) s[k] = { ...this[k] };
    return s;
  }

  equals(o: PupilReactionSettings): boolean {
    return this.reduceMotion === o.reduceMotion && JSON.stringify(this.toJSON()) === JSON.stringify(o.toJSON());
  }

  /// The settings of one transformation kind (undefined for other kinds). A copy.
  shape(kind: OneShotKind): PupilShapeSettings | undefined {
    const k = shapeKey(kind);
    return k ? { ...this[k] } : undefined;
  }

  setShape(kind: OneShotKind, v: PupilShapeSettings): void {
    const k = shapeKey(kind);
    if (k) this[k] = { ...v };
  }

  /// Cooldowns scale by this (1 at full intensity, 3 at zero).
  get cooldownScale(): number { return 1 + 2 * (1 - this.intensity); }
  /// Acceptance probability multiplier (1 at full intensity, 0.4 at zero).
  get acceptanceScale(): number { return 0.4 + 0.6 * this.intensity; }
  /// Hold multiplier (1 at full intensity, 0.6 at zero).
  get holdScale(): number { return 0.6 + 0.4 * this.intensity; }

  /// Every value clamped to its range (non-finite values fall back to the defaults).
  validated(): PupilReactionSettings {
    const d = new PupilReactionSettings();
    const C = PupilReactionSettings;
    const s = this.copy();
    s.intensity = clampOr(this.intensity, C.intensityRange, d.intensity);
    s.minConfidence = clampOr(this.minConfidence, C.confidenceRange, d.minConfidence);
    s.globalCooldown = clampOr(this.globalCooldown, C.globalCooldownRange, d.globalCooldown);
    s.repeatWindow = clampOr(this.repeatWindow, C.repeatWindowRange, d.repeatWindow);
    for (const k of SHAPE_KEYS) {
      const v = s[k], dv = d[k];
      s[k] = { enabled: v.enabled, hold: clampOr(v.hold, C.holdRange, dv.hold), cooldown: clampOr(v.cooldown, C.cooldownRange, dv.cooldown) };
    }
    return s;
  }

  /// Swift Codable (tolerant; not validated, as in the Swift decoder). `reduceMotion` is not decoded.
  static fromJSON(json: unknown): PupilReactionSettings {
    const d = new PupilReactionSettings();
    if (!isRecord(json)) return d;
    const s = new PupilReactionSettings();
    s.enabled = decodeField(json, 'enabled', d.enabled);
    s.intensity = decodeField(json, 'intensity', d.intensity);
    s.minConfidence = decodeField(json, 'minConfidence', d.minConfidence);
    s.globalCooldown = decodeField(json, 'globalCooldown', d.globalCooldown);
    s.repeatWindow = decodeField(json, 'repeatWindow', d.repeatWindow);
    s.moodAccent = decodeField(json, 'moodAccent', d.moodAccent);
    for (const k of SHAPE_KEYS) {
      const v = json[k];
      // Swift Shape's own decoder defaults: enabled true, hold 1, cooldown 90.
      s[k] = isRecord(v)
        ? { enabled: decodeField(v, 'enabled', true), hold: decodeField(v, 'hold', 1), cooldown: decodeField(v, 'cooldown', 90) }
        : d[k];
    }
    return s;
  }

  /// Swift `encode(to:)`: everything but `reduceMotion`.
  toJSON(): Record<string, unknown> {
    const o: Record<string, unknown> = {
      enabled: this.enabled, intensity: this.intensity, minConfidence: this.minConfidence,
      globalCooldown: this.globalCooldown, repeatWindow: this.repeatWindow, moodAccent: this.moodAccent,
    };
    for (const k of SHAPE_KEYS) o[k] = { ...this[k] };
    return o;
  }
}

// MARK: - Decisions

/// Why the arbiter accepted or rejected a cue (or ended a transformation).
export type PupilReactionReason =
  | 'accepted' | 'waiting' | 'disabled' | 'shapeDisabled' | 'lowConfidence' | 'notDirected' | 'stale' | 'ownAudio'
  | 'negativeContext' | 'somber' | 'annoyed' | 'repeatKey' | 'habituated' | 'globalCooldown' | 'shapeCooldown' | 'busy'
  | 'recentCancel' | 'bedtime' | 'sulking' | 'blockedState' | 'notAboutYanni' | 'otherActivity' | 'queueFull';

/// One arbiter event: a cue decision, or a transformation ended early (`interrupted`, with the cause).
export type PupilReactionEventWhat =
  | { kind: 'decision'; cue: ReactionCue; oneShot: OneShotKind; reason: PupilReactionReason }
  | { kind: 'interrupted'; oneShot: OneShotKind; why: string };

const signed2 = (v: number): string => (v < 0 || Object.is(v, -0) ? '-' : '+') + Math.abs(v).toFixed(2);

export class PupilReactionEvent {
  constructor(
    /// Monotonic serial (for diffing in the status page).
    public serial: number,
    /// Engine time.
    public time: number,
    public what: PupilReactionEventWhat,
  ) {}

  /// True for an accepted cue.
  get accepted(): boolean { return this.what.kind === 'decision' && this.what.reason === 'accepted'; }

  /// One-line description.
  get text(): string {
    const w = this.what;
    if (w.kind === 'decision') {
      const c = w.cue;
      const base = `cue ${c.kind} ${c.confidence.toFixed(2)} v${signed2(c.valence)}${c.directedAtYanni ? '' : ' undirected'}` +
        `${c.key === '' ? '' : ` [${c.key}]`} → ${w.oneShot}`;
      return w.reason === 'accepted' ? base + ' ✓' : base + ` ✗ ${w.reason}`;
    }
    return `${w.oneShot} switched back (${w.why})`;
  }
}
