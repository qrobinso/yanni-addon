// Port of Tests/FaceEmotionTests/DynamicsTests.swift.
import { describe, expect, test } from 'vitest';
import { ClassifierSettings, EmotionClassifier, EmotionDynamics, P3, type ImpulseTarget, type PAD3 } from '../../src/emotion';
import { approx, maxAbs, pad } from './support';

function steps(d: EmotionDynamics, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / EmotionDynamics.step); i++) d.step();
}
const abs = (p: PAD3): ImpulseTarget => ({ kind: 'absolute', pad: p });

describe('DynamicsTests', () => {
  test('impulse peak timing and fade', () => {
    const d = new EmotionDynamics();
    const b = d.baseline;
    const target = pad(0.8, 0.4, 0.3);
    const s = 0.5;
    d.apply(abs(target), s);
    let peak = 0, peakAt = 0, t63 = -1;
    const series: number[] = [];
    for (let k = 1; k <= 600; k++) {
      d.step();
      series.push(d.emotion.x);
      if (d.emotion.x > peak) { peak = d.emotion.x; peakAt = k; }
    }
    for (let k = 0; k < series.length; k++) if (series[k] >= 0.63 * peak) { t63 = k + 1; break; }
    expect(approx(peak, s * (target.x - b.x), 0.05 * s * (target.x - b.x))).toBe(true);
    expect(peakAt).toBeLessThanOrEqual(30);
    expect(t63 >= 1 && t63 <= 12).toBe(true);
    expect(series[399]).toBeLessThan(0.05 * peak);
    expect(series.every((x) => x >= -1e-6 && x <= target.x - b.x)).toBe(true);
  });

  test('stacked impulses never overshoot', () => {
    const d = new EmotionDynamics();
    const target = pad(0.8, 0.9, 0.4);
    for (let k = 0; k < 400; k++) {
      if (k % 3 === 0 && k < 120) d.apply(abs(target), 1);
      d.step();
      const e = P3.add(P3.add(d.baseline, d.rest), d.emotion);
      expect(e.x <= target.x + 0.02 && e.y <= target.y + 0.02 && e.z <= target.z + 0.02).toBe(true);
    }
  });

  test('relative impulse pushes by strength times delta', () => {
    const d = new EmotionDynamics();
    d.apply({ kind: 'relative', pad: pad(-0.15, 0.1, 0) }, 1);
    let minP = 0, maxA = 0;
    for (let i = 0; i < 100; i++) { d.step(); minP = Math.min(minP, d.emotion.x); maxA = Math.max(maxA, d.emotion.y); }
    expect(approx(minP, -0.15, 0.01)).toBe(true);
    expect(approx(maxA, 0.1, 0.01)).toBe(true);
  });

  test('mood rise and asymmetric decay', () => {
    const d = new EmotionDynamics();
    d.apply(abs(pad(0.8, 0.4, 0.3)), 1);
    steps(d, 10);
    expect(d.mood.x > 0.02 && d.mood.x < 0.08).toBe(true);
    const p = new EmotionDynamics();
    p.setMood(pad(0.3, 0.3, 0.3));
    steps(p, 600);
    expect(approx(p.mood.x, 0.3 * Math.exp(-1), 0.01)).toBe(true);
    expect(approx(p.mood.y, 0.3 * Math.exp(-600 / 90), 0.005)).toBe(true);
    const n = new EmotionDynamics();
    n.setMood(pad(-0.3, 0, 0));
    steps(n, 240);
    expect(approx(n.mood.x, -0.3 * Math.exp(-1), 0.01)).toBe(true);
  });

  test('mood cap, headroom and pleasure floor', () => {
    const d = new EmotionDynamics(), lo = new EmotionDynamics();
    let ok = true;
    for (let k = 0; k < 30 * 60 * 100; k++) {
      if (k % 100 === 0) {
        d.apply(abs(pad(1, 1, 1)), 1);
        lo.apply(abs(pad(-1, -1, -1)), 1);
      }
      d.step(); lo.step();
      if (!(d.mood.x <= 0.6 + 1e-5 && lo.mood.x >= -0.4 - 1e-5)) ok = false;
    }
    expect(ok).toBe(true);
    expect(d.mood.x > 0.3 && d.mood.x < 0.6).toBe(true);
    expect(lo.mood.x < -0.15 && lo.mood.x > -0.4).toBe(true);
  });

  test('sleepy mood decays three times faster', () => {
    const a = new EmotionDynamics(), b = new EmotionDynamics();
    a.setMood(pad(0, 0.3, 0)); b.setMood(pad(0, 0.3, 0));
    b.sleepy = true;
    steps(a, 90); steps(b, 30);
    expect(approx(a.mood.y, b.mood.y, 0.002)).toBe(true);
  });

  test('somber scales mood pleasure smoothly', () => {
    const d = new EmotionDynamics();
    d.setMood(pad(0.4, 0, 0));
    let last = d.felt.x;
    d.markSomber(d.time);
    for (let i = 0; i < 300; i++) {
      d.step();
      expect(Math.abs(d.felt.x - last)).toBeLessThan(0.01);
      last = d.felt.x;
    }
    expect(approx(d.felt.x, d.baseline.x + d.mood.x * 0.3, 0.01)).toBe(true);
    steps(d, 25);
    expect(approx(d.felt.x, d.baseline.x + d.mood.x, 0.01)).toBe(true);
  });

  test('quiet dynamics settle exactly on baseline', () => {
    const d = new EmotionDynamics();
    d.apply(abs(pad(-0.5, 0.6, -0.3)), 0.8);
    steps(d, 20);
    d.setMood(P3.zero);
    steps(d, 20);
    expect(P3.equals(d.felt, d.baseline)).toBe(true);
  });

  test('non-finite inputs ignored', () => {
    const d = new EmotionDynamics();
    d.apply(abs(pad(NaN, 0, 0)), 1);
    d.apply(abs(pad(0.5, 0, 0)), Infinity);
    d.apply({ kind: 'relative', pad: pad(0, Infinity, 0) }, 1);
    steps(d, 1);
    expect(P3.equals(d.felt, d.baseline)).toBe(true);
  });

  test('day-long soak stays bounded and returns to baseline', () => {
    const d = new EmotionDynamics();
    const u = (): number => Math.random() * 2 - 1;
    let ok = true;
    for (let k = 0; k < 24 * 3600 * 100; k++) {
      if (k % 1500 === 0) d.apply(abs(pad(u(), u(), u())), Math.random());
      d.step();
      if (k % 1000 === 0) {
        const f = d.felt;
        if (!(P3.isFinite(f) && maxAbs(f) <= 1)) ok = false;
      }
    }
    expect(ok).toBe(true);
    steps(d, 3600);
    expect(maxAbs(P3.sub(d.felt, d.baseline))).toBeLessThan(0.01);
  }, 60_000);

  test('persisted mood decays by elapsed time', () => {
    const d = new EmotionDynamics();
    const m = d.decayed(pad(0.3, 0.3, -0.2), 600);
    expect(approx(m.x, 0.3 * Math.exp(-1), 1e-4)).toBe(true);
    expect(approx(m.y, 0.3 * Math.exp(-600 / 90), 1e-4)).toBe(true);
    expect(maxAbs(d.decayed(pad(0.5, 0.5, 0.5), 1e9))).toBeLessThan(1e-4);
  });
});

describe('MoodEnvelopeTests', () => {
  // A warm ten-minute conversation (8 decisions a minute) builds mood to about 0.3, and felt is back inside the
  // classifier's deadzone within 3 minutes of quiet.
  test('ten-minute warm conversation', () => {
    const d = new EmotionDynamics();
    for (let k = 0; k < 10 * 60 * 100; k++) {
      if (k % 750 === 0) d.apply(abs(pad(0.72, 0.42, 0.29)), 0.4);
      d.step();
    }
    expect(approx(d.mood.x, 0.3, 0.1)).toBe(true);
    const c = new ClassifierSettings();
    d.apply(abs(pad(0.72, 0.42, 0.29)), 0.4);
    for (let i = 0; i < 20; i++) d.step();
    let quiet = 0;
    const outside = (): boolean => {
      const x = EmotionClassifier.point(d.baseline, P3.sub(P3.sub(d.felt, d.baseline), P3.scale(d.mood, c.moodShare)),
        P3.zero, c);
      return P3.length(P3.sub(x, d.baseline)) >= c.deadzone;
    };
    while (outside() && quiet < 18_000) { d.step(); quiet += 1; }
    expect(quiet > 0 && quiet < 18_000).toBe(true);
  });
});
