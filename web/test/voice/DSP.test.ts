// Port of Tests/FaceVoiceTests/DSPTests.swift.
import { describe, expect, test } from 'vitest';
import { NoteShape, SVF, SineTable, formantFrequencies, polyBLEPSquare, softLimit, svfG, volumeGain } from '../../src/voice';
import { Fx } from './RendererFixtures';

describe('DSPTests', () => {
  test('sineTableIsAccurate', () => {
    const t = SineTable.make();
    let maxErr = 0;
    for (let i = 0; i < 10_000; i++) {
      const p = i / 1000 - 5;                                // includes negative phases
      maxErr = Math.max(maxErr, Math.abs(SineTable.sin(t, p) - Math.sin(2 * Math.PI * p)));
    }
    expect(maxErr).toBeLessThan(2e-5);
  });

  test('polyBLEPSquareIsBoundedAndBandLimited', () => {
    const dt = 1500.0 / 48000;
    let phase = 0;
    let maxAbs = 0;
    let maxDelta = 0;
    let prev = polyBLEPSquare(0, dt);
    for (let i = 0; i < 4800; i++) {
      phase += dt; if (phase >= 1) phase -= 1;
      const v = polyBLEPSquare(phase, dt);
      maxAbs = Math.max(maxAbs, Math.abs(v)); maxDelta = Math.max(maxDelta, Math.abs(v - prev)); prev = v;
    }
    expect(maxAbs).toBeLessThanOrEqual(1.05);
    expect(maxDelta).toBeLessThan(1.9);                     // a naive square jumps by exactly 2
  });

  test('svfLowPassHasUnityDCGainAndIsStableAtExtremes', () => {
    for (const fc of [20, 1000, 21_600]) {
      const f = new SVF();
      f.setCoefficients(svfG(fc, 48000), 0.2);
      let y = 0;
      for (let i = 0; i < 96_000; i++) y = f.tick(1);
      expect(Math.abs(y - 1), `fc ${fc}: ${y}`).toBeLessThan(1e-3);
      const clean = f.sanitize();
      expect(clean).toBe(true);
    }
  });

  test('svfGClampsBelowNyquistShare', () => {
    expect(Math.abs(svfG(100_000, 16000) - Math.tan(Math.PI * 0.45))).toBeLessThan(1e-3);
  });

  test('softLimiterIsLinearBelowThresholdAndBounded', () => {
    expect(softLimit(0.5)).toBe(0.5);
    expect(softLimit(-0.7)).toBe(-0.7);
    let prev = 0;
    for (let i = 0; i <= 1000; i++) {
      const y = softLimit(i * 0.01);
      expect(y <= 1 && y >= prev).toBe(true);
      prev = y;
    }
    expect(Math.abs(softLimit(-3) + softLimit(3))).toBeLessThan(1e-6);
  });

  test('volumeMapping', () => {
    expect(volumeGain(0)).toBe(0);
    expect(Math.abs(volumeGain(1) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(20 * Math.log10(volumeGain(0.5)) + 20)).toBeLessThan(1e-3);
  });

  test('formantFrequenciesSpanTheirRanges', () => {
    expect(formantFrequencies(0)).toEqual({ f1: 350, f2: 1100 });
    expect(formantFrequencies(1)).toEqual({ f1: 350, f2: 2400 });
    expect(formantFrequencies(0.5).f1).toBe(700);
  });

  test('slurLevelIsContinuousAtTheTransition', () => {
    const a = Fx.sineNote({ start: 0, duration: 0.2 });
    const b = Fx.sineNote({ start: 0.2, duration: 0.2, slur: true });
    const lIn = NoteShape.level(a, 0.2, false, 0);
    expect(Math.abs(NoteShape.level(b, 0, true, lIn) - lIn)).toBeLessThan(1e-6);
    expect(NoteShape.level(b, 0, false, 0)).toBe(0);
  });
});
