// Port of FaceRenderingTests/LidShapeTests.swift (CPU tests; the snapshot and GPU-vs-CPU suites need Metal).
// Small lids follow the sclera's own outline (offset-shape lid), so idle lid-follow and heaviness keep the eyes soft
// ovals; deliberate lids (angled, bent, deep) stay the PyCozmo straight lid.
import { describe, expect, test } from 'vitest';
import { v2 } from '../../src/core/vec';
import { ExpressionLibrary } from '../../src/model/Expression';
import { makeFaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { ParamLayout } from '../../src/model/ParamLayout';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { EyeSDF } from '../../src/render/EyeSDF';
import { makeRenderStyle } from '../../src/render/RenderStyle';
import type { EyeUniforms } from '../../src/render/RenderUniforms';
import { Viewport } from '../../src/render/Viewport';
import { withPupils } from './helpers';

const viewport = new Viewport(v2(128, 64), 1, v2(0));

function pose(o: { upper?: number; lower?: number; angle?: number; bend?: number } = {}): FacePose {
  const p = FacePose.defaults;
  for (const side of ParamLayout.Side.allCases) {
    p.setEye(side, 'upperLidY', o.upper ?? 0);
    p.setEye(side, 'lowerLidY', o.lower ?? 0);
    p.setEye(side, 'upperLidAngle', side === 'left' ? -(o.angle ?? 0) : (o.angle ?? 0));
    p.setEye(side, 'upperLidBend', o.bend ?? 0);
  }
  return p;
}

const eyeL = (p: FacePose) => EyeGeometry.eye('left', p, viewport, makeRenderStyle());

/// Visible boundary y (eye-local, y down) at column x: the topmost (or bottommost) point inside.
function edge(e: EyeUniforms, x: number, top: boolean): number | undefined {
  const inside = (y: number) => EyeSDF.visibleDistance(e, EyeSDF.visible(e, v2(x, y))) < 0;
  if (!inside(0)) return undefined;
  let inn = 0, out = top ? -e.halfExtents.y - 1 : e.halfExtents.y + 1;
  for (let i = 0; i < 30; i++) {
    const mid = 0.5 * (inn + out);
    if (inside(mid)) inn = mid; else out = mid;
  }
  return 0.5 * (inn + out);
}

/// Width of the run of columns whose visible edge is within `band` of the extreme point, as a fraction of the eye
/// width. A flat chord gives a long run; an oval a short one.
function flatRun(e: EyeUniforms, top: boolean, band = 0.3): number {
  const hx = e.halfExtents.x;
  const n = 600;
  const ys: number[] = [];
  for (let i = 0; i <= n; i++) {
    const y = edge(e, -hx + 2 * hx * i / n, top);
    if (y !== undefined) ys.push(top ? y : -y);
  }
  const apex = ys.length ? Math.min(...ys) : 0;
  return ys.filter((y) => y <= apex + band).length / n;
}

describe('LidShape', () => {
  test('smallUpperLidKeepsTheOvalTop', () => {
    const e = eyeL(pose({ upper: 0.05 }));
    expect(e.lidBlend.x).toBe(0);
    const run = flatRun(e, true);
    expect(run).toBeLessThan(0.25);
    // The lid did come down: the apex sits below the sclera's top.
    expect(edge(e, 0, true) ?? 0).toBeGreaterThan(-e.halfExtents.y + 0.5);
    // The same eye with the straight lid alone would show a flat chord.
    const straight = eyeL(pose({ upper: 0.05 }));
    straight.lidBlend.x = 1;
    expect(flatRun(straight, true)).toBeGreaterThan(run + 0.1);
  });

  test('smallLowerLidKeepsTheOvalBottom', () => {
    const e = eyeL(pose({ lower: 0.05 }));
    expect(e.lidBlend.y).toBe(0);
    expect(flatRun(e, false)).toBeLessThan(0.25);
  });

  /// The visible top follows the sclera's curvature: at a small lid it is the sclera's top moved down.
  test('smallLidEdgeIsTheOffsetOutline', () => {
    const open = eyeL(pose());
    const lid = eyeL(pose({ upper: 0.05 }));
    const shift = lid.upperLid.w;
    expect(shift).toBeGreaterThan(0.5);
    for (const x of [-6, -3, 0, 3, 6]) {
      const a = edge(open, x, true)!, b = edge(lid, x, true)!;
      expect(Math.abs((b - a) - shift), `x ${x}`).toBeLessThan(0.1);
    }
  });

  /// Deliberate lids use the straight PyCozmo lid unchanged.
  test('deliberateLidsStayStraight', () => {
    const lib = ExpressionLibrary.bundled();
    for (const name of ['Anger', 'Sadness', 'Happiness', 'Asleep']) {
      const p = lib.get(name)!.pose;
      for (const side of ParamLayout.Side.allCases) {
        const e = EyeGeometry.eye(side, p, viewport, makeRenderStyle());
        // Each lid is either (essentially) open or fully straight.
        for (const [y, w] of [[p.eye(side, 'upperLidY'), e.lidBlend.x], [p.eye(side, 'lowerLidY'), e.lidBlend.y]]) {
          if (y >= 0.25) expect(w, `${name} ${side}`).toBe(1);
        }
      }
    }
    expect(eyeL(pose({ upper: 0.05, angle: 15 })).lidBlend.x).toBe(1);
    expect(eyeL(pose({ upper: 0.05, bend: 0.2 })).lidBlend.x).toBe(1);
    expect(eyeL(pose({ upper: 0.3 })).lidBlend.x).toBe(1);
  });

  /// The blend is continuous: the visible apex moves smoothly as coverage sweeps through the blend range.
  test('blendIsContinuous', () => {
    let prev: number | undefined;
    for (let i = 0; i <= 60; i++) {
      const y = i * 0.005;
      const apex = edge(eyeL(pose({ upper: y })), 0, true)!;
      if (prev !== undefined) expect(Math.abs(apex - prev), `jump at y ${y}`).toBeLessThan(0.4);
      prev = apex;
    }
  });

  /// The outline band follows the curved lid edge: just inside the visible top the outline shows.
  test('outlineBandFollowsTheShapeLid', () => {
    // port-note: Swift sets the deprecated `highlightEnabled = false`; the TS style has no such field.
    const style = makeRenderStyle();
    const vp = new Viewport(v2(1194, 834), 8, v2(0));
    const p = withPupils(pose({ upper: 0.08 }), { y: 1 });
    const e = EyeGeometry.uniforms(makeFaceFrame(p), vp, style).left;
    const w = e.outlineWidth;
    expect(w).toBeGreaterThan(0.5);
    for (const x of [-8, -4, 4, 8]) {
      const top = edge(e, x, true)!;
      const v = EyeSDF.visibleDistance(e, EyeSDF.visible(e, v2(x, top + 0.5 * w)));
      expect(v, `x ${x}`).toBeGreaterThan(-w);
      expect(v, `x ${x}`).toBeLessThan(0);
    }
  });
});
