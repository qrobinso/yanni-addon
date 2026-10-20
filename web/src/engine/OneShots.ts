// Port of FaceEngine/OneShots.swift: declarations, the spec library, per-trigger variation, sampling and the curves of
// the original one-shots. The answers, edge antics, pupil transformations and idle games live in their curve files.
import type { SplitMix64 } from '../core/random';
import { v2, v4, type V2, type V4 } from '../core/vec';
import { BrowLayout, ParamLayout, PupilShape, Units, type BrowLane, type Side } from '../model';
import type { AgentState } from './AgentState';
import * as Answer from './AnswerCurves';
import { OneShotKind } from './Commands';
import { Ease, Track } from './Easing';
import * as Edge from './EdgeAnticCurves';
import { EdgeAnticContext, EdgeAnticParams } from './EdgeAnticCurves';
import { OneShotOutput } from './FaceState';
import * as Game from './IdleGameCurves';
import * as Shape from './PupilShapeCurves';
import { SpringParams } from './Spring';
import { makeGazeOverride } from './Commands';
import type { ClosedRangeF } from './SettingsSupport';

// MARK: - Declarations

/// Channels a one-shot owns (a bit mask). A new one-shot on a busy channel fades the old one out (design Part D, H5).
export type OneShotChannels = number;
export const OneShotChannels = {
  none: 0,
  /// Face / eye centre offsets, including the stage offsets the screen-edge antics use.
  translate: 1 << 0,
  /// Face angle.
  angle: 1 << 1,
  /// Face and eye scale.
  scale: 1 << 2,
  /// Lid coverage and lid angles.
  lids: 1 << 3,
  /// Blink and lid-close channels (Blink defers while owned).
  closure: 1 << 4,
  /// Gaze override.
  gaze: 1 << 5,
  /// Pupil position / size accents (`delta` pupil lanes, `pupilSizeMul`).
  pupils: 1 << 6,
  /// The pupil silhouette. Discrete: owned outright by one slot, never weight-blended or frozen into a residual.
  pupilShape: 1 << 7,
  contains: (set: number, c: number): boolean => (set & c) === c,
  isDisjoint: (a: number, b: number): boolean => (a & b) === 0,
} as const;
const C = OneShotChannels;

/// How a one-shot lets go when it is ended early (state change, channel conflict, retrigger, eviction, cancel).
/// `fade`: fade the last contribution out over 120 ms. `spring`: translate lanes ride an underdamped spring home,
/// the rest fades (the edge antics). `switchBack`: the pupil transformations' scripted coin flip back.
export type OneShotReleaseStyle = 'fade' | 'spring' | 'switchBack';

/// A set of one-shot kinds (a bit per ordinal; two 32-bit words, room for 64 kinds). Immutable.
export class OneShotKindSet {
  private constructor(readonly lo: number, readonly hi: number) {}

  static of(kinds: readonly OneShotKind[]): OneShotKindSet {
    let lo = 0, hi = 0;
    for (const k of kinds) {
      const o = OneShotKind.ordinal(k);
      if (o < 32) lo |= 1 << o; else hi |= 1 << (o - 32);
    }
    return new OneShotKindSet(lo >>> 0, hi >>> 0);
  }

  static readonly empty = new OneShotKindSet(0, 0);

  contains(kind: OneShotKind): boolean {
    const o = OneShotKind.ordinal(kind);
    return o < 32 ? ((this.lo >>> o) & 1) === 1 : ((this.hi >>> (o - 32)) & 1) === 1;
  }

  union(o: OneShotKindSet): OneShotKindSet { return new OneShotKindSet((this.lo | o.lo) >>> 0, (this.hi | o.hi) >>> 0); }
  equals(o: OneShotKindSet): boolean { return this.lo === o.lo && this.hi === o.hi; }
  get kinds(): OneShotKind[] { return OneShotKind.allCases.filter((k) => this.contains(k)); }

  /// The four antics that use the screen edges (not the sleepy sink, which never leaves the screen).
  static readonly screenEdgeAntics = OneShotKindSet.of(['shyPeek', 'popUp', 'curiousLean', 'pretendExit']);
  /// All five edge antics.
  static readonly edgeAntics = OneShotKindSet.of(['shyPeek', 'popUp', 'curiousLean', 'pretendExit', 'sleepySink']);
  /// The five pupil transformations.
  static readonly pupilShapes = OneShotKindSet.of(['starEyes', 'heartEyes', 'noteEyes', 'questionEyes', 'exclaimEyes']);
  /// The four answers: yes, absolutely yes, no, absolutely not.
  static readonly answers = OneShotKindSet.of(['nodYes', 'nodYesBig', 'shakeNo', 'shakeNoBig']);
  /// The ten idle games (IdleGames cancels them as one group).
  static readonly idleGames = OneShotKindSet.of(['pingPong', 'basketball', 'juggling', 'yoYo', 'leapfrog',
    'staringContest', 'hideAndSeek', 'catchTheFly', 'danceBreak', 'hulaHoop']);
}

/// A one-shot request with per-instance options (`FaceState.oneShotPlayRequests`, `FaceCommand.play`). The plain kind
/// requests are this with every option undefined. A plain object: spread-copy it where the Swift copies.
export interface OneShotRequest {
  kind: OneShotKind;
  /// Hold length in seconds (pupil transformations; clamped to `holdRange`). Undefined: the kind's default.
  hold?: number;
  /// Which eye leads (−1 left, +1 right; question marks). Undefined: random.
  leadEye?: number;
  /// Pupil transformations: 0…1; answers: 0.5…1 of the size; every other kind except the edge antics: the amplitude
  /// scale, clamped to `amplitudeIntensityRange`. Undefined: 1 (exactly the unscaled one-shot).
  intensity?: number;
  /// Honour Reduce Motion: no bounce, bob, pulse or face stretch; the silhouettes still change.
  reduceMotion: boolean;
  /// The auto-vocalisation should be soft: −6 dB and shorter, on the same beats. Carried to `StartedOneShot.softVoice`.
  softVoice: boolean;
}

export const OneShotRequest = {
  make: (kind: OneShotKind, o: Partial<Omit<OneShotRequest, 'kind'>> = {}): OneShotRequest =>
    ({ kind, reduceMotion: false, softVoice: false, ...o }),
  /// Clamp for `intensity` as an amplitude scale (ordinary one-shots).
  amplitudeIntensityRange: [0.3, 1.3] as ClosedRangeF,
  equals: (a: OneShotRequest, b: OneShotRequest): boolean =>
    a.kind === b.kind && a.hold === b.hold && a.leadEye === b.leadEye && a.intensity === b.intensity &&
    a.reduceMotion === b.reduceMotion && a.softVoice === b.softVoice,
} as const;

/// A request to end or skip part of active one-shots (`FaceState.oneShotCancels`, consumed by OneShotSampler).
/// `release`: end the matching one-shots now, through their release style (no completion reported). `seekReturn`: jump
/// the playhead of matching one-shots forward to their return keyframe (screen-edge antics). Others are untouched.
export interface OneShotCancel {
  /// One-shots of these kinds match.
  kinds: OneShotKindSet;
  /// One-shots owning any of these channels also match.
  channels: OneShotChannels;
  mode: 'release' | 'seekReturn';
}

export const makeOneShotCancel = (kinds: OneShotKindSet, channels: OneShotChannels = 0,
  mode: 'release' | 'seekReturn' = 'release'): OneShotCancel => ({ kinds, channels, mode });

export interface OneShotSpecInit {
  kind: OneShotKind;
  duration: number;
  channels: OneShotChannels;
  cooldown: number;
  stateScoped: boolean;
  priority: number;
  accentTimes?: number[];
  releaseStyle?: OneShotReleaseStyle;
  allowedStates?: AgentState[];
  speedRange?: ClosedRangeF | null;
  actingChannels?: OneShotChannels;
}

/// Static description of a one-shot kind.
export class OneShotSpec {
  kind: OneShotKind;
  /// Authored duration in seconds at speed 1 (each trigger jitters it by ±6 %).
  duration: number;
  channels: OneShotChannels;
  /// Minimum seconds between two accepted triggers of this kind (engine time).
  cooldown: number;
  /// Released (faded out) when the agent state changes.
  stateScoped: boolean;
  /// Eviction / gaze-override priority; higher wins.
  priority: number;
  /// Seconds (base time) of each main hit / pop / bounce / beat. The voice lands accented notes here.
  accentTimes: number[];
  /// How it lets go when ended early.
  releaseStyle: OneShotReleaseStyle;
  /// When non-empty, released only when the agent state changes to one outside this list.
  allowedStates: AgentState[];
  /// Playback-speed clamp for this kind (null: `OneShotSampler.speedRange`).
  speedRange: ClosedRangeF | null;
  /// Channels the one-shot writes without owning them (pupil transformations' acting).
  actingChannels: OneShotChannels;

  constructor(o: OneShotSpecInit) {
    this.kind = o.kind; this.duration = o.duration; this.channels = o.channels; this.cooldown = o.cooldown;
    this.stateScoped = o.stateScoped; this.priority = o.priority; this.accentTimes = o.accentTimes ?? [];
    this.releaseStyle = o.releaseStyle ?? 'fade'; this.allowedStates = o.allowedStates ?? [];
    this.speedRange = o.speedRange ?? null; this.actingChannels = o.actingChannels ?? 0;
  }

  /// True when the one-shot drives the closure channel (Blink defers).
  get ownsClosure(): boolean { return (this.channels & C.closure) !== 0; }

  /// True when the agent state changing to `to` should release it.
  releases(to: AgentState): boolean {
    if (this.allowedStates.length > 0) return !this.allowedStates.includes(to);
    return this.stateScoped;
  }
}

/// Per-trigger variation, drawn from `s.rng` once at trigger time so repeats never look identical.
export class OneShotParams {
  /// Amplitude multiplier (≈0.9…1.1).
  amp = 1;
  /// Duration multiplier (≈0.94…1.06).
  timeMul = 1;
  /// Direction (±1): tilt / shake / look side.
  side = 1;
  /// Free variation values in [0, 1).
  v1 = 0.5;
  v2 = 0.5;
  /// Gaze points chosen at trigger (meaning depends on the kind).
  gazeA: V2 = v2(0);
  gazeB: V2 = v2(0);
  /// Edge antic timeline and travel, resolved at trigger (empty for every other kind).
  edge = new EdgeAnticParams();
  /// Pupil transformations: hold length (0 = not a transformation), lead eye (±1), intensity (0…1), whether the bounce
  /// plays, and the Reduce Motion flag.
  hold = 0;
  lead = 1;
  intensity = 1;
  bounce = true;
  reduceMotion = false;

  copy(): OneShotParams {
    const p = Object.assign(new OneShotParams(), this);
    p.gazeA = { ...this.gazeA }; p.gazeB = { ...this.gazeB }; p.edge = this.edge.copy();
    return p;
  }
}

// MARK: - OneShotKind extension

/// One of the ten idle games.
export const isIdleGame = (k: OneShotKind): boolean => OneShotKindSet.idleGames.contains(k);
/// One of the five pupil transformations.
export const isPupilShape = (k: OneShotKind): boolean => OneShotKindSet.pupilShapes.contains(k);
/// One of the four answers.
export const isAnswer = (k: OneShotKind): boolean => OneShotKindSet.answers.contains(k);
/// One of the five edge antics.
export const isEdgeAntic = (k: OneShotKind): boolean => OneShotKindSet.edgeAntics.contains(k);
/// One of the four antics that use the screen edges (they need `FaceState.edgeGeometry`).
export const isScreenEdgeAntic = (k: OneShotKind): boolean => OneShotKindSet.screenEdgeAntics.contains(k);

/// The silhouette a pupil transformation shows (`ellipse` for every other kind).
export function pupilShapeOf(k: OneShotKind): PupilShape {
  switch (k) {
    case 'starEyes': return PupilShape.star;
    case 'heartEyes': return PupilShape.heart;
    case 'noteEyes': return PupilShape.note;
    case 'questionEyes': return PupilShape.question;
    case 'exclaimEyes': return PupilShape.exclaim;
    default: return PupilShape.ellipse;
  }
}

/// The gentle counterpart of an emphatic answer; itself otherwise. Bedtime plays the gentle one.
export function gentleAnswer(k: OneShotKind): OneShotKind {
  return k === 'nodYesBig' ? 'nodYes' : k === 'shakeNoBig' ? 'shakeNo' : k;
}

/// What an answer means, for event logs and buttons; null for every other kind.
export function answerTitle(k: OneShotKind): string | null {
  switch (k) {
    case 'nodYes': return 'yes';
    case 'nodYesBig': return 'absolutely yes';
    case 'shakeNo': return 'no';
    case 'shakeNoBig': return 'absolutely not';
    default: return null;
  }
}

// MARK: - Library

const spec = (kind: OneShotKind, duration: number, channels: number, cooldown: number, stateScoped: boolean,
  priority: number, accentTimes: number[]): OneShotSpec =>
  new OneShotSpec({ kind, duration, channels, cooldown, stateScoped, priority, accentTimes });

/// One factory per kind in ordinal order. Built on first use (the curve files' specs depend on their own tables).
const SPEC_FACTORIES: ReadonlyArray<() => OneShotSpec> = [
  () => spec('laugh', 1.1, C.translate | C.scale | C.lids, 0.5, false, 5, [0.21, 0.50, 0.73]),
  () => spec('confusedShake', 0.9, C.translate | C.angle | C.lids, 0.5, false, 6, [0.17, 0.315, 0.48]),
  () => spec('dance', 2.4, C.translate | C.angle | C.scale | C.lids, 1.2, false, 5, [0.25, 0.75, 1.25, 1.75]),
  () => spec('perkUp', 0.5, C.translate | C.scale | C.lids, 0.35, false, 6, [0.17]),
  () => spec('sorryBlink', 0.45, C.closure | C.scale | C.translate, 0.4, true, 8, [0.06, 0.26]),
  () => spec('nodOff', 2.6, C.closure | C.translate | C.angle | C.scale | C.lids, 3.0, true, 7, [2.05]),
  () => spec('yawn', 2.2, C.closure | C.scale | C.translate | C.lids, 4.0, true, 5, [1.125]),
  () => spec('stretch', 1.4, C.scale | C.translate | C.lids, 1.5, false, 4, [0.68]),
  () => spec('lookAway', 1.6, C.gaze | C.lids, 0.8, true, 6, [0.05, 0.75]),
  () => spec('wake', 1.8, C.closure | C.scale | C.translate, 1.0, true, 9, [1.185, 1.55]),
  () => spec('delightedSquint', 1.0, C.lids | C.translate | C.scale | C.pupils, 0.6, false, 3, [0.175]),
  () => spec('mockOffense', 1.7, C.translate | C.scale | C.lids | C.angle, 1.0, false, 5, [0.305, 0.97]),
  () => spec('bigSurprise', 1.2, C.scale | C.lids | C.translate | C.pupils, 0.8, false, 7, [0.205]),
  () => spec('doubleTake', 1.4, C.gaze | C.lids | C.scale | C.translate, 1.2, false, 3, [0.655]),
  () => spec('curiousTilt', 2.0, C.angle | C.scale | C.lids, 1.0, true, 2, [0.64, 1.155]),
  () => spec('sideEye', 2.4, C.gaze | C.lids, 1.5, true, 2, [0.55, 1.25]),
  () => spec('crossEyed', 0.9, C.pupils | C.gaze, 3.0, true, 3, [0.25]),
  () => spec('catchSelf', 1.0, C.closure | C.translate | C.angle | C.scale | C.lids, 2.0, false, 8, [0.22]),
  () => Edge.edgeSpec('shyPeek', C.translate | C.angle | C.scale | C.gaze | C.lids, 3),
  () => Edge.edgeSpec('popUp', C.translate | C.scale | C.gaze | C.lids, 3),
  () => Edge.edgeSpec('curiousLean', C.translate | C.angle | C.scale | C.gaze | C.lids, 3),
  () => Edge.edgeSpec('pretendExit', C.translate | C.angle | C.scale | C.lids | C.pupils, 3),
  () => Edge.edgeSpec('sleepySink', C.translate | C.angle | C.scale | C.lids | C.closure | C.pupils, 7),
  () => Shape.shapeSpec('starEyes', C.scale | C.translate | C.lids | C.pupils),
  () => Shape.shapeSpec('heartEyes', C.gaze | C.angle | C.lids | C.pupils),
  () => Shape.shapeSpec('noteEyes', C.translate | C.pupils),
  () => Shape.shapeSpec('questionEyes', C.angle | C.lids),
  () => Shape.shapeSpec('exclaimEyes', C.scale | C.translate | C.lids | C.pupils),
  () => spec('nodYes', 0.75, C.translate | C.angle | C.scale | C.lids | C.pupils, 0.4, false, 5, [...Answer.AnswerAccents.nodYes]),
  () => spec('nodYesBig', 1.1, C.translate | C.angle | C.scale | C.lids | C.pupils | C.closure, 0.5, false, 6, [...Answer.AnswerAccents.nodYesBig]),
  () => spec('shakeNo', 0.86, C.translate | C.angle | C.scale | C.lids | C.pupils, 0.4, false, 5, [...Answer.AnswerAccents.shakeNo]),
  () => spec('shakeNoBig', 1.1, C.translate | C.angle | C.scale | C.lids | C.pupils, 0.5, false, 6, [...Answer.AnswerAccents.shakeNoBig]),
  ...(['pingPong', 'basketball', 'juggling', 'yoYo', 'leapfrog', 'staringContest', 'hideAndSeek', 'catchTheFly',
    'danceBreak', 'hulaHoop'] as const).map((k) => () => {
    const g = Game.gameInfo(k);
    return Game.gameSpec(k, g.duration, g.accents);
  }),
];
const specCache: (OneShotSpec | undefined)[] = new Array(OneShotKind.count);

const px = (canvas: number): number => Units.poseX(canvas);
const py = (canvas: number): number => Units.poseY(canvas);

/// Volume-preserving motion stretch: sy given, sx = 1/√sy.
function stretchScale(sy: number): V2 {
  const y = Math.max(sy, 0.2);
  return v2(1 / Math.sqrt(y), y);
}

/// 0 → 1 over [a, b], 1 until c, 1 → 0 over [c, d] (smoothstep edges).
function window(t: number, a: number, b: number, c: number, d: number): number {
  return Ease.smoothstep((t - a) / Math.max(b - a, 1e-4)) * (1 - Ease.smoothstep((t - c) / Math.max(d - c, 1e-4)));
}

/// A blink curve: ease-in close, hold, ease-out open. Returns 0…1.
function blinkPulse(t: number, start: number, close: number, hold: number, open: number): number {
  const a = t - start;
  if (a <= 0) return 0;
  if (a < close) return Ease.inQuad(a / close);
  if (a < close + hold) return 1;
  const b = a - close - hold;
  if (b < open) return 1 - Ease.outQuad(b / open);
  return 0;
}

/// Smooth hump of the given full width centred at `c` (sin²), 0 outside.
function hump(t: number, c: number, w: number): number {
  const u = (t - c) / w + 0.5;
  return u <= 0 || u >= 1 ? 0 : Ease.bump(u);
}

function setLids(o: OneShotOutput, upper: number, lower: number): void {
  const l = o.lidCoverage;
  l.x += upper; l.y += lower; l.z += upper; l.w += lower;
}

export interface BrowTrack { y?: number; rotation?: number; curvature?: number; inner?: number; outer?: number; peak?: number }
const BROW_TRACK_LANES: readonly (keyof BrowTrack & BrowLane)[] = ['y', 'rotation', 'curvature', 'inner', 'outer', 'peak'];

/// Adds a brow track to one brow (eye-relative units, degrees; see `BrowLayout`). Brow tracks are channel-free.
function brow(o: OneShotOutput, side: Side, b: BrowTrack): void {
  const raw = o.browDelta.raw;
  for (const lane of BROW_TRACK_LANES) raw[BrowLayout.index(side, lane)] += b[lane] ?? 0;
}

/// The same brow track on both brows.
function brows(o: OneShotOutput, b: BrowTrack): void {
  brow(o, 'left', b);
  brow(o, 'right', b);
}

/// Unit step response of a spring (0 at t ≤ 0 with zero slope, → 1).
function stepResponse(t: number, sp: SpringParams): number {
  if (!(t > 0)) return 0;
  const wd = sp.omega * Math.sqrt(1 - sp.zeta * sp.zeta);
  const e = Math.exp(-sp.zeta * sp.omega * t);
  return 1 - e * (Math.cos(wd * t) + (sp.zeta * sp.omega / wd) * Math.sin(wd * t));
}

/// 1 on the pose lanes that are movement (face centre, scale and angle; each eye's centre and angle), else 0.
const motionLanes: Float64Array = (() => {
  const m = new Float64Array(ParamLayout.count);
  for (const f of ['centerX', 'centerY', 'scaleX', 'scaleY', 'angle'] as const) m[ParamLayout.index(f)] = 1;
  for (const side of ParamLayout.Side.allCases) {
    for (const e of ['centerX', 'centerY', 'angle'] as const) m[ParamLayout.index(side, e)] = 1;
  }
  return m;
})();

/// The one-shot library: specs, per-trigger variation and allocation-free sampling.
///
/// Every curve is authored in base seconds (speed 1, no jitter), canvas units (converted via `Units`) and degrees. A
/// short edge window guarantees each one-shot contributes exactly zero at t = 0 and at t = duration, with zero
/// velocity at both ends.
export const OneShotLibrary = {
  /// The spec of one kind (built on first use).
  spec(kind: OneShotKind): OneShotSpec {
    const i = OneShotKind.ordinal(kind);
    return (specCache[i] ??= SPEC_FACTORIES[i]());
  },

  /// Every spec in ordinal order (builds them all: needs every curve file ported).
  get specs(): OneShotSpec[] { return OneShotKind.allCases.map((k) => OneShotLibrary.spec(k)); },

  /// Base duration (seconds at speed 1, before the per-trigger time multiplier) for the given trigger params.
  baseDuration(kind: OneShotKind, p: OneShotParams): number {
    if (isPupilShape(kind)) return Shape.shapeDuration(kind, p.hold);
    return p.edge.baseDuration > 0 ? p.edge.baseDuration : OneShotLibrary.spec(kind).duration;
  },

  /// Instance duration in seconds at speed 1 for the given trigger params.
  duration(kind: OneShotKind, p: OneShotParams): number {
    // f32: compared against the Float playhead on a one-shot's last frame (OneShotSampler).
    return Math.fround(Math.fround(OneShotLibrary.baseDuration(kind, p)) * Math.fround(p.timeMul));
  },

  /// Accent offsets (base seconds) for this trigger: the spec's, or the edge antic's own.
  accentTimes(kind: OneShotKind, p: OneShotParams): number[] {
    if (isPupilShape(kind)) return Shape.shapeAccentTimes(kind, p);
    return p.edge.baseDuration > 0 ? [p.edge.accent] : [...OneShotLibrary.spec(kind).accentTimes];
  },

  /// Draws per-trigger variation. Call only at trigger time. `eyeGaze` is the current gaze (doubleTake returns to it).
  /// `edge` carries the screen geometry, settings, side hint and current face offset for the edge antics.
  makeParams(r: OneShotKind | OneShotRequest, rng: SplitMix64, eyeGaze: V2,
    edge: EdgeAnticContext = new EdgeAnticContext()): OneShotParams {
    const request = typeof r === 'string' ? OneShotRequest.make(r) : r;
    const kind = request.kind;
    if (isEdgeAntic(kind)) return Edge.makeEdgeParams(kind, rng, edge);
    if (isPupilShape(kind)) return Shape.makeShapeParams(request, rng, eyeGaze);
    if (isIdleGame(kind)) return Game.makeGameParams(request, rng, edge);
    const p = new OneShotParams();
    p.amp = rng.uniform(0.9, 1.1);
    p.timeMul = rng.uniform(0.94, 1.06);
    p.side = rng.chance(0.5) ? 1 : -1;
    p.v1 = rng.unit();
    p.v2 = rng.unit();
    // The answers honour Reduce Motion (smaller moves, no stretch) and the request's intensity (0.5…1 of the size).
    if (isAnswer(kind)) {
      p.reduceMotion = request.reduceMotion;
      const i = request.intensity;
      p.intensity = i === undefined ? 1 : Number.isFinite(i) ? Math.min(Math.max(i, 0.5), 1) : 1;
    } else if (request.intensity !== undefined && Number.isFinite(request.intensity)) {
      // Every other kind: the request's intensity scales the amplitude (undefined leaves it bit-identical).
      const rr = OneShotRequest.amplitudeIntensityRange;
      p.amp *= Math.min(Math.max(request.intensity, rr[0]), rr[1]);
    }
    switch (kind) {
      case 'lookAway':
        p.gazeA = v2(p.side * rng.uniform(0.55, 0.8), rng.uniform(0.22, 0.45));
        p.gazeB = v2(p.gazeA.x + p.side * 0.07, p.gazeA.y + 0.04);
        break;
      case 'sideEye': {
        const gy = rng.uniform(-0.08, 0.05);
        p.gazeA = v2(p.side * 0.72, gy);
        p.gazeB = v2(p.side * 0.8, gy + 0.03);
        break;
      }
      case 'crossEyed':
        // Look at "the nose": most of the way back to centre from wherever the eyes were.
        p.gazeA = v2(Math.min(Math.max(eyeGaze.x, -1), 1) * 0.3, Math.min(Math.max(eyeGaze.y, -1), 1) * 0.3 + 0.05);
        break;
      case 'doubleTake': {
        const o = v2(Math.min(Math.max(eyeGaze.x, -0.9), 0.9), Math.min(Math.max(eyeGaze.y, -0.6), 0.6));
        if (o.x > 0.3) p.side = -1; else if (o.x < -0.3) p.side = 1;
        p.gazeB = o;
        // Swift evaluates the SIMD2 arguments left to right: x's draw first, then y's.
        const gx = Math.min(Math.max(o.x + p.side * rng.uniform(0.45, 0.65), -0.9), 0.9);
        const gy = Math.min(Math.max(o.y + rng.uniform(-0.05, 0.15), -0.6), 0.6);
        p.gazeA = v2(gx, gy);
        break;
      }
      default:
        break;
    }
    return p;
  },

  /// Edge window lengths (seconds): guarantees exact zero and zero slope at both ends.
  edgeIn: 0.03,
  edgeOut: 0.05,

  /// Samples one one-shot at instance time `t` (seconds since trigger, speed already applied).
  /// Returns a full contribution (identity outside 0 < t < duration, except `ownsClosure`).
  sample(kind: OneShotKind, t: number, pIn: OneShotParams): OneShotOutput {
    // Edge antics sampled with empty params (library tests) use the reference trigger.
    const p = isEdgeAntic(kind) && pIn.edge.baseDuration <= 0 ? Edge.referenceParams(kind)
      : (isIdleGame(kind) && pIn.edge.hide <= 0 ? Game.gameReferenceParams(kind) : pIn);
    const L = OneShotLibrary;
    const base = L.baseDuration(kind, p);
    // At or past the instance duration, exactly the end (no rounding short of the edge window's zero).
    // f32: `base * timeMul` is the Float instance duration (`duration`), the playhead's end mark.
    const tb = t >= L.duration(kind, p) ? base : Math.min(Math.max(t / Math.max(p.timeMul, 0.01), 0), base);
    const raw = new OneShotOutput();
    switch (kind) {
      case 'laugh': laugh(tb, p, raw); break;
      case 'confusedShake': confusedShake(tb, p, raw); break;
      case 'dance': dance(tb, p, raw); break;
      case 'perkUp': perkUp(tb, p, raw); break;
      case 'sorryBlink': sorryBlink(tb, p, raw); break;
      case 'nodOff': nodOff(tb, p, raw); break;
      case 'yawn': yawn(tb, p, raw); break;
      case 'stretch': stretch(tb, p, raw); break;
      case 'lookAway': lookAway(tb, p, raw); break;
      case 'wake': wake(tb, p, raw); break;
      case 'delightedSquint': delightedSquint(tb, p, raw); break;
      case 'mockOffense': mockOffense(tb, p, raw); break;
      case 'bigSurprise': bigSurprise(tb, p, raw); break;
      case 'doubleTake': doubleTake(tb, p, raw); break;
      case 'curiousTilt': curiousTilt(tb, p, raw); break;
      case 'sideEye': sideEye(tb, p, raw); break;
      case 'crossEyed': crossEyed(tb, p, raw); break;
      case 'catchSelf': catchSelf(tb, p, raw); break;
      case 'shyPeek': Edge.shyPeek(tb, p, raw); break;
      case 'popUp': Edge.popUp(tb, p, raw); break;
      case 'curiousLean': Edge.curiousLean(tb, p, raw); break;
      case 'pretendExit': Edge.pretendExit(tb, p, raw); break;
      case 'sleepySink': Edge.sleepySink(tb, p, raw); break;
      case 'nodYes': Answer.nodYes(tb, p, raw); break;
      case 'nodYesBig': Answer.nodYesBig(tb, p, raw); break;
      case 'shakeNo': Answer.shakeNo(tb, p, raw); break;
      case 'shakeNoBig': Answer.shakeNoBig(tb, p, raw); break;
      case 'pingPong': case 'basketball': case 'juggling': case 'yoYo': case 'leapfrog': case 'staringContest':
      case 'hideAndSeek': case 'catchTheFly': case 'danceBreak': case 'hulaHoop':
        Game.gameSample(kind, tb, p, raw);
        break;
      case 'starEyes': case 'heartEyes': case 'noteEyes': case 'questionEyes': case 'exclaimEyes': {
        const out = new OneShotOutput();
        Shape.shapeSample(kind, tb, p, raw, out);
        raw.blink = Math.min(Math.max(raw.blink, 0), 1);
        raw.lidClose = Math.min(Math.max(raw.lidClose, 0), 1);
        const edge = Ease.smoothstep(tb / L.edgeIn) * Ease.smoothstep((base - tb) / L.edgeOut);
        L.accumulate(raw, edge, out);
        out.gaze = tb < base ? raw.gaze : null;
        return out;
      }
    }
    raw.blink = Math.min(Math.max(raw.blink, 0), 1);
    raw.lidClose = Math.min(Math.max(raw.lidClose, 0), 1);
    const edge = Ease.smoothstep(tb / L.edgeIn) * Ease.smoothstep((base - tb) / L.edgeOut);
    const out = new OneShotOutput();
    L.accumulate(raw, edge, out);
    out.gaze = tb < base ? raw.gaze : null;
    out.ownsClosure = L.spec(kind).ownsClosure;
    if (isIdleGame(kind)) {
      // Games may show a pupil silhouette (OneShotSampler lets a transformation win); identity at both ends.
      const inside = tb > 0 && tb < base;
      out.pupilShape = inside ? { ...raw.pupilShape } : v2(0);
      out.pupilMorph = inside ? { ...raw.pupilMorph } : v2(0);
      out.pupilShapeScale = inside ? { ...raw.pupilShapeScale } : v4(1);
    }
    return out;
  },

  /// Combines `src` scaled by `w` (0 = identity, 1 = full) into `o`: sums deltas and coverage, multiplies scales, pupil
  /// size and brightness, max-combines closure channels. Gaze is not touched.
  accumulate(src: OneShotOutput, w: number, o: OneShotOutput): void {
    const od = o.delta.raw, sd = src.delta.raw;
    for (let i = 0; i < od.length; i++) od[i] += sd[i] * w;
    o.stageOffset.x += src.stageOffset.x * w; o.stageOffset.y += src.stageOffset.y * w;
    addScaled4(o.eyeStageOffset, src.eyeStageOffset, w);
    o.faceScaleMul.x *= 1 + (src.faceScaleMul.x - 1) * w; o.faceScaleMul.y *= 1 + (src.faceScaleMul.y - 1) * w;
    const e = o.eyeScaleMul, se = src.eyeScaleMul;
    e.x *= 1 + (se.x - 1) * w; e.y *= 1 + (se.y - 1) * w; e.z *= 1 + (se.z - 1) * w; e.w *= 1 + (se.w - 1) * w;
    o.pupilSizeMul.x *= 1 + (src.pupilSizeMul.x - 1) * w; o.pupilSizeMul.y *= 1 + (src.pupilSizeMul.y - 1) * w;
    addScaled4(o.lidCoverage, src.lidCoverage, w);
    o.blink = smax(o.blink, src.blink * w);
    o.lidClose = smax(o.lidClose, src.lidClose * w);
    o.brightnessMul *= 1 + (src.brightnessMul - 1) * w;
    const ob = o.browDelta.raw, sb = src.browDelta.raw;
    for (let i = 0; i < ob.length; i++) ob[i] += sb[i] * w;
  },

  /// Reduce Motion for the one-shots without their own handling (everything but the answers and the pupil
  /// transformations): scales the movement by `k`. Lids, blinks, pupils, brows and brightness keep their size.
  scaleMotion(o: OneShotOutput, k: number): void {
    if (k === 1) return;
    const d = o.delta.raw;
    for (let i = 0; i < d.length; i++) d[i] *= 1 + motionLanes[i] * (k - 1);
    o.stageOffset.x *= k; o.stageOffset.y *= k;
    o.eyeStageOffset.x *= k; o.eyeStageOffset.y *= k; o.eyeStageOffset.z *= k; o.eyeStageOffset.w *= k;
    o.faceScaleMul = v2(1 + (o.faceScaleMul.x - 1) * k, 1 + (o.faceScaleMul.y - 1) * k);
    const e = o.eyeScaleMul;
    o.eyeScaleMul = v4(1 + (e.x - 1) * k, 1 + (e.y - 1) * k, 1 + (e.z - 1) * k, 1 + (e.w - 1) * k);
  },

  motionLanes,

  // Helpers (shared with the curve files).
  px, py, stretchScale, window, blinkPulse, hump, setLids, brow, brows, stepResponse,

  crossAmount: 0.75,
  crossIn: new SpringParams(14.5, 0.5),
  crossOut: new SpringParams(21, 0.5),
  crossRelease: 0.6,
  surpPupilShrink: 0.4,
};

/// Swift.max(x, y) (`y >= x ? y : x`), for NaN parity.
const smax = (x: number, y: number): number => (y >= x ? y : x);

function addScaled4(o: V4, s: V4, w: number): void {
  o.x += s.x * w; o.y += s.y * w; o.z += s.z * w; o.w += s.w * w;
}

const FI = {
  centerX: ParamLayout.index('centerX'), centerY: ParamLayout.index('centerY'), angle: ParamLayout.index('angle'),
};

// MARK: - laugh (1.1 s): squint-and-dip anticipation, three damped "ha-ha-ha" bounces with stretch on take-off and
// squash on landing, lower lids up into a happy squint.

const laughY = new Track([[0, 0], [0.05, 0.35], [0.09, 0.45], [0.21, -2.5], [0.36, 0.25], [0.39, 0.3],
  [0.50, -1.55], [0.62, 0.18], [0.64, 0.2], [0.73, -0.9], [0.84, 0.12], [0.95, -0.05], [1.1, 0]]);
const laughSY = new Track([[0, 0], [0.08, -0.04], [0.13, 0.06], [0.21, -0.005], [0.32, 0.03], [0.375, -0.07],
  [0.43, 0.04], [0.50, 0], [0.59, 0.02], [0.625, -0.05], [0.68, 0.025], [0.73, 0],
  [0.84, -0.03], [0.92, 0.01], [1.1, 0]]);
const laughLower = new Track([[0, 0], [0.06, 0.12], [0.16, 0.38], [0.5, 0.33], [0.8, 0.34], [0.95, 0.18], [1.1, 0]]);
const laughUpper = new Track([[0, 0], [0.06, 0.1], [0.16, 0.05], [0.9, 0.04], [1.1, 0]]);

function laugh(t: number, p: OneShotParams, o: OneShotOutput): void {
  o.delta.raw[FI.centerY] = py(laughY.value(t) * p.amp);
  o.faceScaleMul = stretchScale(1 + laughSY.value(t) * p.amp);
  const lower = laughLower.value(t), upper = laughUpper.value(t);
  const asym = 0.08 * (p.v1 - 0.5) * lower;
  o.lidCoverage = v4(upper, lower + asym, upper, lower - asym);
  o.brightnessMul = 1 + 0.05 * window(t, 0.08, 0.2, 0.8, 1.05);
  // Brows lift into happy arches and bounce a beat behind each hop (follow-through adds the lag).
  const up = window(t, 0.04, 0.18, 0.85, 1.08);
  const bounce = -0.6 * (laughY.value(Math.max(t - 0.04, 0)) / 2.5);
  brows(o, { y: (0.07 * up + 0.025 * bounce) * p.amp, curvature: 0.18 * up });
}

// MARK: - confusedShake (0.9 s): small opposite lean, then a damped ~3 Hz head shake (face angle lags the translation
// for follow-through); one eye squints, the other "raises its brow".

function confusedShake(t: number, p: OneShotParams, o: OneShotOutput): void {
  const f = 3 * (0.92 + 0.16 * p.v1);
  const endW = Ease.smoothstep((0.9 - t) / 0.22);
  const antic = -0.3 * Ease.bump(t / 0.16);
  const osc = (lag: number): number => {
    const tau = Math.max(t - 0.07 - lag, 0);
    return Math.sin(2 * Math.PI * f * tau) * Math.exp(-2.4 * tau) * Ease.smoothstep(tau / 0.12);
  };
  // 3.4 so the first (ramped, decaying) swing peaks at ≈3 canvas units.
  o.delta.raw[FI.centerX] = px(3.4 * p.amp * p.side * (antic + osc(0)) * endW);
  o.delta.raw[FI.angle] = 3.5 * p.amp * p.side * (antic + osc(0.045)) * endW;
  const w = window(t, 0.04, 0.2, 0.6, 0.88);
  const squint = v2(0.28 * w, 0.12 * w), raised = v2(-0.08 * w, 0);
  const [l, r] = p.v2 < 0.5 ? [squint, raised] : [raised, squint];
  o.lidCoverage = v4(l.x, l.y, r.x, r.y);
  // Brows: the "raised" eye's brow arches up, the squinting eye's brow pinches down, with a little wiggle riding the
  // shake.
  const wig = 0.02 * osc(0.06) * endW;
  const up: Side = p.v2 < 0.5 ? 'right' : 'left';
  const down: Side = up === 'left' ? 'right' : 'left';
  brow(o, up, { y: 0.1 * w + wig, rotation: -3 * w, curvature: 0.2 * w });
  brow(o, down, { y: -0.03 * w - wig, curvature: -0.1 * w, inner: -0.08 * w });
}

// MARK: - dance (2.4 s): 120 BPM, four beats + settle. Head tilts ±8° alternating on the beat, dips and squashes on each
// beat, stretches between, eyes take turns hopping; happy squint; glow pulses.

function dance(t: number, p: OneShotParams, o: OneShotOutput): void {
  const beat = 0.5, t0 = 0.25, tEnd = 1.75;
  let g: number, y: number, sy: number, glow: number;
  if (t <= tEnd) {
    const ph = (t - t0) / beat;
    const k = Math.floor(ph + 0.5); // nearest beat; switches where g == 0, so amplitude changes stay continuous
    g = -Math.cos(Math.PI * ph) * (1 + 0.1 * Math.sin(k * 2.3 + p.v1 * 6.283));
    const h = (1 + Math.cos(2 * Math.PI * ph)) / 2;
    const h4 = h * h * h * h, lo = (1 - h) * (1 - h);
    const ramp = Ease.smoothstep(t / t0);
    y = (1.4 * h4 - 0.8 * lo) * ramp;
    sy = (-0.07 * h4 + 0.05 * lo) * ramp;
    glow = 0.04 * h4 * ramp;
  } else {
    const tau = t - tEnd;
    const gEnd = 1 + 0.1 * Math.sin(3 * 2.3 + p.v1 * 6.283);
    g = gEnd * Ease.dampedOsc(tau, 1.3, 5);
    const d = Ease.dampedOsc(tau, 2, 6);
    y = 1.4 * d;
    sy = -0.07 * d;
    glow = 0.04 * Math.max(d, 0);
  }
  const endW = Ease.smoothstep((2.4 - t) / 0.3);
  o.delta.raw[FI.angle] = 8 * p.amp * p.side * g * endW;
  o.delta.raw[FI.centerY] = py(y * p.amp * endW);
  o.faceScaleMul = stretchScale(1 + sy * p.amp * endW);
  const hopL = hump(t, 0.5, 0.22) + hump(t, 1.5, 0.22) + hump(t, 2.0, 0.24);
  const hopR = hump(t, 1.0, 0.22) + hump(t, 2.0, 0.24);
  const first = p.side > 0 ? 1 : 0; // which eye starts hopping varies per trigger
  o.delta.setEye('left', 'centerY', py(-1.3 * p.amp * (first * hopL + (1 - first) * hopR)));
  o.delta.setEye('right', 'centerY', py(-1.3 * p.amp * (first * hopR + (1 - first) * hopL)));
  setLids(o, 0.04 * window(t, 0, 0.3, 1.9, 2.35), 0.22 * window(t, 0, 0.3, 1.9, 2.35));
  o.brightnessMul = 1 + glow * endW;
  // Brows: happy arches, each hopping with its eye.
  const happy = window(t, 0, 0.3, 1.9, 2.35);
  brow(o, 'left', { y: 0.06 * happy + 0.04 * (first * hopL + (1 - first) * hopR), curvature: 0.15 * happy });
  brow(o, 'right', { y: 0.06 * happy + 0.04 * (first * hopR + (1 - first) * hopL), curvature: 0.15 * happy });
}

// MARK: - perkUp (0.5 s): dip + slight squint, then an underdamped scale pop to ~1.08 with lids snapping wide.

const perkScale = new Track([[0, 0], [0.04, -0.3], [0.08, -0.45], [0.16, 1.0], [0.23, 0.6], [0.29, 0.78], [0.36, 0.6], [0.5, 0]]);
const perkY = new Track([[0, 0], [0.07, 0.45], [0.16, -1.1], [0.25, -0.55], [0.32, -0.7], [0.5, 0]]);
const perkUpper = new Track([[0, 0], [0.06, 0.1], [0.13, -0.35], [0.3, -0.25], [0.5, 0]]);
const perkLower = new Track([[0, 0], [0.06, 0.06], [0.13, -0.15], [0.3, -0.1], [0.5, 0]]);

function perkUp(t: number, p: OneShotParams, o: OneShotOutput): void {
  const c = perkScale.value(t) * p.amp;
  o.faceScaleMul = v2(1 + 0.065 * c, 1 + 0.08 * c);
  o.delta.raw[FI.centerY] = py(perkY.value(t) * p.amp);
  setLids(o, perkUpper.value(t), perkLower.value(t));
  // Brows pop up with the scale (dipping a touch on the anticipation).
  brows(o, { y: 0.09 * c, curvature: 0.1 * Math.max(c, 0) });
}

// MARK: - sorryBlink (0.45 s): quick double blink with a sheepish recoil (shrink to 0.94, pull up).

const sorryRecoil = new Track([[0, 0], [0.09, 1], [0.2, 0.8], [0.3, 0.75], [0.45, 0]]);

function sorryBlink(t: number, p: OneShotParams, o: OneShotOutput): void {
  const gap = 0.015 * (p.v1 - 0.5);
  o.blink = smax(blinkPulse(t, 0, 0.06, 0.02, 0.10), blinkPulse(t, 0.2 + gap, 0.055, 0.015, 0.11));
  const r = sorryRecoil.value(t) * p.amp;
  o.faceScaleMul = v2(1 - 0.055 * r, 1 - 0.065 * r);
  o.delta.raw[FI.centerY] = py(-1.0 * r);
  // "Oops": the inner ends lift into a sheepish, concerned tilt.
  brows(o, { inner: 0.1 * r, outer: -0.03 * r });
}

// MARK: - nodOff (2.6 s): lids droop with a failed fight back, head sinks and tilts; at the bottom a startled snap open
// with a little jump, wide eyes, then a clearing blink.

const nodLid = new Track([[0, 0], [0.3, 0.12], [0.8, 0.45], [1.0, 0.32], [1.15, 0.36], [1.6, 0.68], [1.88, 0.8],
  [1.93, 0.8], [2.02, 0], [2.2, 0], [2.6, 0]]);
const nodY = new Track([[0, 0], [0.8, 0.9], [1.0, 0.6], [1.6, 2.0], [1.93, 2.6], [2.05, -1.2], [2.2, 0.3],
  [2.35, -0.15], [2.6, 0]]);
const nodAngle = new Track([[0, 0], [0.8, 2], [1.0, 1.2], [1.6, 5], [1.93, 6.5], [2.06, -1.5], [2.25, 0.6], [2.6, 0]]);
const nodScale = new Track([[0, 0], [1.5, -0.01], [1.93, -0.02], [2.05, 0.06], [2.2, -0.01], [2.6, 0]]);
const nodWide = new Track([[0, 0], [1.95, 0], [2.05, -0.25], [2.3, -0.12], [2.5, 0], [2.6, 0]]);

function nodOff(t: number, p: OneShotParams, o: OneShotOutput): void {
  o.lidClose = nodLid.value(t);
  o.blink = blinkPulse(t, 2.2, 0.05, 0.02, 0.1);
  o.delta.raw[FI.centerY] = py(nodY.value(t) * p.amp);
  o.delta.raw[FI.angle] = nodAngle.value(t) * p.amp * p.side;
  const s = nodScale.value(t) * p.amp;
  o.faceScaleMul = v2(1 + s * 0.85, 1 + s);
  const w = nodWide.value(t);
  setLids(o, w, w * 0.4);
  // Brows sag with the drooping lids, then jump up at the startled snap open.
  brows(o, { y: -0.05 * nodLid.value(t) + 0.45 * Math.max(-w, 0), curvature: 0.5 * Math.max(-w, 0), outer: -0.04 * nodLid.value(t) });
}

// MARK: - yawn (2.2 s): small inhale (rise, eyes open), slow squeeze shut with a tall stretch, a tremble at the peak,
// then a slow heavy release with a slight undershoot.

const yawnLid = new Track([[0, 0], [0.3, 0], [0.4, 0.1], [0.75, 0.6], [0.95, 0.7], [1.4, 0.68], [1.7, 0.4], [2.0, 0.1], [2.2, 0]]);
const yawnSY = new Track([[0, 0], [0.3, 0.03], [0.45, 0.02], [0.85, 0.12], [1.4, 0.115], [1.8, -0.02], [2.0, 0.005], [2.2, 0]]);
const yawnY = new Track([[0, 0], [0.3, -0.6], [0.5, -0.4], [0.9, -1.3], [1.4, -1.2], [1.85, 0.25], [2.2, 0]]);
const yawnLower = new Track([[0, 0], [0.3, -0.08], [0.5, 0], [0.85, 0.25], [1.4, 0.22], [1.9, 0], [2.2, 0]]);
const yawnUpper = new Track([[0, 0], [0.3, -0.1], [0.5, 0], [2.2, 0]]);

function yawn(t: number, p: OneShotParams, o: OneShotOutput): void {
  o.lidClose = yawnLid.value(t);
  const tremble = 0.008 * Math.sin(2 * Math.PI * 6 * t + p.v1 * 6.283) * window(t, 0.85, 0.95, 1.3, 1.4);
  o.faceScaleMul = stretchScale(1 + (yawnSY.value(t) + tremble) * p.amp);
  o.delta.raw[FI.centerY] = py(yawnY.value(t) * p.amp);
  setLids(o, yawnUpper.value(t), yawnLower.value(t));
  // A cartoon yawn: the brows lift and their inner ends rise as the eyes squeeze shut.
  const lid = yawnLid.value(t);
  brows(o, { y: 0.07 * lid * p.amp, curvature: 0.1 * lid, inner: 0.06 * lid });
}

// MARK: - stretch (1.4 s): crouch, strain up to 1.15 tall with squeezed eyes and a tremble, then let go with a drop,
// overshoot and settle.

const stretchSY = new Track([[0, 0], [0.08, -0.035], [0.15, -0.05], [0.35, 0.08], [0.55, 0.15], [0.72, 0.155],
  [0.8, 0.14], [0.92, -0.06], [1.06, 0.03], [1.2, -0.01], [1.4, 0]]);
const stretchY = new Track([[0, 0], [0.15, 0.4], [0.55, -1.5], [0.78, -1.5], [0.92, 0.35], [1.06, -0.15], [1.4, 0]]);
const stretchLid = new Track([[0, 0], [0.3, 0.05], [0.55, 0.25], [0.75, 0.25], [0.9, 0], [1.0, -0.08], [1.4, 0]]);

function stretch(t: number, p: OneShotParams, o: OneShotOutput): void {
  const tremble = 0.006 * Math.sin(2 * Math.PI * 7 * t + p.v1 * 6.283) * window(t, 0.5, 0.55, 0.7, 0.78);
  o.faceScaleMul = stretchScale(1 + (stretchSY.value(t) + tremble) * p.amp);
  o.delta.raw[FI.centerY] = py(stretchY.value(t) * p.amp);
  const l = stretchLid.value(t);
  setLids(o, l, l * 0.6);
  // Brows ride the strain up and drop with the release.
  brows(o, { y: 0.5 * stretchSY.value(t) * p.amp, inner: 0.25 * Math.max(stretchSY.value(t), 0) });
}

// MARK: - lookAway (1.6 s): a hesitant little squint while the eyes dart to a side/down point chosen at trigger, a
// second small drift further away, then release (normal targeting brings them back).

const lookUpper = new Track([[0, 0], [0.07, 0.14], [0.3, 0.18], [1.15, 0.16], [1.6, 0]]);
const lookLower = new Track([[0, 0], [0.3, 0.05], [1.2, 0.05], [1.6, 0]]);

function lookAway(t: number, p: OneShotParams, o: OneShotOutput): void {
  if (t < 1.25) o.gaze = makeGazeOverride(t < 0.75 ? p.gazeA : p.gazeB, 'saccade');
  setLids(o, lookUpper.value(t), lookLower.value(t));
  // Embarrassed: inner ends up a little, the brows a touch lower.
  const k = lookUpper.value(t) / 0.18;
  brows(o, { y: -0.02 * k, inner: 0.07 * k });
}

// MARK: - wake (1.8 s): lids held heavy (≈0.6 of the opening) and opened slowly with one sleepy hesitation — starting
// from the current (closed-looking) opening, never invisible — then a blink-clear double blink and a small stretch.

const wakeLid = new Track([[0, 0], [0.12, 0.6], [0.35, 0.62], [0.6, 0.4], [0.72, 0.47], [1.0, 0.1], [1.1, 0], [1.8, 0]]);
const wakeSY = new Track([[0, 0], [1.3, 0], [1.36, -0.02], [1.55, 0.09], [1.7, -0.02], [1.8, 0]]);
const wakeY = new Track([[0, 0], [1.3, 0], [1.36, 0.2], [1.55, -0.9], [1.7, 0.1], [1.8, 0]]);

function wake(t: number, p: OneShotParams, o: OneShotOutput): void {
  o.lidClose = wakeLid.value(t);
  o.blink = smax(blinkPulse(t, 1.12, 0.06, 0.02, 0.11), blinkPulse(t, 1.33 + 0.02 * p.v1, 0.055, 0.015, 0.1));
  o.faceScaleMul = stretchScale(1 + wakeSY.value(t) * p.amp);
  o.delta.raw[FI.centerY] = py(wakeY.value(t) * p.amp);
  // Brows lift with the little stretch at the end (presence brings them back with the opening eyes).
  brows(o, { y: 0.6 * wakeSY.value(t) * p.amp });
}

// MARK: - delightedSquint (1.0 s): tiny dip, then a happy hop with lower lids springing up into a squint.

export const squintLower = new Track([[0, 0], [0.05, -0.05], [0.16, 0.5], [0.24, 0.42], [0.7, 0.45], [1.0, 0]]);
export const squintY = new Track([[0, 0], [0.06, 0.3], [0.18, -1.1], [0.32, 0.25], [0.42, -0.15], [0.55, 0], [1.0, 0]]);
export const squintScale = new Track([[0, 0], [0.06, -0.02], [0.17, 0.045], [0.3, -0.02], [0.42, 0.01], [0.6, 0], [1.0, 0]]);

function delightedSquint(t: number, p: OneShotParams, o: OneShotOutput): void {
  const lower = squintLower.value(t) * (0.9 + 0.2 * p.v1);
  setLids(o, 0.1 * Math.max(lower, 0) / 0.5, lower);
  o.delta.raw[FI.centerY] = py(squintY.value(t) * p.amp);
  o.faceScaleMul = stretchScale(1 + squintScale.value(t) * p.amp);
  // Delight dilates the pupils (×1.15), easing in with the hop.
  const d = 1 + 0.15 * window(t, 0.04, 0.26, 0.65, 0.98);
  o.pupilSizeMul = v2(d, d);
  // Delighted: buoyant arches that hop with the face.
  const happy = window(t, 0.04, 0.2, 0.62, 0.98);
  brows(o, { y: (0.06 * happy - 0.03 * squintY.value(t)) * p.amp, curvature: 0.2 * happy, peak: -0.06 * happy });
}

// MARK: - mockOffense (1.7 s): a beat of wide-eyed disbelief, then a sharp pull back (shrink, up, head turned) with
// indignant angled lids; held, with a little "hmph" bob; then relax with overshoot.

const offUpper = new Track([[0, 0], [0.1, -0.15], [0.16, -0.12], [0.3, 0.38], [0.7, 0.36], [0.78, 0.42],
  [1.05, 0.38], [1.4, 0.05], [1.55, -0.03], [1.7, 0]]);
const offLidAngle = new Track([[0, 0], [0.16, 0], [0.3, 1], [1.05, 1], [1.5, 0], [1.7, 0]]);
const offScale = new Track([[0, 0], [0.1, 0.02], [0.16, 0.03], [0.28, -1], [0.38, -0.85], [1.05, -0.9],
  [1.3, 0.12], [1.45, -0.04], [1.7, 0]]);
const offY = new Track([[0, 0], [0.1, 0.2], [0.28, -1.6], [0.4, -1.35], [0.7, -1.4], [0.78, -1.0], [0.88, -1.4],
  [1.05, -1.35], [1.35, 0.3], [1.5, -0.1], [1.7, 0]]);
const offAngle = new Track([[0, 0], [0.12, -0.1], [0.3, 1], [1.05, 0.95], [1.4, -0.1], [1.7, 0]]);

function mockOffense(t: number, p: OneShotParams, o: OneShotOutput): void {
  const u = offUpper.value(t);
  setLids(o, u, 0.1 * Math.max(u, 0));
  // Negative left upper-lid angle = inner end lower (as in Anger).
  const a = 10 * offLidAngle.value(t);
  o.delta.setEye('left', 'upperLidAngle', -a);
  o.delta.setEye('right', 'upperLidAngle', a);
  const c = offScale.value(t) * p.amp;
  o.faceScaleMul = v2(1 + 0.1 * c, 1 + 0.08 * c);
  o.delta.raw[FI.centerY] = py(offY.value(t) * p.amp);
  o.delta.raw[FI.angle] = 5 * p.side * offAngle.value(t) * p.amp;
  // Brows: up in disbelief for a beat, then the mock-annoyed V (inner ends down, arches peaking outward), a little
  // extra pinch on the "hmph".
  const v = offLidAngle.value(t);
  const disbelief = Math.max(-u, 0) / 0.15;
  const hmph = 0.04 * hump(t, 0.83, 0.16);
  brows(o, { y: 0.06 * disbelief, rotation: -14 * v, curvature: 0.1 * v, inner: -0.12 * v - hmph, outer: 0.08 * v, peak: 0.2 * v });
}

// MARK: - bigSurprise (1.2 s): anticipation squint + crouch, then a big pop to ~1.2 with a jump, lids flung wide and a
// glow flash; wobbly settle, hold, then ease back.

const surpScale = new Track([[0, 0], [0.05, -0.15], [0.1, -0.25], [0.19, 1.12], [0.28, 0.82], [0.38, 0.98],
  [0.5, 0.9], [0.8, 0.88], [1.2, 0]]);
const surpUpper = new Track([[0, 0], [0.08, 0.22], [0.11, 0.2], [0.19, -0.45], [0.35, -0.38], [0.85, -0.36], [1.2, 0]]);
const surpLower = new Track([[0, 0], [0.08, 0.15], [0.19, -0.3], [0.85, -0.25], [1.2, 0]]);
const surpY = new Track([[0, 0], [0.09, 0.45], [0.2, -1.7], [0.32, -0.9], [0.45, -1.2], [0.8, -1.0], [1.2, 0]]);
const surpGlow = new Track([[0, 0], [0.1, 0], [0.2, 1], [0.5, 0.3], [1.2, 0]]);
/// Pupil shrink (0…1 of `surpPupilShrink`): dots at the pop, slow recovery.
const surpPupil = new Track([[0, 0], [0.1, 0], [0.17, 1], [0.3, 0.92], [0.55, 0.8], [0.9, 0.35], [1.2, 0]]);
const surpPupilShrink = 0.4;

function bigSurprise(t: number, p: OneShotParams, o: OneShotOutput): void {
  const c = surpScale.value(t) * p.amp;
  o.faceScaleMul = v2(1 + 0.17 * c, 1 + 0.22 * c);
  setLids(o, surpUpper.value(t), surpLower.value(t));
  o.delta.raw[FI.centerY] = py(surpY.value(t) * p.amp);
  o.brightnessMul = 1 + 0.1 * Math.max(surpGlow.value(t), 0);
  // Startle: pupils shrink to dots at the pop (≈ ×0.6), then recover.
  const s = 1 - surpPupilShrink * Math.min(Math.max(surpPupil.value(t), 0), 1.1);
  o.pupilSizeMul = v2(s, s);
  // Brows dip with the anticipation squint, then shoot up into high arches with the pop.
  const b = c / 1.12;
  brows(o, { y: 0.12 * b, rotation: 2 * Math.max(b, 0), curvature: 0.22 * Math.max(b, 0) });
}

// MARK: - doubleTake (1.4 s): casual glance away, glance back… beat… then the snap: squint of disbelief, eyes pop wide
// with a jolt.

const takeUpper = new Track([[0, 0], [0.1, 0.1], [0.38, 0.1], [0.48, 0.18], [0.55, 0.2], [0.63, -0.4], [0.9, -0.32], [1.4, 0]]);
const takeLower = new Track([[0, 0], [0.4, 0], [0.5, 0.1], [0.63, -0.2], [0.9, -0.15], [1.4, 0]]);
const takeScale = new Track([[0, 0], [0.48, 0], [0.55, -0.3], [0.64, 1], [0.74, 0.7], [0.84, 0.85], [1.05, 0.6], [1.4, 0]]);
const takeY = new Track([[0, 0], [0.48, 0], [0.55, 0.4], [0.64, -1.3], [0.76, -0.6], [0.9, -0.8], [1.4, 0]]);

function doubleTake(t: number, p: OneShotParams, o: OneShotOutput): void {
  if (t < 0.42) o.gaze = makeGazeOverride(p.gazeA, 'saccade');
  else if (t < 1.1) o.gaze = makeGazeOverride(p.gazeB, 'saccade');
  setLids(o, takeUpper.value(t), takeLower.value(t));
  const c = takeScale.value(t) * p.amp;
  o.faceScaleMul = v2(1 + 0.10 * c, 1 + 0.14 * c);
  o.delta.raw[FI.centerY] = py(takeY.value(t) * p.amp);
  // Brows knit on the squint of disbelief, then pop up on the second look.
  brows(o, { y: 0.12 * c, curvature: 0.18 * Math.max(c, 0), inner: 0.1 * Math.min(c, 0) });
}

// MARK: - curiousTilt (2.0 s): small counter-lean, slow tilt to ~10° with overshoot, the raised eye a little bigger and
// wider; a second "hmm?" nudge mid-hold, then ease out.

const tiltShape = new Track([[0, 0], [0.12, -0.08], [0.55, 1.0], [0.66, 1.07], [0.8, 1.0], [1.05, 1.0], [1.15, 1.15],
  [1.3, 1.02], [1.45, 1.0], [1.75, 0.45], [2.0, 0]]);

function curiousTilt(t: number, p: OneShotParams, o: OneShotOutput): void {
  const a = tiltShape.value(t);
  o.delta.raw[FI.angle] = 10 * p.amp * p.side * a;
  const big: Side = p.side > 0 ? 'left' : 'right';
  const small: Side = p.side > 0 ? 'right' : 'left';
  const up = 0.08 * a * p.amp, down = -0.03 * a * p.amp;
  o.delta.setEye(big, 'scaleX', up); o.delta.setEye(big, 'scaleY', up);
  o.delta.setEye(small, 'scaleX', down); o.delta.setEye(small, 'scaleY', down);
  const wide = -0.1 * Math.max(a, 0), narrow = 0.08 * Math.max(a, 0);
  o.lidCoverage = big === 'left' ? v4(wide, 0, narrow, 0) : v4(narrow, 0, wide, 0);
  // Curious: the raised eye's brow arches high, the other lowers and flattens.
  brow(o, big, { y: 0.12 * a * p.amp, rotation: -4 * a, curvature: 0.3 * a });
  brow(o, small, { y: -0.03 * a * p.amp, curvature: -0.15 * a });
}

// MARK: - sideEye (2.4 s): eyes slide slowly to the side while heavy lids lower (far eye a touch lower, lids slanted
// toward the look); a suspicious creep further, then release.

function sideEye(t: number, p: OneShotParams, o: OneShotOutput): void {
  // Pupils only: the head stays put while the eyes slide into the corner.
  if (t < 1.95) o.gaze = makeGazeOverride(t < 1.1 ? p.gazeA : p.gazeB, 'smooth', true);
  const k = window(t, 0, 0.55, 1.9, 2.4);
  const narrow = 0.06 * hump(t, 1.25, 0.5);
  const near = (0.38 + narrow) * k * p.amp, far = (0.46 + narrow) * k * p.amp;
  const lower = 0.12 * k;
  // Gaze to viewer's right (side > 0) → right eye is the near eye.
  o.lidCoverage = p.side > 0 ? v4(far, lower, near, lower) : v4(near, lower, far, lower);
  const slant = -3 * p.side * k;
  o.delta.setEye('left', 'upperLidAngle', slant);
  o.delta.setEye('right', 'upperLidAngle', slant);
  // Suspicion: the far eye's brow lowers (inner end down), the near one lifts a sceptical touch.
  const nearSide: Side = p.side > 0 ? 'right' : 'left';
  const farSide: Side = p.side > 0 ? 'left' : 'right';
  brow(o, farSide, { y: -0.05 * k, curvature: -0.08 * k, inner: -0.1 * k });
  brow(o, nearSide, { y: 0.04 * k, curvature: 0.08 * k });
}

// MARK: - crossEyed (0.9 s): a moment of silliness. The eyes glance most of the way back to centre while the pupils
// converge on "the nose" (±0.75 inward) with an underdamped spring, hold with a ~7 Hz wobble, then release with a
// little outward overshoot.

function crossEyed(t: number, p: OneShotParams, o: OneShotOutput): void {
  const L = OneShotLibrary;
  if (t < 0.75) o.gaze = makeGazeOverride(p.gazeA, 'saccade');
  const c = stepResponse(t, L.crossIn) - stepResponse(t - L.crossRelease, L.crossOut);
  const hold = window(t, 0.2, 0.3, 0.55, 0.63);
  const ph = 2 * Math.PI * 7 * (t - 0.25) + p.v1 * 6.283;
  const wobble = 0.04 * Math.sin(ph) * hold;
  const wobbleY = 0.02 * Math.sin(ph * 0.5 + 1.3) * hold;
  const inward = L.crossAmount * p.amp * c + wobble;
  // Left eye sits on the viewer's left: inward is +x for it, −x for the right eye.
  o.delta.setEye('left', 'x', inward);
  o.delta.setEye('right', 'x', -inward);
  o.delta.setEye('left', 'y', wobbleY);
  o.delta.setEye('right', 'y', -wobbleY);
  // Silly: brows up, inner ends raised.
  brows(o, { y: 0.05 * c, inner: 0.05 * c });
}

// MARK: - catchSelf (1.0 s): "whoops, was I dozing?" A tiny droop, then the snap open of a nod-off's tail: lids pop
// wide with a little startled jump and scale pop, a quick clearing blink, a small settle.

const catchLid = new Track([[0, 0], [0.06, 0.25], [0.14, 0.45], [0.2, 0], [1.0, 0]]);
const catchY = new Track([[0, 0], [0.14, 0.8], [0.22, -1.1], [0.36, 0.25], [0.5, -0.1], [0.7, 0], [1.0, 0]]);
const catchAngle = new Track([[0, 0], [0.14, 1.5], [0.24, -0.8], [0.4, 0.3], [0.7, 0], [1.0, 0]]);
const catchScale = new Track([[0, 0], [0.14, -0.01], [0.22, 0.05], [0.34, -0.01], [0.5, 0.005], [1.0, 0]]);
const catchWide = new Track([[0, 0], [0.18, 0], [0.24, -0.22], [0.5, -0.1], [0.8, 0], [1.0, 0]]);

function catchSelf(t: number, p: OneShotParams, o: OneShotOutput): void {
  o.lidClose = catchLid.value(t);
  o.blink = blinkPulse(t, 0.42, 0.05, 0.02, 0.1);
  o.delta.raw[FI.centerY] = py(catchY.value(t) * p.amp);
  o.delta.raw[FI.angle] = catchAngle.value(t) * p.amp * p.side;
  const sc = catchScale.value(t) * p.amp;
  o.faceScaleMul = v2(1 + sc * 0.85, 1 + sc);
  const w = catchWide.value(t);
  setLids(o, w, w * 0.4);
  // Brows sag on the droop, then fly up at the snap open.
  brows(o, { y: -0.04 * catchLid.value(t) + 0.45 * Math.max(-w, 0), curvature: 0.5 * Math.max(-w, 0) });
}

export { EdgeAnticContext };
