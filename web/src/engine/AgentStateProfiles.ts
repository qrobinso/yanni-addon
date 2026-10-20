// Port of FaceEngine/AgentStateProfiles.swift.
import type { V2 } from '../core/vec';
import { ExpressionMix, mixEntry as E } from '../model';
import { Modulation, type AgentState } from './AgentState';
import type { OneShotKind } from './Commands';
import type { GazeIntent } from './FaceState';

/// A visual-only automatic hand-off to another state, fired when an entry one-shot completes.
export interface AgentAutoTransition {
  /// The one-shot whose completion triggers the hand-off.
  after: OneShotKind;
  to: AgentState;
  /// Extra hold (seconds) after the one-shot completes before switching.
  delay: number;
}

/// A recurring one-shot while a state is held (drowsy nod-offs, hasMessage perk-ups).
/// Intervals are drawn at each event (lognormal, clamped), never as per-frame chances.
export interface AgentRecurringBeat {
  /// Primary beat kind.
  kind: OneShotKind;
  /// Optional alternate (e.g. yawn among nod-offs) and its probability per event after the first.
  alternate?: OneShotKind;
  alternateChance: number;
  /// First event: uniform in this window after entry.
  firstDelay: readonly [number, number];
  /// Later events: lognormal(median, sigma) clamped to `clamp`.
  median: number;
  sigma: number;
  clamp: readonly [number, number];
}

/// A second stage a fixed time after entry (waking: Tiredness → Neutral, rest gaze → track).
export interface AgentStage2 {
  after: number;
  mix?: ExpressionMix;
  gaze?: GazeIntent;
}

/// Everything an agent state wants from the face. Pure data; `AgentStateBehavior` applies it.
export interface AgentStateProfile {
  mix: ExpressionMix;
  gaze: GazeIntent;
  /// Multipliers (speed, intensity, blinkRate, blinkDuration, glanceRate) and additive terms
  /// (lidHeaviness, bounciness) combined with mood by `MoodModulation`.
  modulation: Modulation;
  breathingDepth: number;
  targetBrightness: number;
  /// Face tilt in degrees (positive = counter-clockwise), spring-smoothed and added to `delta`.
  headTilt: number;
  entryOneShots: OneShotKind[];
  /// True if the entry one-shots should be released when the state exits (H5 `stateScoped`).
  entryOneShotsStateScoped: boolean;
  autoTransition?: AgentAutoTransition;
  stage2?: AgentStage2;
  recurring?: AgentRecurringBeat;
  /// Speaking: speech-envelope pulse on face scale_y and group glances.
  speechPulse: number;
  groupGlances: boolean;
}

/// Peak awake brightness (M9 caps luminance at 0.85).
const awakeBrightness = 0.85;

function profile(o: Partial<AgentStateProfile> & Pick<AgentStateProfile, 'mix' | 'gaze'>): AgentStateProfile {
  return {
    modulation: Modulation.make(), breathingDepth: 1, targetBrightness: awakeBrightness, headTilt: 0,
    entryOneShots: [], entryOneShotsStateScoped: false, speechPulse: 0, groupGlances: false, ...o,
  };
}

const auto = (after: OneShotKind, to: AgentState, delay = 0): AgentAutoTransition => ({ after, to, delay });
const mix = (entries: [string, number][], intensity = 1): ExpressionMix =>
  new ExpressionMix(entries.map(([n, w]) => E(n, w)), intensity);
const S = Modulation.state;

/// Rest points in normalised gaze space (+y down).
const asleepRest: Readonly<V2> = Object.freeze({ x: 0, y: 0.25 });
const sheepishRest: Readonly<V2> = Object.freeze({ x: -0.15, y: 0.5 });
const wakingRest: Readonly<V2> = Object.freeze({ x: 0, y: 0.2 });
const rest = (at: Readonly<V2>): GazeIntent => ({ kind: 'rest', at: { x: at.x, y: at.y } });

/// The agent-state profile table (design C6 + Part D). All values are starting points for tuning.
const table: ReadonlyMap<AgentState, AgentStateProfile> = new Map<AgentState, AgentStateProfile>([
  // Calm baseline: neutral, wandering, never still (IdleBeats adds personality).
  ['idle', profile({ mix: ExpressionMix.neutral, gaze: { kind: 'idle' } })],
  // Someone's here: a touch wider, follows them, blinks a little less.
  ['noticing', profile({
    mix: mix([['Neutral', 0.8], ['Surprise', 0.2]]), gaze: { kind: 'track' },
    modulation: S({ speed: 1.05, blinkRate: 0.9, glanceRate: 1.1 }),
  })],
  // Eye contact held: happy, wide, perky pop.
  ['engaged', profile({
    mix: mix([['Happiness', 0.6], ['Surprise', 0.4]], 0.9), gaze: { kind: 'track' },
    modulation: S({ speed: 1.1, blinkRate: 0.85, bounciness: 0.25 }),
    entryOneShots: ['perkUp'],
  })],
  // Attentive: open eyes, curious head tilt, fewer blinks.
  ['listening', profile({
    mix: mix([['Neutral', 0.6], ['Surprise', 0.4]]), gaze: { kind: 'track' },
    modulation: S({ blinkRate: 0.7 }), headTilt: 4,
  })],
  // Pondering: skeptical squint, eyes up-and-aside, slightly slower, busier blinks.
  ['thinking', profile({
    mix: mix([['Skepticism', 0.5], ['Neutral', 0.5]]), gaze: { kind: 'thinking' },
    modulation: S({ speed: 0.9, blinkRate: 1.2, glanceRate: 1.3 }), headTilt: -2,
  })],
  // Talking: friendly, pulsing with the voice, addressing the group.
  ['speaking', profile({
    mix: mix([['Happiness', 0.4], ['Neutral', 0.6]]), gaze: { kind: 'track' },
    modulation: S({ speed: 1.05, blinkRate: 1.1, bounciness: 0.1 }),
    speechPulse: 0.03, groupGlances: true,
  })],
  // Still engaged after replying: relaxed, softly happy, gentle tilt.
  ['followUp', profile({
    mix: mix([['Happiness', 0.35], ['Neutral', 0.65]], 0.9), gaze: { kind: 'track' },
    modulation: S({ speed: 0.9, blinkRate: 0.9, lidHeaviness: 0.05 }), headTilt: 2.5,
  })],
  // Barge-in: "oh, sorry!" recoil, then back to listening when the sorry-blink ends.
  ['interrupted', profile({
    mix: mix([['Surprise', 0.5], ['Embarrassment', 0.5]]), gaze: { kind: 'track' },
    modulation: S({ speed: 1.15 }),
    entryOneShots: ['sorryBlink'], entryOneShotsStateScoped: false,
    autoTransition: auto('sorryBlink', 'listening'),
  })],
  // Wasn't talking to me: embarrassed, looks away, drifts back to idle.
  ['notForMe', profile({
    mix: ExpressionMix.single('Embarrassment'), gaze: { kind: 'lookAway' },
    modulation: S({ speed: 0.95, blinkRate: 1.2 }), targetBrightness: 0.8, headTilt: -3,
    entryOneShots: ['lookAway'], entryOneShotsStateScoped: true,
    autoTransition: auto('lookAway', 'idle', 1.0),
  })],
  // "Say again?": confused asymmetry, quizzical tilt, head shake.
  ['confused', profile({
    mix: ExpressionMix.single('Confusion'), gaze: { kind: 'track' },
    modulation: S({ blinkRate: 1.1 }), headTilt: -7,
    entryOneShots: ['confusedShake'], entryOneShotsStateScoped: true,
  })],
  // Voice services unreachable or a failed turn: guilty, eyes down, nervous blinks, a little dimmer.
  ['sheepish', profile({
    mix: mix([['Embarrassment', 0.6], ['Guilt', 0.4]]), gaze: rest(sheepishRest),
    modulation: S({ speed: 0.85, blinkRate: 1.3, glanceRate: 0.6 }), targetBrightness: 0.75, headTilt: 3,
  })],
  // "I have something to tell you": eager, wide, bouncy, little perk-ups toward the person.
  ['hasMessage', profile({
    mix: mix([['Excitement', 0.45], ['Happiness', 0.35], ['Surprise', 0.2]]), gaze: { kind: 'track' },
    modulation: S({ speed: 1.15, blinkRate: 0.8, glanceRate: 1.2, bounciness: 0.35 }),
    entryOneShots: ['perkUp'], entryOneShotsStateScoped: true,
    recurring: { kind: 'perkUp', alternateChance: 0, firstDelay: [3.5, 6], median: 7, sigma: 0.35, clamp: [4.5, 14] },
  })],
  // Heavy lids, slow, sleepy wandering, nods off and catches itself, the odd yawn.
  ['drowsy', profile({
    mix: ExpressionMix.single('Tiredness', 0.6), gaze: { kind: 'idle' },
    modulation: S({ speed: 0.6, blinkRate: 0.75, blinkDuration: 1.6, lidHeaviness: 0.35, glanceRate: 0.3 }),
    breathingDepth: 1.4, targetBrightness: 0.6,
    entryOneShotsStateScoped: true,
    recurring: {
      kind: 'nodOff', alternate: 'yawn', alternateChance: 0.35,
      firstDelay: [15, 40], median: 26, sigma: 0.3, clamp: [15, 40],
    },
  })],
  // Closed thin lines, resting slightly down, deep slow breathing, heavily dimmed.
  ['asleep', profile({
    mix: ExpressionMix.single('Asleep'), gaze: rest(asleepRest),
    modulation: S({ speed: 0.5, blinkRate: 0, blinkDuration: 1.6, glanceRate: 0 }),
    breathingDepth: 2.5, targetBrightness: 0.12,
  })],
  // Someone passes while asleep: eyes half open, sleepily watching them.
  ['halfAwake', profile({
    mix: ExpressionMix.single('Tiredness', 0.7), gaze: { kind: 'track' },
    modulation: S({ speed: 0.7, blinkRate: 0.6, blinkDuration: 1.5, lidHeaviness: 0.1, glanceRate: 0.4 }),
    breathingDepth: 1.6, targetBrightness: 0.4,
  })],
  // Slow open from tired, blink-clear, then look at them and hand off to noticing.
  ['waking', profile({
    mix: ExpressionMix.single('Tiredness'), gaze: rest(wakingRest),
    modulation: S({ speed: 0.8, blinkRate: 0.8, blinkDuration: 1.3 }),
    breathingDepth: 1.3, targetBrightness: 0.75,
    entryOneShots: ['wake'], entryOneShotsStateScoped: false,
    autoTransition: auto('wake', 'noticing'),
    stage2: { after: 1.0, mix: mix([['Neutral', 0.8], ['Tiredness', 0.2]]), gaze: { kind: 'track' } },
  })],
]);

export const AgentStateProfile = { awakeBrightness } as const;

export const AgentStateProfiles = {
  asleepRest,
  sheepishRest,
  wakingRest,
  table,
  /// The profile for a state. Read-only: treat the returned profile and its mix as immutable.
  profile: (state: AgentState): AgentStateProfile => table.get(state) ?? table.get('idle')!,
} as const;
