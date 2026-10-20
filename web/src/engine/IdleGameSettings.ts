// Port of FaceEngine/IdleGameSettings.swift.
import type { OneShotKind } from './Commands';
import { clampOr, decodeField, isRecord, type ClosedRangeF } from './SettingsSupport';

/// One game's switch, weight in the random pick and minimum spacing between two of its automatic triggers.
export interface IdleGame {
  enabled: boolean;
  /// Relative weight when several games are eligible (0…3).
  weight: number;
  /// Minimum seconds (engine time) between two automatic triggers of this game.
  cooldown: number;
}

const game = (): IdleGame => ({ enabled: true, weight: 1, cooldown: 180 });

type GameKey = 'pingPong' | 'basketball' | 'juggling' | 'yoYo' | 'leapfrog' | 'staringContest' | 'hideAndSeek'
  | 'catchTheFly' | 'danceBreak' | 'hulaHoop';
const GAME_KEYS: readonly GameKey[] = ['pingPong', 'basketball', 'juggling', 'yoYo', 'leapfrog', 'staringContest',
  'hideAndSeek', 'catchTheFly', 'danceBreak', 'hulaHoop'];
const isGameKey = (k: string): k is GameKey => (GAME_KEYS as readonly string[]).includes(k);

/// Tunables for the idle games (idle games design §5). Engine-side; the app persists them as `playfulness.idleGames`.
/// A class standing in for a Swift struct: `copy()` where the Swift copies.
export class IdleGameSettings {
  /// Master switch for the automatic games (the preview's Play buttons still play).
  enabled = true;
  /// Multiplier on how often games happen (2 = twice as often).
  frequency = 1;
  /// Multiplier on squash, stretch, tilt and overshoot.
  intensity = 1;
  /// Multiplier on every game's duration (>1 slower).
  timingScale = 1;
  pingPong = game();
  basketball = game();
  juggling = game();
  yoYo = game();
  leapfrog = game();
  staringContest = game();
  hideAndSeek = game();
  catchTheFly = game();
  danceBreak = game();
  hulaHoop = game();

  static readonly frequencyRange: ClosedRangeF = [0.25, 4];
  static readonly intensityRange: ClosedRangeF = [0, 2];
  static readonly timingScaleRange: ClosedRangeF = [0.8, 1.4];
  static readonly weightRange: ClosedRangeF = [0, 3];
  static readonly cooldownRange: ClosedRangeF = [30, 1800];

  copy(): IdleGameSettings {
    const s = Object.assign(new IdleGameSettings(), this);
    for (const k of GAME_KEYS) s[k] = { ...this[k] };
    return s;
  }

  equals(o: IdleGameSettings): boolean { return JSON.stringify(this.toJSON()) === JSON.stringify(o.toJSON()); }

  /// Every value clamped into its range; non-finite numbers fall back to the default.
  validated(): IdleGameSettings {
    const d = new IdleGameSettings();
    const s = this.copy();
    const C = IdleGameSettings;
    s.frequency = clampOr(s.frequency, C.frequencyRange, d.frequency);
    s.intensity = clampOr(s.intensity, C.intensityRange, d.intensity);
    s.timingScale = clampOr(s.timingScale, C.timingScaleRange, d.timingScale);
    for (const k of GAME_KEYS) {
      const g = s[k], f = d[k];
      s[k] = { enabled: g.enabled, weight: clampOr(g.weight, C.weightRange, f.weight), cooldown: clampOr(g.cooldown, C.cooldownRange, f.cooldown) };
    }
    return s;
  }

  /// The per-game settings for an idle game kind (undefined for other kinds). A copy.
  game(kind: OneShotKind): IdleGame | undefined { return isGameKey(kind) ? { ...this[kind] } : undefined; }

  /// Writes the per-game settings for an idle game kind (ignored for other kinds).
  setGame(kind: OneShotKind, g: IdleGame): void { if (isGameKey(kind)) this[kind] = { ...g }; }

  /// Swift Codable (tolerant): missing or unreadable keys keep their defaults; the result is validated.
  static fromJSON(json: unknown): IdleGameSettings {
    const d = new IdleGameSettings();
    if (!isRecord(json)) return d.validated();
    const s = new IdleGameSettings();
    s.enabled = decodeField(json, 'enabled', d.enabled);
    s.frequency = decodeField(json, 'frequency', d.frequency);
    s.intensity = decodeField(json, 'intensity', d.intensity);
    s.timingScale = decodeField(json, 'timingScale', d.timingScale);
    for (const k of GAME_KEYS) {
      const v = json[k];
      s[k] = isRecord(v)
        ? { enabled: decodeField(v, 'enabled', true), weight: decodeField(v, 'weight', 1), cooldown: decodeField(v, 'cooldown', 180) }
        : d[k];
    }
    return s.validated();
  }

  toJSON(): Record<string, unknown> {
    const o: Record<string, unknown> = {
      enabled: this.enabled, frequency: this.frequency, intensity: this.intensity, timingScale: this.timingScale,
    };
    for (const k of GAME_KEYS) o[k] = { ...this[k] };
    return o;
  }
}
