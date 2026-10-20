// Port of Tests/FaceEngineTests/FaceAffectTests.swift.
import { describe, expect, test } from 'vitest';
import type { V3 } from '../../src/core/vec';
import { ExpressionLibrary, ExpressionMix, mixEntry } from '../../src/model';
import { FaceAffect, FaceState, Mood } from '../../src/engine';

/// Verbatim copy of MoodColor's pre-refactor effective-PAD logic (the reference the shared function must match).
function legacyPAD(s: FaceState, influence: number): V3 {
  const mix = s.expressionOverride ?? s.targetMix;
  const library = s.library;
  const n = library.get('Neutral')?.pad ?? { p: 0, a: 0, d: 0 };
  const sum = { x: 0, y: 0, z: 0 };
  let total = 0;
  for (const e of mix.entries) {
    if (!(e.weight > 0)) continue;
    const pad = library.get(e.name)?.pad;
    if (!pad) continue;
    sum.x += (pad.p - n.p) * e.weight; sum.y += (pad.a - n.a) * e.weight; sum.z += (pad.d - n.d) * e.weight;
    total += e.weight;
  }
  let mixDelta = { x: 0, y: 0, z: 0 };
  if (total > 0 && Number.isFinite(mix.intensity)) {
    const k = mix.intensity / total;
    const d = { x: sum.x * k, y: sum.y * k, z: sum.z * k };
    mixDelta = Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.z) ? d : { x: 0, y: 0, z: 0 };
  }
  const c = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0);
  const k = Number.isFinite(influence) ? Math.max(influence, 0) : 0;
  const cl = (v: number): number => Math.min(Math.max(v, -1), 1);
  return {
    x: cl(c(s.mood.pleasure) + mixDelta.x * k),
    y: cl(c(s.mood.arousal) + mixDelta.y * k),
    z: cl(c(s.mood.dominance) + mixDelta.z * k),
  };
}

const moods: Mood[] = [
  Mood.playful, { pleasure: 0, arousal: 0, dominance: 0 }, { pleasure: -0.8, arousal: 0.7, dominance: -0.4 },
  { pleasure: 0.9, arousal: 0.9, dominance: 0.9 }, { pleasure: NaN, arousal: 2, dominance: -Infinity },
];
const overrides = (): (ExpressionMix | null)[] => [
  null, ExpressionMix.single('Anger'), ExpressionMix.single('Happiness', 0.5), ExpressionMix.single('NoSuchExpression'),
  new ExpressionMix([mixEntry('Sadness', 2), mixEntry('Surprise', 1)], 1.3), ExpressionMix.neutral,
];

describe('FaceAffect', () => {
  test('matchesLegacyMoodColorLogic', () => {
    const s = new FaceState(ExpressionLibrary.bundled(), 1);
    s.targetMix = ExpressionMix.single('Happiness');
    for (const mood of moods) {
      for (const o of overrides()) {
        for (const k of [0, 0.5, 1, NaN]) {
          s.mood = { ...mood };
          s.expressionOverride = o;
          expect(FaceAffect.effectivePAD(s, k), `${JSON.stringify(mood)} ${o?.entries[0]?.name} k=${k}`)
            .toEqual(legacyPAD(s, k));
        }
      }
    }
  });

  // needs WP7 (MoodColor)
  test.skip('moodColorUsesTheSharedFunction', () => {
    for (const mood of moods) {
      for (const o of overrides()) {
        void mood; void o;
        // TODO(WP7): const m = new MoodColor();
        // TODO(WP7): const h = new LidsHarness([m]);   // the harness lives in PowerCare.test.ts
        // TODO(WP7): h.s.library = ExpressionLibrary.bundled();
        // TODO(WP7): h.s.mood = { ...mood };
        // TODO(WP7): h.s.targetMix = ExpressionMix.single('Sadness');
        // TODO(WP7): h.s.expressionOverride = o;
        // TODO(WP7): h.step();
        // TODO(WP7): expect(m.effectivePAD(h.s)).toEqual(FaceAffect.effectivePAD(h.s, m.expressionInfluence));
      }
    }
  });

  test('defaultInfluenceIsHalf', () => {
    const s = new FaceState(ExpressionLibrary.bundled(), 1);
    s.expressionOverride = ExpressionMix.single('Anger');
    expect(FaceAffect.effectivePAD(s)).toEqual(FaceAffect.effectivePAD(s, 0.5));
    expect(FaceAffect.effectivePAD(s)).not.toEqual(FaceAffect.effectivePAD(s, 0));
  });
});
