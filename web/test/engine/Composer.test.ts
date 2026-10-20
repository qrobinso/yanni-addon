// Port of Tests/FaceEngineTests/ComposerTests.swift.
import { Blink } from '../../src/engine/modifiers/Blink';
import { Breathing } from '../../src/engine/modifiers/Breathing';
import { Brightness } from '../../src/engine/modifiers/Brightness';
import { BurnInDrift } from '../../src/engine/modifiers/BurnInDrift';
import { LidHeaviness } from '../../src/engine/modifiers/LidHeaviness';
import { SquashStretch } from '../../src/engine/modifiers/SquashStretch';
import { describe, expect, test } from 'vitest';
import { Composer, Director, FaceState, LidMath, type Modifier, type Phase } from '../../src/engine';
import { ExpressionLibrary, ExpressionMix, FacePose, ParamLayout, type Side } from '../../src/model';
import type { V4 } from '../../src/core/vec';

// MARK: - Shared harness for the lids / body / composer tests

const library = ExpressionLibrary.bundled();
const pose = (name: string): FacePose => library.get(name)!.pose;

import { LidsHarness, LidsProbe, opening, visibleOpening } from './harness';
export { LidsHarness, LidsProbe, opening, visibleOpening };


const v4 = (x: number, y: number, z: number, w: number): V4 => ({ x, y, z, w });

// MARK: - Composer

function composed(base: FacePose, o: { blink?: number; lidClose?: number; coverage?: V4 } = {}): FacePose {
  const s = new FaceState(library, 1);
  s.basePose = base;
  s.blink = o.blink ?? 0;
  s.lidClose = o.lidClose ?? 0;
  s.lidCoverage = o.coverage ?? v4(0, 0, 0, 0);
  Composer.compose(s);
  return s.output.pose;
}

type Channel = 'blink' | 'lidClose' | 'both' | 'blinkOverHeavy' | 'lidCloseOverHeavy';
const channels: Channel[] = ['blink', 'lidClose', 'both', 'blinkOverHeavy', 'lidCloseOverHeavy'];

describe('Composer', () => {
  test.each(channels)('closureIsMonotonicForEveryExpression(%s)', (channel) => {
    expect(library.names.length).toBeGreaterThanOrEqual(25);
    let failures = 0;
    const fail = (msg: string): void => { if (failures++ < 10) expect.soft(false, msg).toBe(true); };
    for (const name of library.names) {
      const base = pose(name);
      const prev = [Infinity, Infinity], prevU = [-Infinity, -Infinity], prevL = [-Infinity, -Infinity];
      for (let i = 0; i <= 100; i++) {
        const c = i / 100;
        let p: FacePose;
        switch (channel) {
          case 'blink': p = composed(base, { blink: c }); break;
          case 'lidClose': p = composed(base, { lidClose: c }); break;
          case 'both': p = composed(base, { blink: c, lidClose: c }); break;
          case 'blinkOverHeavy': p = composed(base, { blink: c, coverage: v4(0.35, 0, 0.35, 0) }); break;
          case 'lidCloseOverHeavy': p = composed(base, { lidClose: c, coverage: v4(0.35, 0.1, 0.35, 0.1) }); break;
        }
        ParamLayout.Side.allCases.forEach((side, k) => {
          const o = visibleOpening(p, side);
          if (!(o <= prev[k] + 1e-5)) fail(`${name} ${side} ${channel} opening increased at c=${c}`);
          if (!(p.eye(side, 'upperLidY') >= prevU[k] - 1e-5)) fail(`${name} upper lid opened at c=${c}`);
          if (!(p.eye(side, 'lowerLidY') >= prevL[k] - 1e-5)) fail(`${name} lower lid opened at c=${c}`);
          prev[k] = o; prevU[k] = p.eye(side, 'upperLidY'); prevL[k] = p.eye(side, 'lowerLidY');
          if (c === 1) {
            // Never degenerate: the eye keeps a real height for the renderer's pill.
            if (!(p.eye(side, 'scaleY') >= 0.25 * base.eye(side, 'scaleY') * 0.99)) fail(`${name} collapsed`);
            if ((channel === 'blink' || channel === 'both' || channel === 'blinkOverHeavy') && !(opening(p, side) < 0.02)) {
              fail(`${name} blink didn't close`);
            }
            if (channel === 'lidClose' && !(p.eye(side, 'scaleY') >= Composer.lidCloseSquashY * base.eye(side, 'scaleY') - 1e-4)) {
              fail(`${name} lidClose squash`);
            }
          }
        });
      }
    }
    expect(failures).toBe(0);
  });

  test('minimumOpeningOutsideClosureForEveryExpression', () => {
    let failures = 0;
    for (const name of library.names) {
      const base = pose(name);
      for (let i = 0; i <= 20; i++) {
        const h = i / 20;
        for (const cov of [v4(h, 0, h, 0), v4(h, h, h, h), v4(0, h, 0, h)]) {
          const p = composed(base, { coverage: cov });
          for (const side of ParamLayout.Side.allCases) {
            if (!(opening(p, side) >= Composer.minOpening - 1e-4) && failures++ < 10) {
              expect.soft(opening(p, side), `${name} h=${h} ${side}`).toBeGreaterThanOrEqual(Composer.minOpening - 1e-4);
            }
          }
        }
      }
    }
    expect(failures).toBe(0);
  });

  test('drowsyOpeningStaysAboveMinimum', () => {
    const tired = ExpressionMix.single('Tiredness', 0.6).pose(library);
    const p = composed(tired, { coverage: v4(0.35, 0, 0.35, 0) });
    for (const side of ParamLayout.Side.allCases) {
      const a = opening(p, side);
      expect(a).toBeGreaterThanOrEqual(Composer.minOpening - 1e-4);
      expect(a).toBeLessThan(0.5); // still visibly heavy
    }
  });

  test('coverageIsFractionOfRemainingOpening', () => {
    const base = FacePose.defaults;
    base.addBoth('upperLidY', 0.2);
    base.addBoth('lowerLidY', 0.2);
    const p = composed(base.copy(), { coverage: v4(0.25, 0, 0.25, 0) });
    // A = 0.6, u' = 0.2 + 0.25·0.6 = 0.35
    expect(Math.abs(p.eye('left', 'upperLidY') - 0.35)).toBeLessThan(1e-4);
    expect(Math.abs(p.eye('right', 'lowerLidY') - 0.2)).toBeLessThan(1e-4);
    // Negative coverage opens but never below 0.
    const q = composed(base.copy(), { coverage: v4(-0.5, -1, -0.5, -1) });
    expect(q.eye('left', 'upperLidY') < 0.2 && q.eye('left', 'upperLidY') > 0).toBe(true);
    expect(q.eye('left', 'lowerLidY')).toBeGreaterThanOrEqual(0);
    expect(q.eye('left', 'lowerLidY')).toBeLessThan(0.02);
  });

  test('softClampIsContinuousWithoutFlatSpotsInside', () => {
    const k = 0.08;
    let prev = LidMath.softClamp(-0.5, 0, 1, k);
    const step = 0.0005;
    let x = -0.5 + step;
    let failures = 0;
    const check = (ok: boolean, msg: string): void => { if (!ok && failures++ < 10) expect.soft(ok, msg).toBe(true); };
    while (x <= 1.5) {
      const v = LidMath.softClamp(x, 0, 1, k);
      check(v >= 0 && v <= 1, `range at x=${x}`);
      check(v >= prev - 1e-7, `monotonic at x=${x}`);
      check(v - prev <= step * 1.0001 + 1e-6, `Lipschitz at x=${x}`); // no jumps
      if (x > -k / 2 + step && x < 1 + k / 2 - step) check(v > prev, `flat spot at x=${x}`); // no flat spots in the knee
      if (x >= k / 2 && x <= 1 - k / 2) check(Math.abs(v - x) < 1e-6, `identity at x=${x}`); // identity inside
      prev = v;
      x += step;
    }
    expect(failures).toBe(0);
  });

  test('composedLidsAndRadiiMoveContinuously', () => {
    let prevU: number | null = null, prevR: number | null = null;
    const step = 0.002;
    let v = -0.3;
    while (v <= 1.3) {
      const base = FacePose.defaults;
      base.setEye('left', 'upperLidY', v);
      base.setEye('left', 'upperOuterRadiusX', v);
      const p = composed(base);
      const u = p.eye('left', 'upperLidY'), r = p.eye('left', 'upperOuterRadiusX');
      if (prevU !== null && prevR !== null) {
        expect(Math.abs(u - prevU)).toBeLessThanOrEqual(step * 1.01 + 1e-5);
        expect(Math.abs(r - prevR)).toBeLessThanOrEqual(step * 1.01 + 1e-5);
      }
      expect(u >= 0 && u <= 1 && r >= 0 && r <= 1).toBe(true);
      prevU = u; prevR = r;
      v += step;
    }
  });

  test('scalesAreMultiplicative', () => {
    const s = new FaceState(library, 1);
    s.basePose = pose('Surprise').copy();
    s.faceScaleMul = { x: 1.1, y: 0.9 };
    s.eyeScaleMul = v4(1.2, 0.8, 0.5, 2);
    Composer.compose(s);
    const b = s.basePose, p = s.output.pose;
    expect(Math.abs(p.face('scaleX') - b.face('scaleX') * 1.1)).toBeLessThan(1e-5);
    expect(Math.abs(p.face('scaleY') - b.face('scaleY') * 0.9)).toBeLessThan(1e-5);
    expect(Math.abs(p.eye('left', 'scaleX') - b.eye('left', 'scaleX') * 1.2)).toBeLessThan(1e-5);
    expect(Math.abs(p.eye('right', 'scaleY') - b.eye('right', 'scaleY') * 2)).toBeLessThan(1e-5);
  });

  test('nanGuardFallsBackToNeutral', () => {
    const s = new FaceState(library, 1);
    s.delta.setFace('centerX', NaN);
    s.brightness = Infinity;
    Composer.compose(s);
    expect(s.output.pose.hasNonFinite).toBe(false);
    expect(s.output.pose.equals(library.neutral.clamped())).toBe(true);
    expect(Number.isFinite(s.output.brightness)).toBe(true);

    const t = new FaceState(library, 1);
    t.blink = NaN;
    t.lidClose = NaN;
    t.faceScaleMul = { x: Infinity, y: 1 };
    Composer.compose(t);
    expect(t.output.pose.hasNonFinite).toBe(false);
  });

  test('prevPoseAndFrameFields', () => {
    const s = new FaceState(library, 1);
    s.dt = 1 / 60;
    s.basePose.setFace('centerX', 10);
    Composer.compose(s);
    const first = s.output.pose.copy();
    s.basePose.setFace('centerX', 11);
    s.brightness = 1.7;
    s.agentState = 'asleep';
    Composer.compose(s);
    expect(s.prevPose.equals(first)).toBe(true);
    expect(s.output.brightness).toBe(1);
    expect(s.output.isAsleep).toBe(true);
  });

  test('wantsHighFrameRateWithHysteresis', () => {
    const s = new FaceState(library, 1);
    s.dt = 1 / 60;
    s.time = 10;
    const frame = (x: number, blink = 0): boolean => {
      s.time += 1 / 60;
      s.basePose.setFace('centerX', x);
      s.blink = blink;
      Composer.compose(s);
      return s.output.wantsHighFrameRate;
    };
    frame(0); frame(0);
    expect(frame(0)).toBe(false);
    // A blink on its own never asks for the burst (blinks read fine at 60).
    expect(frame(0, 0.5)).toBe(false);
    expect(frame(0, 1)).toBe(false);
    frame(0); frame(0);
    expect(frame(0)).toBe(false);
    // Fast: 1 pose unit/frame = 0.55·60 = 33 canvas/s > 30.
    let x = 0;
    x += 1; expect(frame(x)).toBe(true);
    // Medium: 0.5 pose units/frame = 16.5 canvas/s — between stay (10) and enter (30): stays fast.
    x += 0.5; expect(frame(x)).toBe(true);
    x += 0.5; expect(frame(x)).toBe(true);
    // Slow: drops out.
    x += 0.1; expect(frame(x)).toBe(false);
    // Medium from rest does not enter.
    x += 0.5; expect(frame(x)).toBe(false);
    // During a blink, fast travel of the eye still asks.
    s.lastBlinkTime = s.time;
    x += 1; expect(frame(x, 0.5)).toBe(true);
  });

  test.each([0.0, 1_000_000.0])('fullLidsAndBodyStackIsFrameRateIndependent(%d)', (start) => {
    const make = (fps: number): LidsHarness => {
      const mods: Modifier[] = [
        new Breathing(), new SquashStretch(), new Blink(), new LidHeaviness(), new BurnInDrift(), new Brightness(),
      ];
      const h = new LidsHarness(mods, fps, 99, start);
      h.s.modulation.lidHeaviness = 0.2;
      h.s.targetBrightness = 0.85;
      h.s.basePose = pose('Happiness').copy();
      return h;
    };
    const a = make(60), b = make(120);
    let sawBlink = false;
    let maxErr = 0;
    let worst = '';
    for (let i = 0; i < 60 * 30; i++) {
      if (i === 60 * 12) { a.s.agentState = 'asleep'; b.s.agentState = 'asleep'; a.s.targetBrightness = 0.12; b.s.targetBrightness = 0.12; }
      if (i === 60 * 20) { a.s.agentState = 'idle'; b.s.agentState = 'idle'; a.s.targetBrightness = 0.85; b.s.targetBrightness = 0.85; }
      a.step(); b.step(); b.step();
      if (a.s.blink > 0.5) sawBlink = true;
      for (let p = 0; p < ParamLayout.count; p++) {
        const r = ParamLayout.ranges[p];
        const tol = Math.min((r.upperBound - r.lowerBound) * 1e-3, 0.01);
        const err = Math.abs(a.s.output.pose.raw[p] - b.s.output.pose.raw[p]);
        if (err / tol > maxErr) { maxErr = err / tol; worst = `${ParamLayout.names[p]} t=${a.elapsed} blink=${a.s.blink}/${b.s.blink}`; }
      }
      expect(Math.abs(a.s.output.brightness - b.s.output.brightness)).toBeLessThan(1e-3);
    }
    expect(sawBlink).toBe(true);
    expect(maxErr, `max error / tolerance = ${maxErr} at ${worst}`).toBeLessThanOrEqual(1);
  });
});
