// Port of FaceEmotion/EmotionSettings.swift.
import { EmotionAuthority } from '../engine';
import { clampOr, decodeField, isRecord } from '../engine/SettingsSupport';
import type { PAD3 } from './EmotionTypes';

// MARK: - Personality

/// The personality baseline: where the feeling rests and how strongly it reacts. An owner setting; playful is the
/// default and matches `Mood.playful`, so at baseline the face looks exactly as without the emotion layer.
export type PersonalityPreset = 'playful' | 'calm' | 'bubbly' | 'shy';
export const PersonalityPreset = {
  allCases: ['playful', 'calm', 'bubbly', 'shy'] as readonly PersonalityPreset[],
  /// Resting (pleasure, arousal, dominance).
  baseline(p: PersonalityPreset): PAD3 {
    switch (p) {
      case 'playful': return { x: 0.20, y: 0.15, z: 0.10 };
      case 'calm': return { x: 0.15, y: -0.12, z: 0.12 };
      case 'bubbly': return { x: 0.32, y: 0.32, z: 0.15 };
      case 'shy': return { x: 0.12, y: 0.05, z: -0.15 };
    }
  },
  /// Multiplies every impulse's strength.
  reactivity(p: PersonalityPreset): number {
    switch (p) {
      case 'playful': return 1;
      case 'calm': return 0.8;
      case 'bubbly': return 1.15;
      case 'shy': return 0.9;
    }
  },
  title(p: PersonalityPreset): string {
    switch (p) {
      case 'playful': return 'Playful';
      case 'calm': return 'Calm';
      case 'bubbly': return 'Bubbly';
      case 'shy': return 'Shy';
    }
  },
  summary(p: PersonalityPreset): string {
    switch (p) {
      case 'playful': return 'Cheerful and lively (the default).';
      case 'calm': return 'Content and unhurried; reacts a little less.';
      case 'bubbly': return 'Extra happy and bouncy; reacts a little more.';
      case 'shy': return 'Gentle and a touch unsure of itself.';
    }
  },
} as const;

// MARK: - Tunables

/// Decodes every numeric field of `keys` from `json` onto `s` (missing or mistyped keep the default).
function decodeNumbers<T extends object>(s: T, json: Record<string, unknown>, keys: readonly (keyof T & string)[]): T {
  const o = s as Record<string, unknown>;
  for (const k of keys) o[k] = decodeField(json, k, o[k] as number);
  return s;
}

function pick<T extends object>(s: T, keys: readonly (keyof T & string)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (s as Record<string, unknown>)[k];
  return out;
}

const DYN_KEYS = ['emotionDecaySeconds', 'attackSeconds', 'impulseGain', 'moodGain', 'moodTauPositive',
  'moodTauNegative', 'moodTauArousal', 'moodTauDominance', 'moodCap', 'pleasureFloor', 'sleepyDecayFactor',
  'somberSeconds', 'somberPleasureScale', 'conditionEaseSeconds', 'baselineEaseSeconds'] as const;

/// Emotion and mood dynamics (emotion layer design §3). A class standing in for a Swift struct: `copy()` where the
/// Swift copies.
export class EmotionDynamicsSettings {
  /// After this long an impulse's emotion is below 5 % of its peak.
  emotionDecaySeconds = 4;
  /// Rise time constant of an impulse (63 % of the peak in about this long).
  attackSeconds = 0.08;
  /// Multiplies every impulse's strength (before the personality's reactivity).
  impulseGain = 1;
  /// How fast emotion builds mood (per second, per unit of emotion).
  moodGain = 0.06;
  /// Mood decay time constants (seconds): pleasure above / below baseline, arousal, dominance.
  moodTauPositive = 600;
  moodTauNegative = 240;
  moodTauArousal = 90;
  moodTauDominance = 240;
  /// Mood approaches this deviation softly (headroom), never past it.
  moodCap = 0.6;
  /// Negative pleasure mood approaches −this softly (Yanni never sulks for long).
  pleasureFloor = 0.4;
  /// Mood decays this many times faster while drowsy, asleep or at bedtime.
  sleepyDecayFactor = 3;
  /// Bad news: for this long mood's pleasure counts only `somberPleasureScale` toward felt.
  somberSeconds = 20;
  somberPleasureScale = 0.3;
  /// Conditions ease in and out with this time constant (seconds).
  conditionEaseSeconds = 0.7;
  /// A personality change eases with this time constant (seconds).
  baselineEaseSeconds = 1.5;

  copy(): EmotionDynamicsSettings { return Object.assign(new EmotionDynamicsSettings(), this); }
  equals(o: EmotionDynamicsSettings): boolean { return DYN_KEYS.every((k) => this[k] === o[k]); }

  validated(): EmotionDynamicsSettings {
    const d = new EmotionDynamicsSettings();
    const s = this.copy();
    s.emotionDecaySeconds = clampOr(this.emotionDecaySeconds, [1, 12], d.emotionDecaySeconds);
    s.attackSeconds = clampOr(this.attackSeconds, [0.02, 0.3], d.attackSeconds);
    s.impulseGain = clampOr(this.impulseGain, [0, 1.5], d.impulseGain);
    s.moodGain = clampOr(this.moodGain, [0, 0.2], d.moodGain);
    s.moodTauPositive = clampOr(this.moodTauPositive, [30, 3600], d.moodTauPositive);
    s.moodTauNegative = clampOr(this.moodTauNegative, [30, 3600], d.moodTauNegative);
    s.moodTauArousal = clampOr(this.moodTauArousal, [10, 3600], d.moodTauArousal);
    s.moodTauDominance = clampOr(this.moodTauDominance, [10, 3600], d.moodTauDominance);
    s.moodCap = clampOr(this.moodCap, [0.1, 0.9], d.moodCap);
    s.pleasureFloor = clampOr(this.pleasureFloor, [0.05, 0.9], d.pleasureFloor);
    s.sleepyDecayFactor = clampOr(this.sleepyDecayFactor, [1, 10], d.sleepyDecayFactor);
    s.somberSeconds = clampOr(this.somberSeconds, [0, 120], d.somberSeconds);
    s.somberPleasureScale = clampOr(this.somberPleasureScale, [0, 1], d.somberPleasureScale);
    s.conditionEaseSeconds = clampOr(this.conditionEaseSeconds, [0.05, 10], d.conditionEaseSeconds);
    s.baselineEaseSeconds = clampOr(this.baselineEaseSeconds, [0.05, 10], d.baselineEaseSeconds);
    return s;
  }

  static fromJSON(json: unknown): EmotionDynamicsSettings {
    const s = new EmotionDynamicsSettings();
    return isRecord(json) ? decodeNumbers(s, json, DYN_KEYS) : s;
  }

  toJSON(): Record<string, unknown> { return pick(this, DYN_KEYS); }
}

const CLS_KEYS = ['activationRadius', 'saturationRadius', 'deadzone', 'deadzoneRamp', 'deviationGain',
  'deviationReach', 'moodShare', 'margin', 'dwell', 'fastDwell', 'jumpThreshold', 'runnerUpRatio'] as const;

const DEFAULT_ALLOW_LIST: readonly string[] = ['Contentment', 'Happiness', 'Excitement', 'Amazement', 'Surprise',
  'Curious', 'Confusion', 'Embarrassment', 'Concerned', 'Sadness', 'Disappointment', 'Skepticism', 'Annoyance',
  'Boredom', 'Tiredness'];

/// PAD → named expression (emotion layer design §5.1).
export class ClassifierSettings {
  /// Activation radius: beyond it an expression doesn't apply at all.
  activationRadius = 0.55;
  /// Saturation radius: within it an expression applies fully.
  saturationRadius = 0.15;
  /// Within this distance of the baseline (in classified, amplified units) no expression shows.
  deadzone = 0.24;
  /// The weight ramps from 0 at the deadzone to 1 this much further out.
  deadzoneRamp = 0.5;
  /// Small deviations from the reference are amplified up to this much before classifying…
  deviationGain = 2;
  /// …falling to 1 at a deviation this large (about an anchor's distance from the baseline).
  deviationReach = 0.9;
  /// How much of the slow mood moves the reference, so mood shows through modulation and colour while only emotion
  /// picks an expression.
  moodShare = 0.7;
  /// The current label's distance bonus (hysteresis).
  margin = 0.08;
  /// A challenger must win this long before it takes over (seconds).
  dwell = 0.35;
  /// …or this long when felt jumped more than `jumpThreshold` in the last 0.3 s (surprise reads instantly).
  fastDwell = 0.12;
  jumpThreshold = 0.4;
  /// The runner-up joins the mix when its activation is at least this fraction of the label's.
  runnerUpRatio = 0.5;
  /// The expressions the feeling may read as (family-friendly; never Neutral, which is the deadzone).
  allowList: string[] = [...DEFAULT_ALLOW_LIST];

  static readonly defaultAllowList: readonly string[] = DEFAULT_ALLOW_LIST;
  /// Never chosen, whatever the allow-list says.
  static readonly excluded: ReadonlySet<string> = new Set(['Neutral', 'Anger', 'Fury', 'Horror', 'Disgust', 'Despair',
    'Fear', 'Asleep', 'Rejection']);

  copy(): ClassifierSettings {
    const s = Object.assign(new ClassifierSettings(), this);
    s.allowList = [...this.allowList];
    return s;
  }

  equals(o: ClassifierSettings): boolean {
    return CLS_KEYS.every((k) => this[k] === o[k]) && this.allowList.length === o.allowList.length &&
      this.allowList.every((n, i) => n === o.allowList[i]);
  }

  validated(): ClassifierSettings {
    const d = new ClassifierSettings();
    const s = this.copy();
    s.activationRadius = clampOr(this.activationRadius, [0.1, 1.5], d.activationRadius);
    s.saturationRadius = clampOr(this.saturationRadius, [0, s.activationRadius - 0.05], d.saturationRadius);
    s.deadzone = clampOr(this.deadzone, [0, 0.6], d.deadzone);
    s.deadzoneRamp = clampOr(this.deadzoneRamp, [0.02, 1.5], d.deadzoneRamp);
    s.deviationGain = clampOr(this.deviationGain, [1, 4], d.deviationGain);
    s.deviationReach = clampOr(this.deviationReach, [0.2, 2], d.deviationReach);
    s.moodShare = clampOr(this.moodShare, [0, 1], d.moodShare);
    s.margin = clampOr(this.margin, [0, 0.3], d.margin);
    s.dwell = clampOr(this.dwell, [0, 3], d.dwell);
    s.fastDwell = clampOr(this.fastDwell, [0, s.dwell], d.fastDwell);
    s.jumpThreshold = clampOr(this.jumpThreshold, [0.05, 2], d.jumpThreshold);
    s.runnerUpRatio = clampOr(this.runnerUpRatio, [0, 1], d.runnerUpRatio);
    s.allowList = this.allowList.filter((n) => !ClassifierSettings.excluded.has(n));
    return s;
  }

  static fromJSON(json: unknown): ClassifierSettings {
    const s = new ClassifierSettings();
    if (!isRecord(json)) return s;
    decodeNumbers(s, json, CLS_KEYS);
    const a = json.allowList;
    if (Array.isArray(a) && a.every((n) => typeof n === 'string')) s.allowList = [...(a as string[])];
    return s;
  }

  toJSON(): Record<string, unknown> { return { ...pick(this, CLS_KEYS), allowList: [...this.allowList] }; }
}

const MAP_KEYS = ['cueThreshold', 'stanceThreshold', 'hintTopFeel', 'hintIntensity', 'strengthGain',
  'strengthExponent', 'hintCooldown', 'directedThreshold', 'lateGrace', 'pendingExpiry', 'reactThreshold',
  'actionThreshold', 'runnerUpThreshold', 'sentenceActionThreshold'] as const;

/// Decision-model mapping tunables (decision model design §5).
export class MapperSettings {
  /// A reaction answer becomes a cue at this top probability.
  cueThreshold = 0.7;
  /// A reply sentence's stance nods or shakes at P(yes-ish) or P(no-ish) ≥ this (summed, gentle + strong).
  stanceThreshold = 0.7;
  /// One-shot hints need the top feel at least this likely…
  hintTopFeel = 0.6;
  /// …and the expected intensity (1…5) at least this.
  hintIntensity = 4;
  /// Strength curve: min(1, gain × raw^exponent).
  strengthGain = 1.5;
  strengthExponent = 1;
  /// Per-hint cooldown (seconds); charged only when a hint actually plays.
  hintCooldown = 20;
  /// Pass A cues count as aimed at Yanni at P(addressed = yes) ≥ this.
  directedThreshold = 0.8;
  /// A sentence tag that arrives up to this long after its sentence became audible still applies (seconds).
  lateGrace = 0.1;
  /// Pending sentence tags without an audio start are dropped after this long (seconds).
  pendingExpiry = 20;
  /// Expressive decisions (design §8): the `react` top answer needed for a plan, each sub-action's (brow, gaze,
  /// pupil, move), the runner-up a repeat may swap in, and Pass B's brow / gaze.
  reactThreshold = 0.4;
  actionThreshold = 0.35;
  runnerUpThreshold = 0.2;
  sentenceActionThreshold = 0.5;

  copy(): MapperSettings { return Object.assign(new MapperSettings(), this); }
  equals(o: MapperSettings): boolean { return MAP_KEYS.every((k) => this[k] === o[k]); }

  validated(): MapperSettings {
    const d = new MapperSettings();
    const s = this.copy();
    s.cueThreshold = clampOr(this.cueThreshold, [0.3, 1], d.cueThreshold);
    s.stanceThreshold = clampOr(this.stanceThreshold, [0.5, 1], d.stanceThreshold);
    s.hintTopFeel = clampOr(this.hintTopFeel, [0.2, 1], d.hintTopFeel);
    s.hintIntensity = clampOr(this.hintIntensity, [1, 5], d.hintIntensity);
    s.strengthGain = clampOr(this.strengthGain, [0, 3], d.strengthGain);
    s.strengthExponent = clampOr(this.strengthExponent, [0.25, 4], d.strengthExponent);
    s.hintCooldown = clampOr(this.hintCooldown, [0, 600], d.hintCooldown);
    s.directedThreshold = clampOr(this.directedThreshold, [0, 1], d.directedThreshold);
    s.lateGrace = clampOr(this.lateGrace, [0, 1], d.lateGrace);
    s.pendingExpiry = clampOr(this.pendingExpiry, [1, 120], d.pendingExpiry);
    s.reactThreshold = clampOr(this.reactThreshold, [0.15, 1], d.reactThreshold);
    s.actionThreshold = clampOr(this.actionThreshold, [0.15, 1], d.actionThreshold);
    s.runnerUpThreshold = clampOr(this.runnerUpThreshold, [0.05, 1], d.runnerUpThreshold);
    s.sentenceActionThreshold = clampOr(this.sentenceActionThreshold, [0.2, 1], d.sentenceActionThreshold);
    return s;
  }

  static fromJSON(json: unknown): MapperSettings {
    const s = new MapperSettings();
    return isRecord(json) ? decodeNumbers(s, json, MAP_KEYS) : s;
  }

  toJSON(): Record<string, unknown> { return pick(this, MAP_KEYS); }
}

/// The emotion layer's developer tuning (the settings hub's developer-only `emotion` section). The personality preset
/// is an owner setting and lives elsewhere.
export class EmotionSettings {
  dynamics = new EmotionDynamicsSettings();
  classifier = new ClassifierSettings();
  mapper = new MapperSettings();
  authority = new EmotionAuthority();

  copy(): EmotionSettings {
    const s = new EmotionSettings();
    s.dynamics = this.dynamics.copy(); s.classifier = this.classifier.copy();
    s.mapper = this.mapper.copy(); s.authority = this.authority.copy();
    return s;
  }

  equals(o: EmotionSettings): boolean {
    return this.dynamics.equals(o.dynamics) && this.classifier.equals(o.classifier) && this.mapper.equals(o.mapper) &&
      this.authority.equals(o.authority);
  }

  validated(): EmotionSettings {
    const s = new EmotionSettings();
    s.dynamics = this.dynamics.validated();
    s.classifier = this.classifier.validated();
    s.mapper = this.mapper.validated();
    s.authority = this.authority.validated();
    return s;
  }

  // port-note: Swift decodes `authority` without validating (EmotionAuthority's own decoder); the TS
  // `EmotionAuthority.fromJSON` validates, which `validated()` would do anyway.
  static fromJSON(json: unknown): EmotionSettings {
    const s = new EmotionSettings();
    if (!isRecord(json)) return s;
    if ('dynamics' in json) s.dynamics = EmotionDynamicsSettings.fromJSON(json.dynamics);
    if ('classifier' in json) s.classifier = ClassifierSettings.fromJSON(json.classifier);
    if ('mapper' in json) s.mapper = MapperSettings.fromJSON(json.mapper);
    if (isRecord(json.authority)) s.authority = EmotionAuthority.fromJSON(json.authority);
    return s;
  }

  toJSON(): Record<string, unknown> {
    return { dynamics: this.dynamics.toJSON(), classifier: this.classifier.toJSON(), mapper: this.mapper.toJSON(),
      authority: this.authority.toJSON() };
  }
}

// MARK: - Mood persistence

/// The slow mood saved across launches: `{mood, wallClock}`. Emotion and conditions are never persisted.
/// port-note: `savedAt` is Unix seconds (Swift stores a `Date`).
export interface PersistedMood { p: number; a: number; d: number; savedAt: number }
export const PersistedMood = {
  make: (mood: PAD3, savedAt: number): PersistedMood => ({ p: mood.x, a: mood.y, d: mood.z, savedAt }),
  mood: (m: PersistedMood): PAD3 => ({ x: m.p, y: m.a, z: m.d }),
  decode(text: string | null): PersistedMood | null {
    if (text === null) return null;
    try {
      const o: unknown = JSON.parse(text);
      if (!isRecord(o)) return null;
      const { p, a, d, savedAt } = o;
      return typeof p === 'number' && typeof a === 'number' && typeof d === 'number' && typeof savedAt === 'number'
        ? { p, a, d, savedAt } : null;
    } catch { return null; }
  },
} as const;

/// Where the mood is kept between launches.
export interface MoodStore {
  load(): PersistedMood | null;
  save(mood: PersistedMood): void;
}

/// `localStorage` key `yanni.emotionMood` (Swift: UserDefaults). Storage that throws or is missing reads as empty.
export class LocalStorageMoodStore implements MoodStore {
  static readonly key = 'yanni.emotionMood';
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null =
  typeof localStorage === 'undefined' ? null : localStorage) {}
  load(): PersistedMood | null {
    try { return PersistedMood.decode(this.storage?.getItem(LocalStorageMoodStore.key) ?? null); } catch { return null; }
  }
  save(mood: PersistedMood): void {
    try { this.storage?.setItem(LocalStorageMoodStore.key, JSON.stringify(mood)); } catch { /* storage full or blocked */ }
  }
}

/// In-memory store (tests, previews).
export class MemoryMoodStore implements MoodStore {
  constructor(public value: PersistedMood | null = null) {}
  load(): PersistedMood | null { return this.value; }
  save(mood: PersistedMood): void { this.value = { ...mood }; }
}
