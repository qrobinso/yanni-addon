// Port of Tests/FaceEngineTests/MoodColorTests.swift.
import { describe, expect, test } from 'vitest';
import { v3, type V3 } from '../../src/core/vec';
import { ExpressionLibrary, ExpressionMix, FaceFrame, Oklab } from '../../src/model';
import { FaceEngine, Mood, MoodPalette, type MoodPaletteAnchor } from '../../src/engine';
import { MoodColor } from '../../src/engine/modifiers/MoodColor';
import { LidsHarness } from './harness';

const palette = MoodPalette.standard;
const base = FaceFrame.defaultColor;
const library = ExpressionLibrary.bundled();

const pad = (m: Mood): V3 => v3(m.pleasure, m.arousal, m.dominance);
const dist = (a: V3, b: V3): number => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
const anchor = (name: string): MoodPaletteAnchor => palette.anchors.find((a) => a.name === name)!;
const color = (p: V3): V3 => palette.displayLinear(p);
const isZero = (v: V3): boolean => v.x === 0 && v.y === 0 && v.z === 0;

describe('MoodColor', () => {
  // MARK: Palette

  test('playfulBaselineWithNeutralIsExactlyTheDefaultCyan', () => {
    const c = color(pad(Mood.playful));
    expect(dist(c, base)).toBeLessThan(1e-3);

    const h = new LidsHarness([new MoodColor()]);
    h.run(0.5);
    expect(dist(h.s.eyeColor, base)).toBeLessThan(1e-3);
    expect(dist(h.s.output.color, base)).toBeLessThan(1e-3);
  });

  test('defaultEngineProducesCyanAtBaseline', () => {
    const engine = new FaceEngine({ seed: 3 });
    let frame = engine.tick(1 / 60);
    for (let i = 0; i < 60; i++) frame = engine.tick(1 / 60);
    expect(engine.director.modifier('MoodColor')).toBeInstanceOf(MoodColor);
    expect(dist(frame.color, base)).toBeLessThan(1e-3);
  });

  test.each(MoodPalette.standard.anchors.map((a) => a.name))('eachAnchorResolvesToItsOwnColour %s', (name) => {
    const a = anchor(name);
    const got = palette.displayLab(a.pad);
    const want = palette.normalisedLab(a.lab);
    expect(dist(got, want), `${name}: ΔE_ok`).toBeLessThan(0.02);
  });

  test('moodsReadAsTheirHues', () => {
    const angry = color(anchor('angry').pad);
    expect(angry.x > angry.y && angry.x > angry.z, 'angry').toBe(true);
    const sad = color(anchor('sad').pad);
    expect(sad.z > sad.x && sad.z > sad.y, 'sad').toBe(true);
    const happy = color(anchor('happy').pad);
    expect(happy.y > happy.x && happy.y >= happy.z && happy.z > happy.x, 'happy').toBe(true);
    const excited = color(anchor('excited').pad);
    expect(excited.x > excited.z && excited.y > excited.z, 'excited').toBe(true);
    const embarrassed = color(anchor('embarrassed').pad);
    expect(embarrassed.x > embarrassed.y, 'embarrassed').toBe(true);
  });

  test('lightnessStaysNearTheBaseAcrossPADSpace', () => {
    const baseL = Oklab.fromLinear(base).x;
    let worst = 0;
    // Swift stride(from: -1, through: 1, by: 0.2): -1 + i * 0.2.
    const steps: number[] = [];
    for (let i = 0; i <= 10; i++) steps.push(-1 + i * 0.2);
    for (const p of steps) for (const a of steps) for (const d of steps) {
      const lab = Oklab.fromLinear(color(v3(p, a, d)));
      expect(Number.isFinite(lab.x)).toBe(true);
      worst = Math.max(worst, Math.abs(lab.x - baseL));
    }
    expect(worst, 'worst ΔL').toBeLessThanOrEqual(0.04);
  });

  /// At the default (half) lightness match, moods stay distinct: the four saturated anchors are farther apart
  /// in Oklab than at full match, while lightness still stays within a moderate band of the base.
  test('defaultLightnessMatchKeepsMoodsDistinct', () => {
    const m = new MoodColor().lightnessMatch;
    const baseL = Oklab.fromLinear(base).x;
    const anchors = [v3(-0.6, -0.4, -0.4), v3(-0.6, 0.7, 0.6), v3(-0.6, 0.7, -0.6), v3(-0.3, 0.3, -0.5)];
    const spread = (match: number): number => {
      const labs = anchors.map((a) => palette.displayLab(a, match));
      let minD = Infinity;
      for (let i = 0; i < labs.length; i++) for (let j = i + 1; j < labs.length; j++) minD = Math.min(minD, dist(labs[i], labs[j]));
      return minD;
    };
    expect(spread(m)).toBeGreaterThan(spread(1));
    for (const a of anchors) {
      const l = palette.displayLab(a, m).x;
      expect(Math.abs(l - baseL), 'ΔL').toBeLessThanOrEqual(0.2);
    }
  });

  test('outputsStayInGamutAndFinite', () => {
    for (const p of [v3(9, -9, 9), v3(-1, -1, -1), v3(1, 1, 1), v3(NaN, 0, 0)]) {
      const c = color(p);
      const lo = Math.min(c.x, c.y, c.z), hi = Math.max(c.x, c.y, c.z);
      expect(lo >= 0 && hi <= 1 && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z)).toBe(true);
    }
  });

  // MARK: Smoothing

  test('stepChangeConvergesSmoothlyWithoutOvershoot', () => {
    const m = new MoodColor();
    const h = new LidsHarness([m], 60);
    h.run(0.5);
    h.s.mood = { pleasure: -0.6, arousal: 0.7, dominance: 0.6 }; // angry
    h.step();
    const target = { ...m.targetLab };
    const start = dist(Oklab.fromLinear(base), target);
    expect(start).toBeGreaterThan(0.08);
    let prev = Infinity;
    let at15 = 0;
    let t = 0;
    h.run(3, (h) => {
      t += 1 / 60;
      const d = dist(m.currentLab, target);
      expect(Number.isFinite(d)).toBe(true);
      expect(d, 'distance grew').toBeLessThanOrEqual(prev + 1e-6);
      prev = d;
      if (Math.abs(t - 1.5) < 1e-6) at15 = d;
      const c = h.s.eyeColor;
      expect(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z)).toBe(true);
    });
    // ≈ 1.35 s to 95 %: well on its way at 1 s, settled by 2 s.
    expect(at15, `at 1.5 s: ${at15 / start}`).toBeLessThan(0.1 * start);
    expect(prev).toBeLessThan(0.01 * start);
    const r = h.s.eyeColor;
    expect(r.x > r.y && r.x > r.z).toBe(true);
  });

  test('notTooFast', () => {
    const m = new MoodColor();
    const h = new LidsHarness([m], 60);
    h.run(0.5);
    h.s.mood = { pleasure: -0.6, arousal: -0.4, dominance: -0.4 }; // sad
    h.step();
    const target = { ...m.targetLab };
    const start = dist(Oklab.fromLinear(base), target);
    h.run(0.5);
    expect(dist(m.currentLab, target)).toBeGreaterThan(0.3 * start); // no snap
    h.run(0.5);
    expect(dist(m.currentLab, target)).toBeGreaterThan(0.05 * start);
  });

  test('sixtyAndOneTwentyFpsMatch', () => {
    const ma = new MoodColor(), mb = new MoodColor();
    const a = new LidsHarness([ma], 60), b = new LidsHarness([mb], 120);
    const moods: Mood[] = [{ pleasure: 0.8, arousal: 0.9, dominance: 0.4 }, { pleasure: -0.6, arousal: -0.4, dominance: -0.4 },
      { pleasure: -0.3, arousal: 0.3, dominance: -0.5 }, Mood.playful];
    for (let i = 0; i < 60 * 8; i++) {
      if (i % 120 === 30) {
        const m = moods[Math.trunc(i / 120) % moods.length];
        a.s.mood = { ...m }; b.s.mood = { ...m };
      }
      a.step(); b.step(); b.step();
      expect(dist(a.s.eyeColor, b.s.eyeColor), `frame ${i}`).toBeLessThan(2e-3);
    }
  });

  // MARK: Expression influence

  test('angerExpressionPullsTowardRedOrange', () => {
    const m = new MoodColor();
    const h = new LidsHarness([m]);
    h.s.mood = { pleasure: 0, arousal: 0, dominance: 0 };
    h.run(0.2);
    const before = { ...h.s.eyeColor };
    h.s.expressionOverride = ExpressionMix.single('Anger');
    h.run(4);
    const after = h.s.eyeColor;
    const angry = palette.displayLinear(anchor('angry').pad);
    expect(dist(after, angry)).toBeLessThan(dist(before, angry) - 0.1);
    expect(after.x).toBeGreaterThan(before.x + 0.2);

    // Influence 0: the expression has no effect.
    const m0 = new MoodColor();
    m0.expressionInfluence = 0;
    const h0 = new LidsHarness([m0]);
    h0.s.mood = { pleasure: 0, arousal: 0, dominance: 0 };
    h0.run(0.2);
    const b0 = { ...h0.s.eyeColor };
    h0.s.expressionOverride = ExpressionMix.single('Anger');
    h0.run(4);
    expect(dist(h0.s.eyeColor, b0)).toBeLessThan(1e-5);
  });

  test('targetMixUsedWithoutOverrideAndPADDeltaScalesWithIntensity', () => {
    const d1 = MoodColor.padDelta(ExpressionMix.single('Anger'), library);
    const dHalf = MoodColor.padDelta(ExpressionMix.single('Anger', 0.5), library);
    expect(dist(d1, v3(-0.6, 0.6, 0.5))).toBeLessThan(1e-5);
    expect(dist(dHalf, v3(d1.x * 0.5, d1.y * 0.5, d1.z * 0.5))).toBeLessThan(1e-5);
    expect(isZero(MoodColor.padDelta(ExpressionMix.neutral, library))).toBe(true);
    expect(isZero(MoodColor.padDelta(ExpressionMix.single('NoSuchExpression'), library))).toBe(true);

    const m = new MoodColor();
    const h = new LidsHarness([m]);
    h.s.targetMix = ExpressionMix.single('Happiness');
    h.step();
    const p = m.effectivePAD(h.s);
    const pl = pad(Mood.playful);
    expect(dist(p, v3(pl.x + 0.8 * 0.5, pl.y + 0.4 * 0.5, pl.z + 0.3 * 0.5))).toBeLessThan(1e-5);
  });
});
