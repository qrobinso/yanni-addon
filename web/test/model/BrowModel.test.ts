// Port of Tests/FaceModelTests/BrowModelTests.swift.
import { describe, expect, test } from 'vitest';
import {
  BrowLayout, BrowPose, ExpressionLibrary, ExpressionMix, ParamLayout, cloneExpression, mixEntry,
} from '../../src/model';

describe('Brow model', () => {
  const lib = ExpressionLibrary.bundled();

  test('layout', () => {
    expect(BrowLayout.usedIndices.length).toBe(18);
    expect(new Set(BrowLayout.usedIndices).size).toBe(18);
    expect(BrowLayout.usedIndices.every((i) => i < 32)).toBe(true);
    expect(new Set(BrowLayout.names).size).toBe(18);
    // Padding lanes stay zero.
    const used = new Set(BrowLayout.usedIndices);
    const fives = new BrowPose(new Array(32).fill(5));
    for (let i = 0; i < 32; i++) {
      if (used.has(i)) continue;
      expect(BrowPose.defaults.raw[i]).toBe(0);
      expect(fives.clamped().raw[i]).toBe(0);
    }
    expect(BrowPose.defaults.lane('left', 'width')).toBe(1);
    expect(BrowPose.defaults.lane('right', 'peak')).toBe(0.5);
  });

  test('clamping and non-finite', () => {
    const b = BrowPose.defaults;
    b.setLane('left', 'rotation', 500);
    b.setLane('right', 'width', -3);
    const c = b.clamped();
    expect(c.lane('left', 'rotation')).toBe(BrowLayout.Lane.range('rotation').upperBound);
    expect(c.lane('right', 'width')).toBe(BrowLayout.Lane.range('width').lowerBound);
    b.setLane('left', 'y', NaN);
    expect(b.hasNonFinite).toBe(true);
    expect(BrowPose.restNeutral.hasNonFinite).toBe(false);
  });

  test('every expression has brows in range', () => {
    expect(lib.names.length).toBe(29);
    for (const name of ['MockAnnoyed', 'Curious', 'Concerned', 'Contentment']) expect(lib.get(name), `${name} missing`).toBeDefined();
    for (const name of lib.names) {
      const b = lib.get(name)!.brows;
      expect(b, `${name} has no brows`).toBeDefined();
      expect(b!.equals(b!.clamped()), `${name} brows out of range`).toBe(true);
    }
  });

  /// Annoyance keeps PyCozmo's eyes; the playful squint lives in the new MockAnnoyed entry.
  test('Annoyance unchanged, MockAnnoyed squints', () => {
    const a = lib.get('Annoyance')!.pose;
    expect(a.eye('left', 'upperLidY')).toBe(0);
    expect(a.eye('left', 'upperLidAngle')).toBe(-30);
    expect(a.eye('left', 'lowerLidY')).toBe(0.3);
    const m = lib.get('MockAnnoyed')!;
    expect(m.pose.eye('left', 'upperLidY')).toBeGreaterThan(0.2);
    expect(Math.abs(m.pose.eye('left', 'upperLidAngle'))).toBeLessThan(10);
    // Inner ends down, outer up: negative tilt, arch peaking toward the outer end.
    expect(m.brows!.lane('left', 'rotation')).toBeLessThan(-10);
    expect(m.brows!.lane('left', 'peak')).toBeGreaterThan(0.6);
    // Concerned: inner raised, outer lowered.
    expect(lib.brows('Concerned').lane('left', 'rotation')).toBeGreaterThan(20);
    // Curious: one raised and arched, the other lower and flatter.
    const c = lib.brows('Curious');
    expect(c.lane('left', 'y')).toBeGreaterThan(c.lane('right', 'y'));
    expect(c.lane('left', 'curvature')).toBeGreaterThan(c.lane('right', 'curvature') + 0.3);
  });

  test('JSON round trip', () => {
    const data = lib.jsonText();
    const back = ExpressionLibrary.fromJSON(data);
    expect(back.names).toEqual(lib.names);
    for (const name of lib.names) {
      const a = lib.get(name)!, b = back.get(name)!;
      for (const i of BrowLayout.usedIndices) expect(Math.abs(a.brows!.get(i) - b.brows!.get(i)), `${name} brow ${i}`).toBeLessThan(1e-4);
      for (let i = 0; i < ParamLayout.count; i++) expect(Math.abs(a.pose.get(i) - b.pose.get(i))).toBeLessThan(1e-4);
    }
    // The writer is a fixed point: writing what it read gives the same bytes (Save round trip).
    expect(back.jsonText()).toBe(data);
  });

  test('saved brow edit round trips', () => {
    const edited = lib.copy();
    const e = cloneExpression(edited.get('Happiness')!);
    e.brows!.setLane('right', 'curvature', 0.123);
    edited.set(e);
    expect(lib.get('Happiness')!.brows!.lane('right', 'curvature')).not.toBe(0.123); // value semantics
    const back = ExpressionLibrary.fromJSON(edited.jsonText());
    expect(Math.abs(back.brows('Happiness').lane('right', 'curvature') - 0.123)).toBeLessThan(1e-4);
  });

  test('missing brows are Neutral', () => {
    const json = `{"version": 1, "expressions": {
      "Neutral": {"brows": {"left": {"rotation": 10, "curvature": 0.3}}},
      "Plain": {"left": {"upper_lid": {"y": 0.2}}}
    }}`;
    const l = ExpressionLibrary.fromJSON(json);
    expect(l.get('Plain')!.brows).toBeUndefined();
    expect(l.brows('Plain').equals(l.neutralBrows)).toBe(true);
    // A missing side mirrors the other; missing lanes take defaults.
    expect(l.neutralBrows.lane('right', 'rotation')).toBe(10);
    expect(l.neutralBrows.lane('right', 'width')).toBe(1);
    expect(ExpressionMix.single('Plain').brows(l).equals(l.neutralBrows)).toBe(true);
    // And the writer leaves it missing.
    expect(l.jsonText().split('"brows"').length).toBe(2);
  });

  test('blending linear and log lanes', () => {
    const n = lib.neutralBrows, a = lib.brows('Surprise'), b = lib.brows('Sadness');
    const m = new ExpressionMix([mixEntry('Surprise', 0.25), mixEntry('Sadness', 0.75)], 0.8).brows(lib);
    for (const side of ParamLayout.Side.allCases) {
      for (const lane of BrowLayout.Lane.allCases) {
        const x = n.lane(side, lane), ya = a.lane(side, lane), yb = b.lane(side, lane);
        const expected = BrowLayout.Lane.isScale(lane)
          ? x * Math.exp(0.8 * (0.25 * Math.log(ya / x) + 0.75 * Math.log(yb / x)))
          : x + 0.8 * (0.25 * (ya - x) + 0.75 * (yb - x));
        expect(Math.abs(m.lane(side, lane) - expected), `${side} ${lane}`).toBeLessThan(1e-5);
      }
    }
    // Intensity 0 is Neutral's brows; scales never collapse under exaggeration.
    expect(ExpressionMix.single('Surprise', 0).brows(lib).equals(n)).toBe(true);
    expect(ExpressionMix.single('Surprise', 3).brows(lib).lane('left', 'width')).toBeGreaterThan(0);
  });
});
