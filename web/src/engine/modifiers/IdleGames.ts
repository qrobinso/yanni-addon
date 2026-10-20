// Port of FaceEngine/Modifiers/IdleGames.swift.
import type { EdgeGeometry } from '../../model';
import type { Mood } from '../AgentState';
import { OneShotKind } from '../Commands';
import type { FaceState } from '../FaceState';
import type { IdleGameSettings } from '../IdleGameSettings';
import { Phase, type Modifier } from '../Modifier';
import { OneShotKindSet, isIdleGame, makeOneShotCancel } from '../OneShots';
import { EdgeAntics } from './EdgeAntics';

/// Behaviour phase: decides when Yanni plays one of its idle games (idle games design §3) and stops it.
///
/// **When.** Only while idle or noticing, not at bedtime, not sulking, nobody engaging, mood not low (no games when
/// pleasure < −0.2 or arousal < −0.3); never while another one-shot plays (busy retry); at least
/// `EdgeAntics.idleActivitySpacing` from any idle beat, screen-edge antic or game in both directions; while noticing,
/// only once NoticingAttention has stopped watching; never the same game twice in a row; per-game switches, weights and
/// cooldowns from `s.idleGameSettings`. Lognormal spacing: median 90 s while noticing (50–180 s), 180 s in an empty room
/// (100–360 s), ÷ `frequency`, after a settle of 12–20 s on (re-)entering. The pool comes from the state; per-game mood
/// gates (dance break P > 0.3, hula hoop A > 0.1). Reduce Motion keeps only the staring contest and catch the fly.
///
/// **Cancelling.** Engagement, a tap or scratch, bedtime, sulking, leaving idle / noticing or a change of screen
/// geometry spring-releases a playing game. Randomness only at scheduling and trigger events.
export class IdleGames implements Modifier {
  readonly name = 'IdleGames';
  readonly phase = Phase.behaviour;
  isEnabled = true;

  // MARK: Tuning

  static readonly noticingMedian = 90;
  static readonly noticingClamp: readonly [number, number] = [50, 180];
  static readonly idleMedian = 180;
  static readonly idleClamp: readonly [number, number] = [100, 360];
  static readonly sigma = 0.4;
  static readonly settle: readonly [number, number] = [12, 20];
  static readonly busyRetry = 2;
  /// Global mood gate.
  static readonly minPleasure = -0.2;
  static readonly minArousal = -0.3;

  /// The games whose curves exist. Enable a finished game by adding it here (and its voice line).
  static readonly built = OneShotKindSet.of(['pingPong', 'basketball', 'juggling', 'yoYo', 'leapfrog', 'staringContest',
    'hideAndSeek', 'catchTheFly', 'danceBreak', 'hulaHoop']);
  /// Showier games, to draw someone in.
  static readonly noticingPool: readonly OneShotKind[] = ['pingPong', 'basketball', 'leapfrog', 'hideAndSeek', 'danceBreak'];
  /// Calmer games for an empty room.
  static readonly idlePool: readonly OneShotKind[] = ['juggling', 'yoYo', 'staringContest', 'hideAndSeek', 'catchTheFly', 'hulaHoop'];
  /// The only games Reduce Motion allows.
  static readonly reduceMotionGames = OneShotKindSet.of(['staringContest', 'catchTheFly']);

  /// True for a game whose curve is still a placeholder.
  static isPending(kind: OneShotKind): boolean { return isIdleGame(kind) && !IdleGames.built.contains(kind); }

  /// Per-game mood gate (on top of the global one).
  static moodAllows(kind: OneShotKind, m: Mood): boolean {
    if (!(m.pleasure >= IdleGames.minPleasure && m.arousal >= IdleGames.minArousal)) return false;
    switch (kind) {
      case 'danceBreak': return m.pleasure > 0.3;
      case 'hulaHoop': return m.arousal > 0.1;
      default: return true;
    }
  }

  // MARK: Read-outs

  private _lastGame: OneShotKind | null = null;
  private _triggerCount = 0;
  private _cancelCount = 0;
  private _nextGameAt: number | null = null;

  get lastGame(): OneShotKind | null { return this._lastGame; }
  get triggerCount(): number { return this._triggerCount; }
  get cancelCount(): number { return this._cancelCount; }
  /// When the next game is due (engine time), if scheduled.
  get nextGameAt(): number | null { return this._nextGameAt; }

  // MARK: State

  /// The games this scheduler may pick (`built`; tests widen it to exercise the pools).
  playable: OneShotKindSet = IdleGames.built;

  private lastGeometry: EdgeGeometry | null = null;
  private wasAllowed = false;
  private lastKindTime: number[] = new Array<number>(10).fill(-Infinity);

  static slot(k: OneShotKind): number { return OneShotKind.ordinal(k) - OneShotKind.ordinal('pingPong'); }

  update(s: FaceState): void {
    const st = s.idleGameSettings;
    const active = s.activeOneShots.some(isIdleGame);
    const tapped = s.commands.some((c) => c.kind === 'tap' || c.kind === 'scratch');
    const g = s.edgeGeometry;
    const geometryChanged = !(g === null || this.lastGeometry === null ? g === this.lastGeometry : g.equals(this.lastGeometry));
    if (geometryChanged) this.lastGeometry = g === null ? null : g.copy();
    const stateOK = s.agentState === 'idle' || s.agentState === 'noticing';
    const mayPlay = stateOK && !s.isBedtime && !s.isSulking && !EdgeAntics.isEngaged(s);
    if (active && (!mayPlay || tapped || geometryChanged) && s.oneShotCancels.length < 8) {
      s.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.idleGames));
      this._cancelCount += 1;
    }

    const allowed = mayPlay && st.enabled;
    try {
      if (!allowed) return;
      const noticing = s.agentState === 'noticing';
      const pool = noticing ? IdleGames.noticingPool : IdleGames.idlePool;
      // Nothing playable here (e.g. every idle game still pending): no schedule, and no draw from the shared RNG.
      if (!pool.some((k) => this.playable.contains(k) && st.game(k)?.enabled === true)) {
        this._nextGameAt = null;
        return;
      }
      if (!this.wasAllowed || this._nextGameAt === null) {
        const settled = s.time + s.rng.uniform(IdleGames.settle[0], IdleGames.settle[1]);
        this._nextGameAt = Math.max(this._nextGameAt ?? (s.time + this.interval(s, noticing, st)), settled);
      }
      const due = this._nextGameAt;
      if (!(s.time >= due)) return;
      if (s.activeOneShots.length > 0 || s.oneShotRequests.some(isIdleGame) || (noticing && s.noticingWatching)) {
        this._nextGameAt = s.time + IdleGames.busyRetry;
        return;
      }
      const clear = Math.max(s.lastIdleBeatTime, s.lastEdgeAnticTime, s.lastIdleGameTime) + EdgeAntics.idleActivitySpacing;
      if (s.time < clear) {
        this._nextGameAt = clear;
        return;
      }
      if (!this.fire(s, pool, st)) {
        this._nextGameAt = s.time + this.interval(s, noticing, st);
      }
    } finally {
      this.wasAllowed = allowed;
    }
  }

  private interval(s: FaceState, noticing: boolean, st: IdleGameSettings): number {
    const G = IdleGames;
    const v = noticing ? s.rng.lognormal(G.noticingMedian, G.sigma, G.noticingClamp) : s.rng.lognormal(G.idleMedian, G.sigma, G.idleClamp);
    return v / Math.max(st.frequency, 0.01);
  }

  private weight(k: OneShotKind, s: FaceState, st: IdleGameSettings): number {
    const gs = st.game(k);
    if (!this.playable.contains(k) || gs === undefined || !gs.enabled || !(gs.weight > 0)) return 0;
    if (s.reduceMotion && !IdleGames.reduceMotionGames.contains(k)) return 0;
    if (k === this._lastGame || !IdleGames.moodAllows(k, s.mood)) return 0;
    if (s.time - this.lastKindTime[IdleGames.slot(k)] < gs.cooldown) return 0;
    return gs.weight;
  }

  /// Weighted pick among the eligible games of `pool`. False when none is eligible.
  private fire(s: FaceState, pool: readonly OneShotKind[], st: IdleGameSettings): boolean {
    let total = 0;
    for (const k of pool) total += this.weight(k, s, st);
    if (!(total > 0)) return false;
    let x = s.rng.unit() * total;
    let pick = pool[0];
    for (const k of pool) {
      const w = this.weight(k, s, st);
      if (w <= 0) continue;
      pick = k;
      x -= w;
      if (x < 0) break;
    }
    s.oneShotRequests.push(pick);
    // Booked now (the sampler books it again when it starts) so a beat or antic can't slip in first.
    s.lastIdleGameTime = s.time;
    this._lastGame = pick;
    this.lastKindTime[IdleGames.slot(pick)] = s.time;
    this._triggerCount += 1;
    this._nextGameAt = s.time + this.interval(s, s.agentState === 'noticing', st);
    return true;
  }
}
