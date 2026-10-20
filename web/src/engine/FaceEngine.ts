// Port of FaceEngine/FaceEngine.swift.
import type { V2, V3 } from '../core/vec';
import { ExpressionLibrary, FaceFrame, type EdgeGeometry, type ExpressionMix, type FaceFrameSource } from '../model';
import type { AgentState, Mood } from './AgentState';
import { FaceCommand, type OneShotKind, type PersonTarget } from './Commands';
import type { EdgeAnticSettings } from './EdgeAnticSettings';
import type { EmotionAuthority } from './EmotionAuthority';
import type { ExpressiveGaze, ExpressivePlan } from './ExpressivePlan';
import { FaceState } from './FaceState';
import { Composer } from './Composer';
import type { IdleGameSettings } from './IdleGameSettings';
import type { ListeningGlowConfig } from './ListeningGlow';
import { Director, type Modifier } from './Modifier';
import type { MoodBackgroundConfig } from './MoodBackground';
import { OneShotKindSet, OneShotRequest, isIdleGame, isPupilShape, makeOneShotCancel } from './OneShots';
import type { PowerCare } from './PowerCare';
import { defaultHold } from './PupilShapeCurves';
import type { PupilReactionEvent, PupilReactionSettings } from './PupilReactionTypes';
import { defaultModifierOrder, makeModifiers } from './modifiers';
import { PupilReactions } from './modifiers/PupilReactions';

// Structural views of the modifiers the facade talks to (Swift `as? Type` casts). Absent modifiers read as nil.
interface MoodColorView { background: { burst: { activeKind: OneShotKind | null; level: number } } }
interface PupilReactionsView {
  markSomber(s: FaceState): void;
  eventSerial: number;
  events: PupilReactionEvent[];
}
interface EdgeAnticsView {
  rollSleepySink(s: FaceState): boolean;
  canPlayPerceptionAntic(kind: OneShotKind, s: FaceState): boolean;
  playPerceptionAntic(kind: OneShotKind, side: number, s: FaceState): boolean;
}
interface ExpressiveOverlayView { start(p: ExpressivePlan, at: number): void; cancel(): void }
interface TouchReactionsView { highFiveCount: number }

const clampUnit = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
const sideSign = (side: number): number => (Number.isFinite(side) ? (side > 0 ? 1 : side < 0 ? -1 : 0) : 0);

/// Public facade: owns the state, the director, and the clock. Drive it from the display link.
export class FaceEngine implements FaceFrameSource {
  private _state: FaceState;
  readonly director: Director;
  /// Slow-motion factor for the preview tool (0.05...1). Applied to dt before clamping.
  timeScale = 1;
  private lastPresentationTime: number | null = null;

  static readonly maxDt = 0.05;
  /// Longest friendly-touch window accepted (seconds).
  static readonly maxFriendlyTouchWindow = 5;

  constructor(o: { library?: ExpressionLibrary; seed?: bigint | number; modifiers?: Modifier[] } = {}) {
    this._state = new FaceState(o.library ?? ExpressionLibrary.bundled(), o.seed ?? 0x59414e4e49);
    this.director = new Director(o.modifiers ?? FaceEngine.makeDefaultModifiers());
  }

  /// The engine's state. The live object (Swift hands out a copy): read it, don't keep or mutate it.
  get state(): FaceState { return this._state; }

  /// The standard modifier stack, in registration order within each phase. Only the modifiers ported so far
  /// (see `modifiers/index.ts`).
  static makeDefaultModifiers(): Modifier[] { return makeModifiers(defaultModifierOrder); }

  private view<T>(name: string): T | undefined { return this.director.modifier(name) as unknown as T | undefined; }

  // MARK: Inputs

  setAgentState(s: AgentState): void {
    const st = this._state;
    if (s === st.agentState) return;
    st.previousAgentState = st.agentState;
    st.agentState = s;
    st.agentStateEnteredAt = st.time;
    st.agentStateChanged = true;
  }

  setExpressionOverride(mix: ExpressionMix | null): void { this._state.expressionOverride = mix && mix.copy(); }

  /// Sets the base mood; the effective `state.mood` is it plus the life-cycle mood offset.
  setMood(mood: Mood): void {
    this._state.baseMood = { ...mood };
    this.refreshEffectiveMood();
  }

  /// Additive (pleasure, arousal, dominance) mood offset (life-cycle controller). Non-finite components read as 0;
  /// each is clamped to ±1.
  setMoodOffset(offset: V3): void {
    const c = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0);
    this._state.moodOffset = { x: c(offset.x), y: c(offset.y), z: c(offset.z) };
    this.refreshEffectiveMood();
  }

  private refreshEffectiveMood(): void {
    const c = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0);
    const b = this._state.baseMood, o = this._state.moodOffset;
    this._state.mood = { pleasure: c(b.pleasure + o.x), arousal: c(b.arousal + o.y), dominance: c(b.dominance + o.z) };
  }

  /// Style elasticity (0.5…2, 1 = neutral): squash-and-stretch amount and springiness.
  setElasticity(e: number): void { this._state.elasticity = Math.min(Math.max(Number.isFinite(e) ? e : 1, 0.5), 2); }
  setSpeechLevel(level: number): void { this._state.speechLevel = Math.min(Math.max(level, 0), 1); }

  /// People in view, the one the eyes follow (`primary`) and the one actually engaging (`engaged`, which may be null
  /// while someone merely passes by). With `engaged` omitted the primary person also counts as engaged.
  setPeople(people: readonly PersonTarget[], primary: number | null, engaged: number | null = primary): void {
    const st = this._state;
    st.people.length = 0;
    for (const p of people) st.people.push({ ...p, position: { ...p.position } });
    st.primaryPersonID = primary;
    st.engagedPersonID = engaged;
  }

  send(command: FaceCommand): void { this._state.commands.push(command); }

  // MARK: Screen edges

  /// Where the screen edges are, seen from the face. Push it on every layout change and rotation; null (the default)
  /// turns the screen-edge antics off. An invalid geometry counts as null.
  setEdgeGeometry(geometry: EdgeGeometry | null): void {
    this._state.edgeGeometry = geometry !== null && geometry.isValid ? geometry.copy() : null;
  }

  /// Screen-edge antic tunables (validated on assignment). The getter returns a copy.
  get edgeAnticSettings(): EdgeAnticSettings { return this._state.edgeSettings.copy(); }
  set edgeAnticSettings(v: EdgeAnticSettings) { this._state.edgeSettings = v.validated(); }

  /// Brow animation intensity, 0…1.5 (non-finite reads as 1).
  get browIntensity(): number { return this._state.browIntensity; }
  set browIntensity(v: number) { this._state.browIntensity = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1.5) : 1; }

  // MARK: Emotion layer

  /// The emotion layer's expression: `mix` shown with `weight` (0…1) × the current state's `emotionAuthority`.
  /// Null or weight 0 leaves the state profile exactly as it is. Non-finite weights read as 0.
  setEmotionExpression(mix: ExpressionMix | null, weight: number): void {
    this._state.emotionMix = mix && mix.copy();
    this._state.emotionWeight = mix === null || !Number.isFinite(weight) ? 0 : Math.min(Math.max(weight, 0), 1);
  }

  /// Per-state authority of the emotion expression (validated on assignment). The getter returns a copy.
  get emotionAuthority(): EmotionAuthority { return this._state.emotionAuthority.copy(); }
  set emotionAuthority(v: EmotionAuthority) { this._state.emotionAuthority = v.validated(); }

  /// Bedtime on / off (the life-cycle controller).
  setBedtime(on: boolean): void { this._state.isBedtime = on; }

  // MARK: Mood background

  /// Mood background settings (validated on assignment). The getter returns a copy.
  get moodBackground(): MoodBackgroundConfig { return this._state.backgroundConfig.copy(); }
  set moodBackground(v: MoodBackgroundConfig) { this._state.backgroundConfig = v.validated(); }

  /// The resource governor's fade: true fades the background to black over ≈ 3 s; false brings it back.
  setBackgroundSuppressed(on: boolean): void { this._state.backgroundSuppressed = on; }

  /// Plays `kind`'s colour burst on the mood background now (at most 4 requests wait between frames).
  playBackgroundBurst(kind: OneShotKind): void {
    if (this._state.backgroundBurstRequests.length < 4) this._state.backgroundBurstRequests.push(kind);
  }

  /// The colour burst showing on the mood background (null when none) and its level 0…1.
  get backgroundBurst(): { kind: OneShotKind | null; level: number } {
    const bg = this.view<MoodColorView>('MoodColor')?.background.burst;
    return bg ? { kind: bg.activeKind, level: bg.level } : { kind: null, level: 0 };
  }

  // MARK: Listening glow

  /// The listening glow's target 0…1. Non-finite reads as 0.
  setListeningGlow(target: number): void { this._state.glowTarget = clampUnit(target); }
  /// The person's voice 0…1 while the mic is open; the glow swells with it.
  setListeningVoice(level: number): void { this._state.glowVoice = clampUnit(level); }
  /// The live microphone level 0…1, every frame while the person's turn is live, 0 otherwise.
  setListeningLevel(level: number): void { this._state.glowMic = clampUnit(level); }

  // MARK: Caption band

  /// The caption band: the share of the screen height kept clear at the bottom for the caption bubbles. Non-finite
  /// reads as 0; clamped to 0…`FaceFrame.maxCaptionInset`.
  setCaptionInset(fraction: number, reduceMotion = false): void {
    this._state.captionInsetTarget = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), FaceFrame.maxCaptionInset) : 0;
    this._state.captionInsetReduceMotion = reduceMotion;
  }

  /// Listening glow settings (validated on assignment). The getter returns a copy.
  get listeningGlow(): ListeningGlowConfig { return this._state.glowConfig.copy(); }
  set listeningGlow(v: ListeningGlowConfig) { this._state.glowConfig = v.validated(); }

  /// OLED / power care (validated on assignment). The getter returns a copy.
  get powerCare(): PowerCare { return this._state.powerCare.copy(); }
  set powerCare(v: PowerCare) { this._state.powerCare = v.validated(); }

  /// Starts the launch fade: call before the first frame.
  fadeInFromBlack(): void { this._state.fadingInFromBlack = true; }

  // MARK: Pupil transformations

  /// Pupil transformation tunables (validated on assignment). The getter returns a copy.
  get pupilReactionSettings(): PupilReactionSettings { return this._state.pupilSettings.copy(); }
  set pupilReactionSettings(v: PupilReactionSettings) { this._state.pupilSettings = v.validated(); }

  /// Plays a pupil transformation now, bypassing the arbiter (manual and preview triggers). `leadEye` (−1 left, +1
  /// right) picks the question mark's leading eye (undefined: random). A transformation already showing switches back
  /// first.
  playPupilShape(kind: OneShotKind, leadEye?: number): void {
    if (!isPupilShape(kind)) return;
    const st = this._state.pupilSettings;
    const hold = st.shape(kind)?.hold ?? defaultHold(kind);
    this._state.oneShotPlayRequests.push(OneShotRequest.make(kind, { hold, leadEye, intensity: 1, reduceMotion: st.reduceMotion }));
  }

  /// Switches any showing pupil transformation back to the default pupils.
  cancelPupilShape(): void { this._state.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.pupilShapes)); }

  /// Opens the pupil reactions' somber window (no playful transformations for `PupilReactions.somberWindow` seconds).
  markSomber(): void { this.view<PupilReactionsView>('PupilReactions')?.markSomber(this._state); }

  /// Whether falling asleep now should play the sleepy sink (rolls its chance; see `EdgeAntics.rollSleepySink`).
  rollSleepySink(): boolean {
    const m = this.view<EdgeAnticsView>('EdgeAntics');
    return m ? m.rollSleepySink(this._state) : false;
  }

  /// Plays an edge antic toward `side` (+1 right, −1 left, 0 random). Respects the kind's short cooldown; the
  /// screen-edge antics need `setEdgeGeometry`.
  playEdgeAntic(kind: OneShotKind, side = 0): void {
    this._state.edgeSideHint = sideSign(side);
    this.send(FaceCommand.playOneShot(kind));
  }

  /// Whether perception may play `kind` as a gesture beat now (`EdgeAntics.canPlayPerceptionAntic`).
  canPlayPerceptionEdgeAntic(kind: OneShotKind): boolean {
    const m = this.view<EdgeAnticsView>('EdgeAntics');
    return m ? m.canPlayPerceptionAntic(kind, this._state) : false;
  }

  /// Plays a screen-edge antic as a perception beat toward `side` when the antics' own gates allow it. Returns false,
  /// changing nothing, otherwise.
  playPerceptionEdgeAntic(kind: OneShotKind, side: number): boolean {
    const m = this.view<EdgeAnticsView>('EdgeAntics');
    return m ? m.playPerceptionAntic(kind, side, this._state) : false;
  }

  // MARK: Perception read-outs (cheap, allocation-free)

  /// True while a one-shot plays that a perception beat must not cut: anything except the idle personality beats, the
  /// pupil transformations and the idle games.
  get oneShotBusyForPerception(): boolean {
    // An idle game is Yanni's own play: a reaction to the person outranks it (it yields on the channel conflict).
    return this._state.activeOneShots.some((k) => !isPupilShape(k) && !isIdleGame(k) && !PupilReactions.idleBeatKinds.contains(k));
  }

  /// True while a pupil transformation is showing (including its switch back).
  get pupilShapeShowing(): boolean { return this._state.activeOneShots.some(isPupilShape); }

  /// The pupil reaction arbiter's recent events (oldest first) and the newest serial; (0, []) without the arbiter.
  get pupilReactionEvents(): { serial: number; events: PupilReactionEvent[] } {
    const m = this.view<PupilReactionsView>('PupilReactions');
    return m ? { serial: m.eventSerial, events: m.events } : { serial: 0, events: [] };
  }

  // MARK: Expressive plans (expressive decisions design §7)

  /// Plays a considered reaction over whatever is running, gated for the moment. Returns the plan as gated (the move
  /// dropped when busy), or null when nothing plays.
  playExpressive(plan: ExpressivePlan): ExpressivePlan | null {
    const st = this._state;
    const p = plan.gated(st.agentState, st.isBedtime, st.reduceMotion, st.glowConfig.motion);
    if (p === null) return null;
    // A considered reaction to the person ends any idle game (the eyes go back to them).
    if (st.activeOneShots.some(isIdleGame)) st.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.idleGames));
    if (p.move !== null) {
      if (this.oneShotBusyForPerception) {
        p.move = null;
      } else {
        this.send(FaceCommand.play(OneShotRequest.make(p.move, { intensity: p.moveIntensity, reduceMotion: st.reduceMotion })));
      }
    }
    if (p.cue !== null) this.send(FaceCommand.reactionCue(p.cue));
    const g = FaceEngine.glance(p.gaze, st);
    if (g !== null) this.send(FaceCommand.glance(g.at, g.duration));
    if (p.isEmpty) return null;
    this.view<ExpressiveOverlayView>('ExpressiveOverlay')?.start(p, st.time);
    return p;
  }

  /// Eases any playing plan's overlay and brows out.
  cancelExpressive(): void { this.view<ExpressiveOverlayView>('ExpressiveOverlay')?.cancel(); }

  /// The glance point and duration for a plan's gaze action, or null. Look away and glance around turn away from the
  /// primary person (a side by the clock when nobody is to one side).
  static glance(g: ExpressiveGaze, s: FaceState): { at: V2; duration: number } | null {
    const id = s.primaryPersonID;
    const person = (id === null ? undefined : s.people.find((q) => q.id === id))?.position ?? s.people[0]?.position;
    const px = person?.x ?? 0;
    const away = px > 0.05 ? -1 : px < -0.05 ? 1 : (s.time % 2 < 1 ? 1 : -1);
    switch (g) {
      case 'none': return null;
      case 'lookAt': return { at: person ? { ...person } : { x: 0, y: 0 }, duration: 0.8 };
      case 'lookAway': return { at: { x: 0.6 * away, y: 0.45 }, duration: 0.9 };
      case 'glanceAround': return { at: { x: 0.75 * away, y: -0.1 }, duration: 0.6 };
      case 'eyeRoll': return { at: { x: 0.35 * away, y: -0.85 }, duration: 0.7 };
    }
  }

  // MARK: Touch

  /// Opens the friendly-touch window (perception's high-five) until `hostTime` (seconds, display-link base). Converted
  /// to engine time against the last frame's host time; before any host time is known `hostTime` is taken as seconds
  /// from now. Non-finite values are ignored; a time already past closes the window.
  noteFriendlyTouch(hostTime: number): void {
    if (!Number.isFinite(hostTime)) return;
    const st = this._state;
    const remaining = st.presentationHostTime !== null ? hostTime - st.presentationHostTime : hostTime;
    st.friendlyTouchUntil = st.time + Math.min(Math.max(remaining, 0), FaceEngine.maxFriendlyTouchWindow) * this.timeScale;
  }

  /// High-fives so far (taps inside a friendly-touch window).
  get highFiveCount(): number { return this.view<TouchReactionsView>('TouchReactions')?.highFiveCount ?? 0; }

  /// Spring-returns any active screen-edge antic (and the sleepy sink when `includingSink`).
  cancelEdgeAntics(includingSink = false): void {
    this._state.oneShotCancels.push(makeOneShotCancel(includingSink ? OneShotKindSet.edgeAntics : OneShotKindSet.screenEdgeAntics));
  }

  /// Camera position relative to the screen centre in metres (x + toward the viewer's right, y + down).
  setCameraOffset(metres: V2): void {
    this._state.cameraOffsetMetres = Number.isFinite(metres.x) && Number.isFinite(metres.y) ? { ...metres } : { x: 0, y: 0 };
  }

  /// Replace the expression library (preview tool edits).
  setLibrary(library: ExpressionLibrary): void {
    this._state.library = library;
    this._state.libraryVersion += 1;
  }

  // MARK: Frame

  /// Advances by an explicit dt (seconds, unscaled), optionally with the frame's host time (tests and tools that
  /// simulate the display link: Swift `tick(dt:hostTime:)`).
  tick(rawDt: number, hostTime?: number): FaceFrame {
    const st = this._state;
    if (hostTime !== undefined) st.presentationHostTime = hostTime;
    // f32: Swift computes dt in Float (`Float(rawDt) * timeScale`) and the Double clock accumulates that Float, so
    // engine time drifts from f·dt. Without it a one-shot retriggered exactly one cooldown later is rejected (golden
    // core-mix, frame 120); with it engine time is bit-identical to Swift's.
    const dt = Math.min(Math.fround(Math.fround(rawDt) * Math.fround(this.timeScale)), Math.fround(FaceEngine.maxDt));
    st.dt = Math.max(dt, 0);
    st.time += st.dt;
    st.frame += 1;
    this.director.run(st);
    Composer.compose(st);
    st.agentStateChanged = false;
    st.commands.length = 0;
    return st.output;
  }

  /// Jumps the engine clock (tests: long-uptime precision).
  advanceClockForTesting(time: number): void { this._state.time = time; }

  frame(presentationTime: number): FaceFrame {
    this._state.presentationHostTime = presentationTime;
    const last = this.lastPresentationTime;
    this.lastPresentationTime = presentationTime;
    if (last === null) return this.tick(1.0 / 60.0);
    return this.tick(Math.max(presentationTime - last, 0));
  }

  // MARK: - Idle games

  /// The idle games scheduler (undefined if the stack has none).
  get idleGames(): Modifier | undefined { return this.director.modifier('IdleGames'); }

  /// Idle game tunables (validated on assignment). The getter returns a copy.
  get idleGameSettings(): IdleGameSettings { return this._state.idleGameSettings.copy(); }
  set idleGameSettings(v: IdleGameSettings) { this._state.idleGameSettings = v.validated(); }

  /// Plays an idle game now, `side` +1 / −1 picks which eye leads (0 random). Respects the game's short cooldown.
  playIdleGame(kind: OneShotKind, side = 0): void {
    if (!isIdleGame(kind)) return;
    this._state.edgeSideHint = sideSign(side);
    this.send(FaceCommand.playOneShot(kind));
  }

  /// Spring-returns any playing idle game.
  cancelIdleGames(): void { this._state.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.idleGames)); }
}
