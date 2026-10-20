// Port of Tests/FaceEngineTests/LidHeavinessTests.swift.
import { describe, expect, test } from 'vitest';
import { LidHeaviness } from '../../src/engine/modifiers/LidHeaviness';
import { Composer } from '../../src/engine';
import { ExpressionLibrary, ExpressionMix, ParamLayout } from '../../src/model';
import { LidsHarness, opening } from './harness';

const library = ExpressionLibrary.bundled();

describe('LidHeaviness', () => {
  test('zeroHeavinessAddsNoCoverage', () => {
    const h = new LidsHarness([new LidHeaviness()]);
    h.run(5, (h) => { expect(h.s.lidCoverage).toEqual({ x: 0, y: 0, z: 0, w: 0 }); });
  });

  test('heavyLidsDriftFightAndStayBounded', () => {
    const h = new LidsHarness([new LidHeaviness()], 60);
    h.s.modulation.lidHeaviness = 0.35;
    let lo = 1, hi = 0, maxStep = 0, maxAsym = 0;
    let prev: number | null = null;
    h.run(120, (h) => {
      const l = h.s.lidCoverage.x, r = h.s.lidCoverage.z;
      expect(h.s.lidCoverage.y === 0 && h.s.lidCoverage.w === 0).toBe(true);
      if (h.elapsed > 2) {
        lo = Math.min(lo, l); hi = Math.max(hi, l);
        maxAsym = Math.max(maxAsym, Math.abs(l - r));
        if (prev !== null) maxStep = Math.max(maxStep, Math.abs(l - prev));
        prev = l;
      }
    });
    expect(lo >= 0.35 * 0.4 && hi <= 0.35 * 1.3, `range ${lo}...${hi}`).toBe(true);
    expect(hi - lo, `heavy lids should drift / fight (range ${hi - lo})`).toBeGreaterThan(0.05);
    expect(maxStep, `too jittery: ${maxStep}`).toBeLessThan(0.005);
    expect(maxAsym > 0.005 && maxAsym < 0.35 * 0.15).toBe(true);
  });

  test('heavinessChangesAreSmoothed', () => {
    const h = new LidsHarness([new LidHeaviness()], 60);
    h.step();
    h.s.modulation.lidHeaviness = 0.4;
    h.step();
    expect(h.s.lidCoverage.x).toBeLessThan(0.05);
    h.run(2);
    expect(h.s.lidCoverage.x).toBeGreaterThan(0.2);
  });

  test('drowsyComposedOpeningStaysAboveMinimum', () => {
    const h = new LidsHarness([new LidHeaviness()], 60);
    h.s.basePose = ExpressionMix.single('Tiredness', 0.6).pose(library);
    h.s.modulation.lidHeaviness = 0.35;
    let minA = 1;
    h.run(60, (h) => {
      for (const side of ParamLayout.Side.allCases) minA = Math.min(minA, opening(h.s.output.pose, side));
    });
    expect(minA).toBeGreaterThanOrEqual(Composer.minOpening - 1e-4);
    expect(minA).toBeLessThan(0.4);
  });

  test('worksFromLongUptime', () => {
    const h = new LidsHarness([new LidHeaviness()], 120, 1, 1_000_000);
    h.s.modulation.lidHeaviness = 0.3;
    let prev: number | null = null;
    h.run(30, (h) => {
      const v = h.s.lidCoverage.x;
      expect(Number.isFinite(v)).toBe(true);
      if (prev !== null && h.elapsed > 1) expect(Math.abs(v - prev)).toBeLessThan(0.005);
      prev = v;
    });
  });
});
