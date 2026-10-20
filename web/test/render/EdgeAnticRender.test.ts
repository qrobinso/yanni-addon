// Port of FaceRenderingTests/EdgeAnticRenderTests.swift: the CPU geometry tests that need neither FaceEngine nor
// Metal (`referenceMatchesFitting`, `fittingMatchesRendererPlacement`).
import { describe, expect, test } from 'vitest';
import { v2 } from '../../src/core/vec';
import { EdgeGeometry } from '../../src/model/EdgeGeometry';
import { makeFaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { makeRenderStyle } from '../../src/render/RenderStyle';
import { Viewport, edgeGeometryFitting } from '../../src/render/Viewport';

/// The six iPad screens (points; only the aspect and fitted scale matter) in both orientations.
const edgeDevices: { name: string; width: number; height: number }[] = [
  { name: '11in-landscape', width: 1194, height: 834 }, { name: '11in-portrait', width: 834, height: 1194 },
  { name: '13in-landscape', width: 1376, height: 1032 }, { name: '13in-portrait', width: 1032, height: 1376 },
  { name: 'mini-landscape', width: 1133, height: 744 }, { name: 'mini-portrait', width: 744, height: 1133 },
];

describe('EdgeAnticGeometry', () => {
  test('referenceMatchesFitting', () => {
    const g = edgeGeometryFitting(1194, 834, makeRenderStyle());
    const r = EdgeGeometry.reference;
    for (const k of ['visibleHalfExtent', 'leftEyeCenter', 'rightEyeCenter', 'leftEyeHalfSize', 'rightEyeHalfSize'] as const) {
      const a = g[k], b = r[k];
      expect(Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01, `${k}: ${a.x},${a.y} vs ${b.x},${b.y}`).toBe(true);
    }
  });

  /// The geometry agrees with where the renderer actually draws the eyes.
  test('fittingMatchesRendererPlacement', () => {
    for (const d of edgeDevices) {
      const style = makeRenderStyle();
      const g = edgeGeometryFitting(d.width, d.height, style);
      const vp = Viewport.fitting(d.width, d.height, style);
      const stage = v2(30, -12);
      const u = EyeGeometry.uniforms(makeFaceFrame(FacePose.defaults, { stageOffset: stage }), vp, style);
      for (const [side, e] of [['left', u.left], ['right', u.right]] as const) {
        const c = vp.canvas(e.center);
        const canvas = v2(c.x - Viewport.canvasCenter.x, c.y - Viewport.canvasCenter.y);
        const expected = v2(g.center(side).x + stage.x, g.center(side).y + stage.y);
        expect(Math.abs(canvas.x - expected.x) < 0.01 && Math.abs(canvas.y - expected.y) < 0.01, `${d.name} ${side}`).toBe(true);
      }
      expect(Math.abs(g.visibleHalfExtent.x * vp.pixelsPerUnit - d.width / 2)).toBeLessThan(0.01);
    }
  });
});
