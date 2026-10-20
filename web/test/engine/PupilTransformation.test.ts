// Port of Tests/FaceEngineTests/PupilTransformationTests.swift.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import type { V2, V4 } from '../../src/core/vec';
import { EdgeGeometry, ExpressionLibrary, FaceFrame, ParamLayout, PupilShape, type Side } from '../../src/model';
import {
  Director, FaceCommand, FaceEngine, FaceState, OneShotApply, OneShotLibrary, OneShotParams, OneShotRequest,
  OneShotSampler, PupilReactions, isEdgeAntic, pupilShapeOf, type OneShotKind,
} from '../../src/engine';
import * as Shape from '../../src/engine/PupilShapeCurves';
import { ShapeRig, allShapes, hasDefaultPupils, pupilAspectRatio } from './ShapeRig';

// MARK: - Harness

/// Runs only the one-shot modifiers (OneShotTests.swift's OneShotRig).
class OneShotRig {
  readonly sampler = new OneShotSampler();
  readonly director = new Director([this.sampler, new OneShotApply()]);
  s = new FaceState(ExpressionLibrary.bundled(), 1);
  constructor() { this.s.edgeGeometry = EdgeGeometry.reference; }
  step(dt: number): void {
    const s = this.s;
    s.dt = dt; s.time += dt; s.frame += 1;
    this.director.run(s);
    s.commands.length = 0;
    s.agentStateChanged = false;
  }
  request(k: OneShotKind): void { this.s.oneShotRequests.push(k); }
}

/// A full default engine on a screen (EdgeAnticTests.swift's EdgeRig, the parts used here).
class EdgeRig {
  readonly engine: FaceEngine;
  constructor(automatic = false) {
    this.engine = new FaceEngine({ seed: 42 });
    this.engine.setEdgeGeometry(EdgeGeometry.reference);
    const st = this.engine.edgeAnticSettings;
    st.enabled = automatic;
    this.engine.edgeAnticSettings = st;
    this.engine.setAgentState('idle');
    for (let i = 0; i < 60; i++) this.engine.tick(1 / 60);
  }
  tick(dt = 1 / 120): FaceFrame { return this.engine.tick(dt); }
  run(seconds: number, each: (f: FaceFrame) => void = () => {}): void {
    const n = Math.round(seconds * 120);
    for (let i = 0; i < n; i++) each(this.tick());
  }
}

const shape = (f: FaceFrame, side: Side): PupilShape => FaceFrame.shape(f, side);
const morph = (f: FaceFrame, side: Side): number => FaceFrame.morph(f, side);
const shapeScale = (f: FaceFrame, side: Side): V2 => FaceFrame.shapeScale(f, side);
const maxAbsDiff2 = (a: V2, b: V2): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const maxAbsDiff4 = (a: V4, b: V4): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z), Math.abs(a.w - b.w));
const lanes4 = (v: V4): number[] => [v.x, v.y, v.z, v.w];

const cross = <A, B>(as: A[], bs: B[]): [A, B][] => as.flatMap((a) => bs.map((b): [A, B] => [a, b]));

// MARK: - Shapes and timing

describe('PupilTransformationTests', () => {
  test.each(allShapes)('completesAndRestoresDefaultPupils(%s)', (kind) => {
    const rig = new ShapeRig();
    rig.engine.playPupilShape(kind);
    let shown = false, completed = false;
    rig.run(Shape.shapeDuration(kind, 0) + 0.3, undefined, (f) => {
      if (shape(f, 'left') === pupilShapeOf(kind) && morph(f, 'left') >= 1) shown = true;
      if (rig.state.completedOneShots.includes(kind)) completed = true;
    });
    expect(shown, `${kind} never showed its full shape`).toBe(true);
    expect(completed).toBe(true);
    expect(hasDefaultPupils(rig.frame)).toBe(true);
    expect(rig.shapeActive).toBe(false);
  });

  /// Morph shapes never jump between frames; scales stay continuous.
  test.each(cross<OneShotKind, number>(['starEyes', 'heartEyes'], [1 / 60, 1 / 120]))('morphShapesNeverJump(%s, %f)', (kind, dt) => {
    const rig = new ShapeRig();
    rig.engine.playPupilShape(kind);
    let prev = rig.tick(dt);
    rig.run(Shape.shapeDuration(kind, 0) + 0.1, dt, (f) => {
      const dm = Math.abs(morph(f, 'left') - morph(prev, 'left'));
      const ds = maxAbsDiff2(shapeScale(f, 'left'), shapeScale(prev, 'left'));
      // The pop morphs in over 100 ms (≥ 6 frames at 60 fps): a ramp, never a jump.
      expect(dm, `morph jumped by ${dm}`).toBeLessThanOrEqual(dt * 16);
      expect(ds, `scale jumped by ${ds}`).toBeLessThanOrEqual(dt * 6);
      if (shape(f, 'left') !== shape(prev, 'left')) {
        // An ellipse ↔ shape change only happens at morph ≈ 0 (invisible).
        expect(Math.min(morph(f, 'left'), morph(prev, 'left'))).toBeLessThanOrEqual(0.001);
      }
      prev = f;
    });
  });

  /// Switch shapes change silhouette only while the pupil is a sliver (< 15 % as wide as tall), at 60 and 120 fps,
  /// both on the way in and on the way back.
  test.each(cross<OneShotKind, number>(['noteEyes', 'questionEyes', 'exclaimEyes'], [1 / 60, 1 / 120]))(
    'switchShapesFlipOnlyAtTheSliver(%s, %f)', (kind, dt) => {
      const rig = new ShapeRig();
      rig.engine.playPupilShape(kind);
      let prev = rig.tick(dt);
      let flips = 0;
      rig.run(Shape.shapeDuration(kind, 0) + 0.1, dt, (f) => {
        for (const side of ParamLayout.Side.allCases) {
          if (shape(f, side) === shape(prev, side)) continue;
          flips += 1;
          expect(pupilAspectRatio(f, side) < 0.15 && pupilAspectRatio(prev, side) < 0.15,
            `${kind} flipped at aspect ${pupilAspectRatio(prev, side)} → ${pupilAspectRatio(f, side)}`).toBe(true);
        }
        prev = f;
      });
      expect(flips, `expected in + out on both eyes, got ${flips}`).toBe(4);
    });

  /// The flip takes 140–180 ms from the start of the squash to fully open, and the swap is at a fixed time.
  test('coinFlipTiming', () => {
    const f = Shape.flipIn + Shape.flipOut;
    expect(f >= 0.14 && f <= 0.18).toBe(true);
    expect(Shape.flipX(0.11 - 0.0001, 0.11, true)).toBeLessThanOrEqual(Shape.sliver + 1e-4);
    expect(Shape.flipX(0.11 + 0.0001, 0.11, true)).toBeLessThanOrEqual(Shape.sliver + 1e-4);
    expect(Shape.flipX(0.11 - 0.07, 0.11, true)).toBe(1);
    expect(Shape.flipX(0.11 + 0.10, 0.11, true)).toBe(1);
    // Scales never exceed 1 even through the overshoot.
    for (const kind of allShapes) {
      const p = new OneShotParams();
      for (let t = 0; t < Shape.shapeDuration(kind, 0); t += 0.004) {
        const o = OneShotLibrary.sample(kind, t, p);
        expect(Math.max(...lanes4(o.pupilShapeScale)), `${kind} scale at ${t}`).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  test('questionMarkOneEyeLeadsBy120ms', () => {
    for (const lead of [-1, 1]) {
      const rig = new ShapeRig();
      rig.engine.playPupilShape('questionEyes', lead);
      const first: Partial<Record<Side, number>> = {};
      let t = 0;
      rig.run(0.5, undefined, (f) => {
        t += 1 / 120;
        for (const side of ParamLayout.Side.allCases) {
          if (first[side] === undefined && shape(f, side) === PupilShape.question) first[side] = t;
        }
      });
      expect(first.left).toBeDefined();
      expect(first.right).toBeDefined();
      const l = first.left!, r = first.right!;
      const leadSide: Side = lead < 0 ? 'left' : 'right';
      const lag = leadSide === 'left' ? r - l : l - r;
      expect(Math.abs(lag - 0.12), `lead ${lead}: lag ${lag}`).toBeLessThan(0.02);
    }
  });

  test('notesBobAlternatingBetweenTheEyes', () => {
    const p = new OneShotParams();
    let opposite = 0, same = 0;
    for (let t = Shape.shapeIntro('noteEyes') + 0.3; t < Shape.shapeIntro('noteEyes') + 1.3; t += 0.01) {
      const o = OneShotLibrary.sample('noteEyes', t, p);
      const l = o.delta.eye('left', 'y'), r = o.delta.eye('right', 'y');
      if (Math.abs(l) > 0.02) { if (l * r < 0) opposite += 1; else same += 1; }
    }
    expect(opposite > 20 && same === 0).toBe(true);
  });

  test('exclamationEndsInADelightedSquint', () => {
    const p = new OneShotParams();
    const tEnd = Shape.shapeIntro('exclaimEyes') + Shape.defaultHold('exclaimEyes');
    const o = OneShotLibrary.sample('exclaimEyes', tEnd + 0.35, p);
    expect(o.pupilShape, 'back to the default pupil before the squint').toEqual({ x: 0, y: 0 });
    expect(o.lidCoverage.y > 0.3 && o.lidCoverage.w > 0.3, `lower lids up: ${JSON.stringify(o.lidCoverage)}`).toBe(true);
    expect(o.pupilSizeMul.x).toBeGreaterThan(1.05);
  });

  test('starPopsWithOneBounceAndLowIntensityDropsIt', () => {
    const localMinima = (p: OneShotParams): number => {
      let n = 0;
      let t = 0.25;
      let a = OneShotLibrary.sample('starEyes', t - 0.005, p).pupilShapeScale.x;
      let b = OneShotLibrary.sample('starEyes', t, p).pupilShapeScale.x;
      while (t < 0.46) {
        const c = OneShotLibrary.sample('starEyes', t + 0.005, p).pupilShapeScale.x;
        if (b < a - 1e-5 && b < c - 1e-5) n += 1;
        a = b; b = c; t += 0.005;
      }
      return n;
    };
    const rng = new SplitMix64(1);
    const zero = { x: 0, y: 0 };
    const full = OneShotLibrary.makeParams(OneShotRequest.make('starEyes', { intensity: 1 }), rng, zero);
    const low = OneShotLibrary.makeParams(OneShotRequest.make('starEyes', { intensity: 0.3 }), rng, zero);
    const calm = OneShotLibrary.makeParams(OneShotRequest.make('starEyes', { reduceMotion: true }), rng, zero);
    expect(localMinima(full)).toBe(1);
    expect(localMinima(low)).toBe(0);
    expect(calm.bounce).toBe(false);
    // Peak at 1.0 (the pop), rest at 0.9; size is the same at any intensity.
    expect(Math.abs(OneShotLibrary.sample('starEyes', 0.24, low).pupilShapeScale.x - 1)).toBeLessThan(0.01);
    expect(Math.abs(OneShotLibrary.sample('starEyes', 0.8, low).pupilShapeScale.x - Shape.shapeRest)).toBeLessThan(0.001);
    // Reduce Motion: no face stretch.
    for (let t = 0; t < 0.5; t += 0.01) {
      const o = OneShotLibrary.sample('starEyes', t, calm);
      expect(Math.abs(o.faceScaleMul.x - 1) < 1e-6 && Math.abs(o.faceScaleMul.y - 1) < 1e-6).toBe(true);
    }
  });

  test('heartsStartWithAShyGlance', () => {
    const rng = new SplitMix64(3);
    const p = OneShotLibrary.makeParams(OneShotRequest.make('heartEyes'), rng, { x: 0, y: 0 });
    const o = OneShotLibrary.sample('heartEyes', 0.2, p);
    expect(o.gaze).not.toBeNull();
    const g = o.gaze!;
    expect(g.pupilsOnly && g.point.y > 0.2 && Math.abs(g.point.x) > 0.3).toBe(true);
    expect(o.lidCoverage.x, 'upper lids lowered').toBeGreaterThan(0.05);
    expect(o.pupilShape, 'no heart yet during the glance').toEqual({ x: 0, y: 0 });
    expect(OneShotLibrary.sample('heartEyes', 0.9, p).pupilShape).toEqual({ x: PupilShape.heart, y: PupilShape.heart });
  });

  test('holdUsesTheRequestAndIgnoresMoodSpeed', () => {
    const rig = new ShapeRig();
    const m = { ...rig.engine.state.mood };
    m.arousal = -1; m.pleasure = 0;
    rig.engine.setMood(m);   // slow mood: modulation.speed well below 1
    rig.run(1);
    expect(rig.state.modulation.speed).toBeLessThan(0.95);
    rig.engine.send(FaceCommand.play(OneShotRequest.make('starEyes', { hold: 0.5 })));
    let t = 0, end: number | undefined;
    rig.run(3, undefined, () => {
      t += 1 / 120;
      if (end === undefined && !rig.shapeActive && t > 0.1) end = t;
    });
    const expected = Shape.shapeDuration('starEyes', 0.5);
    expect(Math.abs((end ?? 99) - expected), `ended at ${end ?? -1}, expected ${expected}`).toBeLessThan(0.03);
  });

  test('wantsHighFrameRateWhileTheSilhouetteMoves', () => {
    const rig = new ShapeRig();
    rig.run(2);
    rig.engine.playPupilShape('noteEyes');
    let fastDuringFlip = true;
    let t = 0;
    rig.run(0.25, undefined, (f) => {
      t += 1 / 120;
      if (t > 0.05 && t < 0.2 && !f.wantsHighFrameRate) fastDuringFlip = false;
    });
    expect(fastDuringFlip).toBe(true);
  });

  // MARK: Ending early

  /// Cancelled at every 50 ms of every transformation, the pupils come back to default within the switch back,
  /// silhouettes only change at slivers (or invisibly at morph 0), and scales never jump.
  test.each(allShapes)('cancelAtEvery50msRestores(%s)', (kind) => {
    const total = Shape.shapeDuration(kind, 0);
    for (let c = 0.05; c < total; c += 0.05) {
      const rig = new ShapeRig();
      rig.engine.playPupilShape(kind);
      rig.run(c);
      rig.engine.cancelPupilShape();
      let prev = rig.frame;
      let restoredAt: number | undefined;
      let t = 0;
      rig.run(0.4, undefined, (f) => {
        t += 1 / 120;
        for (const side of ParamLayout.Side.allCases) {
          if (shape(f, side) !== shape(prev, side)) {
            const atSliver = pupilAspectRatio(f, side) < 0.15 && pupilAspectRatio(prev, side) < 0.15;
            const invisible = Math.min(morph(f, side), morph(prev, side)) <= 0.02;
            expect(atSliver || invisible, `${kind} cancelled at ${c}: pop at ${t}`).toBe(true);
          }
          // No faster than the coin flip itself (≈ 38 /s at its steepest).
          const ds = maxAbsDiff2(shapeScale(f, side), shapeScale(prev, side));
          expect(ds, `${kind} cancelled at ${c}: scale jump ${ds}`).toBeLessThan(0.36);
        }
        if (restoredAt === undefined && hasDefaultPupils(f)) restoredAt = t;
        prev = f;
      });
      expect(restoredAt ?? 99, `${kind} cancelled at ${c}`).toBeLessThanOrEqual(Shape.switchBackDuration + 0.02);
      expect(rig.shapeActive).toBe(false);
    }
  });

  test.each(allShapes)('urgentStateEngagementAndSulkInterrupt(%s)', (kind) => {
    // Urgent state.
    let rig = new ShapeRig();
    rig.engine.playPupilShape(kind);
    rig.run(Shape.shapeIntro(kind) + 0.2);
    rig.engine.setAgentState('notForMe');
    rig.run(0.3);
    expect(hasDefaultPupils(rig.frame), 'notForMe').toBe(true);
    // Listening starting mid-hold.
    rig = new ShapeRig(7, 'idle');
    rig.engine.playPupilShape(kind);
    rig.run(Shape.shapeIntro(kind) + 0.2);
    rig.engine.setAgentState('listening');
    rig.run(0.3);
    expect(hasDefaultPupils(rig.frame), 'listening').toBe(true);
    // A tap sulk.
    rig = new ShapeRig(7, 'idle');
    rig.engine.playPupilShape(kind);
    rig.run(Shape.shapeIntro(kind) + 0.1);
    let sulked = false;
    for (let i = 0; i < 12 && !sulked; i++) {
      rig.engine.send(FaceCommand.tap({ x: 0, y: 0 }));
      rig.run(0.05);
      sulked = rig.state.isSulking;
    }
    rig.run(0.3);
    expect(sulked && hasDefaultPupils(rig.frame), 'sulk').toBe(true);
  });

  test('thinkingToSpeakingIsNotAnInterrupt', () => {
    const rig = new ShapeRig(7, 'thinking');
    rig.engine.playPupilShape('heartEyes');
    rig.run(1.0);
    rig.engine.setAgentState('speaking');
    rig.run(0.3);
    expect(shape(rig.frame, 'left') === PupilShape.heart && morph(rig.frame, 'left') === 1).toBe(true);
  });

  test.each(allShapes)('watchdogForcesTheSwitchBack(%s)', (kind) => {
    const rig = new ShapeRig();
    rig.engine.playPupilShape(kind);
    rig.run(Shape.shapeIntro(kind) + 0.1);
    rig.sampler.stallForTesting(kind);
    let nonDefault = 0;
    rig.run(Shape.shapeDuration(kind, 0) + 2, undefined, (f) => {
      if (!hasDefaultPupils(f)) nonDefault += 1 / 120;
    });
    expect(rig.sampler.shapeWatchdogCount).toBe(1);
    expect(hasDefaultPupils(rig.frame) && !rig.shapeActive).toBe(true);
    const limit = Shape.shapeDuration(kind, 0) + OneShotSampler.shapeWatchdogGrace + Shape.switchBackDuration + 0.05;
    expect(nonDefault, `non-default for ${nonDefault} s`).toBeLessThanOrEqual(limit);
  });

  test('watchdogAtModulationSpeedHalf', () => {
    // Mood can slow every other one-shot to half speed; a transformation keeps its own clock and never trips the
    // watchdog.
    const rig = new OneShotRig();
    rig.s.modulation.speed = 0.5;
    rig.s.oneShotPlayRequests.push(OneShotRequest.make('noteEyes'));
    for (let t = 0; t < Shape.shapeDuration('noteEyes', 0) + 1; t += 1 / 120) rig.step(1 / 120);
    expect(rig.sampler.shapeWatchdogCount).toBe(0);
    expect(rig.s.pupilShape).toEqual({ x: 0, y: 0 });
    expect(rig.s.pupilShapeScale).toEqual({ x: 1, y: 1, z: 1, w: 1 });
  });

  /// A conflicting `.pupils` one-shot mid-hold mutes the acting but leaves the silhouette; a new transformation
  /// switches the old one back first (coin flip, no pop), then plays.
  test('conflictsAndRetriggersExitOnlyThroughTheSwitchBack', () => {
    const rig = new OneShotRig();
    rig.s.oneShotPlayRequests.push(OneShotRequest.make('starEyes'));
    for (let i = 0; i < 90; i++) rig.step(1 / 120);   // into the hold
    expect(rig.s.pupilShape.x).toBe(PupilShape.star);
    rig.request('delightedSquint');   // owns .pupils, .lids, .translate, .scale
    for (let i = 0; i < 30; i++) rig.step(1 / 120);
    expect(rig.s.pupilShape.x, 'the star survives the conflict').toBe(PupilShape.star);
    expect(rig.s.activeOneShots.includes('starEyes') && rig.s.activeOneShots.includes('delightedSquint')).toBe(true);

    // A new transformation: old flips back, then the new one starts.
    rig.s.oneShotPlayRequests.push(OneShotRequest.make('questionEyes'));
    let prevShape = [rig.s.pupilShape.x, rig.s.pupilShape.y], prevScale = lanes4(rig.s.pupilShapeScale);
    let sawQuestion = false;
    for (let i = 0; i < 120; i++) {
      rig.step(1 / 120);
      const sh = [rig.s.pupilShape.x, rig.s.pupilShape.y], sc = lanes4(rig.s.pupilShapeScale);
      for (let e = 0; e < 2; e++) {
        if (sh[e] === prevShape[e]) continue;
        const a0 = prevScale[2 * e] / (1.24 * prevScale[2 * e + 1]), a1 = sc[2 * e] / (1.24 * sc[2 * e + 1]);
        expect(a0 < 0.15 && a1 < 0.15, 'swap outside the sliver').toBe(true);
      }
      if (sh[0] === PupilShape.question || sh[1] === PupilShape.question) sawQuestion = true;
      prevShape = sh; prevScale = sc;
    }
    expect(sawQuestion).toBe(true);
  });

  test('transformationsAreNeverEvicted', () => {
    const rig = new OneShotRig();
    rig.s.oneShotPlayRequests.push(OneShotRequest.make('heartEyes'));
    rig.step(1 / 120);
    // Fill every other slot with high-priority one-shots, then ask for more.
    for (const k of ['wake', 'sorryBlink', 'catchSelf', 'nodOff', 'bigSurprise', 'confusedShake', 'perkUp'] as OneShotKind[]) {
      rig.request(k);
      rig.step(1 / 120);
    }
    expect(rig.s.activeOneShots.includes('heartEyes')).toBe(true);
    // Evicting it explicitly takes the switch back, never a frozen residual.
    for (let i = 0; i < 100; i++) rig.step(1 / 120);
    const before = { ...rig.s.pupilShape };
    rig.sampler.evictForTesting('heartEyes', rig.s);
    rig.step(1 / 120);
    expect(rig.s.pupilShape, 'the silhouette is still showing at the start of the switch back').toEqual(before);
    for (let i = 0; i < 30; i++) rig.step(1 / 120);
    expect(rig.s.pupilShape).toEqual({ x: 0, y: 0 });
    expect(rig.s.pupilShapeScale).toEqual({ x: 1, y: 1, z: 1, w: 1 });
    expect(rig.s.activeOneShots.includes('heartEyes')).toBe(false);
  });

  test.each(allShapes)('sixtyAndOneTwentyFpsAgree(%s)', (kind) => {
    const a = new OneShotRig(), b = new OneShotRig();
    a.s.oneShotPlayRequests.push(OneShotRequest.make(kind, { leadEye: 1 }));
    b.s.oneShotPlayRequests.push(OneShotRequest.make(kind, { leadEye: 1 }));
    a.step(1 / 60);
    b.step(1 / 120); b.step(1 / 120);
    for (let i = 0; i < 150; i++) {
      a.step(1 / 60);
      b.step(1 / 120); b.step(1 / 120);
      expect(maxAbsDiff2(a.s.pupilMorph, b.s.pupilMorph)).toBeLessThan(0.02);
      expect(maxAbsDiff4(a.s.pupilShapeScale, b.s.pupilShapeScale)).toBeLessThan(0.03);
    }
  });

  test('blinksDuringAHoldCoverTheShape', () => {
    const rig = new ShapeRig();
    rig.engine.playPupilShape('starEyes');
    rig.run(0.7);
    rig.engine.send(FaceCommand.blink);
    let maxBlink = 0;
    rig.run(0.2, undefined, (f) => {
      maxBlink = Math.max(maxBlink, f.closureScale.y < 0.9 ? 1 : 0);
      expect(shape(f, 'left'), 'the star stays while the lids close over it').toBe(PupilShape.star);
    });
    expect(maxBlink, 'the blink played').toBe(1);
  });

  // MARK: Mutual exclusion

  test('idleBeatsAndEdgeAnticsWaitForATransformation', () => {
    const rig = new EdgeRig(true);
    rig.engine.playPupilShape('noteEyes');
    rig.tick();
    let overlap = false;
    rig.run(Shape.shapeDuration('noteEyes', 0) - 0.1, () => {
      const a = rig.engine.state.activeOneShots;
      if (a.some(isEdgeAntic) || a.some((k) => PupilReactions.idleBeatKinds.contains(k))) overlap = true;
    });
    expect(overlap).toBe(false);
  });
});
