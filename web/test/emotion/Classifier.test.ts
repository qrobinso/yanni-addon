// Port of Tests/FaceEmotionTests/ClassifierTests.swift.
import { describe, expect, test } from 'vitest';
import { ExpressionLibrary } from '../../src/model';
import { ClassifierSettings, EmotionClassifier, MoodLabeler, P3, PersonalityPreset, type PAD3 } from '../../src/emotion';
import { pad } from './support';

const lib = ExpressionLibrary.bundled();
const s = new ClassifierSettings();
const base = PersonalityPreset.baseline('playful');

function classifier(): EmotionClassifier {
  const c = new EmotionClassifier();
  c.setCandidates(lib, s.allowList);
  return c;
}

/// Runs the 50 ms grid for `seconds` at a fixed point.
function hold(c: EmotionClassifier, x: PAD3, t0: number, seconds: number): number {
  let t = t0;
  for (let i = 0; i < Math.round(seconds / EmotionClassifier.interval); i++) {
    t += EmotionClassifier.interval;
    c.update(x, base, t, s);
  }
  return t;
}

describe('ClassifierTests', () => {
  test('anchors label themselves', () => {
    for (const name of s.allowList) {
      const p = lib.get(name)?.pad;
      expect(p, `${name} has no PAD`).toBeDefined();
      if (!p) continue;
      const x = pad(p.p, p.a, p.d);
      if (P3.length(P3.sub(x, base)) < s.deadzone) continue;
      const c = classifier();
      hold(c, x, 0, 1);
      expect(c.labelName, `${name} → ${c.labelName}`).toBe(name);
    }
  });

  test('never a non-allow-listed label', () => {
    const c = classifier();
    let t = 0;
    const u = (): number => Math.random() * 2 - 1;
    for (let i = 0; i < 5000; i++) {
      t = hold(c, pad(u(), u(), u()), t, 0.5);
      const l = c.labelName;
      if (l !== null) expect(s.allowList.includes(l) && !ClassifierSettings.excluded.has(l)).toBe(true);
    }
  });

  test('deadzone gives zero weight', () => {
    const c = classifier();
    hold(c, pad(0.8, 0.4, 0.3), 0, 1);
    expect(c.labelName).toBe('Happiness');
    const inside = P3.add(base, pad(0.05, 0.05, 0.05));
    expect(c.weightAndIntensity(inside, base, s).weight).toBe(0);
    hold(c, inside, 1, 1);
    expect(c.labelName).toBeNull();
  });

  test('oscillation within the margin never flips', () => {
    const h = pad(0.8, 0.4, 0.3), e = pad(0.8, 0.9, 0.4);
    const mid = P3.scale(P3.add(h, e), 0.5);
    const dir = P3.div(P3.sub(e, h), P3.length(P3.sub(e, h)));
    const c = classifier();
    let t = hold(c, P3.sub(mid, P3.scale(dir, 0.05)), 0, 1);
    const first = c.labelName;
    expect(first).toBe('Happiness');
    let flips = 0, last = first;
    for (let k = 0; k < 400; k++) {
      t = hold(c, P3.add(mid, P3.scale(dir, k % 2 === 0 ? 0.03 : -0.03)), t, 0.05);
      if (c.labelName !== last) { flips += 1; last = c.labelName; }
    }
    expect(flips).toBe(0);
  });

  test('dwell and fast path', () => {
    const c = classifier();
    let t = hold(c, pad(0.8, 0.4, 0.3), 0, 1);
    const e = pad(0.8, 0.9, 0.4);
    let k = 0;
    while (c.labelName !== 'Excitement' && k < 100) { t = hold(c, e, t, 0.05); k += 1; }
    const waited = k * 0.05;
    expect(waited <= 0.2 && waited < s.dwell).toBe(true);
    const c2 = classifier();
    let t2 = hold(c2, pad(0.8, 0.85, 0.4), 0, 1);
    expect(c2.labelName).toBe('Excitement');
    let x = pad(0.8, 0.85, 0.4);
    let n = 0;
    while (c2.labelName !== 'Happiness' && n < 200) {
      x = P3.add(x, P3.scale(P3.sub(pad(0.8, 0.4, 0.3), x), 0.05));
      t2 = hold(c2, x, t2, 0.05);
      n += 1;
    }
    expect(c2.labelName).toBe('Happiness');
  });

  test('mix changes at most five times a second under a slow sweep', () => {
    const c = classifier();
    let t = 0;
    const versions: number[] = [];
    let last = c.mixVersion;
    const a = pad(-0.6, -0.4, -0.4), b = pad(0.8, 0.9, 0.4);
    for (let k = 0; k <= 400; k++) {
      const x = P3.add(a, P3.scale(P3.sub(b, a), k / 400));
      t += EmotionClassifier.interval;
      c.update(x, base, t, s);
      if (c.mixVersion !== last) { versions.push(t); last = c.mixVersion; }
    }
    versions.forEach((v, i) => {
      let n = 0;
      for (let j = i; j < versions.length && versions[j] < v + 1; j++) n++;
      expect(n).toBeLessThanOrEqual(5);
    });
    expect(versions.length).toBeGreaterThan(0);
  });

  test('intensity guard near reference', () => {
    const c = classifier();
    hold(c, pad(0.5, 0.2, 0.2), 0, 1);
    const { weight, intensity } = c.weightAndIntensity(pad(0.5, 0.2, 0.2), pad(0.5, 0.2, 0.2), s);
    expect(weight === 0 && Number.isFinite(intensity)).toBe(true);
  });

  test('mood label buckets', () => {
    expect(MoodLabeler.bucket(PersonalityPreset.baseline('playful'), 0)).toBe('playful');
    expect(MoodLabeler.bucket(pad(0.5, 0.2, 0.2), 0)).toBe('cheerful');
    expect(MoodLabeler.bucket(pad(0.5, 0.5, 0.2), 0)).toBe('excited');
    expect(MoodLabeler.bucket(pad(0.2, -0.2, 0.1), 0)).toBe('calm');
    expect(MoodLabeler.bucket(pad(-0.1, 0, 0), 0)).toBe('a bit down');
    expect(MoodLabeler.bucket(pad(0.2, 0.1, -0.2), 0)).toBe('unsure');
    expect(MoodLabeler.bucket(pad(0.2, 0.1, 0.1), 0.7)).toBe('a bit bored');
    const l = new MoodLabeler();
    l.reset(PersonalityPreset.baseline('playful'), 0);
    const r0 = l.update(pad(0.5, 0.2, 0.2), 0, 0);
    const r1 = l.update(pad(0.5, 0.2, 0.2), 0, 4.9);
    const r2 = l.update(pad(0.5, 0.2, 0.2), 0, 5.0);
    expect(!r0 && !r1 && r2).toBe(true);
    expect(l.label).toBe('cheerful');
  });
});
