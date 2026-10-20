// Port of FaceEngine/Modifiers/AgentStateBehavior.swift.
import type { SplitMix64 } from '../../core/random';
import { ParamLayout } from '../../model';
import type { AgentState } from '../AgentState';
import { AgentStateProfiles, type AgentStateProfile } from '../AgentStateProfiles';
import { FaceCommand } from '../Commands';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { Spring1, SpringParams } from '../Spring';

// f32: Swift draws these delays as Float and adds them to the Double clock (clamp bounds tie with the frame grid).
const f32 = Math.fround;
const ANGLE = ParamLayout.index('angle');

/// Behaviour phase: turns the current `AgentState` into targets (expression mix, gaze intent, state modulation,
/// breathing depth, brightness), requests entry one-shots, runs per-state schedules (drowsy nod-offs, hasMessage
/// perk-ups, speaking group glances), the speaking pulse and head tilt, and the visual-only auto-transitions
/// (interrupted → listening, notForMe → idle, waking → noticing).
///
/// State changes are detected against this modifier's own last-seen state, so changes made by anyone are honoured.
export class AgentStateBehavior implements Modifier {
  readonly name = 'AgentStateBehavior';
  readonly phase = Phase.behaviour;
  isEnabled = true;

  /// SP2/SP4 own the real state machine and may turn the visual-only hand-offs off.
  autoTransitionsEnabled = true;
  /// Safety net: hand off after this many seconds in the state if the awaited one-shot never completes. Null disables.
  autoTransitionFallback: number | null = 8;

  /// Head-tilt spring (degrees). Slow and slightly underdamped so the tilt settles with life.
  static readonly tiltSpring = new SpringParams(6, 0.75);
  /// Speech pulse gain spring: fades the pulse in/out around speaking.
  static readonly pulseSpring = new SpringParams(10, 1);
  /// Held lid closure per state (lid-close channel), so sleeping eyes are thin lines.
  static heldLidClose(state: AgentState): number {
    switch (state) {
      case 'asleep': return 0.85;
      case 'halfAwake': return 0.25;
      default: return 0;
    }
  }
  /// Brow presence per state (eyebrows design §4): awake 1; drowsy and half awake partly relaxed; asleep gone.
  static browPresence(state: AgentState): number {
    switch (state) {
      case 'asleep': return 0;
      case 'halfAwake': return 0.6;
      case 'drowsy': return 0.88;
      default: return 1;
    }
  }
  static readonly lidCloseFallSpring = new SpringParams(1.6, 1);
  static readonly lidCloseOpenSpring = new SpringParams(4, 1);
  /// While the sleepy sink is still playing after the change to asleep, the held closure comes down faster.
  static readonly lidCloseSinkSpring = new SpringParams(8, 1);
  /// Startled wake (`s.fastWakeAt`): the eyes snap open on a much faster (still critically damped) spring.
  static readonly lidCloseFastOpenSpring = new SpringParams(14, 1);
  /// A sub-threshold tap while asleep (`s.lidStirAt`) lowers the held closure by this much for `lidStirDuration` s.
  static readonly lidStirDepth = 0.5;
  static readonly lidStirDuration = 0.45;
  /// How long after `s.fastWakeAt` the fast opening (and Brightness's fast ramp) applies.
  static readonly fastWakeWindow = 1.2;
  /// Group glance spacing while speaking with others present (lognormal median, sigma, clamp; seconds).
  static readonly glanceMedian = 4.5;
  static readonly glanceSigma = 0.35;
  static readonly glanceClamp = [2.5, 10] as const;
  static readonly glanceDuration = [0.45, 0.9] as const;

  private _lastSeenState: AgentState | null = null;
  private _profile: AgentStateProfile = AgentStateProfiles.profile('idle');
  get lastSeenState(): AgentState | null { return this._lastSeenState; }
  get profile(): AgentStateProfile { return this._profile; }
  private enteredAt = 0;
  private stage2Applied = false;
  private heldLidClose = new Spring1(0);
  private browPresence = new Spring1(1);

  // Auto-transition tracking.
  private awaitingSeenActive = false;
  private awaitedCompletedAt: number | null = null;

  // Recurring beats.
  private nextBeatAt = Infinity;
  private lastBeatWasAlternate = false;
  private beatsFired = 0;

  // Speaking glances.
  private nextGlanceAt = Infinity;

  // Continuous extras.
  private tilt = new Spring1(0);
  private pulseGain = new Spring1(0);

  update(s: FaceState): void {
    if (s.agentState !== this._lastSeenState) this.enter(s.agentState, s);

    const st2 = this._profile.stage2;
    if (st2 && !this.stage2Applied && s.time - this.enteredAt >= st2.after) {
      this.stage2Applied = true;
      if (st2.mix) s.targetMix = st2.mix.copy();
      if (st2.gaze) s.gazeIntent = st2.gaze;
    }

    this.runRecurring(s);
    this.runGroupGlances(s);
    this.applyContinuous(s);
    this.runAutoTransition(s);
  }

  // MARK: Entry

  private enter(state: AgentState, s: FaceState): void {
    const first = this._lastSeenState === null;
    this._lastSeenState = state;
    const profile = AgentStateProfiles.profile(state);
    this._profile = profile;
    this.enteredAt = s.time;
    this.stage2Applied = false;
    this.awaitingSeenActive = false;
    this.awaitedCompletedAt = null;

    s.targetMix = profile.mix.copy();
    s.gazeIntent = profile.gaze;
    s.stateModulation = { ...profile.modulation };
    s.breathingDepth = profile.breathingDepth;
    s.targetBrightness = profile.targetBrightness;

    // The engine's startup state (idle) gets no entry one-shots; any explicit state does.
    if (!(first && profile.entryOneShots.length === 0)) {
      for (const k of profile.entryOneShots) s.oneShotRequests.push(k);
    }

    const r = profile.recurring;
    if (r) {
      this.nextBeatAt = s.time + f32(s.rng.uniform(r.firstDelay[0], r.firstDelay[1]));
      this.lastBeatWasAlternate = false;
      this.beatsFired = 0;
    } else {
      this.nextBeatAt = Infinity;
    }

    this.nextGlanceAt = profile.groupGlances ? s.time + this.nextGlanceInterval(s.rng) : Infinity;
  }

  // MARK: Schedules (random draws only at events)

  private runRecurring(s: FaceState): void {
    const r = this._profile.recurring;
    if (!r || !(s.time >= this.nextBeatAt)) return;
    // Don't stomp on a one-shot that's already playing; retry shortly (deterministic, no roll).
    // A catch-yourself (life cycle) playing out counts as busy too: never nod off in the middle of it.
    const a = s.activeOneShots;
    if (a.includes(r.kind) || (r.alternate !== undefined && a.includes(r.alternate))
      || a.includes('catchSelf') || a.includes('sleepySink')) {
      this.nextBeatAt = s.time + 1.5;
      return;
    }
    let kind = r.kind;
    const isFirst = this.beatsFired === 0;
    if (r.alternate !== undefined && !isFirst && !this.lastBeatWasAlternate && s.rng.chance(r.alternateChance)) {
      kind = r.alternate;
      this.lastBeatWasAlternate = true;
    } else {
      this.lastBeatWasAlternate = false;
    }
    s.oneShotRequests.push(kind);
    this.beatsFired += 1;
    this.nextBeatAt = s.time + f32(s.rng.lognormal(r.median, r.sigma, r.clamp));
  }

  private nextGlanceInterval(rng: SplitMix64): number {
    return f32(rng.lognormal(AgentStateBehavior.glanceMedian, AgentStateBehavior.glanceSigma, AgentStateBehavior.glanceClamp));
  }

  private runGroupGlances(s: FaceState): void {
    if (!this._profile.groupGlances || !(s.time >= this.nextGlanceAt)) return;
    try {
      if (!(s.people.length > 1)) return;
      // Pick one of the people who isn't the primary listener.
      let others = 0;
      for (const p of s.people) if (p.id !== s.primaryPersonID) others += 1;
      if (!(others > 0)) return;
      let pick = Math.min(Math.trunc(s.rng.unit() * others), others - 1);
      for (const p of s.people) {
        if (p.id === s.primaryPersonID) continue;
        if (pick === 0) {
          const g = AgentStateBehavior.glanceDuration;
          s.commands.push(FaceCommand.glance(p.position, f32(s.rng.uniform(g[0], g[1]))));
          break;
        }
        pick -= 1;
      }
    } finally {
      this.nextGlanceAt = s.time + this.nextGlanceInterval(s.rng);
    }
  }

  // MARK: Continuous extras

  private applyContinuous(s: FaceState): void {
    const B = AgentStateBehavior;
    let lidTarget = B.heldLidClose(s.agentState);
    const sinceStir = s.time - s.lidStirAt;
    if (lidTarget > 0 && sinceStir >= 0 && sinceStir < B.lidStirDuration) {
      lidTarget = Math.max(lidTarget - B.lidStirDepth, 0);
    }
    if (s.frame <= 1) this.heldLidClose = new Spring1(lidTarget);
    const sinking = s.agentState === 'asleep' && s.activeOneShots.includes('sleepySink');
    const lidSpring = lidTarget > this.heldLidClose.value ? (sinking ? B.lidCloseSinkSpring : B.lidCloseFallSpring)
      : (s.time - s.fastWakeAt < B.fastWakeWindow ? B.lidCloseFastOpenSpring : B.lidCloseOpenSpring);
    this.heldLidClose.step(lidTarget, lidSpring, s.dt);
    s.lidClose = Math.max(s.lidClose, Math.min(Math.max(this.heldLidClose.value, 0), 1));

    // Brow presence: from the state's target, never from the stir-adjusted closure.
    const pTarget = B.browPresence(s.agentState);
    if (s.frame <= 1) this.browPresence = new Spring1(pTarget);
    const pSpring = pTarget < this.browPresence.value ? B.lidCloseFallSpring
      : (s.time - s.fastWakeAt < B.fastWakeWindow ? B.lidCloseFastOpenSpring : B.lidCloseOpenSpring);
    this.browPresence.step(pTarget, pSpring, s.dt);
    let presence = Math.min(Math.max(this.browPresence.value, 0), 1);
    if (s.agentState === 'waking' || s.agentState === 'halfAwake') {
      presence = Math.min(presence, 1 - Math.min(Math.max(s.composedLidClose, 0), 1));
    }
    s.browPresence = Number.isFinite(presence) ? presence : 1;

    this.tilt.step(this._profile.headTilt, B.tiltSpring, s.dt * Math.max(s.modulation.speed, 0.2));
    s.delta.raw[ANGLE] += this.tilt.value;

    this.pulseGain.step(this._profile.speechPulse, B.pulseSpring, s.dt);
    if (this.pulseGain.value > 1e-5) {
      // speechEnvelope is last frame's (affect runs after behaviour): one frame of lag is invisible.
      s.faceScaleMul = { x: s.faceScaleMul.x, y: s.faceScaleMul.y * (1 + this.pulseGain.value * s.speechEnvelope) };
    }
  }

  // MARK: Auto-transitions (fire on one-shot completion)

  private runAutoTransition(s: FaceState): void {
    const at = this._profile.autoTransition;
    if (!at) return;
    if (this.awaitedCompletedAt === null) {
      if (s.completedOneShots.includes(at.after)) {
        this.awaitedCompletedAt = s.time;
      } else if (s.activeOneShots.includes(at.after)) {
        this.awaitingSeenActive = true;
      } else if (this.awaitingSeenActive) {
        // Was playing, no longer is: completed (covers samplers that clear `completedOneShots` first).
        this.awaitedCompletedAt = s.time;
      }
    }
    if (!this.autoTransitionsEnabled) return;
    let fire = false;
    if (this.awaitedCompletedAt !== null && s.time - this.awaitedCompletedAt >= at.delay - 1e-9) fire = true;
    if (this.autoTransitionFallback !== null && s.time - this.enteredAt >= this.autoTransitionFallback) fire = true;
    if (!fire) return;

    s.previousAgentState = s.agentState;
    s.agentState = at.to;
    s.agentStateEnteredAt = s.time;
    s.agentStateChanged = true;
    this.enter(at.to, s);
  }
}
