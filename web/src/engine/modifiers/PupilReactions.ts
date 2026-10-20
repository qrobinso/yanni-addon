// Port of FaceEngine/Modifiers/PupilReactions.swift.
import type { AgentState } from '../AgentState';
import type { OneShotKind } from '../Commands';
import { FaceAffect } from '../FaceAffect';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { OneShotKindSet, OneShotRequest, isEdgeAntic, isIdleGame, isPupilShape, makeOneShotCancel } from '../OneShots';
import {
  PupilReactionEvent, ReactionCueKind, type PupilReactionEventWhat, type PupilReactionReason, type PupilReactionSettings,
  type ReactionCue,
} from '../PupilReactionTypes';
import { defaultHold } from '../PupilShapeCurves';
import { TouchReactions } from './TouchReactions';

/// Behaviour phase: the pupil reaction arbiter (pupil transformations design §2). It turns semantic reaction cues
/// (`FaceCommand.reactionCue`) into rare, well-placed transformations and ends a showing transformation when the moment
/// changes.
///
/// **Gates, in order** (the first failure is the logged reason): enabled and intensity > 0, the transformation
/// enabled; confidence ≥ `minConfidence`, affection and music `directedAtYanni`; fresh (≤ `freshness` old; a future
/// host time waits); the sliding repeat window per topic key; music never over Yanni's own voice; emotional context
/// (negative cue or affect rejects, opens a 60 s somber window; hearts blocked at tap "hmph" level); state (bedtime,
/// sulking, blocked states; listening only for cues aimed at Yanni, or a directed perception cue within
/// `perceptionListeningWindow` of entering listening); never over an edge antic, idle game or idle beat, no stacking,
/// no restart within 3 s of an early end; global and per-shape cooldowns × `cooldownScale`; habituation 0.5ⁿ ×
/// `acceptanceScale`.
///
/// **Interrupts.** A showing transformation switches back when listening or engaged starts (unless held by a directed
/// perception cue for `perceptionHold`), when the state becomes a blocked one, at bedtime, when a sulk starts, or when
/// an urgent one-shot starts. An early end keeps the global cooldown and refunds the shape's own.
///
/// Randomness only when a cue is evaluated.
export class PupilReactions implements Modifier {
  readonly name = 'PupilReactions';
  readonly phase = Phase.behaviour;
  isEnabled = true;

  // MARK: Tuning

  /// Oldest acceptable cue (seconds of host time).
  static readonly freshness = 1.5;
  /// A cue more than this far in the future is dropped as invalid (seconds).
  static readonly maxLead = 5;
  static readonly negativeCueValence = -0.1;
  static readonly negativeAffect = -0.2;
  /// Valence / affect below this opens the somber window.
  static readonly somberThreshold = -0.2;
  static readonly somberWindow = 60;
  static readonly restartBlock = 3;
  /// A directed perception cue may play in listening for this long after listening starts (seconds, engine time).
  static readonly perceptionListeningWindow = 2;
  /// Listening / engaged starting this soon after a directed perception cue's acceptance doesn't end its
  /// transformation (seconds, engine time).
  static readonly perceptionHold = 3;
  static readonly habituationWindow = 600;
  /// Music counts as Yanni's own audio above this speech level.
  static readonly ownAudioLevel = 0.02;
  static readonly blockedStates: readonly AgentState[] = ['drowsy', 'asleep', 'halfAwake', 'waking', 'interrupted', 'notForMe',
    'confused', 'sheepish', 'hasMessage'];
  /// States whose start ends a showing transformation (besides the blocked ones).
  static readonly interruptStates: readonly AgentState[] = ['listening', 'engaged'];
  static readonly urgentOneShots = OneShotKindSet.of(['bigSurprise', 'mockOffense', 'sorryBlink', 'wake', 'catchSelf',
    'lookAway', 'nodOff', 'yawn']);
  /// The idle personality beats (IdleBeats' kinds).
  static readonly idleBeatKinds = OneShotKindSet.of(['curiousTilt', 'doubleTake', 'delightedSquint', 'sideEye', 'crossEyed']);
  /// The affect is re-read this often (seconds).
  static readonly affectInterval = 0.1;
  static readonly eventCapacity = 32;
  static readonly keyCapacity = 16;
  static readonly historyCapacity = 32;
  static readonly pendingCapacity = 4;

  // MARK: Read-outs

  /// Recent events, oldest first (at most `eventCapacity`).
  readonly events: PupilReactionEvent[] = [];
  private _eventSerial = 0;
  private _lastDecision: PupilReactionEvent | null = null;
  private _lastAcceptedAt = -Infinity;
  private _lastCancelAt = -Infinity;
  private _somberUntil = -Infinity;

  /// Serial of the newest event (0 = none yet).
  get eventSerial(): number { return this._eventSerial; }
  get lastDecision(): PupilReactionEvent | null { return this._lastDecision; }
  /// Engine time of the last accepted cue, and of the last early end.
  get lastAcceptedAt(): number { return this._lastAcceptedAt; }
  get lastCancelAt(): number { return this._lastCancelAt; }
  get somberUntil(): number { return this._somberUntil; }

  /// Engine time from which a cue could pass the cooldowns and the restart block (ignores the other gates).
  nextAllowed(kind: OneShotKind, st: PupilReactionSettings): number {
    const g = this._lastAcceptedAt + st.globalCooldown * st.cooldownScale;
    const k = this.lastShapeAt[this.slot(kind)] + (st.shape(kind)?.cooldown ?? 0) * st.cooldownScale;
    return Math.max(g, k, this._lastCancelAt + PupilReactions.restartBlock);
  }

  // MARK: Private state

  private lastShapeAt: number[] = new Array<number>(5).fill(-Infinity);
  private refund: number[] = new Array<number>(5).fill(-Infinity);
  private keys: string[] = new Array<string>(PupilReactions.keyCapacity).fill('');
  private keySeen: number[] = new Array<number>(PupilReactions.keyCapacity).fill(-Infinity);
  private historyKind: number[] = new Array<number>(PupilReactions.historyCapacity).fill(-1);
  private historyTime: number[] = new Array<number>(PupilReactions.historyCapacity).fill(-Infinity);
  private historyNext = 0;
  private pending: ReactionCue[] = [];
  private lastState: AgentState | null = null;
  private wasBedtime = false;
  private wasSulking = false;
  private nextAffectAt = -Infinity;
  private affectP = 0;
  /// The transformation the arbiter started and is still showing (for the refund on an early end).
  private current: OneShotKind | null = null;
  /// Until when (engine time) `current`, accepted from a directed perception cue, ignores listening / engaged starts.
  private perceptionHoldUntil = -Infinity;

  slot(k: OneShotKind): number {
    switch (k) {
      case 'starEyes': return 0;
      case 'heartEyes': return 1;
      case 'noteEyes': return 2;
      case 'questionEyes': return 3;
      default: return 4;
    }
  }

  /// Opens the somber window now (the emotion layer calls it for bad news).
  markSomber(s: FaceState): void { this._somberUntil = Math.max(this._somberUntil, s.time + PupilReactions.somberWindow); }

  update(s: FaceState): void {
    const R = PupilReactions;
    // Affect (sampled at 10 Hz) and the somber window.
    if (s.time >= this.nextAffectAt) {
      this.nextAffectAt = s.time + R.affectInterval;
      this.affectP = FaceAffect.effectivePAD(s).x;
      if (this.affectP < R.somberThreshold) this._somberUntil = Math.max(this._somberUntil, s.time + R.somberWindow);
    }

    const showing = s.activeOneShots.find(isPupilShape);
    if (showing === undefined) this.current = null;

    // Interrupts.
    const stateChanged = this.lastState !== null && this.lastState !== s.agentState;
    if (showing !== undefined) {
      const k = showing;
      let why: string | null = null;
      const held = this.current === k && s.time - this.perceptionHoldUntil <= 0;
      if (stateChanged && R.blockedStates.includes(s.agentState)) {
        why = s.agentState;
      } else if (stateChanged && R.interruptStates.includes(s.agentState) && !held) {
        why = s.agentState;
      } else if (s.isBedtime && !this.wasBedtime) {
        why = 'bedtime';
      } else if (s.isSulking && !this.wasSulking) {
        why = 'sulk';
      } else {
        const u = s.startedOneShots.find((x) => R.urgentOneShots.contains(x.kind));
        if (u !== undefined) why = u.kind;
      }
      if (why !== null) this.interrupt(k, why, s);
    }
    this.lastState = s.agentState;
    this.wasBedtime = s.isBedtime;
    this.wasSulking = s.isSulking;

    // Held cues whose moment has come.
    const now = s.presentationHostTime;
    if (this.pending.length > 0 && now !== null) {
      let i = 0;
      while (i < this.pending.length) {
        const h = this.pending[i].hostTime;
        if (h !== null && h > now + 0.008) { i += 1; continue; }
        const c = this.pending.splice(i, 1)[0];
        this.evaluate(c, s);
      }
    }

    // New cues.
    for (const command of s.commands) {
      if (command.kind !== 'reactionCue') continue;
      const c = command.cue;
      const h = c.hostTime;
      if (h !== null && now !== null && h > now + 0.008) {
        const k = ReactionCueKind.oneShot(c.kind);
        if (h > now + R.maxLead) {
          this.log({ kind: 'decision', cue: c, oneShot: k, reason: 'stale' }, s);
        } else if (this.pending.length < R.pendingCapacity) {
          this.pending.push(c);
          this.log({ kind: 'decision', cue: c, oneShot: k, reason: 'waiting' }, s);
        } else {
          this.log({ kind: 'decision', cue: c, oneShot: k, reason: 'queueFull' }, s);
        }
        continue;
      }
      this.evaluate(c, s);
    }
  }

  /// Ends the showing transformation through its switch back and books the early end.
  private interrupt(k: OneShotKind, why: string, s: FaceState): void {
    s.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.pupilShapes));
    this._lastCancelAt = s.time;
    if (this.current === k) this.lastShapeAt[this.slot(k)] = this.refund[this.slot(k)];
    this.current = null;
    this.log({ kind: 'interrupted', oneShot: k, why }, s);
  }

  /// Runs the gates for one cue; on success requests the transformation.
  private evaluate(c: ReactionCue, s: FaceState): void {
    const r = this.decide(c, s);
    const kind = ReactionCueKind.oneShot(c.kind);
    if (r === 'accepted') {
      const st = s.pupilSettings;
      const hold = (st.shape(kind)?.hold ?? defaultHold(kind)) * st.holdScale;
      s.oneShotPlayRequests.push(OneShotRequest.make(kind, { hold, intensity: st.intensity, reduceMotion: st.reduceMotion }));
      const i = this.slot(kind);
      this.refund[i] = this.lastShapeAt[i];
      this.lastShapeAt[i] = s.time;
      this._lastAcceptedAt = s.time;
      this.historyKind[this.historyNext] = i;
      this.historyTime[this.historyNext] = s.time;
      this.historyNext = (this.historyNext + 1) % PupilReactions.historyCapacity;
      this.current = kind;
      this.perceptionHoldUntil = c.source === 'perception' && c.directedAtYanni ? s.time + PupilReactions.perceptionHold : -Infinity;
    }
    this.log({ kind: 'decision', cue: c, oneShot: kind, reason: r }, s);
  }

  private decide(c: ReactionCue, s: FaceState): PupilReactionReason {
    const R = PupilReactions;
    const st = s.pupilSettings;
    const kind = ReactionCueKind.oneShot(c.kind);
    if (!(st.enabled && st.intensity > 0)) return 'disabled';
    if (!(st.shape(kind)?.enabled ?? false)) return 'shapeDisabled';
    if (!(Number.isFinite(c.confidence) && c.confidence >= st.minConfidence)) return 'lowConfidence';
    if (ReactionCueKind.needsDirected(c.kind) && !c.directedAtYanni) return 'notDirected';
    const h = c.hostTime, now = s.presentationHostTime;
    if (h !== null && now !== null && (!Number.isFinite(h) || now - h > R.freshness)) return 'stale';

    // Sliding repeat window (every valid sighting restarts it).
    if (c.key !== '' && this.seenRecently(c.key, s.time, st.repeatWindow)) return 'repeatKey';

    if (c.kind === 'music' && (s.speechLevel > R.ownAudioLevel || s.agentState === 'speaking')) return 'ownAudio';

    const v = Number.isFinite(c.valence) ? c.valence : 0;
    if (Math.min(v, this.affectP) < R.somberThreshold) this._somberUntil = Math.max(this._somberUntil, s.time + R.somberWindow);
    if (v < R.negativeCueValence || this.affectP < R.negativeAffect) return 'negativeContext';
    if (s.time < this._somberUntil) return 'somber';
    if (kind === 'heartEyes' && s.tapAnnoyance >= TouchReactions.hmphThreshold) return 'annoyed';

    if (s.isBedtime) return 'bedtime';
    if (s.isSulking) return 'sulking';
    if (R.blockedStates.includes(s.agentState)) return 'blockedState';
    if (s.agentState === 'listening' && !(c.directedAtYanni && (c.source === 'conversation'
      || (c.source === 'perception' && s.time - s.agentStateEnteredAt <= R.perceptionListeningWindow)))) {
      return 'notAboutYanni';
    }

    if (s.activeOneShots.some((k) => isEdgeAntic(k) || isIdleGame(k))) return 'otherActivity';
    if (s.time - s.lastIdleBeatTime < 3 && s.activeOneShots.some((k) => R.idleBeatKinds.contains(k))) return 'otherActivity';
    if (s.activeOneShots.some(isPupilShape) || this.current !== null) return 'busy';
    if (s.time - this._lastCancelAt < R.restartBlock) return 'recentCancel';

    if (s.time - this._lastAcceptedAt < st.globalCooldown * st.cooldownScale) return 'globalCooldown';
    const i = this.slot(kind);
    if (s.time - this.lastShapeAt[i] < (st.shape(kind)?.cooldown ?? 0) * st.cooldownScale) return 'shapeCooldown';

    let n = 0;
    for (let j = 0; j < R.historyCapacity; j++) {
      if (this.historyKind[j] === i && s.time - this.historyTime[j] < R.habituationWindow) n += 1;
    }
    const p = Math.pow(2, -n) * st.acceptanceScale;
    if (p < 1 && s.rng.unit() >= p) return 'habituated';
    return 'accepted';
  }

  /// True when `key` was seen within `window` seconds; records this sighting either way (LRU of 16 keys).
  private seenRecently(key: string, now: number, window: number): boolean {
    const i = this.keys.indexOf(key);
    if (i >= 0) {
      const recent = now - this.keySeen[i] < window;
      this.keySeen[i] = now;
      return recent;
    }
    let oldest = 0;
    for (let j = 0; j < this.keys.length; j++) if (this.keySeen[j] < this.keySeen[oldest]) oldest = j;
    this.keys[oldest] = key;
    this.keySeen[oldest] = now;
    return false;
  }

  private log(what: PupilReactionEventWhat, s: FaceState): void {
    this._eventSerial += 1;
    const e = new PupilReactionEvent(this._eventSerial, s.time, what);
    if (this.events.length >= PupilReactions.eventCapacity) this.events.shift();
    this.events.push(e);
    if (what.kind === 'decision') this._lastDecision = e;
  }
}
