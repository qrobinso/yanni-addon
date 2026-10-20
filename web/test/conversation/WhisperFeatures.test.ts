// The Smart Turn front end's pieces against first principles (the end-to-end parity is SmartTurnModel.test.ts).
import { describe, expect, test } from 'vitest';
import { FFT400, melFilterBank, N_FRAMES, N_MELS, WhisperFeatureExtractor } from '../../src/conversation/turnml/WhisperFeatures';
import { SplitMix64 } from '../../src/core/random';

describe('WhisperFeatures', () => {
  test('the mixed-radix FFT equals a naive DFT', () => {
    const rng = new SplitMix64(9);
    const re = new Float64Array(400), im = new Float64Array(400);
    for (let i = 0; i < 400; i++) { re[i] = rng.uniform(-1, 1); im[i] = rng.uniform(-1, 1); }
    const or = new Float64Array(400), oi = new Float64Array(400);
    new FFT400().transform(re, im, or, oi);
    let worst = 0;
    for (const k of [0, 1, 7, 100, 199, 200, 201, 333, 399]) {
      let sr = 0, si = 0;
      for (let n = 0; n < 400; n++) {
        const a = (-2 * Math.PI * k * n) / 400;
        sr += re[n] * Math.cos(a) - im[n] * Math.sin(a);
        si += re[n] * Math.sin(a) + im[n] * Math.cos(a);
      }
      worst = Math.max(worst, Math.abs(sr - or[k]), Math.abs(si - oi[k]));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  test('Slaney mel filters: 80 triangles over 201 bins, area-normalised', () => {
    const m = melFilterBank();
    expect(m.length).toBe(80 * 201);
    for (let r = 0; r < 80; r++) {
      const row = m.subarray(r * 201, r * 201 + 201);
      expect(Math.max(...row)).toBeGreaterThan(0);
    }
    // Slaney normalisation: each triangle's peak is 2 / (hi − lo); the first spans 0…74.5 Hz (peak ≈ 0.0268 at 37 Hz,
    // so bin 1 at 40 Hz reads just under it).
    expect(m[1]).toBeGreaterThan(0.02);
    expect(m[1]).toBeLessThan(0.0269);
  });

  test('silence gives the floor everywhere', () => {
    const f = new WhisperFeatureExtractor().extract(new Float32Array(128_000));
    expect(f.length).toBe(N_MELS * N_FRAMES);
    expect(f.every((x) => x === f[0])).toBe(true);
    expect(f[0]).toBeCloseTo((-10 + 4) / 4, 6); // log10(1e-10) clamp, then (x + 4) / 4
  });
});
