// Port of Tests/FaceEngineTests/BrightnessTests.swift.
import { describe, expect, test } from 'vitest';
import { Brightness } from '../../src/engine/modifiers/Brightness';
import { Phase } from '../../src/engine';
import { LidsHarness, LidsProbe } from './harness';

describe('Brightness', () => {
  test('convergesWithTimeConstant', () => {
    const b = new Brightness();
    const h = new LidsHarness([b], 60);
    h.s.targetBrightness = 0.85;
    h.step();
    expect(Math.abs(b.level - 0.85)).toBeLessThan(1e-6); // starts at target, no fade-in from black
    h.s.targetBrightness = 0.12;
    h.run(Brightness.tau);
    const expected = 0.12 + (0.85 - 0.12) * Math.exp(-1);
    expect(Math.abs(b.level - expected), `${b.level} vs ${expected}`).toBeLessThan(2e-3);
    h.run(15);
    expect(Math.abs(b.level - 0.12)).toBeLessThan(1e-3);
    expect(Math.abs(h.s.output.brightness - 0.12)).toBeLessThan(1e-3);
  });

  test('multipliesIntoExistingBrightness', () => {
    const h = new LidsHarness([
      new LidsProbe('LidsProbe', Phase.motion, (s) => { s.brightness *= 0.5; }),
      new Brightness(),
    ]);
    h.s.targetBrightness = 0.8;
    h.run(1, (h) => { expect(Math.abs(h.s.output.brightness - 0.4)).toBeLessThan(1e-5); });
  });

  test('sixtyAndOneTwentyFpsMatch', () => {
    const ba = new Brightness(), bb = new Brightness();
    const a = new LidsHarness([ba], 60), b = new LidsHarness([bb], 120);
    a.s.targetBrightness = 0.85; b.s.targetBrightness = 0.85;
    for (let i = 0; i < 60 * 10; i++) {
      if (i === 30) { a.s.targetBrightness = 0.12; b.s.targetBrightness = 0.12; }
      if (i === 400) { a.s.targetBrightness = 0.7; b.s.targetBrightness = 0.7; }
      a.step(); b.step(); b.step();
      expect(Math.abs(ba.level - bb.level)).toBeLessThan(1e-4);
    }
  });

  test('nonFiniteTargetIsIgnored', () => {
    const b = new Brightness();
    const h = new LidsHarness([b]);
    h.s.targetBrightness = NaN;
    h.run(1);
    expect(Number.isFinite(b.level)).toBe(true);
    expect(Number.isFinite(h.s.output.brightness)).toBe(true);
  });
});
