// Port of Tests/FaceEngineTests/ExpressionTransitionTests.swift.
import { describe, expect, test } from 'vitest';
import { ExpressionTransition } from '../../src/engine';
import { ExpressionLibrary, ExpressionMix, FacePose, ParamLayout, mixEntry as E } from '../../src/model';
import { ASTRig } from './ASTRig';

const lib = ExpressionLibrary.bundled();

function rig(et: ExpressionTransition = new ExpressionTransition()): ASTRig {
  const r = new ASTRig([et]);
  r.tick(); // snap to Neutral
  return r;
}

/// Runs a scripted sequence (mix changes, override, mood-ish modulation) and samples every 1/60 s.
function trajectory(fps: number): FacePose[] {
  const r = rig();
  r.state.modulation.speed = 1.2;
  r.state.modulation.bounciness = 0.3;
  r.state.modulation.intensity = 1.05;
  const dt = 1 / fps;
  const perSample = fps / 60;
  const out: FacePose[] = [];
  for (let frame = 1; frame <= fps * 3; frame++) {
    const prior = frame - 1; // changes land at sample boundaries for both rates
    if (prior % perSample === 0) {
      switch (prior / perSample) {
        case 30: r.state.targetMix = ExpressionMix.single('Surprise'); break;
        case 60: r.state.targetMix = new ExpressionMix([E('Happiness', 0.7), E('Tiredness', 0.3)], 0.8); break;
        case 90: r.state.expressionOverride = ExpressionMix.single('Anger'); break;
        case 92: r.state.expressionOverride = ExpressionMix.single('Confusion'); break; // mid-lag change
        case 130: r.state.expressionOverride = null; break;
        default: break;
      }
    }
    r.tick(dt);
    if (frame % perSample === 0) out.push(r.state.basePose.copy());
  }
  return out;
}

describe('ExpressionTransition', () => {
  test('convergesToTarget', () => {
    const r = rig();
    r.state.targetMix = new ExpressionMix([E('Surprise', 0.5), E('Happiness', 0.5)]);
    r.run(2.5);
    const target = r.state.targetMix.pose(lib);
    for (let i = 0; i < ParamLayout.count; i++) {
      expect(Math.abs(r.state.basePose.get(i) - target.get(i)), ParamLayout.names[i]).toBeLessThan(1e-3);
    }
  });

  test('firstFrameSnaps', () => {
    const r = new ASTRig([new ExpressionTransition()]);
    r.state.targetMix = ExpressionMix.single('Asleep');
    r.tick();
    expect(Math.abs(r.state.basePose.eye('left', 'upperLidY') - lib.get('Asleep')!.pose.eye('left', 'upperLidY'))).toBeLessThan(1e-6);
  });

  test('scalePopsButRadiiDoNot', () => {
    const r = rig();
    r.state.targetMix = ExpressionMix.single('Happiness'); // upper radii x 0.5 → 1.0
    let radiusPeak = 0;
    r.run(1.5, undefined, (s) => { radiusPeak = Math.max(radiusPeak, s.state.basePose.eye('left', 'upperInnerRadiusX')); });
    expect(radiusPeak).toBeLessThanOrEqual(1.0 + 1e-4);

    r.state.targetMix = ExpressionMix.single('Surprise'); // eye scale 1 → 1.25
    let scalePeak = 0;
    r.run(1.5, undefined, (s) => { scalePeak = Math.max(scalePeak, s.state.basePose.eye('left', 'scaleX')); });
    expect(scalePeak, 'underdamped scale pops past the target').toBeGreaterThan(1.26);
    expect(Math.abs(r.state.basePose.eye('left', 'scaleX') - 1.25)).toBeLessThan(1e-3);
  });

  test('lidsLagTheShape', () => {
    const et = new ExpressionTransition();
    et.leadChance = 0; // follow: the eye shape leads, the lids follow (the brow-led variant holds the shape back)
    const r = rig(et);
    r.state.targetMix = new ExpressionMix([E('Surprise', 0.5), E('Happiness', 0.5)]);
    r.run(0.03, 1 / 120);
    expect(r.state.basePose.eye('left', 'scaleX'), 'scale already moving').toBeGreaterThan(1.005);
    expect(Math.abs(r.state.basePose.eye('left', 'lowerLidY')), "lids haven't started").toBeLessThan(1e-6);
    r.run(0.1, 1 / 120);
    expect(r.state.basePose.eye('left', 'lowerLidY'), 'lids follow').toBeGreaterThan(0.02);
  });

  test('bouncinessAndSpeedModulateSprings', () => {
    const peak = (bounciness: number, speed: number): { peak: number; at50ms: number } => {
      const r = rig();
      r.state.modulation.bounciness = bounciness;
      r.state.modulation.speed = speed;
      r.state.targetMix = ExpressionMix.single('Surprise');
      let p = 0, at50 = 0, t = 0;
      r.run(1, undefined, (s) => {
        t = Math.fround(t + Math.fround(1 / 60));
        p = Math.max(p, s.state.basePose.eye('left', 'scaleX'));
        if (Math.abs(t - 0.05) < 0.005) at50 = s.state.basePose.eye('left', 'scaleX');
      });
      return { peak: p, at50ms: at50 };
    };
    expect(peak(1, 1).peak).toBeGreaterThan(peak(0, 1).peak);
    expect(peak(0, 1.5).at50ms).toBeGreaterThan(peak(0, 0.6).at50ms);
  });

  test('frameRateIndependent', () => {
    const a = trajectory(60), b = trajectory(120);
    expect(a.length).toBe(b.length);
    let worst = 0;
    for (let k = 0; k < a.length; k++) {
      for (let i = 0; i < ParamLayout.count; i++) {
        const r = ParamLayout.ranges[i];
        // Tolerance relative to a practical span (positions span ±200 in the table but move ~±60).
        const span = Math.min(r.upperBound - r.lowerBound, 3);
        worst = Math.max(worst, Math.abs(a[k].get(i) - b[k].get(i)) / span);
      }
    }
    expect(worst, `worst relative deviation ${worst}`).toBeLessThanOrEqual(1e-3);
  });

  test('cacheRecomputesOnlyOnChange', () => {
    const et = new ExpressionTransition();
    const r = rig(et);
    expect(et.cacheRecomputeCount).toBe(1);
    r.run(0.2);
    expect(et.cacheRecomputeCount).toBe(1);

    r.state.targetMix.intensity = 0.5; // intensity alone: no re-resolve
    r.state.modulation.intensity = 1.2;
    r.run(0.2);
    expect(et.cacheRecomputeCount).toBe(1);

    r.state.targetMix = ExpressionMix.single('Surprise');
    r.run(0.2);
    expect(et.cacheRecomputeCount).toBe(2);

    r.state.expressionOverride = ExpressionMix.single('Anger');
    r.tick();
    expect(et.cacheRecomputeCount).toBe(3);
    expect(Math.abs(et.currentTarget.eye('left', 'upperLidAngle') - lib.get('Anger')!.pose.eye('left', 'upperLidAngle') * 1.2)).toBeLessThan(1e-4);
    r.state.expressionOverride = null;
    r.tick();
    expect(et.cacheRecomputeCount).toBe(4);

    // Library edit (preview tool) invalidates.
    const edited = r.state.library.copy();
    const surprise = edited.get('Surprise')!;
    surprise.pose.setEye('left', 'scaleX', 1.5);
    edited.set(surprise);
    r.state.library = edited;
    r.state.libraryVersion += 1;
    r.state.modulation.intensity = 1;
    r.state.targetMix = ExpressionMix.single('Surprise');
    r.tick();
    expect(et.cacheRecomputeCount).toBe(5);
    expect(Math.abs(et.currentTarget.eye('left', 'scaleX') - 1.5)).toBeLessThan(1e-5);
  });

  test('intensityModulationMatchesExpressionMix', () => {
    const et = new ExpressionTransition();
    const r = rig(et);
    const mix = new ExpressionMix([E('Surprise', 0.6), E('Sadness', 0.4)], 0.9);
    r.state.targetMix = mix;
    for (const mod of [0.5, 1, 1.3]) {
      r.state.modulation.intensity = mod;
      r.tick();
      const expected = new ExpressionMix(mix.entries, 0.9 * mod).pose(lib);
      for (let i = 0; i < ParamLayout.count; i++) {
        expect(Math.abs(et.currentTarget.get(i) - expected.get(i)), `${ParamLayout.names[i]} @${mod}`).toBeLessThan(1e-4);
      }
    }
    r.state.targetMix = ExpressionMix.single('Surprise');
    r.state.modulation.intensity = 0.5;
    r.tick();
    expect(Math.abs(et.currentTarget.eye('left', 'scaleX') - Math.exp(0.5 * Math.log(1.25))), 'log-space scale').toBeLessThan(1e-5);
  });

  test('overrideBeatsTargetMix', () => {
    const r = rig();
    r.state.targetMix = ExpressionMix.single('Happiness');
    r.state.expressionOverride = ExpressionMix.single('Sadness');
    r.run(2.5);
    const sad = lib.get('Sadness')!.pose;
    expect(Math.abs(r.state.basePose.eye('left', 'upperLidAngle') - sad.eye('left', 'upperLidAngle'))).toBeLessThan(1e-3);
  });

  test('recoversFromNonFinite', () => {
    const r = rig();
    r.state.basePose.setEye('left', 'scaleX', NaN);
    r.tick();
    expect(r.state.basePose.hasNonFinite).toBe(false);
  });
});
