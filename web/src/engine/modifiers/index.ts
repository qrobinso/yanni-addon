// The modifier registry: the 27 modifiers of `FaceEngine.makeDefaultModifiers()` in their Swift order, and a factory
// for each one ported so far. `makeDefaultModifiers` builds only the registered ones, in that order.
//
// Registering a modifier (WP5–WP7): port it to `modifiers/<Name>.ts` (a class implementing `Modifier` whose `name` is
// exactly the Swift name), import it here and add `<Name>: () => new <Name>(),` to `modifierFactories`. Nothing else:
// the engine, the golden scenarios test and the skipped unit tests pick it up from this table.
import type { Modifier } from '../Modifier';
import { OneShotApply } from './OneShotApply';
import { OneShotSampler } from './OneShotSampler';

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
