// Port of FaceEngine/Commands.swift.
import type { V2 } from '../core/vec';
import type { VocalContour } from '../model';
import type { OneShotRequest } from './OneShots';
import type { ReactionCue } from './PupilReactionTypes';

/// One-shot animations. Implementations live in OneShots.ts (and the curve files).
export type OneShotKind =
  | 'laugh' | 'confusedShake' | 'dance' | 'perkUp' | 'sorryBlink' | 'nodOff' | 'yawn' | 'stretch' | 'lookAway' | 'wake'
  | 'delightedSquint' | 'mockOffense' | 'bigSurprise' | 'doubleTake' | 'curiousTilt' | 'sideEye' | 'crossEyed'
  /// Catching yourself dozing (life cycle, drowsy → idle). Not state-scoped.
  | 'catchSelf'
  /// Screen-edge antics.
  | 'shyPeek' | 'popUp' | 'curiousLean' | 'pretendExit'
  /// Falling asleep (life cycle, drowsy → asleep). Never leaves the screen.
  | 'sleepySink'
  /// Pupil transformations.
  | 'starEyes' | 'heartEyes' | 'noteEyes' | 'questionEyes' | 'exclaimEyes'
  /// Answers.
  | 'nodYes' | 'nodYesBig' | 'shakeNo' | 'shakeNoBig'
  /// Idle games.
  | 'pingPong' | 'basketball' | 'juggling' | 'yoYo' | 'leapfrog' | 'staringContest' | 'hideAndSeek' | 'catchTheFly'
  | 'danceBreak' | 'hulaHoop';

const KINDS: readonly OneShotKind[] = [
  'laugh', 'confusedShake', 'dance', 'perkUp', 'sorryBlink', 'nodOff', 'yawn', 'stretch', 'lookAway', 'wake',
  'delightedSquint', 'mockOffense', 'bigSurprise', 'doubleTake', 'curiousTilt', 'sideEye', 'crossEyed', 'catchSelf',
  'shyPeek', 'popUp', 'curiousLean', 'pretendExit', 'sleepySink',
  'starEyes', 'heartEyes', 'noteEyes', 'questionEyes', 'exclaimEyes',
  'nodYes', 'nodYesBig', 'shakeNo', 'shakeNoBig',
  'pingPong', 'basketball', 'juggling', 'yoYo', 'leapfrog', 'staringContest', 'hideAndSeek', 'catchTheFly',
  'danceBreak', 'hulaHoop',
];
const ORDINAL = new Map<OneShotKind, number>(KINDS.map((k, i) => [k, i]));

export const OneShotKind = {
  allCases: KINDS,
  count: 42,
  /// Stable dense index (allocation-free, for per-kind tables). Equals the declaration order.
  ordinal: (k: OneShotKind): number => ORDINAL.get(k)!,
  /// Swift `OneShotKind(rawValue:)`.
  fromRaw: (raw: string): OneShotKind | undefined => ORDINAL.has(raw as OneShotKind) ? raw as OneShotKind : undefined,
} as const;

/// A person the eyes can look at. Positions are in normalised gaze space:
/// x -1 (viewer's left of screen) ... 1 (right), y -1 (up) ... 1 (down); (0,0) = straight ahead.
export interface PersonTarget {
  id: number;
  position: V2;
  /// Metres from the device; drives eye convergence. Use ~1.5 if unknown.
  distance: number;
  /// 0...1, how interesting (engagement, motion).
  salience: number;
  /// 0...1, how squarely the person's head is turned toward the eyes on screen (1 when unknown).
  facing: number;
  /// 0...1, perception's eye-contact level (0 when unknown).
  lookingAtMe: number;
}

export function makePersonTarget(id: number, position: V2, distance = 1.5, salience = 0.5, facing = 1,
  lookingAtMe = 0): PersonTarget {
  return {
    id, position: { ...position }, distance, salience,
    facing: Number.isFinite(facing) ? Math.min(Math.max(facing, 0), 1) : 1,
    lookingAtMe: Number.isFinite(lookingAtMe) ? Math.min(Math.max(lookingAtMe, 0), 1) : 0,
  };
}

/// Discrete inputs queued for the next frame (Swift enum with payloads).
export type FaceCommand =
  | { kind: 'playOneShot'; oneShot: OneShotKind }
  /// Brief look at a point, then return.
  | { kind: 'glance'; at: V2; duration: number }
  /// Something moved or made a sound there; glance toward it and lose interest.
  | { kind: 'stimulus'; at: V2; strength: number }
  /// Rest gaze at a point until a new target appears.
  | { kind: 'restGaze'; at: V2 }
  /// Force a single blink now.
  | { kind: 'blink' }
  /// Start a one-shot so that it begins at a given host time (display-link seconds).
  | { kind: 'playOneShotAt'; oneShot: OneShotKind; hostTime: number }
  /// A vocal note the face should react to, timed to when it is heard.
  | { kind: 'vocalCue'; cue: VocalCue }
  /// Drop vocal cues at or after this host time; active ones fade out.
  | { kind: 'cancelVocalCues'; fromHostTime: number }
  /// Someone tapped the screen at a point in normalised gaze space (clamped to ±1).
  | { kind: 'tap'; at: V2 }
  /// One stroke of a scratch, with a 0…1 intensity from the stroke rate.
  | { kind: 'scratch'; at: V2; intensity: number }
  /// Start a one-shot with per-instance options.
  | { kind: 'play'; request: OneShotRequest }
  /// A semantic moment that may deserve a pupil transformation; the PupilReactions arbiter decides.
  | { kind: 'reactionCue'; cue: ReactionCue }
  /// The person did something worth watching. NoticingAttention snaps back to watching them.
  | { kind: 'attend'; personID: number | null };

export const FaceCommand = {
  playOneShot: (oneShot: OneShotKind): FaceCommand => ({ kind: 'playOneShot', oneShot }),
  glance: (at: V2, duration: number): FaceCommand => ({ kind: 'glance', at: { ...at }, duration }),
  stimulus: (at: V2, strength: number): FaceCommand => ({ kind: 'stimulus', at: { ...at }, strength }),
  restGaze: (at: V2): FaceCommand => ({ kind: 'restGaze', at: { ...at } }),
  blink: { kind: 'blink' } as FaceCommand,
  playOneShotAt: (oneShot: OneShotKind, hostTime: number): FaceCommand => ({ kind: 'playOneShotAt', oneShot, hostTime }),
  vocalCue: (cue: VocalCue): FaceCommand => ({ kind: 'vocalCue', cue }),
  cancelVocalCues: (fromHostTime: number): FaceCommand => ({ kind: 'cancelVocalCues', fromHostTime }),
  tap: (at: V2): FaceCommand => ({ kind: 'tap', at: { ...at } }),
  scratch: (at: V2, intensity: number): FaceCommand => ({ kind: 'scratch', at: { ...at }, intensity }),
  play: (request: OneShotRequest): FaceCommand => ({ kind: 'play', request }),
  reactionCue: (cue: ReactionCue): FaceCommand => ({ kind: 'reactionCue', cue }),
  attend: (personID: number | null): FaceCommand => ({ kind: 'attend', personID }),
} as const;

/// How a vocal note should colour the face's reaction.
export type VocalCueKind = 'plain' | 'accent' | 'startle' | 'curious' | 'sleepy' | 'wobble' | 'question';

/// One vocal note as the face sees it. Produced by the voice director from the same plan the synth plays.
export interface VocalCue {
  /// Audible onset in host seconds (display-link time base).
  hostTime: number;
  /// Note length in seconds (real time).
  duration: number;
  /// Pitch contour (semitones relative to the voice's base pitch), shared with the synth.
  contour: VocalContour;
  /// 0…1 loudness of the note.
  intensity: number;
  /// 0…1 attack sharpness.
  articulation: number;
  /// Pleasure of the affect the phrase was planned from (-1…1).
  valence: number;
  kind: VocalCueKind;
  /// True for notes that should get a discrete hop (accented, or ≥180 ms since the previous onset).
  accent: boolean;
  /// The one-shot paired with this phrase, if any (VocalSync softens overlapping channels).
  pairedOneShot?: OneShotKind;
}

export function makeVocalCue(o: Omit<VocalCue, 'kind' | 'accent'> & Partial<Pick<VocalCue, 'kind' | 'accent'>>): VocalCue {
  return { kind: 'plain', accent: false, ...o };
}

/// A one-shot that started this frame (published by OneShotSampler so the voice can match it).
export interface StartedOneShot {
  kind: OneShotKind;
  /// Engine time at which it started.
  engineTime: number;
  /// Host time of the frame on which it started (null when the engine is driven without host time).
  hostTime: number | null;
  /// Playback rate (speed × per-trigger time jitter): accent at `accentTime / rate` seconds after start.
  rate: number;
  /// Accent offsets in seconds at rate 1 (copied from the one-shot spec).
  accentTimes: number[];
  /// The request asked for a soft auto-vocalisation (`OneShotRequest.softVoice`).
  softVoice: boolean;
}

/// How a gaze move should be executed.
export type GazeMoveMode = 'saccade' | 'smooth';

/// A gaze instruction produced by one-shots, overriding normal targeting while active.
export interface GazeOverride {
  point: V2;
  mode: GazeMoveMode;
  /// Move only the pupils: the head and eye shapes hold where they were (side-eye).
  pupilsOnly: boolean;
}

export const makeGazeOverride = (point: V2, mode: GazeMoveMode, pupilsOnly = false): GazeOverride =>
  ({ point: { ...point }, mode, pupilsOnly });
