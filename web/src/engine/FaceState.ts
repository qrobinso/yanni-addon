// Port of FaceEngine/FaceState.swift (GazeIntent, GazeTarget, OneShotOutput, FaceState).
import { SplitMix64 } from '../core/random';
import { v2, v3, v4, type V2, type V3, type V4 } from '../core/vec';
import {
  BrowPose, FaceFrame, FacePose, makeFaceFrame, type EdgeGeometry, type ExpressionLibrary, type ExpressionMix,
} from '../model';
import { ExpressionMix as Mix } from '../model';
import { Modulation, Mood, type AgentState } from './AgentState';
import type { FaceCommand, GazeMoveMode, GazeOverride, OneShotKind, PersonTarget, StartedOneShot } from './Commands';
import { EdgeAnticSettings } from './EdgeAnticSettings';
import { EmotionAuthority } from './EmotionAuthority';
import { IdleGameSettings } from './IdleGameSettings';
import { ListeningGlowConfig } from './ListeningGlow';
import { MoodBackgroundConfig } from './MoodBackground';
import type { OneShotCancel, OneShotRequest } from './OneShots';
import { PowerCare } from './PowerCare';
import { PupilReactionSettings } from './PupilReactionTypes';

/// What the current agent state wants the eyes to do with gaze. Set by AgentStateBehavior, interpreted by Attention.
export type GazeIntent =
  /// Wander: fixations, glances, people-hopping, stimuli.
  | { kind: 'idle' }
  /// Follow the primary person (falls back to idle if nobody is present).
  | { kind: 'track' }
  /// Look up-and-aside, slowly wandering (thinking).
  | { kind: 'thinking' }
  /// Hold gaze at a point (asleep: slightly down; sheepish: down).
  | { kind: 'rest'; at: V2 }
  /// Avoid the primary person: look to the side/down.
  | { kind: 'lookAway' };

export const gazeIntentEquals = (a: GazeIntent, b: GazeIntent): boolean =>
  a.kind === b.kind && (a.kind !== 'rest' || (b.kind === 'rest' && a.at.x === b.at.x && a.at.y === b.at.y));

/// Where the eyes should look this frame and how to get there. Written by Attention, read by GazeTracking.
export interface GazeTarget {
  point: V2;
  mode: GazeMoveMode;
  /// Target velocity in gaze units/s (for pursuit feed-forward). Zero for static targets.
  velocity: V2;
  /// Distance in metres (for convergence).
  distance: number;
  /// True while this target is eye contact with the primary person (`.track`, not interrupted).
  contact: boolean;
}

export const makeGazeTarget = (point: V2, mode: GazeMoveMode, velocity: V2 = v2(0), distance = 1.5,
  contact = false): GazeTarget => ({ point: { ...point }, mode, velocity: { ...velocity }, distance, contact });

/// Per-frame output of every active one-shot, sampled in the behaviour phase (OneShotSampler) and applied
/// in the motion phase (OneShotApply). Reset each frame. A class standing in for a Swift struct: `copy()` it
/// wherever the Swift copies.
export class OneShotOutput {
  /// Additive pose delta (PyCozmo units).
  delta: FacePose = FacePose.zero;
  /// Whole-face stage offset, canvas units (screen-edge antics; see `FaceFrame.stageOffset`).
  stageOffset: V2 = v2(0);
  /// Per-eye stage offset, canvas units (left x, left y, right x, right y).
  eyeStageOffset: V4 = v4(0);
  /// Multiplicative face scale (x, y).
  faceScaleMul: V2 = v2(1);
  /// Multiplicative per-eye scale: (leftX, leftY, rightX, rightY).
  eyeScaleMul: V4 = v4(1);
  /// Additional upper/lower lid coverage as fraction of remaining opening, per eye.
  lidCoverage: V4 = v4(0);
  /// Blink-channel closure 0...1 contributed by one-shots.
  blink = 0;
  /// Lid-close channel 0...1 contributed by one-shots.
  lidClose = 0;
  /// Brightness multiplier.
  brightnessMul = 1;
  /// Multiplicative pupil size (left, right): startle dots, delighted dilation.
  pupilSizeMul: V2 = v2(1);
  /// Gaze override while a one-shot owns gaze.
  gaze: GazeOverride | null = null;
  /// True while any active one-shot owns the closure channel (Blink defers).
  ownsClosure = false;
  /// Pupil silhouette per eye (`PupilShape` raw), morph 0…1 and scale (lx, ly, rx, ry). Written only by the slot
  /// that owns the `.pupilShape` channel; never accumulated.
  pupilShape: V2 = v2(0);
  pupilMorph: V2 = v2(0);
  pupilShapeScale: V4 = v4(1);
  /// Additive brow delta (eye-relative units). Channel-free: every active one-shot's brow track is summed.
  browDelta: BrowPose = BrowPose.zero;

  copy(): OneShotOutput {
    const o = new OneShotOutput();
    o.delta.copyFrom(this.delta);
    o.stageOffset = { ...this.stageOffset };
    o.eyeStageOffset = { ...this.eyeStageOffset };
    o.faceScaleMul = { ...this.faceScaleMul };
    o.eyeScaleMul = { ...this.eyeScaleMul };
    o.lidCoverage = { ...this.lidCoverage };
    o.blink = this.blink;
    o.lidClose = this.lidClose;
    o.brightnessMul = this.brightnessMul;
    o.pupilSizeMul = { ...this.pupilSizeMul };
    o.gaze = this.gaze && { ...this.gaze, point: { ...this.gaze.point } };
    o.ownsClosure = this.ownsClosure;
    o.pupilShape = { ...this.pupilShape };
    o.pupilMorph = { ...this.pupilMorph };
    o.pupilShapeScale = { ...this.pupilShapeScale };
    o.browDelta.copyFrom(this.browDelta);
    return o;
  }
}

/// The single per-frame state the director threads through every modifier.
///
/// Fields are grouped by who writes them. Per-frame accumulators are reset by the director at the start of each
/// frame; everything else persists. A class standing in for the Swift struct (the engine owns one instance).
export class FaceState {
  // MARK: Clock (director)
  /// Engine time in seconds (time-scaled, monotonic).
  time = 0;
  /// Frame delta in seconds, already time-scaled and clamped to ≤ 0.05.
  dt = 0;
  frame = 0;
  /// Shared RNG. Draw only at scheduled events, never as per-frame chances.
  rng: SplitMix64;

  // MARK: Library (engine)
  library: ExpressionLibrary;
  /// Incremented whenever the library is edited (preview tool), so caches can invalidate.
  libraryVersion = 0;

  // MARK: Inputs (engine facade)
  agentState: AgentState = 'idle';
  previousAgentState: AgentState = 'idle';
  agentStateEnteredAt = 0;
  /// True only on the first frame after a state change.
  agentStateChanged = false;
  /// Explicit expression from the preview tool; beats the agent-state mix when set.
  expressionOverride: ExpressionMix | null = null;
  /// Effective mood every modifier reads: `baseMood + moodOffset`, each component clamped to −1…1.
  mood: Mood = Mood.playful;
  /// The mood set by `FaceEngine.setMood`.
  baseMood: Mood = Mood.playful;
  /// Additive (pleasure, arousal, dominance) offset owned by the life-cycle controller. Zero by default.
  moodOffset: V3 = v3(0);
  /// Style personality: how elastic the face is (0.5…2, 1 = neutral).
  elasticity = 1.3;
  /// Raw speech output level 0...1. Use `speechEnvelope` for animation.
  speechLevel = 0;
  /// People in view.
  people: PersonTarget[] = [];
  /// The person the eyes follow / who has the turn, if any.
  primaryPersonID: number | null = null;
  /// The person actually engaging with Yanni (looking at the face), if any.
  engagedPersonID: number | null = null;
  /// Engine time of the last sub-threshold "stir" tap while asleep (TouchReactions).
  lidStirAt = -Infinity;
  /// End (engine time) of the friendly-touch window (`FaceEngine.noteFriendlyTouch`).
  friendlyTouchUntil = -Infinity;
  /// Camera position relative to the screen centre in metres (x + toward the viewer's right, y + down).
  cameraOffsetMetres: V2 = v2(0);
  /// Commands queued since the last frame; cleared by the engine after the frame.
  commands: FaceCommand[] = [];
  /// Host time (seconds, display-link base) of the frame being computed; null when driven by `tick(dt)` alone.
  presentationHostTime: number | null = null;
  /// Where the screen edges are, seen from the face. Null = no screen known: the screen-edge antics are off.
  edgeGeometry: EdgeGeometry | null = null;
  /// Screen-edge antic tunables (engine facade `edgeAnticSettings`).
  edgeSettings = new EdgeAnticSettings();
  /// Bedtime is on (life-cycle controller).
  isBedtime = false;
  /// Pupil transformation tunables (engine facade `pupilReactionSettings`).
  pupilSettings = new PupilReactionSettings();
  /// Reduce Motion (the system setting, carried by `pupilSettings.reduceMotion`; never persisted).
  get reduceMotion(): boolean { return this.pupilSettings.reduceMotion; }
  /// The engine-wide Reduce Motion factor for movement amplitudes: `reducedMotionScale` with Reduce Motion on, else 1.
  get motionScale(): number { return this.reduceMotion ? FaceState.reducedMotionScale : 1; }
  static readonly reducedMotionScale = 0.5;
  /// Brow animation intensity (engine facade `browIntensity`). 0 = static neutral brows.
  browIntensity = 1;
  /// Mood background settings (engine facade `moodBackground`).
  backgroundConfig = new MoodBackgroundConfig();
  /// The resource governor's background fade (engine facade `setBackgroundSuppressed`).
  backgroundSuppressed = false;
  /// Manual colour burst requests (engine facade `playBackgroundBurst`); the mood background consumes and clears.
  backgroundBurstRequests: OneShotKind[] = [];
  /// Listening glow settings (engine facade `listeningGlow`).
  glowConfig = new ListeningGlowConfig();
  /// Listening glow target 0…1: the mic (engine facade `setListeningGlow`).
  glowTarget = 0;
  /// The person's voice 0…1 (engine facade `setListeningVoice`).
  glowVoice = 0;
  /// The live mic level 0…1 (engine facade `setListeningLevel`).
  glowMic = 0;
  /// The caption band's target, a share of the screen height, and Reduce Motion for its spring.
  captionInsetTarget = 0;
  captionInsetReduceMotion = false;
  /// The sprung caption band (`CaptionInset`; Composer copies it into the frame).
  captionInset = 0;
  /// OLED / power care (engine facade `powerCare`).
  powerCare = new PowerCare();
  /// Launch fade (engine facade `fadeInFromBlack`). Cleared by `Brightness` once it has arrived.
  fadingInFromBlack = false;
  /// The emotion layer's expression (`FaceEngine.setEmotionExpression`). Null or weight 0 = the profile alone.
  emotionMix: ExpressionMix | null = null;
  /// 0…1 weight of `emotionMix` before the state's authority.
  emotionWeight = 0;
  /// How much of the emotion expression each agent state lets show (engine facade `emotionAuthority`).
  emotionAuthority = new EmotionAuthority();

  // MARK: Behaviour coordination
  /// True while TouchReactions is sulking (written every frame by TouchReactions).
  isSulking = false;
  /// TouchReactions' annoyance level (0 calm … ≥ 4.5 sulk), written every frame by TouchReactions.
  tapAnnoyance = 0;
  /// How hard the tickle laughs out loud (0…1), written every frame by TouchReactions.
  tickleLaugh = 0;
  /// Requests to end or skip active one-shots; OneShotSampler consumes and clears. Anyone may append.
  oneShotCancels: OneShotCancel[] = [];
  /// Side (+1 right, −1 left) for the next screen-edge antic the sampler starts; 0 = random. Consumed by the sampler.
  edgeSideHint = 0;
  /// Engine time of the last idle personality beat (IdleBeats) and of the last screen-edge antic start.
  lastIdleBeatTime = -Infinity;
  lastEdgeAnticTime = -Infinity;
  /// Engine time of the last idle game start (IdleGames / OneShotSampler).
  lastIdleGameTime = -Infinity;
  /// Idle game tunables (engine facade `idleGameSettings`).
  idleGameSettings = new IdleGameSettings();
  /// True while NoticingAttention is actively watching the person (or checking in), written every frame.
  noticingWatching = false;

  // MARK: Behaviour phase (AgentStateBehavior, OneShotSampler, IdleBeats)
  /// Requests for new one-shots; OneShotSampler consumes and clears. Anyone may append.
  oneShotRequests: OneShotKind[] = [];
  /// Requests with per-instance options (hold, lead eye, intensity); consumed after `oneShotRequests`.
  oneShotPlayRequests: OneShotRequest[] = [];
  /// Active one-shot kinds this frame.
  activeOneShots: OneShotKind[] = [];
  /// One-shot kinds that completed during the previous sampler pass.
  completedOneShots: OneShotKind[] = [];
  /// One-shots that started during this frame's sampler pass.
  startedOneShots: StartedOneShot[] = [];
  oneShot = new OneShotOutput();
  targetMix: ExpressionMix = Mix.neutral;
  gazeIntent: GazeIntent = { kind: 'idle' };
  /// Multipliers from the agent-state profile, combined into `modulation` by MoodModulation.
  stateModulation: Modulation = Modulation.make();
  /// Extra breathing amplitude multiplier from state (asleep deep breathing).
  breathingDepth = 1;
  /// Target overall brightness from state (Brightness modifier smooths toward it).
  targetBrightness = 0.85;
  /// Engine time of the last startled wake (TouchReactions).
  fastWakeAt = -Infinity;
  /// A transient reaction expression (TouchReactions' annoyance) layered over the shown mix.
  reactionOverlay: ExpressionMix | null = null;

  // MARK: Affect phase (MoodModulation)
  modulation: Modulation = Modulation.make();
  /// Smoothed speech level (attack 30 ms, release 120 ms).
  speechEnvelope = 0;

  // MARK: Expression phase (ExpressionTransition)
  /// Spring-animated base expression pose.
  basePose: FacePose;
  /// Spring-animated base brows (ExpressionTransition), eye-relative units.
  browBase: BrowPose;
  /// 0…1 brow presence (AgentStateBehavior). Persists between frames.
  browPresence = 1;

  // MARK: Attention phase (Attention, GazeTracking, MicroMotion)
  gazeTarget: GazeTarget = makeGazeTarget(v2(0), 'smooth');
  /// Set by Attention every frame: a one-shot gaze override, a glance or a stimulus owns the gaze target.
  gazeInterrupted = false;
  /// Current eye gaze (normalised gaze space), after springs.
  eyeGaze: V2 = v2(0);
  /// Current head (face) gaze component, lagging the eyes.
  headGaze: V2 = v2(0);
  isSaccading = false;
  /// Set by GazeTracking when a large saccade starts and a blink would look natural. Blink consumes it.
  saccadeBlinkRequest = false;

  // MARK: Lids phase (Blink, LidHeaviness)
  /// Last time any blink-channel closure started (Blink and one-shots).
  lastBlinkTime = -100;

  // MARK: Per-frame accumulators (reset by director each frame)
  /// Additive pose delta from all modifiers (PyCozmo units; author amplitudes via `Units`).
  delta: FacePose = FacePose.zero;
  /// Whole-face and per-eye stage offsets (canvas units), outside the pose.
  stageOffset: V2 = v2(0);
  eyeStageOffset: V4 = v4(0);
  /// Multiplicative face scale (x, y).
  faceScaleMul: V2 = v2(1);
  /// Multiplicative per-eye scale: (leftX, leftY, rightX, rightY).
  eyeScaleMul: V4 = v4(1);
  /// Extra lid coverage as fraction of remaining opening: (leftUpper, leftLower, rightUpper, rightLower).
  lidCoverage: V4 = v4(0);
  /// Multiplicative pupil size (left, right). Composer clamps the product.
  pupilSizeMul: V2 = v2(1);
  /// Blink channel 0...1 (max-combined).
  blink = 0;
  /// Lid-close channel 0...1 (max-combined).
  lidClose = 0;
  /// Brightness multiplier for this frame (the Brightness modifier sets the base).
  brightness = 1;
  /// Pupil silhouette, morph and scale this frame. Identity: ellipse, 0, 1.
  pupilShape: V2 = v2(0);
  pupilMorph: V2 = v2(0);
  pupilShapeScale: V4 = v4(1);
  /// Additive brow delta (eye-relative units).
  browDelta: BrowPose = BrowPose.zero;
  /// Brow follow-through (canvas units, left xy, right xy), written by the Brows modifier.
  browOffset: V4 = v4(0);
  /// 0…1 weight of `reactionOverlay` this frame (written each frame by TouchReactions; 0 when nobody writes it).
  reactionOverlayWeight = 0;

  // MARK: Output phase (MoodColor)
  /// Smoothed mood-driven eye colour, linear RGB 0...1.
  eyeColor: V3 = { ...FaceFrame.defaultColor };
  /// Smoothed mood background colour, linear RGB.
  backgroundColor: V3 = v3(0);
  /// 0…1 mix from the theme background toward `backgroundColor`.
  backgroundStrength = 0;
  /// 0…1 life-cycle presence of the whole background, smoothed.
  backgroundPresence = 1;
  /// The Brightness modifier's smoothed base level: the background's dimming.
  baseBrightness = 1;
  /// The listening glow (MoodColor's `ListeningGlow`).
  glowLevel = 0;
  glowHeight = 0;
  glowMotion = 0;
  glowRipple = 0;
  glowColor: V3 = v3(0);
  glowColor2: V3 = v3(0);
  glowPhase: V4 = v4(0);

  // MARK: Output (composer)
  /// Last frame's composed pose (for velocity-driven effects like squash/stretch).
  prevPose: FacePose;
  /// Last frame's composed lid-close channel (0…1, blink excluded).
  composedLidClose = 0;
  output: FaceFrame;

  constructor(library: ExpressionLibrary, seed: bigint | number) {
    this.library = library;
    this.rng = new SplitMix64(seed);
    this.basePose = library.neutral.copy();
    this.prevPose = library.neutral.copy();
    this.browBase = library.neutralBrows.copy();
    this.output = makeFaceFrame(library.neutral.copy(), { brows: library.neutralBrows.copy() });
  }

  /// Resets per-frame accumulators. Called by the director at frame start.
  resetFrameAccumulators(): void {
    this.delta.raw.fill(0);
    this.stageOffset = v2(0);
    this.eyeStageOffset = v4(0);
    this.faceScaleMul = v2(1);
    this.eyeScaleMul = v4(1);
    this.lidCoverage = v4(0);
    this.pupilSizeMul = v2(1);
    this.blink = 0;
    this.lidClose = 0;
    this.brightness = 1;
    this.reactionOverlayWeight = 0;
    this.pupilShape = v2(0);
    this.pupilMorph = v2(0);
    this.pupilShapeScale = v4(1);
    this.browDelta.raw.fill(0);
    this.browOffset = v4(0);
    this.oneShot = new OneShotOutput();
    this.saccadeBlinkRequest = false;
  }
}
