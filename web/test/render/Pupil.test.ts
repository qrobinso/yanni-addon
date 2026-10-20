// Port of FaceRenderingTests/PupilTests.swift: sclera / pupil geometry (containment, continuity, lids, rim + ink band).
import { describe, expect, test } from 'vitest';
import { v2, type V2 } from '../../src/core/vec';
import { ExpressionLibrary } from '../../src/model/Expression';
import { makeFaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { ParamLayout } from '../../src/model/ParamLayout';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { EyeSDF } from '../../src/render/EyeSDF';
import { PupilSolver, ScleraShape } from '../../src/render/PupilGeometry';
import { makeRenderStyle, RenderStyle } from '../../src/render/RenderStyle';
import type { EyeUniforms } from '../../src/render/RenderUniforms';
import { Viewport } from '../../src/render/Viewport';
import { blinkFrame, dist2, TestRandom, withPupils } from './helpers';

const library = ExpressionLibrary.bundled();
const expr = (name: string) => library.get(name)!.pose;
const unitViewport = () => new Viewport(v2(128, 64), 10, v2(0));

/// `n` points on the pupil ellipse rim (eye-local).
function rim(e: EyeUniforms, n = 64): V2[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / n * 2 * Math.PI;
    return v2(e.pupil.x + Math.cos(t) * e.pupil.z, e.pupil.y + Math.sin(t) * e.pupil.w);
  });
}

function solverShapes(): [string, ScleraShape][] {
  const out: [string, ScleraShape][] = [];
  for (const [label, scaleY, oval] of [['neutral', 1, 0.75], ['boxy', 1, 0], ['oval', 1, 1], ['squashed', 0.35, 0.75],
    ['flat', 0.2, 0], ['tall', 1.3, 0.3]] as const) {
    const style = { ...RenderStyle.neutralGeometry, ovalness: oval };
    const pose = FacePose.defaults;
    pose.setEye('left', 'scaleY', scaleY);
    out.push([label, ScleraShape.of(EyeGeometry.eye('left', pose, unitViewport(), style))]);
  }
  return out;
}

/// Fraction of the pupil's area that no lid covers (sampled).
function uncoveredFraction(e: EyeUniforms): number {
  let total = 0, open = 0;
  const n = 40;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ux = (i + 0.5) / n * 2 - 1, uy = (j + 0.5) / n * 2 - 1;
      if (ux * ux + uy * uy > 1) continue;
      total += 1;
      if (EyeSDF.visible(e, v2(e.pupil.x + ux * e.pupil.z, e.pupil.y + uy * e.pupil.w)).dOpen < 0) open += 1;
    }
  }
  return open / Math.max(total, 1);
}

describe('PupilTests', () => {
  /// The exact boundary distance agrees with brute force over a dense boundary sampling.
  test('boundaryDistanceMatchesBruteForce', () => {
    const rng = new TestRandom(0xd15);
    for (let n = 0; n < 60; n++) {
      const half = v2(rng.float(2, 16), rng.float(1, 20));
      const r = () => v2(rng.float(0.01, 1) * half.x, rng.float(0.01, 1) * half.y);
      const a = r(), b = r(), c = r(), d = r();
      const shape = new ScleraShape(half, { x: a.x, y: a.y, z: b.x, w: b.y }, { x: c.x, y: c.y, z: d.x, w: d.y });
      const pts = shape.boundaryPoints(400);
      for (let m = 0; m < 40; m++) {
        const p = v2(rng.float(-1.2, 1.2) * half.x, rng.float(-1.2, 1.2) * half.y);
        const brute = Math.min(...pts.map((q) => dist2(q, p)));
        const got = shape.boundaryDistance(p);
        expect(Math.abs(got - brute), `${JSON.stringify(p)}: ${got} vs ${brute}`).toBeLessThan(0.02 + 0.002 * brute);
      }
    }
  });

  /// Over a grid of expression × pupil position × size × squash × eye scale × rotation × ovalness × closure, the
  /// pupil rim never crosses the outline's inner edge, and lies inside the sclera.
  test('pupilNeverCrossesTheOutline', () => {
    const rng = new TestRandom(0xc0ffee);
    const positions = [-1, -0.6, 0, 0.6, 1];
    let checked = 0;
    const bad: string[] = [];
    for (const name of library.names) {
      const base = expr(name);
      for (let n = 0; n < 160; n++) {
        const style = makeRenderStyle();
        style.eyeScale = rng.pick([0.3, 0.55, 0.8, 1.05, 1.3]);
        style.ovalness = rng.pick([0, 0.4, 0.75, 1]);
        let pose = base.copy();
        pose.setFace('angle', rng.float(-30, 30));
        pose.setEye('left', 'angle', rng.float(-30, 30));
        pose = withPupils(pose, { x: rng.pick(positions), y: rng.pick(positions),
          size: rng.pick([0.15, 0.3, 0.5, 0.7, 0.85]), squash: rng.pick([0, 0.2, 0.4]) });
        const c = rng.pick([0, 0.3, 0.6, 0.9, 1]);
        const frame = blinkFrame(pose, c);
        for (const side of ParamLayout.Side.allCases) {
          const e = EyeGeometry.eye(side, frame.pose, unitViewport(), style, frame.closureScale);
          const shape = ScleraShape.of(e);
          const w = e.outlineWidth;
          const worst = Math.min(...rim(e, 96).map((p) => shape.depth(p)));
          if (!(worst >= w - 2e-3)) bad.push(`${name} ${side} c=${c} style(${style.eyeScale},${style.ovalness}): rim depth ${worst} < outline ${w}`);
          if (!(e.pupil.z > 0 && e.pupil.w > 0 && Number.isFinite(e.pupil.x) && Number.isFinite(e.pupil.y))) bad.push(`${name} ${side} bad pupil`);
          checked += 1;
        }
      }
    }
    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThan(7000);
  });

  /// Open, un-lidded eyes keep the full clearance: outline + the M2 sclera margin.
  test('openEyesKeepTheScleraMargin', () => {
    for (const v of [v2(1, 0), v2(-1, 0), v2(0, 1), v2(0, -1), v2(1, 1), v2(-1, 1)]) {
      const e = EyeGeometry.eye('left', withPupils(FacePose.defaults, { x: v.x, y: v.y }), unitViewport(), makeRenderStyle());
      const shape = ScleraShape.of(e);
      const worst = Math.min(...rim(e, 128).map((p) => shape.depth(p)));
      const need = makeRenderStyle().rimWidth + makeRenderStyle().inkWidth + PupilSolver.margin(e.pupil.z);
      expect(worst, `${JSON.stringify(v)}: clearance < ${need}`).toBeGreaterThanOrEqual(need - 0.01);
    }
  });

  /// C5: no snapping. |Δc| ≤ 2·max(ex, ey)·|Δv| on a fine grid, including squashed eyes and squashed pupils.
  test('mappingIsLipschitz', () => {
    const step = 0.02;
    const bad: string[] = [];
    for (const [label, shape] of solverShapes()) {
      for (const squash of [0, 0.4]) {
        const a = 0.5 * shape.half.x, b = a * (1 - squash);
        const n = Math.trunc(2 / step);
        let prevRow: V2[] = [];
        for (let j = 0; j <= n; j++) {
          const row: V2[] = [];
          for (let i = 0; i <= n; i++) {
            const v = v2(-1 + i * step, -1 + j * step);
            const p = PupilSolver.place(shape, v, a, b, 1.6);
            const bound = 2 * Math.max(p.travel.x, p.travel.y) * step + 1e-3;
            if (row.length > 0) {
              const d = dist2(p.center, row[row.length - 1]);
              if (!(d <= bound)) bad.push(`${label} squash ${squash}: jump ${d} > ${bound} at ${JSON.stringify(v)}`);
            }
            if (prevRow.length > 0) {
              const d = dist2(p.center, prevRow[i]);
              if (!(d <= bound)) bad.push(`${label} squash ${squash}: jump ${d} > ${bound} at ${JSON.stringify(v)}`);
            }
            row.push(p.center);
          }
          prevRow = row;
        }
      }
    }
    expect(bad).toEqual([]);
  });

  /// ±1 puts the pupil on the contained boundary: on the axes and at the corners the centre depth equals ρ
  /// (touching), and anywhere on the |v|∞ = 1 square it is never deeper-than-allowed violated.
  test('pupilTouchesTheBoundaryAtFullTravel', () => {
    for (const [label, shape] of solverShapes()) {
      for (const squash of [0, 0.3]) {
        const a = 0.45 * shape.half.x, b = a * (1 - squash);
        const depth = (v: V2): [number, number] => {
          const p = PupilSolver.place(shape, v, a, b, 1.6);
          return [shape.scaledY(p.k).depth(v2(p.center.x, p.center.y * p.k)), p.rho];
        };
        for (const v of [v2(1, 0), v2(-1, 0), v2(0, 1), v2(0, -1), v2(1, 1), v2(-1, 1), v2(1, -1), v2(-1, -1)]) {
          const [d, rho] = depth(v);
          expect(Math.abs(d - rho), `${label} squash ${squash} v ${JSON.stringify(v)}: depth ${d} vs ρ ${rho}`).toBeLessThan(0.02);
        }
        for (let i = 0; i < 64; i++) {
          const t = i / 64 * 2 * Math.PI;
          const m = Math.max(Math.abs(Math.cos(t)), Math.abs(Math.sin(t)));
          const v = v2(Math.cos(t) / m, Math.sin(t) / m);
          const [d, rho] = depth(v);
          expect(d, `${label} v ${JSON.stringify(v)}`).toBeGreaterThanOrEqual(rho - 2e-3);
        }
      }
    }
  });

  /// A pupil too big for a tiny eye shrinks until it fits, rather than poking out.
  test('oversizedPupilShrinks', () => {
    const style = makeRenderStyle();
    style.eyeScale = 0.3;
    const pose = withPupils(FacePose.defaults, { size: 0.85 });
    pose.setEye('left', 'scaleY', 0.3);
    const e = EyeGeometry.eye('left', pose, unitViewport(), style);
    expect(e.pupil.z).toBeLessThan(0.85 * e.halfExtents.x);
    const shape = ScleraShape.of(e);
    expect(Math.min(...rim(e).map((p) => shape.depth(p)))).toBeGreaterThanOrEqual(e.outlineWidth - 2e-3);
  });

  /// H2: whenever the opening at the pupil's column is at least 1.2 pupil y-radii, ≥ 60 % of the pupil is
  /// uncovered by the lids, whatever the gaze asks for.
  test('lidsLeaveMostOfThePupilVisible', () => {
    const rng = new TestRandom(0x11d5);
    let tested = 0;
    const bad: string[] = [];
    for (const name of library.names) {
      const base = expr(name);
      for (let n = 0; n < 60; n++) {
        let pose = base.copy();
        pose.addBoth('upperLidY', rng.float(0, 0.35));
        pose.addBoth('lowerLidY', rng.float(0, 0.25));
        pose = withPupils(pose, { x: rng.float(-0.8, 0.8), y: rng.pick([-1, -0.7, 0, 0.7, 1]) });
        for (const side of ParamLayout.Side.allCases) {
          const e = EyeGeometry.eye(side, pose, unitViewport(), makeRenderStyle());
          const o = EyeGeometry.opening(e, e.pupil.x);
          if (o.bottom - o.top < 1.2 * e.pupil.w) continue;
          // Containment wins over the lids: skip pupils already pressed against the sclera boundary.
          const k = e.pupil.z / e.pupil.w;
          const rho = e.pupil.z + (e.bandWidth + PupilSolver.margin(e.pupil.z)) * Math.max(k, 1);
          const depth = ScleraShape.of(e).scaledY(k).depth(v2(e.pupil.x, e.pupil.y * k));
          if (!(depth - rho > 0.05)) continue;
          tested += 1;
          const f = uncoveredFraction(e);
          if (!(f >= 0.6)) bad.push(`${name} ${side} pupil ${JSON.stringify(e.pupil)} opening ${JSON.stringify(o)}: only ${f} visible`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(tested, `only ${tested} cases`).toBeGreaterThan(500);
  });

  /// H9: during a blink the pupil rides the closure squash as a rigid body (no sliding toward the lids).
  test('blinkSquashesThePupilRigidly', () => {
    const pose = withPupils(FacePose.defaults, { x: 0.3, y: -0.4 });
    const open = EyeGeometry.eye('left', pose, unitViewport(), makeRenderStyle());
    for (const c of [0.2, 0.4, 0.6]) {
      const f = blinkFrame(pose, c);
      const e = EyeGeometry.eye('left', f.pose, unitViewport(), makeRenderStyle(), f.closureScale);
      const s = f.closureScale;
      expect(Math.abs(e.pupil.x - open.pupil.x * s.x), `c ${c}`).toBeLessThan(0.05);
      expect(Math.abs(e.pupil.y - open.pupil.y * s.y), `c ${c}`).toBeLessThan(0.05);
      expect(Math.abs(e.pupil.w - open.pupil.w * s.y)).toBeLessThan(0.05);
    }
  });

  /// C6: closed eyes have no pupil pixels anywhere; the rim thins and the ink fills the slit, so an
  /// ivory-rimmed ink line remains.
  test('closedEyeHasNoPupilPixels', () => {
    const style = makeRenderStyle();
    const vp = Viewport.fitting(600, 420, style);
    for (const frame of [blinkFrame(FacePose.defaults, 1), blinkFrame(expr('Happiness'), 1), makeFaceFrame(expr('Asleep'))]) {
      const u = EyeGeometry.uniforms(frame, vp, style);
      for (const e of [u.left, u.right]) {
        expect(e.pupilVisibility).toBe(0);
        let white = 0, dark = 0, pupil = 0;
        const r = Math.trunc(e.cullRadius);
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx += 3) {
            const s = EyeSDF.sample(e, u, v2(e.center.x + dx, e.center.y + dy));
            if (s.pupil !== 0) pupil += 1;
            const c = s.color;
            if (s.coverage > 0.99 && Math.min(c.x, c.y, c.z) > 0.5) white += 1;
            if (s.coverage > 0.99 && Math.max(c.x, c.y, c.z) < 0.05) dark += 1;
          }
        }
        expect(pupil).toBe(0);
        expect(white, 'no ivory rim pixels on the closed line').toBeGreaterThan(0);
        expect(dark, 'no ink pixels on the closed line').toBeGreaterThan(0);
      }
    }
  });

  /// The inner edge of the outline band lies at the outline width from the sclera boundary, within ±5 %,
  /// all around the rim, including tight corner tips.
  test.each(['neutral', 'boxy', 'oval', 'squashed', 'flat'])('outlineBandIsEven %s', (label) => {
    const shape = solverShapes().find(([l]) => l === label)![1];
    const style = { ...RenderStyle.neutralGeometry, ovalness: ({ boxy: 0, oval: 1, flat: 0 } as Record<string, number>)[label] ?? 0.75 };
    const pose = FacePose.defaults;
    pose.setEye('left', 'scaleY', ({ squashed: 0.35, flat: 0.2 } as Record<string, number>)[label] ?? 1);
    const e = EyeGeometry.eye('left', pose, unitViewport(), style);
    expect(ScleraShape.of(e).equals(shape)).toBe(true);
    const w = e.outlineWidth;
    expect(w).toBeGreaterThan(0.5);
    for (let i = 0; i < 360; i++) {
      const t = i / 360 * 2 * Math.PI;
      const dir = v2(Math.cos(t), Math.sin(t));
      // Bisection along the ray from the centre for visible SDF = −w (inner edge of the band).
      const d = (s: number) => EyeSDF.visibleDistance(e, EyeSDF.visible(e, v2(dir.x * s, dir.y * s))) + w;
      let lo = 0, hi = Math.max(e.halfExtents.x, e.halfExtents.y) * 1.5;
      if (!(d(lo) < 0)) continue;
      for (let k = 0; k < 40; k++) {
        const mid = 0.5 * (lo + hi);
        if (d(mid) < 0) lo = mid; else hi = mid;
      }
      const truth = shape.boundaryDistance(v2(dir.x * lo, dir.y * lo));
      expect(Math.abs(truth - w), `${label} at ${i}°: band ${truth} vs ${w}`).toBeLessThanOrEqual(0.05 * w);
    }
  });
});
