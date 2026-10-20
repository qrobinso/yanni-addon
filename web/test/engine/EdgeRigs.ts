// Port of the rigs in Tests/FaceEngineTests/EdgeAnticTests.swift (shared with ReduceMotion.test.ts).
import { expect } from 'vitest';
import type { V2 } from '../../src/core/vec';
import {
  Director, EdgeAnticSettings, EdgeAntics, FaceEngine, FaceState, IdleBeats, OneShotApply, OneShotSampler,
  isEdgeAntic, isScreenEdgeAntic, type AgentState, type Modifier, type OneShotKind,
} from '../../src/engine';
import { EdgeGeometry, ExpressionLibrary, type FaceFrame, type Side } from '../../src/model';
import { ASTRig } from './ASTRig';

/// IdleBeatsTests.beatKinds.
export const beatKinds: readonly OneShotKind[] = ['curiousTilt', 'doubleTake', 'delightedSquint', 'sideEye'];

export const screenAntics: OneShotKind[] = ['shyPeek', 'popUp', 'curiousLean', 'pretendExit'];
export const allEdgeAntics: OneShotKind[] = ['shyPeek', 'popUp', 'curiousLean', 'pretendExit', 'sleepySink'];

/// A full default engine on a screen, driven frame by frame.
export class EdgeRig {
  readonly engine: FaceEngine;
  geometry: EdgeGeometry | null;

  constructor(o: { geometry?: EdgeGeometry | null; seed?: number; state?: AgentState; automatic?: boolean } = {}) {
    this.engine = new FaceEngine({ seed: o.seed ?? 42 });
    this.geometry = o.geometry === undefined ? EdgeGeometry.reference : o.geometry;
    this.engine.setEdgeGeometry(this.geometry);
    const st = this.engine.edgeAnticSettings;
    st.enabled = o.automatic ?? false;
    this.engine.edgeAnticSettings = st;
    this.engine.setAgentState(o.state ?? 'idle');
    for (let i = 0; i < 60; i++) this.engine.tick(1.0 / 60);
  }

  get edge(): EdgeAntics { return this.engine.director.modifier('EdgeAntics') as EdgeAntics; }
  get sampler(): OneShotSampler { return this.engine.director.modifier('OneShotSampler') as OneShotSampler; }
  get frame(): FaceFrame { return this.engine.state.output; }

  tick(dt = 1.0 / 120): FaceFrame { return this.engine.tick(dt); }

  run(seconds: number, dt = 1.0 / 120, each: (f: FaceFrame) => void = () => {}): void {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) each(this.tick(dt));
  }

  runUntil(limit: number, cond: (f: FaceFrame) => boolean, dt = 1.0 / 120): number | null {
    let t = 0;
    while (t < limit) {
      const f = this.tick(dt);
      t += dt;
      if (cond(f)) return t;
    }
    return null;
  }

  visible(side: Side, f?: FaceFrame): number {
    return (this.geometry ?? EdgeGeometry.reference).visibleFractionIn(side, f ?? this.frame);
  }

  bothHidden(f?: FaceFrame): boolean { return this.visible('left', f) <= 0 && this.visible('right', f) <= 0; }

  get screenAnticActive(): boolean { return this.engine.state.activeOneShots.some(isScreenEdgeAntic); }

  /// Plays a screen-edge antic and returns once it has started.
  play(kind: OneShotKind, side = 1): void {
    this.engine.playEdgeAntic(kind, side);
    this.tick();
    expect(this.engine.state.activeOneShots.includes(kind), `${kind} did not start`).toBe(true);
  }
}

/// Runs only the one-shot modifiers on a screen (sampler-level tests).
export class EdgeSamplerRig {
  readonly sampler = new OneShotSampler();
  readonly director: Director;
  s: FaceState;

  constructor(o: { seed?: number; geometry?: EdgeGeometry } = {}) {
    this.director = new Director([this.sampler, new OneShotApply()]);
    this.s = new FaceState(ExpressionLibrary.bundled(), o.seed ?? 1);
    this.s.edgeGeometry = o.geometry ?? EdgeGeometry.reference;
  }

  step(dt: number): void {
    const s = this.s;
    s.dt = Math.fround(dt);
    s.time += s.dt;
    s.frame += 1;
    this.director.run(s);
    s.commands.length = 0;
    s.agentStateChanged = false;
  }

  play(kind: OneShotKind, side = 1): void {
    this.s.edgeSideHint = side;
    this.s.oneShotRequests.push(kind);
  }

  /// Total stage of each eye (face + eye stage) from the sampler output.
  stage(side: Side): V2 {
    const o = this.s.oneShot, e = o.eyeStageOffset;
    return side === 'left' ? { x: o.stageOffset.x + e.x, y: o.stageOffset.y + e.y } : { x: o.stageOffset.x + e.z, y: o.stageOffset.y + e.w };
  }
}

/// Minimal behaviour stack for long trigger simulations: beats, antics, sampler.
export class EdgeTriggerRig {
  readonly beats = new IdleBeats();
  readonly edge = new EdgeAntics();
  readonly sampler = new OneShotSampler();
  rig: ASTRig;
  antics: { time: number; kind: OneShotKind }[] = [];
  beatsFired: { time: number; kind: OneShotKind }[] = [];
  /// Automatic antics that started while another one-shot was already playing.
  startedOverOthers = 0;

  constructor(o: { seed: number; withBeats?: boolean; settings?: EdgeAnticSettings }) {
    const mods: Modifier[] = [];
    if (o.withBeats ?? true) mods.push(this.beats);
    mods.push(this.edge, this.sampler, new OneShotApply());
    this.rig = new ASTRig(mods, o.seed);
    this.rig.state.edgeGeometry = EdgeGeometry.reference;
    this.rig.state.edgeSettings = o.settings ?? new EdgeAnticSettings();
  }

  run(seconds: number, dt = 1 / 20, each: (s: FaceState) => void = () => {}): void {
    const n = Math.trunc(seconds / Math.fround(dt));
    for (let i = 0; i < n; i++) {
      each(this.rig.state);
      const busyBefore = this.rig.state.activeOneShots.some((k) => !isEdgeAntic(k));
      this.rig.tick(dt);
      for (const st of this.rig.state.startedOneShots) {
        if (isEdgeAntic(st.kind)) {
          this.antics.push({ time: this.rig.state.time, kind: st.kind });
          if (busyBefore) this.startedOverOthers += 1;
        } else if (beatKinds.includes(st.kind) || st.kind === 'crossEyed') {
          this.beatsFired.push({ time: this.rig.state.time, kind: st.kind });
        }
      }
    }
  }
}
