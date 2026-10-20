// Port of Tests/FaceModelTests/FaceModelTests.swift.
import { describe, expect, test } from 'vitest';
import {
  ExpressionLibrary, ExpressionMix, FacePose, ParamLayout, cloneExpression, expressionEquals, mixEntry,
} from '../../src/model';

describe('ParamLayout', () => {
  test('layout has 51 unique names', () => {
    expect(ParamLayout.names.length).toBe(51);
    expect(new Set(ParamLayout.names).size).toBe(51);
    expect(ParamLayout.index('right', 'lowerLidBend')).toBe(42);
    expect(ParamLayout.index('left', 'centerX')).toBe(5);
  });

  test('defaults match PyCozmo', () => {
    const d = FacePose.defaults;
    expect(d.face('scaleX')).toBe(1);
    expect(d.eye('left', 'upperOuterRadiusY')).toBe(0.5);
    expect(d.eye('right', 'upperLidY')).toBe(0);
    expect(d.raw.length).toBe(51); // Swift: padding lanes 51..<64 are zero
    expect(d.eye('left', 'size')).toBe(0.5);
    expect(ParamLayout.index('right', 'squash')).toBe(50);
  });

  test('toArray / fromArray round trip in ParamLayout order', () => {
    const d = FacePose.defaults;
    const a = d.toArray();
    expect(a.length).toBe(51);
    expect(a[ParamLayout.index('left', 'size')]).toBe(0.5);
    expect(FacePose.fromArray(a).equals(d)).toBe(true);
  });
});

describe('ExpressionLibrary', () => {
  const lib = ExpressionLibrary.bundled();

  test('loads all 29', () => {
    expect(lib.attribution).not.toBe('fallback');
    expect(lib.expressions.size).toBe(29); // PyCozmo's 25 plus Curious, Concerned, MockAnnoyed, Contentment
    for (const n of ['Neutral', 'Happiness', 'Sadness', 'Surprise', 'Anger', 'Confusion', 'Skepticism',
      'Suspicion', 'Boredom', 'Tiredness', 'Excitement', 'Fear', 'Embarrassment', 'Asleep']) {
      expect(lib.get(n), `missing ${n}`).toBeDefined();
    }
  });

  test('values match source', () => {
    const anger = lib.get('Anger')!.pose;
    expect(anger.eye('left', 'upperLidAngle')).toBe(-30);
    expect(anger.eye('right', 'upperLidAngle')).toBe(30);
    expect(anger.eye('left', 'upperLidY')).toBe(0.6);
    expect(lib.get('Asleep')!.pose.eye('left', 'centerY')).toBe(50);
    expect(lib.get('Neutral')!.pose.eye('right', 'scaleX')).toBe(1.0);
    const happy = lib.get('Happiness')!.pose;
    expect(happy.eye('left', 'lowerLidBend')).toBe(0.4);
    expect(happy.eye('left', 'upperInnerRadiusX')).toBe(1.0);
  });

  test('every expression has PAD', () => {
    for (const e of lib.expressions.values()) expect(e.pad, `${e.name} has no pad`).toBeDefined();
  });

  test('JSON round trip is lossless', () => {
    const again = ExpressionLibrary.fromJSON(lib.jsonText());
    expect(again.expressions.size).toBe(lib.expressions.size);
    for (const [name, e] of lib.expressions) {
      expect(expressionEquals(again.get(name)!, e), `${name} changed in round trip`).toBe(true);
    }
  });

  test('missing keys take defaults', () => {
    const l = ExpressionLibrary.fromJSON('{"version":1,"expressions":{"X":{"left":{"upper_lid":{"y":0.3}}}}}');
    const x = l.get('X')!.pose;
    expect(x.eye('left', 'upperLidY')).toBe(0.3);
    expect(x.eye('left', 'scaleX')).toBe(1);
    expect(x.eye('right', 'lowerOuterRadiusX')).toBe(0.5);
    expect(x.face('scaleY')).toBe(1);
  });

  test('malformed JSON throws', () => {
    expect(() => ExpressionLibrary.fromJSON('{"expressions":{}}')).toThrow(); // version is required
    expect(() => ExpressionLibrary.fromJSON('{"version":1,"expressions":{"X":{"face":{"scale_x":"1"}}}}')).toThrow();
    expect(() => ExpressionLibrary.fromJSON('{"version":1,"expressions":{"X":{"pad":{"p":1}}}}')).toThrow();
  });

  test('fallback has Neutral', () => {
    expect(ExpressionLibrary.fallback.get('Neutral')).toBeDefined();
  });
});

describe('ExpressionMix', () => {
  const lib = ExpressionLibrary.bundled();

  test('intensity zero is Neutral', () => {
    expect(ExpressionMix.single('Anger', 0).pose(lib).equals(lib.neutral)).toBe(true);
  });

  test('single at full intensity is exact', () => {
    const p = ExpressionMix.single('Anger').pose(lib);
    const anger = lib.get('Anger')!.pose;
    for (let i = 0; i < ParamLayout.count; i++) expect(Math.abs(p.get(i) - anger.get(i))).toBeLessThan(1e-5);
  });

  test('weights renormalise', () => {
    const a = new ExpressionMix([mixEntry('Happiness', 7), mixEntry('Tiredness', 3)]).pose(lib);
    const b = new ExpressionMix([mixEntry('Happiness', 0.7), mixEntry('Tiredness', 0.3)]).pose(lib);
    for (let i = 0; i < ParamLayout.count; i++) expect(Math.abs(a.get(i) - b.get(i))).toBeLessThan(1e-5);
    const h = lib.get('Happiness')!.pose, t = lib.get('Tiredness')!.pose;
    const expected = h.mul(0.7).add(t.mul(0.3));
    for (let i = 0; i < ParamLayout.count; i++) {
      if (!ParamLayout.scaleIndices.includes(i)) expect(Math.abs(a.get(i) - expected.get(i))).toBeLessThan(1e-4);
    }
  });

  test('scale blends in log space and stays positive', () => {
    const surprise = lib.get('Surprise')!.pose;
    const half = ExpressionMix.single('Surprise', 0.5).pose(lib);
    const i = ParamLayout.index('left', 'scaleX');
    expect(Math.abs(half.get(i) - Math.sqrt(surprise.get(i)))).toBeLessThan(1e-4); // neutral scale is 1
    const big = ExpressionMix.single('Surprise', 3).pose(lib);
    expect(big.get(i)).toBeGreaterThan(surprise.get(i));
    const sad = ExpressionMix.single('Sadness', 1.3).pose(lib);
    expect(Math.abs(sad.get(i) - 1)).toBeLessThan(1e-5); // no inflation from Neutral
  });

  test('unknown names are skipped', () => {
    const p = new ExpressionMix([mixEntry('Nope', 5), mixEntry('Anger', 1)]).pose(lib);
    const anger = lib.get('Anger')!.pose;
    for (let i = 0; i < ParamLayout.count; i++) expect(Math.abs(p.get(i) - anger.get(i))).toBeLessThan(1e-5);
  });

  test('empty mix is Neutral', () => {
    expect(new ExpressionMix([]).pose(lib).equals(lib.neutral)).toBe(true);
  });
});

describe('Expression JSON format', () => {
  test('saved JSON is rounded and ordered', () => {
    const lib = ExpressionLibrary.bundled();
    const e = cloneExpression(lib.get('Anger')!);
    e.pose.setEye('left', 'upperLidY', 0.6000000238);
    lib.set(e);
    const text = lib.jsonText();
    expect(text.includes('0.6000000')).toBe(false);
    const cx = text.indexOf('"center_x"'), lid = text.indexOf('"upper_lid"');
    expect(cx).toBeGreaterThanOrEqual(0);
    expect(lid).toBeGreaterThanOrEqual(0);
    expect(cx).toBeLessThan(lid);
    expect(ExpressionLibrary.fromJSON(text).expressions.size).toBe(29);
  });

  test('strings are quoted like Swift JSONEncoder (slashes escaped)', () => {
    const text = ExpressionLibrary.bundled().jsonText();
    expect(text).toContain('pycozmo\\/expressions\\/expressions.py');
  });
});

describe('Pupil model', () => {
  test('old JSON without pupils loads defaults', () => {
    const l = ExpressionLibrary.fromJSON('{"version":1,"expressions":{"X":{"left":{"upper_lid":{"y":0.3}}}}}');
    const x = l.get('X')!.pose;
    expect(x.eye('left', 'size')).toBe(0.5);
    expect(x.eye('right', 'x')).toBe(0);
  });

  test('pupils round trip', () => {
    const lib = ExpressionLibrary.bundled();
    const e = cloneExpression(lib.get('Happiness')!);
    e.pose.setEye('left', 'x', 0.25); e.pose.setEye('right', 'y', -0.4);
    e.pose.setEye('left', 'size', 0.62); e.pose.setEye('right', 'squash', 0.1);
    lib.set(e);
    const p = ExpressionLibrary.fromJSON(lib.jsonText()).get('Happiness')!.pose;
    expect(p.eye('left', 'x')).toBe(0.25);
    expect(p.eye('right', 'y')).toBe(-0.4);
    expect(p.eye('left', 'size')).toBe(0.62);
    expect(p.eye('right', 'squash')).toBe(0.1);
  });

  test('pupil size blends in log space', () => {
    const lib = ExpressionLibrary.bundled();
    const e = cloneExpression(lib.get('Surprise')!);
    e.pose.setEye('left', 'size', 0.25);
    lib.set(e);
    const half = ExpressionMix.single('Surprise', 0.5).pose(lib);
    const n = lib.neutral.eye('left', 'size');
    expect(Math.abs(half.eye('left', 'size') - n * Math.sqrt(0.25 / n))).toBeLessThan(1e-4);
  });
});
