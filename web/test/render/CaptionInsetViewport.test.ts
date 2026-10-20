// Port of FaceRenderingTests/CaptionInsetViewportTests.swift: with a caption showing, the face's whole motion envelope
// and its rest eyes and brows sit in the top 70 % of every iPad and Mac window, centred there; the band interpolates
// continuously; the edge geometry sees the area above the band.
import { describe, expect, test } from 'vitest';
import { v2 } from '../../src/core/vec';
import { FaceFrame } from '../../src/model/FaceFrame';
import { makeRenderStyle } from '../../src/render/RenderStyle';
import { edgeGeometryFitting, Viewport } from '../../src/render/Viewport';

const sizes: [string, number, number][] = [
  ['iPad 11 landscape', 1194, 834], ['iPad 11 portrait', 834, 1194],
  ['iPad 13 landscape', 1376, 1032], ['iPad 13 portrait', 1032, 1376],
  ['iPad mini landscape', 1133, 744], ['iPad mini portrait', 744, 1133],
  ['Mac window', 900, 560], ['Mac wide', 1600, 700], ['Mac small', 480, 300],
];

describe('CaptionInsetViewportTests', () => {
  test.each(sizes.flatMap(([n, w, h]) => [false, true].map((brows) => [n, w, h, brows] as const)))(
    'faceStaysInTheTopBand %s brows %s', (name, w, h, brows) => {
      const style = { ...makeRenderStyle(), browsEnabled: brows };
      const band = 0.3;
      const top = h * (1 - band);
      const vp = Viewport.fitting(w, h, style, band);
      const env = brows ? Viewport.browEnvelope : Viewport.envelope;
      const centre = Viewport.screenCenter(style);
      const lo = vp.pixel(v2(centre.x - env.x / 2, centre.y - env.y / 2));
      const hi = vp.pixel(v2(centre.x + env.x / 2, centre.y + env.y / 2));
      expect(lo.y >= -0.5 && hi.y <= top + 0.5, `${name}: envelope ${lo.y}…${hi.y} vs band top ${top}`).toBe(true);
      expect(lo.x >= -0.5 && hi.x <= w + 0.5).toBe(true);
      const c = vp.pixel(centre);
      expect(Math.abs(c.x - w / 2) < 0.01 && Math.abs(c.y - top / 2) < 0.01, "centred in the face's area").toBe(true);

      // The rest eyes and brows, as the edge antics see them, inside the visible area above the band.
      const g = edgeGeometryFitting(w, h, style, band);
      expect(Math.abs(g.visibleHalfExtent.y * vp.pixelsPerUnit - top / 2)).toBeLessThan(0.5);
      const boxes = [[g.leftEyeCenter, g.leftEyeHalfSize], [g.rightEyeCenter, g.rightEyeHalfSize]];
      if (brows) boxes.push([g.leftBrowCenter, g.leftBrowHalfSize], [g.rightBrowCenter, g.rightBrowHalfSize]);
      for (const [bc, half] of boxes) {
        expect(bc.y + half.y <= g.visibleHalfExtent.y && bc.y - half.y >= -g.visibleHalfExtent.y, name).toBe(true);
      }
    });

  test('noBandIsExactlyTheOldFit', () => {
    const style = { ...makeRenderStyle(), browsEnabled: true };
    for (const [, w, h] of sizes) {
      expect(Viewport.fitting(w, h, style, 0).equals(Viewport.fitting(w, h, style))).toBe(true);
    }
  });

  test('theFaceMovesContinuouslyAndOnlyUpOrSmaller', () => {
    const style = { ...makeRenderStyle(), browsEnabled: true };
    let last = Viewport.fitting(1194, 834, style);
    for (let i = 1; i <= 60; i++) {
      const vp = Viewport.fitting(1194, 834, style, i / 200);
      const a = vp.pixel(Viewport.screenCenter(style)), b = last.pixel(Viewport.screenCenter(style));
      expect(a.y <= b.y && b.y - a.y < 4, `step ${i}`).toBe(true);
      expect(vp.pixelsPerUnit).toBeLessThanOrEqual(last.pixelsPerUnit);
      last = vp;
    }
  });

  test('badBandsReadAsNoneOrTheCap', () => {
    const style = makeRenderStyle();
    expect(Viewport.fitting(1194, 834, style, NaN).equals(Viewport.fitting(1194, 834, style))).toBe(true);
    expect(Viewport.fitting(1194, 834, style, 3).equals(Viewport.fitting(1194, 834, style, FaceFrame.maxCaptionInset))).toBe(true);
  });
});
