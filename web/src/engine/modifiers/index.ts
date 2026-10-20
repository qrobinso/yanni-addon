// The modifier registry: the 27 modifiers of `FaceEngine.makeDefaultModifiers()` in their Swift order, and a factory
// for each one ported so far. `makeDefaultModifiers` builds only the registered ones, in that order.
//
// Registering a modifier (WP5–WP7): port it to `modifiers/<Name>.ts` (a class implementing `Modifier` whose `name` is
// exactly the Swift name), import it here and add `<Name>: () => new <Name>(),` to `modifierFactories`. Nothing else:
// the engine, the golden scenarios test and the skipped unit tests pick it up from this table.
import type { Modifier } from '../Modifier';
import { OneShotApply } from './OneShotApply';
import { OneShotSampler } from './OneShotSampler';
// WP7
import { Blink } from './Blink';
import { Breathing } from './Breathing';
import { Brightness } from './Brightness';
import { Brows } from './Brows';
import { BurnInDrift } from './BurnInDrift';
import { CaptionInset } from './CaptionInset';
import { LidHeaviness } from './LidHeaviness';
import { MoodColor } from './MoodColor';
import { SquashStretch } from './SquashStretch';
import { TouchReactions } from './TouchReactions';
import { VocalSync } from './VocalSync';
// WP5
import { AgentStateBehavior } from './AgentStateBehavior';
import { Attention } from './Attention';
import { ExpressionTransition } from './ExpressionTransition';
import { ExpressiveOverlay } from './ExpressiveOverlay';
import { GazeTracking } from './GazeTracking';
import { MicroMotion } from './MicroMotion';
import { MoodModulation } from './MoodModulation';
import { NoticingAttention } from './NoticingAttention';
import { Pupils } from './Pupils';
import { ThinkingBeats } from './ThinkingBeats';
// WP6
import { EdgeAntics } from './EdgeAntics';
import { IdleBeats } from './IdleBeats';
import { IdleGames } from './IdleGames';
import { PupilReactions } from './PupilReactions';

/// Swift `FaceEngine.makeDefaultModifiers()` order (registration order within each phase).
export const defaultModifierOrder = [
  // behaviour
  'AgentStateBehavior',
  'IdleBeats',
  'EdgeAntics',
  'IdleGames',
  'TouchReactions',
  'PupilReactions',
  'OneShotSampler',
  'ExpressiveOverlay',
  // affect
  'MoodModulation',
  // expression
  'ExpressionTransition',
  // attention
  'Attention',
  'NoticingAttention',
  'ThinkingBeats',
  'GazeTracking',
  'Pupils',
  'MicroMotion',
  // motion
  'Breathing',
  'OneShotApply',
  'VocalSync',
  'SquashStretch',
  // lids
  'Blink',
  'LidHeaviness',
  // output
  'BurnInDrift',
  'Brows',
  'MoodColor',
  'Brightness',
  'CaptionInset',
] as const;

export type ModifierName = (typeof defaultModifierOrder)[number];

/// One factory per ported modifier (a fresh instance per call).
export const modifierFactories: Partial<Record<ModifierName, () => Modifier>> = {
  OneShotSampler: () => new OneShotSampler(),
  OneShotApply: () => new OneShotApply(),
  // WP7
  TouchReactions: () => new TouchReactions(),
  Breathing: () => new Breathing(),
  VocalSync: () => new VocalSync(),
  SquashStretch: () => new SquashStretch(),
  Blink: () => new Blink(),
  LidHeaviness: () => new LidHeaviness(),
  BurnInDrift: () => new BurnInDrift(),
  Brows: () => new Brows(),
  MoodColor: () => new MoodColor(),
  Brightness: () => new Brightness(),
  CaptionInset: () => new CaptionInset(),
  // WP5
  AgentStateBehavior: () => new AgentStateBehavior(),
  ExpressiveOverlay: () => new ExpressiveOverlay(),
  MoodModulation: () => new MoodModulation(),
  ExpressionTransition: () => new ExpressionTransition(),
  Attention: () => new Attention(),
  NoticingAttention: () => new NoticingAttention(),
  ThinkingBeats: () => new ThinkingBeats(),
  GazeTracking: () => new GazeTracking(),
  Pupils: () => new Pupils(),
  MicroMotion: () => new MicroMotion(),
  // WP6
  IdleBeats: () => new IdleBeats(),
  EdgeAntics: () => new EdgeAntics(),
  IdleGames: () => new IdleGames(),
  PupilReactions: () => new PupilReactions(),
};

/// True when `name` has a factory.
export const isModifierRegistered = (name: string): boolean => name in modifierFactories;

/// Every default modifier not ported yet (in Swift order).
export const missingModifiers = (): ModifierName[] => defaultModifierOrder.filter((n) => !isModifierRegistered(n));

/// Builds the named modifiers that are registered, in the given order (unregistered names are skipped).
export function makeModifiers(names: readonly string[]): Modifier[] {
  const out: Modifier[] = [];
  for (const n of names) {
    const f = modifierFactories[n as ModifierName];
    if (f) out.push(f());
  }
  return out;
}

export { OneShotApply, OneShotSampler };
// WP5
export {
  AgentStateBehavior, Attention, ExpressionTransition, ExpressiveOverlay, GazeTracking, MicroMotion, MoodModulation,
  NoticingAttention, Pupils, ThinkingBeats,
};
// WP6
export { EdgeAntics, IdleBeats, IdleGames, PupilReactions };
