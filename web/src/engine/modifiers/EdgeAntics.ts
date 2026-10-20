// Port of FaceEngine/Modifiers/EdgeAntics.swift.
import type { EdgeGeometry } from '../../model';
import type { AgentState } from '../AgentState';
import type { OneShotKind } from '../Commands';
import type { EdgeAnticSettings } from '../EdgeAnticSettings';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { OneShotKindSet, isScreenEdgeAntic, makeOneShotCancel } from '../OneShots';

/// Behaviour phase: decides when Yanni plays with the screen edges (screen-edge antics design §3) and keeps it safe.
///
/// **When.** Only while idle or noticing, with screen geometry known, not at bedtime, not sulking and nobody engaging;
/// never while another one-shot plays; at least `idleActivitySpacing` (25 s) from any idle beat or idle game in both
/// directions; never the same antic twice in a row; per-antic cooldowns, weights and switches from `s.edgeSettings`.
/// Regular (lognormal spacing, median 70 s alone, 45 s with someone in view, ÷ `frequency`), greeting (someone appears
/// after ≥ 60 s alone, or a wake completes: a pop-up `greetingChance` of the time) and after a conversation
/// (`postConversationChance` of a curious lean or pretend exit 4–10 s later). Perception beats pass the same gates.
///
/// **Cancelling.** Engagement, a tap, bedtime, sulking, leaving idle / noticing or a change of screen geometry
/// spring-releases any active screen-edge antic.
///
/// **Watchdog.** If both eyes (and their brows) are fully off screen for longer than `maxHiddenSeconds` the antic's
/// playhead jumps to its return keyframe; if still hidden `watchdogGrace` later, the antic is spring-released.
///
/// The sleepy sink is decided by `rollSleepySink` (the life-cycle controller, through the engine).
export class EdgeAntics implements Modifier {
  readonly name = 'EdgeAntics';
  readonly phase = Phase.behaviour;
  isEnabled = true;

  // MARK: Tuning

  /// Minimum seconds between a screen-edge antic and an idle personality beat, either way round.
  static readonly idleActivitySpacing = 25;
  static readonly aloneMedian = 70;
  static readonly aloneClamp: readonly [number, number] = [40, 120];
  static readonly noticingMedian = 45;
  static readonly noticingClamp: readonly [number, number] = [25, 90];
  static readonly sigma = 0.4;
  /// After (re-)entering an eligible context, wait at least this long first.
  static readonly settle: readonly [number, number] = [8, 15];
  /// If a one-shot is playing when an antic is due, retry after this delay.
  static readonly busyRetry = 2;
  static readonly greetingAloneTime = 60;
  static readonly greetingDelay = 0.8;
  static readonly postConversationDelay: readonly [number, number] = [4, 10];
  static readonly contextWindow = 5;
  /// Watchdog: after the playhead jump, how long the eyes may stay hidden before the spring release.
  static readonly watchdogGrace = 0.35;
  static readonly conversationStates: readonly AgentState[] = ['engaged', 'listening', 'thinking', 'speaking', 'followUp', 'interrupted'];

  // MARK: Read-outs

  private _lastAntic: OneShotKind | null = null;
  private _lastAnticTime = -Infinity;
  private _triggerCount = 0;
  private _cancelCount = 0;
  private _watchdogSeeks = 0;
  private _watchdogReleases = 0;
  private _hiddenFor = 0;
  private _nextAnticAt: number | null = null;
  private _greetingAt: number | null = null;
  private _postConversationAt: number | null = null;

  get lastAntic(): OneShotKind | null { return this._lastAntic; }
  get lastAnticTime(): number { return this._lastAnticTime; }
  get triggerCount(): number { return this._triggerCount; }
  get cancelCount(): number { return this._cancelCount; }
  get watchdogSeeks(): number { return this._watchdogSeeks; }
  get watchdogReleases(): number { return this._watchdogReleases; }
  /// Seconds (engine time) both eyes have been fully off screen.
  get hiddenFor(): number { return this._hiddenFor; }
  /// When the next regular antic is due (engine time), if scheduled.
  get nextAnticAt(): number | null { return this._nextAnticAt; }
  /// Pending contextual triggers (engine time), for tests and the preview.
  get greetingAt(): number | null { return this._greetingAt; }
  get postConversationAt(): number | null { return this._postConversationAt; }

  /// Tests: a different watchdog limit than `maxHiddenSeconds`.
  watchdogLimitOverride: number | null = null;

  // MARK: Private state

  private lastGeometry: EdgeGeometry | null = null;
  private wasAllowed = false;
  private wasPresent = false;
  private aloneSince: number | null = null;
  private lastStateSeen: AgentState | null = null;
  private lastKindTime: number[] = [-Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
  private seekSent = false;
  private releaseSent = false;

  static slot(k: OneShotKind): number {
    switch (k) {
      case 'shyPeek': return 0;
      case 'popUp': return 1;
      case 'curiousLean': return 2;
      case 'pretendExit': return 3;
      default: return 4;
    }
  }

  /// True while someone engaging with Yanni is in view.
  static isEngaged(s: FaceState): boolean {
    const id = s.engagedPersonID;
    if (id === null) return false;
    return s.people.some((p) => p.id === id);
  }

  private static screenAnticActive(s: FaceState): boolean { return s.activeOneShots.some(isScreenEdgeAntic); }

  update(s: FaceState): void {
    const g = s.edgeGeometry !== null && s.edgeGeometry.isValid ? s.edgeGeometry : null;
    const st = s.edgeSettings;
    const active = EdgeAntics.screenAnticActive(s);
    const engaged = EdgeAntics.isEngaged(s);
    const tapped = s.commands.some((c) => c.kind === 'tap' || c.kind === 'scratch');
    const stateOK = s.agentState === 'idle' || s.agentState === 'noticing';

    // Contexts (tracked even while not eligible).
    const present = s.people.length > 0;
    if (this.aloneSince === null && !present) this.aloneSince = s.time;
    if (present && !this.wasPresent) {
      const a = this.aloneSince;
      if (a !== null && s.time - a >= EdgeAntics.greetingAloneTime) this.maybeGreeting(s);
      this.aloneSince = null;
    } else if (!present && this.wasPresent) {
      this.aloneSince = s.time;
    }
    this.wasPresent = present;
    const last = this.lastStateSeen;
    if (last !== null && last !== s.agentState) {
      const back = s.agentState === 'idle' || s.agentState === 'noticing';
      if (last === 'waking' && back) this.maybeGreeting(s);
      if (EdgeAntics.conversationStates.includes(last) && back) this.maybePostConversation(s);
    }
    this.lastStateSeen = s.agentState;

    // Cancelling.
    const geometryChanged = !geometryEquals(g, this.lastGeometry);
    if (geometryChanged) this.lastGeometry = g === null ? null : g.copy();
    const mayPlay = g !== null && stateOK && !s.isBedtime && !s.isSulking && !engaged;
    if (active && (!mayPlay || tapped || geometryChanged) && s.oneShotCancels.length < 8) {
      s.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.screenEdgeAntics));
      this._cancelCount += 1;
    }

    this.watchdog(s, active ? g : null, st);

    const allowed = mayPlay && st.enabled;
    try {
      if (!allowed) {
        this._greetingAt = null;
        this._postConversationAt = null;
        return;
      }

      if (!this.wasAllowed || this._nextAnticAt === null) {
        const settled = s.time + s.rng.uniform(EdgeAntics.settle[0], EdgeAntics.settle[1]);
        const scheduled = this._nextAnticAt ?? (s.time + this.interval(s, present, st));
        this._nextAnticAt = Math.max(scheduled, settled);
      }

      // Contextual triggers first (they are rare and time-sensitive).
      const gAt = this._greetingAt;
      if (gAt !== null && s.time >= gAt) {
        if (s.time - gAt > EdgeAntics.contextWindow) this._greetingAt = null;
        else if (this.ready(s) && this.fire(s, ['popUp'], st, false, present)) this._greetingAt = null;
      }
      const pAt = this._postConversationAt;
      if (pAt !== null && s.time >= pAt) {
        if (s.time - pAt > EdgeAntics.contextWindow) this._postConversationAt = null;
        else if (this.ready(s) && this.fire(s, ['curiousLean', 'pretendExit'], st, false, present)) {
          this._postConversationAt = null;
        }
      }

      const due = this._nextAnticAt;
      if (due === null || !(s.time >= due)) return;
      if (s.activeOneShots.length > 0 || EdgeAntics.anticQueued(s)) {
        this._nextAnticAt = s.time + EdgeAntics.busyRetry;
        return;
      }
      const clear = Math.max(s.lastIdleBeatTime, s.lastEdgeAnticTime, s.lastIdleGameTime) + EdgeAntics.idleActivitySpacing;
      if (s.time < clear) {
        this._nextAnticAt = clear;
        return;
      }
      const candidates: OneShotKind[] = present ? ['curiousLean', 'shyPeek', 'popUp'] : ['shyPeek', 'curiousLean', 'pretendExit', 'popUp'];
      if (!this.fire(s, candidates, st, true, present)) {
        this._nextAnticAt = s.time + this.interval(s, present, st);
      }
    } finally {
      this.wasAllowed = allowed;
    }
  }

  // MARK: - Sleepy sink

  /// Whether falling asleep now should play the sleepy sink (rolls `sleepySinkChance`). False without screen geometry,
  /// with the antics or the sink switched off, at bedtime when `quietAtBedtime`, or within its cooldown.
  rollSleepySink(s: FaceState): boolean {
    const st = s.edgeSettings;
    if (!(this.isEnabled && st.enabled && st.sleepySink.enabled && (s.edgeGeometry?.isValid ?? false))) return false;
    if (s.isBedtime && st.quietAtBedtime) return false;
    if (s.reduceMotion) return false;
    if (!(s.time - this.lastKindTime[4] >= st.sleepySink.cooldown)) return false;
    if (!s.rng.chance(st.sleepySinkChance)) return false;
    this.lastKindTime[4] = s.time;
    return true;
  }

  // MARK: - Perception beats

  /// Whether perception may play `kind` as a gesture beat now (perception upgrade §6.6): the same gates as the
  /// automatic antics, and the antic's own cooldown (shared with the automatic triggers).
  canPlayPerceptionAntic(kind: OneShotKind, s: FaceState): boolean {
    if (!(this.isEnabled && isScreenEdgeAntic(kind) && (s.edgeGeometry?.isValid ?? false))) return false;
    const st = s.edgeSettings;
    const a = st.antic(kind);
    if (!st.enabled || a === undefined || !a.enabled) return false;
    if (!(s.agentState === 'idle' || s.agentState === 'noticing')) return false;
    if (EdgeAntics.isEngaged(s) || s.isBedtime || s.isSulking) return false;
    if (s.activeOneShots.length > 0 || EdgeAntics.anticQueued(s)) return false;
    if (!(s.time >= Math.max(s.lastIdleBeatTime, s.lastEdgeAnticTime, s.lastIdleGameTime) + EdgeAntics.idleActivitySpacing)) return false;
    return s.time - this.lastKindTime[EdgeAntics.slot(kind)] >= a.cooldown;
  }

  /// Plays `kind` toward `side` (+1 right, −1 left, 0 random) as a perception beat when `canPlayPerceptionAntic`
  /// allows it, booking it exactly like an automatic trigger. Returns false, changing nothing, otherwise.
  playPerceptionAntic(kind: OneShotKind, side: number, s: FaceState): boolean {
    if (!this.canPlayPerceptionAntic(kind, s)) return false;
    s.edgeSideHint = Number.isFinite(side) ? (side > 0 ? 1 : (side < 0 ? -1 : 0)) : 0;
    s.oneShotRequests.push(kind);
    // Booked now (the sampler books it again when it starts) so an idle beat can't slip in before it starts.
    s.lastEdgeAnticTime = s.time;
    this._lastAntic = kind;
    this._lastAnticTime = s.time;
    this.lastKindTime[EdgeAntics.slot(kind)] = s.time;
    this._triggerCount += 1;
    this._nextAnticAt = s.time + this.interval(s, s.people.length > 0, s.edgeSettings);
    return true;
  }

  /// A screen-edge antic request is waiting for the sampler (a perception beat queued between frames).
  private static anticQueued(s: FaceState): boolean { return s.oneShotRequests.some(isScreenEdgeAntic); }

  // MARK: - Internals

  private ready(s: FaceState): boolean {
    return s.activeOneShots.length === 0 && !EdgeAntics.anticQueued(s)
      && s.time >= Math.max(s.lastIdleBeatTime, s.lastEdgeAnticTime, s.lastIdleGameTime) + EdgeAntics.idleActivitySpacing;
  }

  private interval(s: FaceState, present: boolean, st: EdgeAnticSettings): number {
    const E = EdgeAntics;
    const v = present ? s.rng.lognormal(E.noticingMedian, E.sigma, E.noticingClamp) : s.rng.lognormal(E.aloneMedian, E.sigma, E.aloneClamp);
    return v / Math.max(st.frequency, 0.01);
  }

  private maybeGreeting(s: FaceState): void {
    const st = s.edgeSettings;
    if (!(st.enabled && st.popUp.enabled && s.rng.chance(st.greetingChance))) return;
    this._greetingAt = s.time + EdgeAntics.greetingDelay;
  }

  private maybePostConversation(s: FaceState): void {
    const st = s.edgeSettings;
    if (!(st.enabled && s.rng.chance(st.postConversationChance))) return;
    this._postConversationAt = s.time + s.rng.uniform(EdgeAntics.postConversationDelay[0], EdgeAntics.postConversationDelay[1]);
  }

  /// Weighted pick among eligible candidates and request it. Returns false when none is eligible.
  private fire(s: FaceState, candidates: OneShotKind[], st: EdgeAnticSettings, avoidRepeat: boolean, present: boolean): boolean {
    let total = 0;
    const weights = [0, 0, 0, 0];
    const weight = (k: OneShotKind): number => {
      const a = st.antic(k);
      if (a === undefined || !a.enabled || !(a.weight > 0)) return 0;
      // Reduce Motion: only the curious lean (no slide-offs, pop-ups or exits), so it may repeat.
      if (s.reduceMotion && k !== 'curiousLean') return 0;
      if (avoidRepeat && !s.reduceMotion && k === this._lastAntic) return 0;
      if (s.time - this.lastKindTime[EdgeAntics.slot(k)] < a.cooldown) return 0;
      return a.weight;
    };
    for (let i = 0; i < candidates.length && i < 4; i++) {
      weights[i] = weight(candidates[i]);
      total += weights[i];
    }
    if (!(total > 0)) return false;
    let x = s.rng.unit() * total;
    let pick = candidates[0];
    for (let i = 0; i < candidates.length && i < 4; i++) {
      const w = weights[i];
      if (w <= 0) continue;
      pick = candidates[i];
      x -= w;
      if (x < 0) break;
    }

    // Toward the person in view (lean), away from them for the shy peek (it peeks back at them).
    let side = 0;
    const id = s.primaryPersonID;
    const p = present && id !== null ? s.people.find((q) => q.id === id) : undefined;
    if (p !== undefined && Math.abs(p.position.x) > 0.05) {
      const toward = p.position.x > 0 ? 1 : -1;
      side = pick === 'shyPeek' ? -toward : toward;
    }
    s.edgeSideHint = side;
    s.oneShotRequests.push(pick);
    this._lastAntic = pick;
    this._lastAnticTime = s.time;
    this.lastKindTime[EdgeAntics.slot(pick)] = s.time;
    this._triggerCount += 1;
    this._nextAnticAt = s.time + this.interval(s, present, st);
    return true;
  }

  /// While a screen-edge antic plays, measures how long both eyes have been fully off screen (last composed frame) and
  /// brings them back.
  private watchdog(s: FaceState, g: EdgeGeometry | null, st: EdgeAnticSettings): void {
    if (g === null) { this._hiddenFor = 0; this.seekSent = false; this.releaseSent = false; return; }
    // A brow still on screen counts as visible (the geometry carries brow boxes when brows are drawn).
    const hidden = g.extentVisibleFractionIn('left', s.output) <= 0 && g.extentVisibleFractionIn('right', s.output) <= 0;
    if (!hidden) { this._hiddenFor = 0; this.seekSent = false; this.releaseSent = false; return; }
    // f32: Swift accumulates in Float, and the default 1.2 s limit is a whole number of 60 Hz frames.
    this._hiddenFor = Math.fround(this._hiddenFor + Math.max(s.dt, 0));
    const limit = Math.fround(this.watchdogLimitOverride ?? st.maxHiddenSeconds);
    if (s.oneShotCancels.length >= 8) return;
    if (this._hiddenFor > limit && !this.seekSent) {
      this.seekSent = true;
      this._watchdogSeeks += 1;
      s.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.screenEdgeAntics, 0, 'seekReturn'));
    }
    if (this._hiddenFor > Math.fround(limit + Math.fround(EdgeAntics.watchdogGrace)) && !this.releaseSent) {
      this.releaseSent = true;
      this._watchdogReleases += 1;
      s.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.screenEdgeAntics));
    }
  }
}

/// Swift `EdgeGeometry?` equality.
function geometryEquals(a: EdgeGeometry | null, b: EdgeGeometry | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}
