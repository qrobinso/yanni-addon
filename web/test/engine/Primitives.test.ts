// Port of Tests/FaceEngineTests/PrimitivesTests.swift.
import { describe, expect, test } from 'vitest';
import { Noise1D, Spring1, SpringParams, Track } from '../../src/engine';
import { SplitMix64 } from '../../src/core/random';

describe('Spring', () => {
  const simulate = (fps: number, seconds: number, p: SpringParams): Spring1 => {
    const s = new Spring1(0);
    const dt = 1 / fps;
    for (let i = 0; i < Math.trunc(seconds * fps); i++) s.step(1, p, dt);
    return s;
  };

  test.each([new SpringParams(55, 0.75), new SpringParams(10, 1), new SpringParams(4, 1.6)])(
    'frameRateIndependent(%o)', (p) => {
      for (const t of [0.05, 0.25, 1.0]) {
        const a = simulate(60, t, p), b = simulate(120, t, p);
        expect(Math.abs(a.value - b.value)).toBeLessThan(1e-4);
        expect(Math.abs(a.velocity - b.velocity)).toBeLessThan(1e-2);
      }
    });

  test('underdampedOvershootsThenSettles', () => {
    const s = new Spring1(0); let peak = 0;
    for (let i = 0; i < 240; i++) { s.step(1, new SpringParams(30, 0.5), 1 / 120); peak = Math.max(peak, s.value); }
    expect(peak).toBeGreaterThan(1.05);
    expect(Math.abs(s.value - 1)).toBeLessThan(1e-3);
  });

  test('criticalNeverOvershoots', () => {
    const s = new Spring1(0);
    for (let i = 0; i < 240; i++) { s.step(1, new SpringParams(20, 1), 1 / 120); expect(s.value).toBeLessThanOrEqual(1.0001); }
  });
});

describe('Random', () => {
  test('deterministic', () => {
    const a = new SplitMix64(42), b = new SplitMix64(42), c = new SplitMix64(43);
    const take = (r: SplitMix64): bigint[] => Array.from({ length: 10 }, () => r.next());
    const xa = take(a), xb = take(b), xc = take(c);
    expect(xa).toEqual(xb);
    expect(xa).not.toEqual(xc);
  });

  test('lognormalMedian', () => {
    const r = new SplitMix64(7);
    const xs = Array.from({ length: 4001 }, () => r.lognormal(3.5, 0.4)).sort((x, y) => x - y);
    expect(Math.abs(xs[2000] - 3.5)).toBeLessThan(0.2);
  });
});

describe('NoiseAndEase', () => {
  test('noiseIsSmoothAndBounded', () => {
    const n = new Noise1D(1);
    let prev = n.value(0);
    for (let i = 1; i <= 10_000; i++) {
      const v = n.value(i * 0.001);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.01);
      expect(Math.abs(v - prev)).toBeLessThan(0.01);
      prev = v;
    }
  });

  test('trackHitsKeys', () => {
    const t = new Track([[0, 0], [0.1, 1], [0.3, -0.5], [0.5, 0]]);
    expect(Math.abs(t.value(0.1) - 1)).toBeLessThan(1e-5);
    expect(Math.abs(t.value(0.3) + 0.5)).toBeLessThan(1e-5);
    expect(t.value(0.6)).toBe(0);
  });
});
