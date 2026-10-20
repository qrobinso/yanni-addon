// Port of FaceRenderingTests/MoodBackgroundRenderTests.swift (CPU tests only; the GPU comparisons need Metal):
// luminance cap and APL budget, hue kept when dimming, readability on every anchor, the vignette, sleep with no
// bleed, and ink brows following the background.
import { describe, expect, test } from 'vitest';
import type { V3 } from '../../src/core/vec';
import { makeFaceFrame, type FaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { Oklab } from '../../src/model/Oklab';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { EyeSDF } from '../../src/render/EyeSDF';
import { makeRenderStyle, type RenderStyle } from '../../src/render/RenderStyle';
import { Viewport } from '../../src/render/Viewport';
import { MoodBackground, MoodBackgroundConfig } from '../../src/engine/MoodBackground';
import { MoodPalette } from '../../src/engine/MoodPalette';

const aspect = 4.0 / 3.0;

function colourStyle(): RenderStyle {
  const s = makeRenderStyle();
  s.backgroundVignette = 0.25;
  s.backgroundVignetteInner = 0.45;
  return s;
}

function frame(colour: V3, o: { strength?: number; presence?: number; brightness?: number } = {}): FaceFrame {
  const brightness = o.brightness ?? 0.85;
  return makeFaceFrame(FacePose.defaults, { brightness, backgroundColor: colour, backgroundStrength: o.strength ?? 0.8,
    backgroundPresence: o.presence ?? 1, backgroundBrightness: brightness });
}

const anchorColours: [string, V3][] = MoodPalette.background.anchors.map((a) =>
  [a.name, Oklab.toLinearClamped(new MoodBackground().colourLab(a.pad, new MoodBackgroundConfig()), { x: 0, y: 0, z: 0 })]);

const hue = (lab: V3): number => Math.atan2(lab.z, lab.y) * 180 / Math.PI;
const zero = { x: 0, y: 0, z: 0 };

describe('MoodBackgroundRender', () => {
  test('blackModeAndDefaultFramesKeepTheThemeBackground', () => {
    expect(EyeGeometry.background(makeFaceFrame(FacePose.defaults), makeRenderStyle(), aspect)).toEqual(zero);
    const theme = makeRenderStyle();
    theme.backgroundColor = { x: 0.1, y: 0.05, z: 0.02 };
    expect(EyeGeometry.background(makeFaceFrame(FacePose.defaults), theme, aspect)).toEqual(theme.backgroundColor);
  });

  test('luminanceNeverExceedsTheCap', () => {
    const s = colourStyle();
    for (const [name, c] of anchorColours) {
      for (const b of [0.12, 0.6, 0.85, 1]) {
        for (const k of [0.5, 0.8, 1]) {
          const bg = EyeGeometry.background(frame(c, { strength: k, brightness: b }), s, aspect);
          expect(EyeGeometry.luminance(bg), `${name} b ${b} k ${k}`).toBeLessThanOrEqual(s.backgroundMaxLuminance + 1e-3);
        }
      }
    }
  });

  test('aplBudgetHoldsTheMeanPictureLevel', () => {
    const s = colourStyle();
    s.backgroundAPLBudget = 0.15;
    for (const [name, c] of anchorColours) {
      const bg = EyeGeometry.background(frame(c, { strength: 1, brightness: 1 }), s, aspect);
      const apl = EyeGeometry.luminance(bg) * EyeGeometry.vignetteMean(s.backgroundVignette, s.backgroundVignetteInner, aspect);
      expect(apl, `${name} APL`).toBeLessThanOrEqual(0.15 + 1e-3);
      // Hue kept at the lower strength.
      const lab = Oklab.fromLinear(c);
      expect(Math.abs(hue(Oklab.fromLinear(bg)) - hue(lab)) < 2 || Math.abs(lab.y) < 0.02, name).toBe(true);
    }
    // Uncapped (LCD, Mac) by default.
    expect(makeRenderStyle().backgroundAPLBudget).toBe(0);
  });

  test('vignetteMeanMatchesABruteForceAverage', () => {
    const v = 0.25, inner = 0.45;
    let sum = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = (i + 0.5) / n * 2 - 1, y = (j + 0.5) / n * 2 - 1;
        const r = Math.sqrt((x * aspect) * (x * aspect) + y * y) / Math.sqrt(aspect * aspect + 1);
        sum += 1 - v * EyeGeometry.smoothstep(inner, EyeGeometry.vignetteOuter, r);
      }
    }
    expect(Math.abs(EyeGeometry.vignetteMean(v, inner, aspect) - sum / (n * n))).toBeLessThan(0.005);
  });

  test.each([0xfcbb3d, 0xf38258])('dimmingKeepsTheHue %s', (hex) => {
    const c = Oklab.linear(hex);
    const full = Oklab.fromLinear(EyeGeometry.background(frame(c, { brightness: 1 }), colourStyle(), aspect));
    const dim = Oklab.fromLinear(EyeGeometry.background(frame(c, { brightness: 0.6 }), colourStyle(), aspect));
    expect(Math.abs(hue(full) - hue(dim))).toBeLessThan(2);
    expect(Math.abs(hue(dim) - hue(Oklab.fromLinear(c)))).toBeLessThan(2);
    expect(dim.x).toBeLessThan(full.x);
  });

  test('readabilityGapOnEveryAnchorAsDisplayed', () => {
    // At full brightness and strength (the brightest case), the rendered background stays ≥ 0.12 below the
    // rendered sclera in Oklab L.
    const s = colourStyle();
    s.backgroundMaxLuminance = 1; // even uncapped
    const vp = Viewport.fitting(400, 300, s);
    for (const [name, c] of anchorColours) {
      const u = EyeGeometry.uniforms(frame(c, { strength: 1, brightness: 1 }), vp, s);
      const sclera = Oklab.fromLinear({ x: u.sclera.x, y: u.sclera.y, z: u.sclera.z }).x;
      const bg = Oklab.fromLinear({ x: u.background.x, y: u.background.y, z: u.background.z }).x;
      expect(sclera - bg, `${name}: ΔL`).toBeGreaterThanOrEqual(0.12 - 2e-3);
    }
  });

  test('asleepFramesShowNoColour', () => {
    for (const [, c] of anchorColours) {
      expect(EyeGeometry.background(frame(c, { presence: 0 }), colourStyle(), aspect)).toEqual(zero);
    }
  });

  test('browsTurnInkOnColourAndIvoryOnBlack', () => {
    const s = colourStyle();
    s.browsEnabled = true;
    const vp = Viewport.fitting(400, 300, s);
    const lavender = Oklab.linear(0xb78bbe);
    const z = (f: FaceFrame, side: 'browLeft' | 'browRight' = 'browLeft') => EyeGeometry.uniforms(f, vp, s)[side].bands.z;
    expect(z(frame(lavender))).toBe(1);
    expect(z(frame(lavender, { presence: 0 }))).toBe(0);
    // Dimmed (idle, brightness 0.6): still ink, never a grey-on-grey middle.
    expect(z(frame(Oklab.linear(0x9a928c), { brightness: 0.6 }), 'browRight')).toBeGreaterThan(0.99);
    s.browInkAuto = false;
    expect(z(frame(lavender))).toBe(0);
    s.browInk = true;
    expect(z(frame(lavender, { presence: 0 }))).toBe(1);
    // The crossfade is continuous through a fade.
    s.browInk = false;
    s.browInkAuto = true;
    let last = 1;
    for (let i = 0; i <= 100; i++) {
      const v = z(frame(lavender, { presence: 1 - i / 100 }));
      expect(last - v).toBeLessThan(0.2);
      last = v;
    }
  });

  test('vignetteDarkensEdgesOnlyAsMuchAsSet', () => {
    const vp = Viewport.fitting(400, 300, colourStyle());
    const u = EyeGeometry.uniforms(frame(Oklab.linear(0x7ccbec)), vp, colourStyle());
    const centre = EyeSDF.background(u, { x: 200, y: 150 });
    const corner = EyeSDF.background(u, { x: 0.5, y: 0.5 });
    const edge = EyeSDF.background(u, { x: 200, y: 0.5 });
    expect(centre, 'flat in the middle').toEqual({ x: u.background.x, y: u.background.y, z: u.background.z });
    expect(Math.abs(corner.x / centre.x - 0.75)).toBeLessThan(0.02);
    expect(edge.x / centre.x).toBeGreaterThan(0.8);
    expect(edge.x / centre.x).toBeLessThan(1);
    // The classic black-theme falloff (vignette 1 from 0.1) reaches black in the corners.
    const classic = makeRenderStyle();
    classic.backgroundColor = { x: 0.3, y: 0.3, z: 0.3 };
    const uc = EyeGeometry.uniforms(makeFaceFrame(FacePose.defaults), vp, classic);
    expect(EyeSDF.background(uc, { x: 0.5, y: 0.5 }).x).toBeLessThan(0.01);
  });
});
