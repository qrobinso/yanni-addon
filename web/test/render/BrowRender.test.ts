// Port of FaceRenderingTests/BrowRenderTests.swift: the CPU suite (BrowGeometryTests). Eyebrow geometry (eyebrows
// design §6). `edgeAnticsWithBrows` needs FaceEngine and the BrowRenderTests suite needs Metal: not ported.
import { describe, expect, test } from 'vitest';
import { v2, v4, type V2 } from '../../src/core/vec';
import { Composer } from '../../src/engine/Composer';
import type { FaceState } from '../../src/engine/FaceState';
import { BrowPose } from '../../src/model/BrowPose';
import { ExpressionLibrary } from '../../src/model/Expression';
import { ExpressionMix } from '../../src/model/ExpressionMix';
import { Canvas, Units, cloneFaceFrame, makeFaceFrame, type FaceFrame } from '../../src/model/FaceFrame';
import { ParamLayout } from '../../src/model/ParamLayout';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { EyeSDF } from '../../src/render/EyeSDF';
import { RenderStyle, makeRenderStyle } from '../../src/render/RenderStyle';
import { BrowUniforms, FrameUniforms, frameUniformFloats, packFrameUniforms } from '../../src/render/RenderUniforms';
import { Viewport, edgeGeometryFitting } from '../../src/render/Viewport';
import { blinkClosureScale, blinked } from './helpers';

const library = ExpressionLibrary.bundled();
const browStyle = (): RenderStyle => ({ ...makeRenderStyle(), browsEnabled: true });
const vp = Viewport.fitting(1194, 834, browStyle());
const N = BrowUniforms.pointCount, S = BrowUniforms.segmentCount;

/// Composer.composedBrows reads only browBase, browDelta and library: a stub stands in for a full FaceState.
const composed = (browBase: BrowPose): BrowPose =>
  Composer.composedBrows({ browBase, browDelta: BrowPose.zero, library } as unknown as FaceState);

function frame(name: string, intensity = 1): FaceFrame {
  const mix = ExpressionMix.single(name, intensity);
  return makeFaceFrame(mix.pose(library).clamped(), { brows: composed(mix.brows(library)) });
}

const u = (f: FaceFrame, style = browStyle(), viewport = vp): FrameUniforms => EyeGeometry.uniforms(f, viewport, style);

/// Swift `FrameUniforms ==`: every packed float equal.
function sameUniforms(a: FrameUniforms, b: FrameUniforms): boolean {
  const pa = packFrameUniforms(a, new Float32Array(frameUniformFloats));
  const pb = packFrameUniforms(b, new Float32Array(frameUniformFloats));
  return pa.every((x, i) => x === pb[i]);
}

const add = (a: V2, b: V2): V2 => v2(a.x + b.x, a.y + b.y);

describe('BrowGeometry', () => {
  /// Brows off: the frame's brow fields change nothing, and the layout is the brow-less one.
  test('browsOffIsUnchanged', () => {
    const plain = makeRenderStyle();
    const wild = makeFaceFrame(library.neutral.copy());
    wild.brows.setLane('left', 'y', 0.5);
    wild.browPresence = 0.3;
    wild.browOffset = v4(3, -3, 2, 2);
    const pvp = Viewport.fitting(1194, 834, plain);
    expect(sameUniforms(u(makeFaceFrame(library.neutral.copy()), plain, pvp), u(wild, plain, pvp))).toBe(true);
    expect(u(wild, plain, pvp).browLeft.isVisible).toBe(false);
    // The brow-less viewport is exactly the original fit.
    const exact = Math.min(1194 / 108, 834 / 72);
    expect(pvp.pixelsPerUnit).toBe(exact * Viewport.fitFraction);
    expect(edgeGeometryFitting(1194, 834, plain).hasBrows).toBe(false);
  });

  /// Brows on: a taller envelope including the brows; the face moves down and gets ≈ 15–20 % smaller in 4:3 landscape.
  test('browsOnLayout', () => {
    const off = Viewport.fitting(1194, 834, makeRenderStyle());
    const on = vp;
    const ratio = on.pixelsPerUnit / off.pixelsPerUnit;
    expect(ratio > 0.78 && ratio < 0.86, `eye size ratio ${ratio}`).toBe(true);
    expect(on.pixel(Viewport.canvasCenter).y, 'face moved down').toBeGreaterThan(off.size.y / 2);
  });

  test('endsTaperToTheConfiguredMinimum', () => {
    const s = browStyle();
    const b = u(frame('Neutral')).browLeft;
    expect(b.isVisible).toBe(true);
    let rMax = 0;
    for (let i = 0; i < N; i++) rMax = Math.max(rMax, b.points[i].z);
    const floor = Math.max(s.rimWidth + s.inkWidth, RenderStyle.browMinTipPixels / vp.pixelsPerUnit);
    expect(Math.abs(b.points[0].z - Math.max(s.browInnerTip * rMax, floor)), 'inner tip').toBeLessThan(1e-3 * rMax);
    expect(Math.abs(b.points[S].z - Math.max(s.browOuterTip * rMax, floor)), 'outer tip').toBeLessThan(1e-4 + 1e-3 * rMax);
    // Comma: blunt inner end, fine outer tip, thickest nearer the inner end.
    expect(b.points[0].z).toBeGreaterThan(2 * b.points[S].z);
    let thickest = 0;
    for (let i = 1; i < N; i++) if (b.points[i].z > b.points[thickest].z) thickest = i;
    expect(thickest).toBeLessThan(Math.trunc(N / 2));
  });

  /// The SDF stays inside the cull circle, and the rim / ink bands are exact where the stroke is wide and thinned
  /// (by the eyes' rule) near the tips.
  test('boundsAndBands', () => {
    const fu = u(frame('Happiness'));
    const b = fu.browLeft;
    const r = b.cullRadius;
    let inside = 0;
    const bad: string[] = [];
    for (let y = -r - 4; y <= r + 4; y += 1.5) {
      for (let x = -r - 4; x <= r + 4; x += 1.5) {
        const px = add(b.center, v2(x, y));
        const s = EyeSDF.browSample(b, fu, px);
        if (s.coverage > 0) {
          inside += 1;
          if (!(Math.sqrt(x * x + y * y) <= r)) bad.push(`covered pixel outside the cull radius at ${x},${y}`);
        }
        const { d, r: rad } = EyeSDF.browField(b, fu, px);
        if (d < 0) {
          const bands = EyeGeometry.bands(b.bands.x, b.bands.y, 2 * rad);
          if (!(Math.abs(s.rim - bands.rim) < 1e-6 && Math.abs(s.ink - bands.ink) < 1e-6)) bad.push(`bands at ${x},${y}`);
          if (rad > 2 * (b.bands.x + b.bands.y) && !(s.rim === b.bands.x && s.ink === b.bands.y)) bad.push(`full bands at ${x},${y}`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(inside).toBeGreaterThan(100);
  });

  test('tipsStayOutlinedNotTranslucent', () => {
    // Interior pixels are fully covered (flat colour); only the anti-aliased edge is partial.
    const fu = u(frame('Neutral'));
    const b = fu.browRight;
    const ppu = fu.pixelsPerUnit;
    for (let k = 0; k < N; k++) {
      const q = b.points[k];
      const s = EyeSDF.browSample(b, fu, add(b.center, v2(q.x * ppu, q.y * ppu)));
      if (q.z * ppu > 0.75) expect(s.coverage, `spine point ${k} not solid`).toBe(1);
    }
  });

  /// The minimum gap holds for every expression × intensity × lid state × stage offset × face tilt.
  test.each(library.names)('minimumGapHolds %s', (name) => {
    const s = browStyle();
    const bad: string[] = [];
    for (const intensity of [1, 1.3]) {
      for (const tilt of [-12, 0, 12]) {
        for (const closure of [0, 0.5, 1]) {
          for (const stage of [v2(0, 0), v2(-40, 20)]) {
            let f = frame(name, intensity);
            f.pose.setFace('angle', tilt);
            f = makeFaceFrame(blinked(f.pose, closure), { closureScale: blinkClosureScale(closure), stageOffset: stage,
              brows: f.brows });
            const fu = u(f);
            for (const side of ParamLayout.Side.allCases) {
              const pose = f.pose;
              const ratio = Math.sqrt(s.eyeAsymmetry);
              const asym = side === 'left' ? ratio : 1 / ratio;
              const h = Canvas.eyeHeight * pose.eye(side, 'scaleY') * pose.face('scaleY') * s.eyeScale * asym
                / blinkClosureScale(closure).y;
              const c = EyeGeometry.browClearance(side, f, fu, vp, s);
              if (!(c >= s.browMinGap * h * 0.9)) bad.push(`${name} ×${intensity} tilt ${tilt} closure ${closure} ${side}: ${c}`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  /// Blink closure never moves a brow (it hangs on the pre-closure sclera).
  test('blinkDoesNotMoveBrows', () => {
    const f = frame('Neutral');
    const open = u(f);
    for (const c of [0.3, 0.7, 1]) {
      const closed = u(makeFaceFrame(blinked(f.pose, c), { closureScale: blinkClosureScale(c), brows: f.brows }));
      for (const [a, b] of [[closed.browLeft, open.browLeft], [closed.browRight, open.browRight]]) {
        expect(Math.abs(a.center.x - b.center.x) < 1e-3 && Math.abs(a.center.y - b.center.y) < 1e-3).toBe(true);
        for (let i = 0; i < N; i++) {
          const dx = a.points[i].x - b.points[i].x, dy = a.points[i].y - b.points[i].y, dz = a.points[i].z - b.points[i].z;
          expect(Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4 && Math.abs(dz) < 1e-4, `closure ${c} moved brow point ${i}`)
            .toBe(true);
        }
      }
    }
  });

  /// The two brows never overlap each other, whatever the lanes (the composer keeps the inner ends apart).
  test('browsNeverOverlapEachOther', () => {
    const cases: FaceFrame[] = library.names.map((n) => frame(n, 1.3));
    const base = BrowPose.defaults;
    for (const side of ParamLayout.Side.allCases) {
      base.setLane(side, 'x', -0.25); base.setLane(side, 'width', 1.4); base.setLane(side, 'rotation', -40);
    }
    cases.push(makeFaceFrame(library.neutral.copy(), { brows: composed(base) }));
    for (const f of cases) {
      const fu = u(f);
      const l = fu.browLeft, r = fu.browRight;
      let best = Number.MAX_VALUE;
      const lc = vp.canvas(l.center), rc = vp.canvas(r.center);
      for (let i = 0; i < N; i++) {
        const p = add(lc, v2(l.points[i].x, l.points[i].y));
        for (let j = 0; j < S; j++) {
          const a = add(rc, v2(r.points[j].x, r.points[j].y));
          const b = add(rc, v2(r.points[j + 1].x, r.points[j + 1].y));
          best = Math.min(best, EyeSDF.taperedSegment(p, a, b, r.points[j].z, r.points[j + 1].z).d - l.points[i].z);
        }
      }
      expect(best, `brows overlap by ${-best}`).toBeGreaterThan(0);
    }
  });

  /// Presence shrinks the brow toward its arch peak and removes it below a pixel; no translucent interior.
  test('fadeIsGeometric', () => {
    const f = frame('Neutral');
    const full = u(f).browLeft;
    f.browPresence = 0.4;
    const fu = u(f);
    const b = fu.browLeft;
    let rFull = 0, rFade = 0;
    for (let i = 0; i < N; i++) { rFull = Math.max(rFull, full.points[i].z); rFade = Math.max(rFade, b.points[i].z); }
    expect(Math.abs(rFade - 0.4 * rFull)).toBeLessThan(1e-3);
    const q = b.points[Math.trunc(S / 3)];
    expect(EyeSDF.browSample(b, fu, add(b.center, v2(q.x * fu.pixelsPerUnit, q.y * fu.pixelsPerUnit))).coverage).toBe(1);
    f.browPresence = 0.5 / (rFull * vp.pixelsPerUnit) * 0.99;
    expect(u(f).browLeft.isVisible, 'under a pixel: gone').toBe(false);
    f.browPresence = 0;
    expect(u(f).browLeft.isVisible).toBe(false);
  });

  /// Brows ride the stage offsets (screen-edge antics) and the face's tilt; the edge geometry counts them.
  test('browsFollowStageAndEdgeGeometryCountsThem', () => {
    const f = frame('Neutral');
    const moved = cloneFaceFrame(f);
    moved.stageOffset = v2(30, 0);
    const a = u(f).browLeft.center, b = u(moved).browLeft.center;
    expect(Math.abs((b.x - a.x) / vp.pixelsPerUnit - 30)).toBeLessThan(0.01);
    const g = edgeGeometryFitting(1194, 834, browStyle());
    expect(g.hasBrows).toBe(true);
    // Pushed down until the eye has left the bottom edge, its brow can still be on screen.
    const off = v2(0, g.visibleHalfExtent.y - g.center('left').y + g.halfSize('left').y + 1);
    expect(g.visibleFraction('left', off)).toBe(0);
    expect(g.extentVisibleFraction('left', off)).toBeGreaterThan(0);
    // Hiding sideways takes the brow out too.
    const x = g.offsetX('left', 0, -1);
    expect(g.extentVisibleFraction('left', v2(x - 0.01, 0))).toBe(0);
  });

  /// Every expression at intensity 1.3 with the gaze up keeps its brows on screen on every iPad, both orientations.
  test('browsStayOnScreen', () => {
    const sizes: [number, number][] = [[1194, 834], [1366, 1024], [1180, 820], [1133, 744], [1376, 1032], [1210, 834], [1024, 768]];
    const bad: string[] = [];
    for (const [w, h] of sizes) {
      for (const [ww, hh] of [[w, h], [h, w]]) {
        const v = Viewport.fitting(ww, hh, browStyle());
        for (const name of library.names) {
          if (name === 'Asleep') continue;
          const f = frame(name, 1.3);
          // Gaze up: head and eye shapes shift up (canvas), plus burn-in drift.
          f.pose.setFace('centerY', f.pose.face('centerY') + Units.poseY(-4 - 4));
          const fu = u(f, browStyle(), v);
          for (const b of [fu.browLeft, fu.browRight]) {
            if (!b.isVisible) continue;
            for (let i = 0; i < N; i++) {
              const top = b.center.y + (b.points[i].y - b.points[i].z) * v.pixelsPerUnit;
              if (!(top >= 0)) bad.push(`${name} brow off the top on ${ww}×${hh}: ${top}`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test('inkBrowsFillWithInk', () => {
    const s = browStyle();
    s.browInk = true;
    const fu = u(frame('Neutral'), s);
    const b = fu.browLeft;
    const q = b.points[4];
    const c = EyeSDF.browSample(b, fu, add(b.center, v2(q.x * fu.pixelsPerUnit, q.y * fu.pixelsPerUnit))).color;
    expect(c).toEqual({ x: fu.ink.x, y: fu.ink.y, z: fu.ink.z });
  });

  /// The brows' CPU geometry stays cheap (it runs every frame on the main thread; the bound is loose).
  test('browGeometryIsCheap', () => {
    const f = frame('Happiness');
    const fu = u(f);
    const style = browStyle();
    const n = 400;
    const t0 = performance.now();
    let sink = 0;
    for (let i = 0; i < n; i++) sink += EyeGeometry.brow('left', f, fu.left, vp, style).placement.x;
    const per = (performance.now() - t0) / 1000 / n;
    expect(sink).not.toBe(0);
    expect(per, `one brow took ${per * 1000} ms`).toBeLessThan(0.0015);
  });
});
