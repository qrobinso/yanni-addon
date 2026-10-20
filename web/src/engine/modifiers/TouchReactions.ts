// Port of FaceEngine/Modifiers/TouchReactions.swift.
import { roundSwift, type V2 } from '../../core/vec';
import { ExpressionMix, ParamLayout, Units, mixEntry } from '../../model';
import type { AgentState } from '../AgentState';
import { FaceCommand, OneShotKind } from '../Commands';
import { Ease } from '../Easing';
import type { FaceState, GazeIntent } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { Noise1D } from '../Noise';
import { OneShotLibrary, OneShotRequest } from '../OneShots';
import { Spring1, SpringParams } from '../Spring';

type Category = 'sleepy' | 'waking' | 'flinchOnly' | 'conversation' | 'awake';

const CENTER_X = ParamLayout.index('centerX'), CENTER_Y = ParamLayout.index('centerY'), ANGLE = ParamLayout.index('angle');
const L_CENTER_Y = ParamLayout.index('left', 'centerY'), R_CENTER_Y = ParamLayout.index('right', 'centerY');
const clampP = (raw: V2): V2 => ({
  x: Number.isFinite(raw.x) ? Math.min(Math.max(raw.x, -1), 1) : 0,
  y: Number.isFinite(raw.y) ? Math.min(Math.max(raw.y, -1), 1) : 0,
});

/// Behaviour phase: what Yanni does when someone taps the screen (`FaceCommand.tap(at:)`).
///
/// **Sleepy** (asleep, drowsy, halfAwake): `tapsToWake` taps within `tapWakeWindow` wake Yanni; taps short of the
/// count stir (a lid flutter, then half-awake). Startled (`startleChance`) → `.bigSurprise`, straight to `.noticing`,
/// a fast eye opening (`s.fastWakeAt`) and a glance toward the tap. Gentle → `.waking`.
///
/// **Awake**: every tap is a quick flinch (a blink plus a springy face-scale dip with a small push away from the
/// finger) and a glance. An annoyance accumulator A (+1 per tap, τ = 4 s) escalates: friendly < 1.5 ≤ "hey…" < 3 ≤
/// "hmph" < 4.5 ≤ sulk (lookAway, gaze held away ≈ 3 s, then a forgiving sideEye and A = 2). Never the same reaction
/// twice in a row; cooldowns respected; a reaction still playing is not cut unless the tier escalated.
///
/// **Overlay**: a Skepticism → MockAnnoyed mix (`s.reactionOverlay`, changed only at taps) with weight
/// smoothstep(A: 1.5 → 4.5), spring-smoothed; full during a sulk.
///
/// **High-five**: inside the friendly-touch window an awake, non-sulking tap keeps the flinch, adds no annoyance and
/// plays a big `delightedSquint`, closing the window. **Thinking / speaking**: flinch + glance, A accumulates (overlay
/// at half weight). **notForMe / sheepish / interrupted / waking**: flinch only.
///
/// **Tickle** (`FaceCommand.scratch`): a squirm envelope L drives a wiggle, giggly hops, eye bobs, a squirm away from
/// the finger, a happy squint, lifted brows and a little pupil dilation; giggle bursts (`laugh`) ride on it. Fatigue
/// wears it down on long scratches. Randomness only at taps and bursts (`s.rng`).
export class TouchReactions implements Modifier {
  readonly name = 'TouchReactions';
  readonly phase = Phase.behaviour;
  isEnabled = true;

  /// When false, taps don't wake a sleepy Yanni (they just stir: a tiny flinch).
  tapWakesEnabled = true;
  /// Taps within `tapWakeWindow` needed to wake a sleepy Yanni (≥ 1).
  tapsToWake = 1;
  static readonly tapWakeWindow = 4;

  /// Probability that a tap startles rather than gently wakes, per sleepy state (null: not sleepy).
  static startleChance(state: AgentState): number | null {
    switch (state) {
      case 'asleep': return 0.6;
      case 'drowsy': return 0.35;
      case 'halfAwake': return 0.2;
      default: return null;
    }
  }
  static readonly annoyanceTau = 4;
  static readonly heyThreshold = 1.5;
  static readonly hmphThreshold = 3;
  static readonly sulkThreshold = 4.5;
  static readonly maxAnnoyance = 6;
  static readonly sulkDuration: readonly [number, number] = [2.7, 3.4];
  static readonly forgivenAnnoyance = 2;
  static readonly glanceDuration: readonly [number, number] = [0.6, 0.9];
  static readonly startleGlanceDuration = 1.1;
  static readonly recoilSpring = new SpringParams(20, 0.5);
  static readonly recoilDip = 0.04;
  static readonly recoilPush = 1.2;
  static readonly tinyFlinch = 0.35;
  static readonly overlaySpring = new SpringParams(12, 1);
  static readonly overlayIntensity = 0.8;
  static readonly conversationOverlayScale = 0.5;
  /// Peak displacement of the ζ = 0.5 spring per unit initial velocity is ≈ 0.546 / ω.
  static readonly recoilKick = -TouchReactions.recoilDip * TouchReactions.recoilSpring.omega / 0.546;
  static readonly highFiveIntensity = 1.2;

  static readonly tickleHold = 0.45;
  static readonly tickleAttack = new SpringParams(14, 1);
  static readonly tickleRelease = new SpringParams(4.5, 1);
  static readonly giggleInterval = 2.0;
  static readonly giggleJitter: readonly [number, number] = [0, 0.6];
  static readonly giggleMinGap = 1.4;
  static readonly fatigueStart = 4;
  static readonly fatigueSpan = 6;
  static readonly fatigueFloor = 0.45;
  static readonly fatigueRecovery = 2.5;
  static readonly wiggleHz = 4.2;
  static readonly wiggleX = 2.4;
  static readonly wiggleAngle = 6;
  static readonly hopHz = 3.3;
  static readonly hopY = 1.4;
  static readonly eyeBob = 0.7;
  static readonly squirmAway = 1.2;
  static readonly squintLower = 0.18;
  static readonly squintUpper = 0.03;
  static readonly browLift = 0.08;
  static readonly browArch = 0.16;
  static readonly tickleDilation = 0.08;
  static readonly reducedTempo = 0.6;
  static readonly bedtimeTickleScale = 0.6;
  static readonly conversationTickleScale = 0.5;

  static readonly friendly: readonly OneShotKind[] = ['perkUp', 'delightedSquint', 'curiousTilt'];
  static readonly hey: readonly OneShotKind[] = ['doubleTake', 'sideEye'];
  static readonly hmph: readonly OneShotKind[] = ['mockOffense'];
  static readonly hmphFallback: readonly OneShotKind[] = ['sideEye', 'doubleTake'];

  // MARK: Read-outs

  annoyance = 0;
  lastReaction: OneShotKind | null = null;
  highFiveCount = 0;
  lastHighFiveAt = -Infinity;
  tapCount = 0;
  tapWakeCount = 0;
  get pendingWakeTaps(): number { return this.sleepyTapCount; }
  get isSulking(): boolean { return this.sulkUntil !== null; }
  get overlayWeight(): number { return Math.min(Math.max(this.overlayW.value, 0), 1); }
  get tickleLevel(): number { return Math.min(Math.max(this.tickle.value, 0), 1); }
  giggleCount = 0;
  strokeCount = 0;
  /// Tests / preview: force (true/false) or leave random (null) the startle decision.
  forceStartle: boolean | null = null;

  // MARK: Private state

  private lastTier = -1;
  private lastStarted: OneShotKind | null = null;
  private lastRequestAt: number[] = new Array<number>(OneShotKind.count).fill(-Infinity);
  private recoil = new Spring1(0);
  private recoilDir: V2 = { x: 0, y: 0 };
  private overlayW = new Spring1(0);
  private sulkUntil: number | null = null;
  private sulkState: AgentState = 'idle';
  private sulkSavedGaze: GazeIntent | null = null;
  private sleepyTapCount = 0;
  private sleepyWindowStart = -Infinity;
  private tickle = new Spring1(0);
  private lastStrokeAt = -Infinity;
  private strokePoint: V2 = { x: 0, y: 0 };
  private strokeIntensity = 0;
  private scratchRunStart = -Infinity;
  private nextGiggleAt = Infinity;
  private lastGiggleAt = -Infinity;
  private tickleClock = 0;
  private wigglePhase = 0;
  private hopPhase = 0;
  private readonly tickleNoise = new Noise1D(0x71c31e);

  private static category(s: AgentState): Category {
    switch (s) {
      case 'asleep': case 'drowsy': case 'halfAwake': return 'sleepy';
      case 'waking': return 'waking';
      case 'notForMe': case 'sheepish': case 'interrupted': return 'flinchOnly';
      case 'thinking': case 'speaking': return 'conversation';
      default: return 'awake';
    }
  }

  update(s: FaceState): void {
    const dt = Math.max(Number.isFinite(s.dt) ? s.dt : 0, 0);

    // Sulk bookkeeping (A is held while sulking), else decay.
    const until = this.sulkUntil;
    if (until !== null) {
      if (s.agentState !== this.sulkState) this.endSulk(s, false);
      else if (s.time >= until) this.endSulk(s, true);
    } else if (this.annoyance > 0) {
      this.annoyance *= Math.exp(-dt / TouchReactions.annoyanceTau);
      if (this.annoyance < 1e-4) this.annoyance = 0;
    }

    // Whatever started last (anyone's one-shot) also counts as "the previous reaction".
    for (const st of s.startedOneShots) this.lastStarted = st.kind;

    // Springs advance over this frame interval with the pre-tap targets; a tap acts at the frame's end.
    this.stepSprings(s, dt);

    // Taps and strokes (only the commands queued before this modifier; ones we append aren't revisited).
    const n = s.commands.length;
    for (let i = 0; i < n; i++) {
      const c = s.commands[i];
      if (c.kind === 'tap') this.handleTap(c.at, s);
      else if (c.kind === 'scratch') this.handleStroke(c.at, c.intensity, s);
    }

    this.scheduleGiggles(s);
    s.tickleLaugh = this.tickleLaughDrive(s);
    this.writeRecoil(s);
    this.writeTickle(s, dt);
    s.reactionOverlayWeight = this.overlayWeight;
    s.isSulking = this.isSulking;
    s.tapAnnoyance = this.annoyance;
  }

  // MARK: Taps

  private handleTap(raw: V2, s: FaceState): void {
    const p = clampP(raw);
    this.tapCount += 1;
    switch (TouchReactions.category(s.agentState)) {
      case 'sleepy':
        if (!this.tapWakesEnabled) { this.flinch(p, TouchReactions.tinyFlinch, false, false, s); return; }
        if (s.time - this.sleepyWindowStart > TouchReactions.tapWakeWindow) {
          this.sleepyWindowStart = s.time;
          this.sleepyTapCount = 0;
        }
        this.sleepyTapCount += 1;
        if (this.sleepyTapCount >= Math.max(this.tapsToWake, 1)) {
          this.sleepyTapCount = 0;
          this.sleepyWindowStart = -Infinity;
          this.tapWakeCount += 1;
          this.wake(p, s);
        } else {
          this.stir(p, this.sleepyTapCount, s);
        }
        break;
      case 'waking':
        this.flinch(p, TouchReactions.tinyFlinch, false, false, s);
        break;
      case 'flinchOnly':
        this.flinch(p, 1, true, false, s);
        break;
      case 'conversation':
        if (this.takeFriendlyTouch(s)) { this.flinch(p, 1, true, true, s); return; }
        this.addAnnoyance();
        this.updateOverlayMix(s);
        this.flinch(p, 1, true, true, s);
        break;
      case 'awake':
        if (this.isSulking) { this.flinch(p, TouchReactions.tinyFlinch, false, false, s); return; }
        if (this.takeFriendlyTouch(s)) { this.highFive(p, s); return; }
        this.addAnnoyance();
        this.flinch(p, 1, true, true, s);
        this.react(s);
        break;
    }
  }

  /// True when the friendly-touch window is open; closes it (one tap per window).
  private takeFriendlyTouch(s: FaceState): boolean {
    if (!(s.time <= s.friendlyTouchUntil)) return false;
    s.friendlyTouchUntil = -Infinity;
    return true;
  }

  /// The high-five: the flinch stays, then a big delighted squint instead of a poke reaction. No annoyance.
  private highFive(p: V2, s: FaceState): void {
    this.flinch(p, 1, true, true, s);
    s.oneShotPlayRequests.push(OneShotRequest.make('delightedSquint', { intensity: TouchReactions.highFiveIntensity }));
    this.lastRequestAt[OneShotKind.ordinal('delightedSquint')] = s.time;
    this.lastReaction = 'delightedSquint';
    this.lastTier = 0;
    this.highFiveCount += 1;
    this.lastHighFiveAt = s.time;
  }

  /// A tap short of the wake count: the first flutters the lids, later ones half-wake an asleep Yanni.
  private stir(p: V2, level: number, s: FaceState): void {
    this.flinch(p, TouchReactions.tinyFlinch, false, false, s);
    if (level >= 2 && s.agentState === 'asleep') this.setAgentState('halfAwake', s);
    else s.lidStirAt = s.time;
  }

  private addAnnoyance(): void { this.annoyance = Math.min(this.annoyance + 1, TouchReactions.maxAnnoyance); }

  private wake(p: V2, s: FaceState): void {
    const chance = TouchReactions.startleChance(s.agentState) ?? 0;
    const startled = this.forceStartle ?? s.rng.chance(chance);
    this.addAnnoyance();
    if (startled) {
      this.request('bigSurprise', s);
      this.lastReaction = 'bigSurprise';
      this.lastTier = -1;
      s.fastWakeAt = s.time;
      this.setAgentState('noticing', s);
      s.commands.push(FaceCommand.glance(p, TouchReactions.startleGlanceDuration));
    } else {
      this.setAgentState('waking', s);
    }
  }

  /// Same write pattern as AgentStateBehavior's auto-transitions.
  private setAgentState(to: AgentState, s: FaceState): void {
    if (s.agentState === to) return;
    s.previousAgentState = s.agentState;
    s.agentState = to;
    s.agentStateEnteredAt = s.time;
    s.agentStateChanged = true;
  }

  private flinch(p: V2, size: number, blink: boolean, glance: boolean, s: FaceState): void {
    const len = Math.sqrt(p.x * p.x + p.y * p.y);
    this.recoilDir = len > 1 ? { x: p.x / len, y: p.y / len } : { ...p };
    this.recoil.velocity = TouchReactions.recoilKick * size;
    if (blink && !this.closureBusy(s)) s.commands.push(FaceCommand.blink);
    if (glance) {
      const g = TouchReactions.glanceDuration;
      s.commands.push(FaceCommand.glance(p, s.rng.uniform(g[0], g[1])));
    }
  }

  /// A one-shot that owns the closure channel would defer a commanded blink until it ends (late blink): skip it.
  private closureBusy(s: FaceState): boolean {
    return s.activeOneShots.some((k) => OneShotLibrary.spec(k).ownsClosure);
  }

  // MARK: Tickle

  /// How much tickle the state allows (0: strokes ignored) and whether giggle bursts may play.
  private tickleScale(s: FaceState): { scale: number; bursts: boolean } {
    if (this.isSulking) return { scale: 0, bursts: false };
    const night = s.isBedtime ? TouchReactions.bedtimeTickleScale : 1;
    switch (TouchReactions.category(s.agentState)) {
      case 'awake':
        return s.agentState === 'listening'
          ? { scale: TouchReactions.conversationTickleScale * night, bursts: false } : { scale: night, bursts: true };
      case 'conversation': return { scale: TouchReactions.conversationTickleScale * night, bursts: false };
      default: return { scale: 0, bursts: false };
    }
  }

  private handleStroke(raw: V2, intensity: number, s: FaceState): void {
    const p = clampP(raw);
    const newRun = s.time - this.lastStrokeAt > TouchReactions.tickleHold;
    this.strokeCount += 1;
    this.lastStrokeAt = s.time;
    this.strokePoint = p;
    this.strokeIntensity = Number.isFinite(intensity) ? Math.min(Math.max(intensity, 0), 1) : 0.5;
    if (TouchReactions.category(s.agentState) === 'sleepy') {
      // One tap per stroke run: the tap-to-wake rules decide.
      if (newRun) this.handleTap(p, s);
      return;
    }
    if (!(this.tickleScale(s).scale > 0)) return;
    if (this.scratchRunStart === -Infinity) this.scratchRunStart = s.time;
    if (newRun) this.nextGiggleAt = Math.max(s.time, this.lastGiggleAt + TouchReactions.giggleMinGap);
  }

  /// 1 for a fresh scratch, down to `fatigueFloor` after a long continuous one.
  private fatigue(s: FaceState): number {
    if (!Number.isFinite(this.scratchRunStart)) return 1;
    const worn = Ease.smoothstep((s.time - this.scratchRunStart - TouchReactions.fatigueStart) / TouchReactions.fatigueSpan);
    return 1 - (1 - TouchReactions.fatigueFloor) * worn;
  }

  private scheduleGiggles(s: FaceState): void {
    if (!(s.time - this.lastStrokeAt <= TouchReactions.tickleHold)) {
      // Strokes stopped: no more bursts; a long enough rest makes the next scratch fresh.
      this.nextGiggleAt = Infinity;
      if (s.time - this.lastStrokeAt > TouchReactions.fatigueRecovery) this.scratchRunStart = -Infinity;
      return;
    }
    const { scale, bursts } = this.tickleScale(s);
    if (!(bursts && scale > 0 && s.time >= this.nextGiggleAt)) return;
    const f = this.fatigue(s);
    const j = TouchReactions.giggleJitter;
    this.nextGiggleAt = s.time + (TouchReactions.giggleInterval + s.rng.uniform(j[0], j[1])) / f;
    if (s.activeOneShots.includes('laugh') || !(s.time - this.lastGiggleAt >= TouchReactions.giggleMinGap)) return;
    const size = (0.7 + 0.4 * this.strokeIntensity) * f * scale;
    s.oneShotPlayRequests.push(OneShotRequest.make('laugh', { intensity: size, reduceMotion: s.reduceMotion }));
    this.lastGiggleAt = s.time;
    this.lastRequestAt[OneShotKind.ordinal('laugh')] = s.time;
    this.giggleCount += 1;
  }

  /// The laugh fit's drive (`FaceState.tickleLaugh`).
  private tickleLaughDrive(s: FaceState): number {
    if (!(s.time - this.lastStrokeAt <= TouchReactions.tickleHold)) return 0;
    const { scale, bursts } = this.tickleScale(s);
    return bursts ? this.strokeIntensity * this.fatigue(s) * scale : 0;
  }

  /// The squirm: the envelope steps toward the stroke intensity (while strokes come) or 0, then writes wiggle, hops,
  /// squirm-away, squint, brows and pupils in proportion. Nothing when L is 0.
  private writeTickle(s: FaceState, dt: number): void {
    const T = TouchReactions;
    const scale = this.tickleScale(s).scale;
    const going = s.time - this.lastStrokeAt <= T.tickleHold && scale > 0;
    const target = going ? this.strokeIntensity * this.fatigue(s) * scale : 0;
    if (this.tickle.value !== target || this.tickle.velocity !== 0) {
      this.tickle.step(target, target > this.tickle.value ? T.tickleAttack : T.tickleRelease, dt);
      if (!Number.isFinite(this.tickle.value) || !Number.isFinite(this.tickle.velocity)) this.tickle = new Spring1(target);
      if (Math.abs(this.tickle.value - target) < 1e-4 && Math.abs(this.tickle.velocity) < 1e-3) this.tickle = new Spring1(target);
    }
    const l = Math.min(Math.max(this.tickle.value, 0), 1);
    if (!(l > 0)) { this.wigglePhase = 0; this.hopPhase = 0; return; }
    // Tempo wobbles on slow noise (and quickens a little with intensity) so the squirm never loops.
    const tempo = (s.reduceMotion ? T.reducedTempo : 1) * (0.85 + 0.3 * this.strokeIntensity);
    this.tickleClock = (this.tickleClock + dt) % 1000;
    const wob = this.tickleNoise.value(this.tickleClock * 0.9);
    const twoPi = 2 * Math.PI;
    this.wigglePhase = (this.wigglePhase + twoPi * T.wiggleHz * tempo * (1 + 0.18 * wob) * dt) % twoPi;
    this.hopPhase = (this.hopPhase + twoPi * T.hopHz * tempo * (1 - 0.12 * wob) * dt) % twoPi;
    const m = s.motionScale * l;
    const sway = Math.sin(this.wigglePhase) * (0.8 + 0.2 * this.tickleNoise.value(this.tickleClock * 1.7 + 9));
    // Hops: a quick lift and a softer landing (|sin|^1.5), squashing a touch at the bottom.
    const hs = Math.abs(Math.sin(this.hopPhase));
    const hop = hs * Math.sqrt(hs);
    // Squirm away from the finger (mostly sideways).
    const away = -this.strokePoint.x * T.squirmAway;
    const d = s.delta.raw;
    d[CENTER_X] += Units.poseX((T.wiggleX * sway + away) * m);
    d[CENTER_Y] += Units.poseY(-T.hopY * hop * m);
    d[ANGLE] += T.wiggleAngle * Math.sin(this.wigglePhase - 0.6) * m;
    d[L_CENTER_Y] += Units.poseY(-T.eyeBob * Math.sin(this.wigglePhase) * m);
    d[R_CENTER_Y] += Units.poseY(T.eyeBob * Math.sin(this.wigglePhase) * m);
    const squash = 0.035 * (1 - hop) * m;
    s.faceScaleMul.y *= 1 - squash;
    s.faceScaleMul.x *= 1 + 0.6 * squash;
    const lower = (T.squintLower + 0.03 * Math.sin(this.wigglePhase * 2)) * l, upper = T.squintUpper * l;
    const lc = s.lidCoverage;
    lc.x += upper; lc.y += lower; lc.z += upper; lc.w += lower;
    const bi = Number.isFinite(s.browIntensity) ? Math.min(Math.max(s.browIntensity, 0), 2) : 1;
    s.browDelta.addBoth('y', (T.browLift + 0.02 * hop) * l * bi);
    s.browDelta.addBoth('curvature', T.browArch * l * bi);
    const dil = 1 + T.tickleDilation * l;
    s.pupilSizeMul.x *= dil; s.pupilSizeMul.y *= dil;
  }

  // MARK: Escalation

  private react(s: FaceState): void {
    const a = this.annoyance;
    if (a >= TouchReactions.sulkThreshold) { this.startSulk(s); return; }
    const tier = a < TouchReactions.heyThreshold ? 0 : (a < TouchReactions.hmphThreshold ? 1 : 2);
    this.updateOverlayMix(s);

    // Let the current reaction play out unless we've escalated.
    const last = this.lastReaction;
    if (last !== null && s.activeOneShots.includes(last) && tier <= this.lastTier) return;

    const primary = tier === 0 ? TouchReactions.friendly : (tier === 1 ? TouchReactions.hey : TouchReactions.hmph);
    let kind = this.pick(primary, s);
    if (kind === null && tier === 2) kind = this.pick(TouchReactions.hmphFallback, s);
    if (kind === null) return;
    this.request(kind, s);
    this.lastReaction = kind;
    this.lastTier = tier;
  }

  /// Uniform choice among candidates that aren't the previous reaction, aren't playing and are off cooldown.
  private pick(candidates: readonly OneShotKind[], s: FaceState): OneShotKind | null {
    let count = 0;
    for (const k of candidates) if (this.allowed(k, s)) count += 1;
    if (count === 0) return null;
    let index = Math.min(Math.trunc(s.rng.unit() * count), count - 1);
    for (const k of candidates) {
      if (!this.allowed(k, s)) continue;
      if (index === 0) return k;
      index -= 1;
    }
    return null;
  }

  private allowed(k: OneShotKind, s: FaceState): boolean {
    return k !== this.lastReaction && k !== this.lastStarted && !s.activeOneShots.includes(k)
      && s.time - this.lastRequestAt[OneShotKind.ordinal(k)] >= OneShotLibrary.spec(k).cooldown;
  }

  private request(k: OneShotKind, s: FaceState): void {
    s.oneShotRequests.push(k);
    this.lastRequestAt[OneShotKind.ordinal(k)] = s.time;
  }

  // MARK: Sulk

  private startSulk(s: FaceState): void {
    const sd = TouchReactions.sulkDuration;
    this.sulkUntil = s.time + s.rng.uniform(sd[0], sd[1]);
    this.sulkState = s.agentState;
    this.sulkSavedGaze = s.gazeIntent;
    s.gazeIntent = { kind: 'lookAway' };
    s.reactionOverlay = ExpressionMix.single('MockAnnoyed', TouchReactions.overlayIntensity);
    if (this.lastReaction !== 'lookAway'
      && s.time - this.lastRequestAt[OneShotKind.ordinal('lookAway')] >= OneShotLibrary.spec('lookAway').cooldown) {
      this.request('lookAway', s);
    }
    this.lastReaction = 'lookAway';
    this.lastTier = 3;
  }

  private endSulk(s: FaceState, forgive: boolean): void {
    this.sulkUntil = null;
    this.annoyance = Math.min(this.annoyance, TouchReactions.forgivenAnnoyance);
    const g = this.sulkSavedGaze;
    if (s.agentState === this.sulkState && s.gazeIntent.kind === 'lookAway' && g !== null) s.gazeIntent = g;
    this.sulkSavedGaze = null;
    this.updateOverlayMix(s);
    if (!forgive) return;
    if (this.allowed('sideEye', s)) this.request('sideEye', s);
    this.lastReaction = 'sideEye';
    this.lastTier = 1;
  }

  // MARK: Continuous output

  private stepSprings(s: FaceState, dt: number): void {
    const r = this.recoil;
    if (r.value !== 0 || r.velocity !== 0) {
      r.step(0, TouchReactions.recoilSpring, dt);
      if ((Math.abs(r.value) < 1e-5 && Math.abs(r.velocity) < 1e-4) || !Number.isFinite(r.value) || !Number.isFinite(r.velocity)) {
        this.recoil = new Spring1(0);
      }
    }
    const target = this.overlayTarget(s);
    const o = this.overlayW;
    if (o.value !== target || o.velocity !== 0) {
      o.step(target, TouchReactions.overlaySpring, dt);
      if (!Number.isFinite(o.value) || !Number.isFinite(o.velocity)) this.overlayW = new Spring1(target);
      if (Math.abs(this.overlayW.value - target) < 1e-5 && Math.abs(this.overlayW.velocity) < 1e-4) this.overlayW = new Spring1(target);
    }
  }

  private writeRecoil(s: FaceState): void {
    if (this.recoil.value === 0) return;
    const dip = TouchReactions.recoilDip;
    const r = Math.min(Math.max(this.recoil.value, -3 * dip), 3 * dip);
    s.faceScaleMul.y *= 1 + r;
    s.faceScaleMul.x *= 1 + 0.6 * r;
    // r < 0 at the dip: push away from the finger in proportion.
    const push = (r / dip) * TouchReactions.recoilPush;
    s.delta.raw[CENTER_X] += Units.poseX(push * this.recoilDir.x);
    s.delta.raw[CENTER_Y] += Units.poseY(push * this.recoilDir.y);
  }

  private overlayTarget(s: FaceState): number {
    if (this.isSulking) return 1;
    const T = TouchReactions;
    const w = Ease.smoothstep((this.annoyance - T.heyThreshold) / (T.sulkThreshold - T.heyThreshold));
    switch (TouchReactions.category(s.agentState)) {
      case 'awake': case 'flinchOnly': return w;
      case 'conversation': return w * T.conversationOverlayScale;
      default: return 0;
    }
  }

  /// Skepticism → MockAnnoyed as A rises, quantised to quarters so the mix (and its caches) change rarely.
  private updateOverlayMix(s: FaceState): void {
    const f = Math.min(Math.max((this.annoyance - 2) / 2.5, 0), 1);
    const q = roundSwift(f * 4) / 4;
    const I = TouchReactions.overlayIntensity;
    const mix = q <= 0 ? ExpressionMix.single('Skepticism', I)
      : q >= 1 ? ExpressionMix.single('MockAnnoyed', I)
        : new ExpressionMix([mixEntry('Skepticism', 1 - q), mixEntry('MockAnnoyed', q)], I);
    if (s.reactionOverlay === null || !s.reactionOverlay.equals(mix)) s.reactionOverlay = mix;
  }
}
