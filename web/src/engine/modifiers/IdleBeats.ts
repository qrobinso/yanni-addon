// Port of FaceEngine/Modifiers/IdleBeats.swift.
import type { SplitMix64 } from '../../core/random';
import type { AgentState, Mood } from '../AgentState';
import type { OneShotKind } from '../Commands';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { EdgeAntics } from './EdgeAntics';

/// Behaviour phase: rare "personality beats" while idle or noticing (design C1a.5): a curious tilt, a double-take, a
/// delighted squint at nothing (happy moods), a slow suspicious side-eye (rare, confident-but-not-happy moods), a brief
/// cross-eyed moment of silliness (rare, playful moods: P > 0.3 and A > 0.2). Lognormal spacing (median 45 s, never
/// under 20 s), never the same beat twice in a row. Beats and screen-edge antics keep `EdgeAntics.idleActivitySpacing`
/// apart in both directions. Randomness is drawn only when a beat is scheduled or fires.
export class IdleBeats implements Modifier {
  readonly name = 'IdleBeats';
  readonly phase = Phase.behaviour;
  isEnabled = true;

  static readonly medianSpacing = 45;
  static readonly sigma = 0.45;
  static readonly minSpacing = 20;
  static readonly maxSpacing = 120;
  /// After (re-)entering idle/noticing, wait at least this long before a beat (settle first).
  static readonly settle: readonly [number, number] = [6, 12];
  /// If another one-shot is playing when a beat is due, retry after this delay.
  static readonly busyRetry = 2;

  // Base weights; mood gates delightedSquint and sideEye.
  static readonly curiousTiltWeight = 1.0;
  static readonly doubleTakeWeight = 0.8;
  static readonly delightedSquintWeight = 1.0;
  static readonly sideEyeWeight = 0.25;
  static readonly crossEyedWeight = 0.3;

  private _lastBeat: OneShotKind | null = null;
  private _lastBeatTime = -Infinity;
  private nextBeatAt: number | null = null;
  private wasEligible = false;

  get lastBeat(): OneShotKind | null { return this._lastBeat; }
  get lastBeatTime(): number { return this._lastBeatTime; }

  static isEligible(s: AgentState): boolean { return s === 'idle' || s === 'noticing'; }

  update(s: FaceState): void {
    const eligible = IdleBeats.isEligible(s.agentState);
    try {
      if (!eligible) return;

      if (!this.wasEligible || this.nextBeatAt === null) {
        const spaced = this._lastBeatTime + IdleBeats.minSpacing;
        const settled = s.time + s.rng.uniform(IdleBeats.settle[0], IdleBeats.settle[1]);
        const scheduled = this.nextBeatAt ?? (s.time + this.nextInterval(s.rng));
        this.nextBeatAt = Math.max(scheduled, spaced, settled);
      }
      const due = this.nextBeatAt;
      if (!(s.time >= due)) return;

      if (s.activeOneShots.length > 0) {
        this.nextBeatAt = s.time + IdleBeats.busyRetry;
        return;
      }
      // Keep clear of a recent screen-edge antic or idle game.
      const clear = Math.max(s.lastEdgeAnticTime, s.lastIdleGameTime) + EdgeAntics.idleActivitySpacing;
      if (s.time < clear) {
        this.nextBeatAt = clear;
        return;
      }

      const kind = this.pick(s.mood, s.rng);
      s.oneShotRequests.push(kind);
      this._lastBeat = kind;
      this._lastBeatTime = s.time;
      s.lastIdleBeatTime = s.time;
      this.nextBeatAt = s.time + this.nextInterval(s.rng);
    } finally {
      this.wasEligible = eligible;
    }
  }

  private nextInterval(rng: SplitMix64): number {
    return rng.lognormal(IdleBeats.medianSpacing, IdleBeats.sigma, [IdleBeats.minSpacing, IdleBeats.maxSpacing]);
  }

  /// Weighted choice without allocation; excludes the previous beat.
  private pick(mood: Mood, rng: SplitMix64): OneShotKind {
    const B = IdleBeats;
    let w0 = B.curiousTiltWeight;
    let w1 = B.doubleTakeWeight;
    let w2 = mood.pleasure > 0.3 ? B.delightedSquintWeight : 0;
    let w3 = mood.dominance > 0 && mood.pleasure < 0.3 ? B.sideEyeWeight : 0;
    let w4 = mood.pleasure > 0.3 && mood.arousal > 0.2 ? B.crossEyedWeight : 0;
    switch (this._lastBeat) {
      case 'curiousTilt': w0 = 0; break;
      case 'doubleTake': w1 = 0; break;
      case 'delightedSquint': w2 = 0; break;
      case 'sideEye': w3 = 0; break;
      case 'crossEyed': w4 = 0; break;
      default: break;
    }
    const total = w0 + w1 + w2 + w3 + w4;
    let x = rng.unit() * total;
    x -= w0; if (x < 0) return 'curiousTilt';
    x -= w1; if (x < 0) return 'doubleTake';
    x -= w2; if (x < 0) return 'delightedSquint';
    x -= w3; if (x < 0 && w3 > 0) return 'sideEye';
    if (w4 > 0) return 'crossEyed';
    if (w3 > 0) return 'sideEye';
    return w1 > 0 ? 'doubleTake' : 'curiousTilt';
  }
}
