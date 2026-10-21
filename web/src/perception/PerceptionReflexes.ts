// Port of FacePerception/PerceptionReflexes.swift: the reflex table's value types. The table itself
// (PerceptionReflexTable.swift, +Rows, +Decide) is in PerceptionReflexTable.ts.
import type { V2, V3 } from '../core/vec';
import type { AgentState, OneShotKind, ReactionCue } from '../engine';
import { reactionCueEquals } from '../engine';

/// An emotion impulse: move the felt PAD toward `target` by `strength`. The coordinator hands it to `onImpulse`.
export interface ReflexImpulse { target: V3; strength: number }
export const makeReflexImpulse = (target: V3, strength: number): ReflexImpulse => ({ target, strength });
export const reflexImpulseEquals = (a: ReflexImpulse | null, b: ReflexImpulse | null): boolean =>
  a === b || (a !== null && b !== null && a.strength === b.strength && a.target.x === b.target.x &&
    a.target.y === b.target.y && a.target.z === b.target.z);

/// One beat per event.
export type ReflexBeat =
  | { kind: 'none' }
  | { kind: 'oneShot'; oneShot: OneShotKind }
  | { kind: 'cue'; cue: ReactionCue }
  /** A screen-edge antic toward `side` (−1 left, +1 right); plays only if the engine's antic gating allows it. */
  | { kind: 'edgeAntic'; oneShot: OneShotKind; side: number };

export const ReflexBeat = {
  none: { kind: 'none' } as ReflexBeat,
  oneShot: (oneShot: OneShotKind): ReflexBeat => ({ kind: 'oneShot', oneShot }),
  cue: (cue: ReactionCue): ReflexBeat => ({ kind: 'cue', cue }),
  edgeAntic: (oneShot: OneShotKind, side: number): ReflexBeat => ({ kind: 'edgeAntic', oneShot, side }),
  equals(a: ReflexBeat, b: ReflexBeat): boolean {
    switch (a.kind) {
      case 'none': return b.kind === 'none';
      case 'oneShot': return b.kind === 'oneShot' && a.oneShot === b.oneShot;
      case 'cue': return b.kind === 'cue' && reactionCueEquals(a.cue, b.cue);
      case 'edgeAntic': return b.kind === 'edgeAntic' && a.oneShot === b.oneShot && a.side === b.side;
    }
  },
} as const;

/// What one perception event does to the face: impulse and beat plus the gaze moves that go with it.
export interface PerceptionEffects {
  impulse: ReflexImpulse | null;
  beat: ReflexBeat;
  /// Glance at this camera-relative point first (the coordinator converts it to screen-relative).
  glanceAt: V2 | null;
  /// A stimulus toward this camera-relative point (pointing).
  stimulus: { at: V2; strength: number } | null;
  /// Counts as activity for the life cycle (daytime only; the coordinator checks bedtime).
  activity: boolean;
  /// Why (log line: what happened or why it was rejected).
  reason: string;
  /// Habituation: the beat plays at this intensity (1, 0.6, 0.3); the impulse is already scaled.
  intensity: number;
  /// Played instead when the arbiter turns the cue down for rarity, or the edge antic isn't allowed.
  fallback: OneShotKind | null;
  /// The nod mirror's softer chirp.
  softVoice: boolean;
  /// A second beat after this one (dancing: dance along once the note eyes have shown).
  followUp: { kind: OneShotKind; after: number } | null;
  /// The high-five approach: arm the friendly-touch window until this host time.
  friendlyTouchUntil: number | null;
}

export function makePerceptionEffects(o: Partial<PerceptionEffects> & { reason: string }): PerceptionEffects {
  return {
    impulse: null, beat: ReflexBeat.none, glanceAt: null, stimulus: null, activity: false, intensity: 1, fallback: null,
    softVoice: false, followUp: null, friendlyTouchUntil: null, ...o,
  };
}

export const PerceptionEffects = {
  rejected: (why: string): PerceptionEffects => makePerceptionEffects({ reason: why }),
  /// True when a beat results.
  plays: (fx: PerceptionEffects): boolean => fx.beat.kind !== 'none',
} as const;

/// What the reflexes need to know about the moment.
export interface ReflexContext {
  agentState: AgentState;
  isBedtime: boolean;
  isSulking: boolean;
  primaryID: number | null;
  /// Engine host time (seconds) now.
  now: number;
  /// When this person arrived and how long the room had been empty before.
  arrivedAt: number | null;
  aloneBeforeArrival: number;
  /// A conversation beat, answer, edge antic or another perception beat is playing → one-shot beats are "busy".
  oneShotBusy: boolean;
  /// A pupil transformation is showing → urgent beats would cut it: "shape showing".
  pupilShapeShowing: boolean;
  /// The person engaged with Yanni right now (null: nobody).
  engagedID: number | null;
}

export function makeReflexContext(o: Partial<ReflexContext> & Pick<ReflexContext, 'agentState' | 'now'>): ReflexContext {
  return {
    isBedtime: false, isSulking: false, primaryID: null, arrivedAt: null, aloneBeforeArrival: 0, oneShotBusy: false,
    pupilShapeShowing: false, engagedID: null, ...o,
  };
}

export const someoneEngaged = (c: ReflexContext): boolean => c.engagedID !== null;
