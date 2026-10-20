// Port of Tests/FaceEngineTests/ReduceMotionTests.swift.
import { describe, expect, test } from 'vitest';
import { FaceEngine, FaceState, OneShotLibrary, OneShotOutput, FaceCommand, missingModifiers } from '../../src/engine';
import { ExpressionLibrary, type FacePose } from '../../src/model';
import { EdgeRig, EdgeTriggerRig } from './EdgeRigs';

/// The engine-wide Reduce Motion factor (hardening design §10): one-shot movement and motion squash-and-stretch × 0.5,
/// screen-edge antics limited to the curious lean, and the face never still.
describe('ReduceMotion', () => {
  test('factorFollowsTheSystemFlag', () => {
    const s = new FaceState(ExpressionLibrary.bundled(), 0);
    expect(!s.reduceMotion && s.motionScale === 1).toBe(true);
    s.pupilSettings.reduceMotion = true;
    expect(s.reduceMotion && s.motionScale === FaceState.reducedMotionScale).toBe(true);
    expect(FaceState.reducedMotionScale).toBe(0.5);
  });

  test('scaleMotionHalvesMovementOnly', () => {
    const o = new OneShotOutput();
    o.delta.setFace('centerY', 10);
    o.delta.setFace('angle', 4);
    o.delta.setEye('left', 'centerX', 6);
    o.delta.setEye('left', 'upperLidY', 0.3);
    o.stageOffset = { x: 8, y: -4 };
    o.faceScaleMul = { x: 1.1, y: 0.9 };
    o.lidCoverage = { x: 0.2, y: 0.2, z: 0.2, w: 0.2 };
    o.blink = 0.7;
    OneShotLibrary.scaleMotion(o, 0.5);
    expect(o.delta.face('centerY') === 5 && o.delta.face('angle') === 2 && o.delta.eye('left', 'centerX') === 3).toBe(true);
    expect(o.stageOffset).toEqual({ x: 4, y: -2 });
    expect(Math.abs(o.faceScaleMul.x - 1.05) < 1e-6 && Math.abs(o.faceScaleMul.y - 0.95) < 1e-6).toBe(true);
    // Lids and blinks keep their size: the one-shot still reads.
    expect(o.delta.eye('left', 'upperLidY')).toBe(0.3);
    expect(o.lidCoverage).toEqual({ x: 0.2, y: 0.2, z: 0.2, w: 0.2 });
    expect(o.blink).toBe(0.7);
  });

  /// The perk-up's scale pop is half as big with Reduce Motion (its lids still snap wide).
  // needs the full default stack (lights up once WP6/WP7 register every modifier)
  test.skipIf(missingModifiers().length > 0)('oneShotAmplitudeIsHalved', () => {
    const peak = (reduced: boolean): { scale: number; lids: number } => {
      const engine = new FaceEngine({ seed: 4 });
      const p = engine.pupilReactionSettings;
      p.reduceMotion = reduced;
      engine.pupilReactionSettings = p;
      for (let i = 0; i < 60; i++) engine.tick(1.0 / 60);
      engine.send(FaceCommand.playOneShot('perkUp'));
      let scale = 0, lids = 0;
      for (let i = 0; i < 60; i++) {
        engine.tick(1.0 / 60);
        const o = engine.state.oneShot;
        scale = Math.max(scale, Math.abs(o.faceScaleMul.y - 1), Math.abs(o.faceScaleMul.x - 1));
        lids = Math.max(lids, Math.abs(o.lidCoverage.x), Math.abs(o.delta.eye('left', 'upperLidY')));
      }
      return { scale, lids };
    };
    const full = peak(false), reduced = peak(true);
    expect(full.scale).toBeGreaterThan(0.02);
    expect(Math.abs(reduced.scale / full.scale - 0.5), `${full.scale} → ${reduced.scale}`).toBeLessThan(0.05);
    expect(Math.abs(reduced.lids - full.lids)).toBeLessThan(1e-4);
  });

  test('edgeAnticsAreOnlyTheCuriousLean', () => {
    const t = new EdgeTriggerRig({ seed: 5, withBeats: false });
    t.rig.state.pupilSettings.reduceMotion = true;
    t.run(2 * 3600);
    expect(t.antics.length, `${t.antics.length}`).toBeGreaterThanOrEqual(3);
    expect(t.antics.every((a) => a.kind === 'curiousLean'), `${t.antics.map((a) => a.kind)}`).toBe(true);
  }, 600_000);

  test('noSleepySinkWithReduceMotion', () => {
    // Control: with the chance at 1 it plays.
    const control = new EdgeRig({ automatic: true });
    const cs = control.engine.edgeAnticSettings;
    cs.sleepySinkChance = 1;
    control.engine.edgeAnticSettings = cs;
    control.tick();
    expect(control.engine.rollSleepySink()).toBe(true);

    const rig = new EdgeRig({ automatic: true });
    const p = rig.engine.pupilReactionSettings;
    p.reduceMotion = true;
    rig.engine.pupilReactionSettings = p;
    const st = rig.engine.edgeAnticSettings;
    st.sleepySinkChance = 1;
    rig.engine.edgeAnticSettings = st;
    rig.tick();
    expect(rig.engine.rollSleepySink()).toBe(false);
  });

  /// Never perfectly still with Reduce Motion either: holding idle for 10 s, the pose changes every frame.
  // needs the full default stack (lights up once WP6/WP7 register every modifier)
  test.skipIf(missingModifiers().length > 0)('neverStillWithReduceMotion', () => {
    const engine = new FaceEngine({ seed: 3 });
    const p = engine.pupilReactionSettings;
    p.reduceMotion = true;
    engine.pupilReactionSettings = p;
    const dt = 1.0 / 60;
    for (let i = 0; i < 120; i++) engine.tick(dt);
    let prev: FacePose = engine.tick(dt).pose.copy();
    let stillFrames = 0;
    for (let i = 0; i < 600; i++) {
      const pose = engine.tick(dt).pose.copy();
      if (pose.equals(prev)) stillFrames += 1;
      prev = pose;
    }
    expect(stillFrames).toBe(0);
  });
});
