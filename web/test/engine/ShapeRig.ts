// Swift ShapeRig (PupilTransformationTests.swift) and the PupilReactionsTests cue helpers, shared by the pupil tests.
import type { V2 } from '../../src/core/vec';
import { FaceFrame, type Side } from '../../src/model';
import {
  FaceCommand, FaceEngine, FaceState, OneShotSampler, PupilReactions, PupilReactionSettings, isPupilShape,
  makeReactionCue, type AgentState, type OneShotKind, type PupilReactionReason, type ReactionCue, type ReactionCueKind,
  type ReactionCueSource,
} from '../../src/engine';

/// A full default engine (no screen edges, so no edge antics), driven at a fixed rate.
export class ShapeRig {
  readonly engine: FaceEngine;
  host = 1000;
  constructor(seed: number | bigint = 7, state: AgentState = 'engaged') {
    this.engine = new FaceEngine({ seed });
    this.engine.setAgentState(state);
    for (let i = 0; i < 30; i++) this.tick();
  }
  get sampler(): OneShotSampler { return this.engine.director.modifier('OneShotSampler') as unknown as OneShotSampler; }
  get arbiter(): PupilReactions { return this.engine.director.modifier('PupilReactions') as unknown as PupilReactions; }
  get frame(): FaceFrame { return this.engine.state.output; }
  get state(): FaceState { return this.engine.state; }
  tick(dt = 1 / 120): FaceFrame { this.host += dt; return this.engine.tick(dt, this.host); }
  run(seconds: number, dt = 1 / 120, each: (f: FaceFrame) => void = () => {}): void {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) each(this.tick(dt));
  }
  get shapeActive(): boolean { return this.engine.state.activeOneShots.some(isPupilShape); }
}

/// The default pupils on both eyes.
export const hasDefaultPupils = (f: FaceFrame | FaceState): boolean => {
  const s = f.pupilShape, m = f.pupilMorph, c = f.pupilShapeScale;
  return s.x === 0 && s.y === 0 && m.x === 0 && m.y === 0 && c.x === 1 && c.y === 1 && c.z === 1 && c.w === 1;
};

/// Width / height of one eye's pupil (the default pupil is 1 : 1.24).
export function pupilAspectRatio(f: FaceFrame, side: Side): number {
  const s: V2 = FaceFrame.shapeScale(f, side);
  return s.x / (1.24 * Math.max(s.y, 1e-3));
}

export const allShapes: OneShotKind[] = ['starEyes', 'heartEyes', 'noteEyes', 'questionEyes', 'exclaimEyes'];

// MARK: PupilReactionsTests statics

export function cue(kind: ReactionCueKind, o: { confidence?: number; directed?: boolean; valence?: number;
  source?: ReactionCueSource; hostTime?: number | null; key?: string } = {}): ReactionCue {
  return makeReactionCue(kind, o.confidence ?? 0.9, {
    source: o.source ?? 'conversation', directedAtYanni: o.directed ?? true, valence: o.valence ?? 0.5,
    hostTime: o.hostTime ?? null, key: o.key ?? '',
  });
}

/// Sends a cue, ticks once, returns the arbiter's reason.
export function send(rig: ShapeRig, c: ReactionCue): PupilReactionReason | undefined {
  rig.engine.send(FaceCommand.reactionCue(c));
  rig.tick();
  const w = rig.arbiter.events.at(-1)?.what;
  return w?.kind === 'decision' ? w.reason : undefined;
}

/// A rig with the given settings tweaks.
export function rig(state: AgentState = 'engaged', tweak: (s: PupilReactionSettings) => void = () => {}): ShapeRig {
  const r = new ShapeRig(7, state);
  const st = r.engine.pupilReactionSettings;
  tweak(st);
  r.engine.pupilReactionSettings = st;
  return r;
}
