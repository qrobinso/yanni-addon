// Port of FaceEngine/EdgeAnticSettings.swift.
import type { OneShotKind } from './Commands';
import { clampOr, decodeField, isRecord, type ClosedRangeF } from './SettingsSupport';

/// One antic's switch, weight in the random pick and minimum spacing between two of its triggers.
export interface EdgeAntic {
  enabled: boolean;
  /// Relative weight when several antics are eligible (0…3).
  weight: number;
  /// Minimum seconds (engine time) between two automatic triggers of this antic.
  cooldown: number;
}

const antic = (weight = 1, cooldown = 120, enabled = true): EdgeAntic => ({ enabled, weight, cooldown });

function decodeAntic(v: unknown, d: EdgeAntic): EdgeAntic {
  if (!isRecord(v)) return { ...d };
  // Swift Antic's own decoder defaults: enabled true, weight 1, cooldown 120 (not the field's default).
  return {
    enabled: decodeField(v, 'enabled', true),
    weight: decodeField(v, 'weight', 1),
    cooldown: decodeField(v, 'cooldown', 120),
  };
}

type AnticKey = 'shyPeek' | 'popUp' | 'curiousLean' | 'pretendExit' | 'sleepySink';
const ANTIC_KEYS: readonly AnticKey[] = ['shyPeek', 'popUp', 'curiousLean', 'pretendExit', 'sleepySink'];

/// Tunables for the screen-edge antics (screen-edge antics design §5). Engine-side; the app persists them.
///
/// Decoding is tolerant and every value is range-checked by `validated()`, which the engine facade applies on every
/// assignment. No combination can stretch a fully hidden moment past `maxHiddenSeconds` or push stage motion past
/// its speed bound. A class standing in for a Swift struct: `copy()` where the Swift copies.
export class EdgeAnticSettings {
  /// Master switch for the automatic antics and the sleepy sink (manual triggers still play).
  enabled = true;
  /// Multiplier on how often antics happen (2 = twice as often).
  frequency = 1;
  /// Multiplier on partial travel. Never applies to the "fully hidden" targets.
  travel = 1;
  /// Multiplier on squash, stretch, tilt and overshoot.
  intensity = 1;
  /// Multiplier on every antic's duration (>1 slower).
  timingScale = 1;
  /// Longest moment (engine seconds) both eyes may be fully off screen.
  maxHiddenSeconds = 1.2;
  shyPeek = antic(1, 150);
  popUp = antic(1, 120);
  curiousLean = antic(1.3, 60);
  pretendExit = antic(0.8, 180);
  /// The sleepy sink's weight is unused (it has its own chance).
  sleepySink = antic(1, 60);
  /// Chance of a pop-up greeting when someone appears after ≥ 60 s alone, or a wake completes.
  greetingChance = 0.35;
  /// Chance of a curious lean or pretend exit 4–10 s after a conversation ends.
  postConversationChance = 0.3;
  /// Chance that falling asleep plays the sleepy sink.
  sleepySinkChance = 0.5;
  /// No sleepy sink at bedtime (bedtime always suppresses the screen-edge antics).
  quietAtBedtime = true;

  static readonly frequencyRange: ClosedRangeF = [0.25, 4];
  static readonly travelRange: ClosedRangeF = [0.5, 1.5];
  static readonly intensityRange: ClosedRangeF = [0, 2];
  static readonly timingScaleRange: ClosedRangeF = [0.8, 1.4];
  static readonly maxHiddenRange: ClosedRangeF = [0.8, 2.0];
  static readonly weightRange: ClosedRangeF = [0, 3];
  static readonly cooldownRange: ClosedRangeF = [10, 900];
  static readonly chanceRange: ClosedRangeF = [0, 1];

  copy(): EdgeAnticSettings {
    const s = Object.assign(new EdgeAnticSettings(), this);
    for (const k of ANTIC_KEYS) s[k] = { ...this[k] };
    return s;
  }

  equals(o: EdgeAnticSettings): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(o.toJSON());
  }

  /// Every value clamped into its range; non-finite numbers fall back to the default.
  validated(): EdgeAnticSettings {
    const d = new EdgeAnticSettings();
    const s = this.copy();
    const C = EdgeAnticSettings;
    const a = (x: EdgeAntic, f: EdgeAntic): EdgeAntic => ({
      enabled: x.enabled, weight: clampOr(x.weight, C.weightRange, f.weight), cooldown: clampOr(x.cooldown, C.cooldownRange, f.cooldown),
    });
    s.frequency = clampOr(s.frequency, C.frequencyRange, d.frequency);
    s.travel = clampOr(s.travel, C.travelRange, d.travel);
    s.intensity = clampOr(s.intensity, C.intensityRange, d.intensity);
    s.timingScale = clampOr(s.timingScale, C.timingScaleRange, d.timingScale);
    s.maxHiddenSeconds = clampOr(s.maxHiddenSeconds, C.maxHiddenRange, d.maxHiddenSeconds);
    for (const k of ANTIC_KEYS) s[k] = a(s[k], d[k]);
    s.greetingChance = clampOr(s.greetingChance, C.chanceRange, d.greetingChance);
    s.postConversationChance = clampOr(s.postConversationChance, C.chanceRange, d.postConversationChance);
    s.sleepySinkChance = clampOr(s.sleepySinkChance, C.chanceRange, d.sleepySinkChance);
    return s;
  }

  /// The per-antic settings for an edge antic kind (undefined for other kinds). A copy.
  antic(kind: OneShotKind): EdgeAntic | undefined {
    return (ANTIC_KEYS as readonly string[]).includes(kind) ? { ...this[kind as AnticKey] } : undefined;
  }

  /// Writes the per-antic settings for an edge antic kind (ignored for other kinds).
  setAntic(kind: OneShotKind, a: EdgeAntic): void {
    if ((ANTIC_KEYS as readonly string[]).includes(kind)) this[kind as AnticKey] = { ...a };
  }

  /// Swift Codable (tolerant): missing or unreadable keys keep their defaults; the result is validated.
  static fromJSON(json: unknown): EdgeAnticSettings {
    const d = new EdgeAnticSettings();
    if (!isRecord(json)) return d.validated();
    const s = new EdgeAnticSettings();
    s.enabled = decodeField(json, 'enabled', d.enabled);
    s.frequency = decodeField(json, 'frequency', d.frequency);
    s.travel = decodeField(json, 'travel', d.travel);
    s.intensity = decodeField(json, 'intensity', d.intensity);
    s.timingScale = decodeField(json, 'timingScale', d.timingScale);
    s.maxHiddenSeconds = decodeField(json, 'maxHiddenSeconds', d.maxHiddenSeconds);
    for (const k of ANTIC_KEYS) s[k] = json[k] === undefined ? d[k] : decodeAntic(json[k], d[k]);
    s.greetingChance = decodeField(json, 'greetingChance', d.greetingChance);
    s.postConversationChance = decodeField(json, 'postConversationChance', d.postConversationChance);
    s.sleepySinkChance = decodeField(json, 'sleepySinkChance', d.sleepySinkChance);
    s.quietAtBedtime = decodeField(json, 'quietAtBedtime', d.quietAtBedtime);
    return s.validated();
  }

  toJSON(): Record<string, unknown> {
    return {
      enabled: this.enabled, frequency: this.frequency, travel: this.travel, intensity: this.intensity,
      timingScale: this.timingScale, maxHiddenSeconds: this.maxHiddenSeconds,
      shyPeek: { ...this.shyPeek }, popUp: { ...this.popUp }, curiousLean: { ...this.curiousLean },
      pretendExit: { ...this.pretendExit }, sleepySink: { ...this.sleepySink },
      greetingChance: this.greetingChance, postConversationChance: this.postConversationChance,
      sleepySinkChance: this.sleepySinkChance, quietAtBedtime: this.quietAtBedtime,
    };
  }
}
