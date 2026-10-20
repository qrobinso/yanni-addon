// Port of FaceRenderingTests/RenderStyleCodableTests.swift: tolerant Codable for RenderStyle (the settings hub's
// pinned tuning style). Swift `JSONEncoder().encode` → `RenderStyle.encode`, `JSONDecoder().decode` →
// `RenderStyle.decode(JSON.parse(...))`.
import { describe, expect, test } from 'vitest';
import { makeRenderStyle, RenderStyle } from '../../src/render/RenderStyle';

type Key = keyof RenderStyle;
const enc = (s: RenderStyle) => RenderStyle.encode(s);
// The persisted field families, read back off the encoder (Swift `colorFields` / `floatFields` / `boolFields`).
const families = (() => {
  const o = enc(makeRenderStyle());
  const keys = Object.keys(o) as Key[];
  return {
    color: keys.filter((k) => Array.isArray(o[k])),
    float: keys.filter((k) => typeof o[k] === 'number'),
    bool: keys.filter((k) => typeof o[k] === 'boolean'),
  };
})();

/// A style with every persisted field moved off its default (each by a distinct amount).
function everythingChanged(): RenderStyle {
  const s = makeRenderStyle() as unknown as Record<string, unknown>;
  families.color.forEach((k, i) => { const f = (i + 1) / 16; s[k] = { x: f, y: 1 - f, z: f / 2 }; });
  families.float.forEach((k, i) => { s[k] = (s[k] as number) + 0.125 * (i + 1); });
  for (const k of families.bool) s[k] = !s[k];
  return s as unknown as RenderStyle;
}

const decode = (json: string) => RenderStyle.decode(JSON.parse(json));
const roundTrip = (s: RenderStyle) => RenderStyle.decode(JSON.parse(JSON.stringify(enc(s))));

describe('RenderStyleCodable', () => {
  test('roundTripKeepsEveryColourFloatAndSwitchField', () => {
    const s = everythingChanged();
    const d = makeRenderStyle();
    expect(families.color.length).toBeGreaterThan(0);
    for (const k of [...families.color, ...families.float, ...families.bool]) expect(s[k], k).not.toEqual(d[k]);
    expect(roundTrip(s)).toEqual(s);
  });

  test('roundTripOfNamedFieldsFromEachFamily', () => {
    const s = makeRenderStyle();
    s.crescentColor = { x: 0.9, y: 0.1, z: 0.4 };
    s.rimColor = RenderStyle.ivoryRim.rimColor;
    s.eggTaper = 0.12;
    s.inkWidth = 1.3;
    s.pairTilt = 4;
    s.notchEnabled = false;
    s.shapeMoodAccent = false;
    const back = roundTrip(s);
    expect(back).toEqual(s);
    expect(back.crescentColor).toEqual({ x: 0.9, y: 0.1, z: 0.4 });
    expect(back.eggTaper).toBe(0.12);
    expect(back.notchEnabled).toBe(false);
  });

  test('everyStoredFieldIsPersistedExceptTheMoodAnchorAndDeprecatedOnes', () => {
    const persisted = new Set([...families.color, ...families.float, ...families.bool]);
    // port-note: the deprecated alias fields (highlight*, glow*) do not exist on the TS RenderStyle.
    const notPersisted = new Set(['color', 'highlightAnchor', 'highlightParallax', 'glowRadius', 'glowStrength']);
    const stored = Object.keys(makeRenderStyle()).filter((k) => !notPersisted.has(k));
    expect(new Set(stored)).toEqual(persisted);
  });

  test('missingKeysKeepTheirDefaults', () => {
    expect(decode('{}')).toEqual(makeRenderStyle());
    const partial = decode('{"eggTaper": 0.5, "notchEnabled": false, "rimColor": [1, 1, 1]}');
    const expected = makeRenderStyle();
    expected.eggTaper = 0.5;
    expected.notchEnabled = false;
    expected.rimColor = { x: 1, y: 1, z: 1 };
    expect(partial).toEqual(expected);
  });

  test('unknownKeysAndWrongTypesAreIgnored', () => {
    const s = decode('{"futureKnob": 3, "eggTaper": "wide", "notchEnabled": 7, "scleraColor": "ivory", "inkWidth": 0.9}');
    const expected = makeRenderStyle();
    expected.inkWidth = 0.9;
    expect(s).toEqual(expected);
  });

  test('wrongLengthColoursAreIgnored', () => {
    const s = decode('{"scleraColor": [1, 0], "rimColor": [1, 0, 0, 0], "inkColor": [], "crescentColor": [0.5, 0.5, 0.5]}');
    const expected = makeRenderStyle();
    expected.crescentColor = { x: 0.5, y: 0.5, z: 0.5 };
    expect(s).toEqual(expected);
  });

  test('nonFiniteColoursAndNumbersAreIgnored', () => {
    // Swift's decoder maps "nan" / "inf" / "-inf" strings to floats; the TS decoder takes the parsed values.
    const s = RenderStyle.decode({ scleraColor: [NaN, 0, 0], rimColor: [0, Infinity, 0], eggTaper: NaN,
      rimWidth: -Infinity, crescentColor: [0.25, 0.5, 0.75] });
    const expected = makeRenderStyle();
    expected.crescentColor = { x: 0.25, y: 0.5, z: 0.75 };
    expect(s).toEqual(expected);
    const d = makeRenderStyle();
    expect(s.scleraColor).toEqual(d.scleraColor);
    expect(s.rimColor).toEqual(d.rimColor);
    expect(s.eggTaper).toBe(d.eggTaper);
    expect(s.rimWidth).toBe(d.rimWidth);
  });

  test('moodAnchorColourIsNeverEncoded', () => {
    const s = makeRenderStyle();
    s.color = { x: 0.3, y: 0.2, z: 0.9 };
    const o = JSON.parse(JSON.stringify(enc(s))) as Record<string, unknown>;
    expect(o.color).toBeUndefined();
    for (const k of ['highlightAnchor', 'highlightParallax', 'glowRadius', 'glowStrength', 'outlineColor',
      'outlineWidth', 'highlightColor', 'highlightEnabled', 'highlightSize']) {
      expect(o[k], k).toBeUndefined();
    }
    // A stored `color` key is not read back either.
    expect(decode('{"color": [0.3, 0.2, 0.9]}').color).toEqual(makeRenderStyle().color);
  });

  test('coloursAreStoredAsLinearRGBArrays', () => {
    const s = makeRenderStyle();
    s.crescentColor = { x: 0.25, y: 0.5, z: 0.75 };
    const o = JSON.parse(JSON.stringify(enc(s))) as Record<string, unknown>;
    expect(o.crescentColor).toEqual([0.25, 0.5, 0.75]);
  });
});
