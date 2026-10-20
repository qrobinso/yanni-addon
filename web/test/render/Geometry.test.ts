// Port of FaceRenderingTests/GeometryTests.swift (Viewport, EyeGeometry, golden sensitivity, ovalness).
import { describe, expect, test } from 'vitest';
import { add2, sub2, v2, type V2 } from '../../src/core/vec';
import { ExpressionLibrary } from '../../src/model/Expression';
import { Canvas, makeFaceFrame, Units } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { ParamLayout } from '../../src/model/ParamLayout';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { EyeSDF } from '../../src/render/EyeSDF';
import { makeRenderStyle, RenderStyle } from '../../src/render/RenderStyle';
import type { EyeUniforms } from '../../src/render/RenderUniforms';
import { Viewport } from '../../src/render/Viewport';
import { golden, goldenEntries, goldenPose, iou, minimumIoU, raster } from './golden';
import { blinked, dist2, TestRandom } from './helpers';

describe('ViewportTests', () => {
  /// Drawable sizes (pixels, landscape) of current iPads.
  const iPads: [string, number, number][] = [
    ['iPad Pro 11"', 2420, 1668], ['iPad Pro 13"', 2752, 2064], ['iPad Pro 12.9"', 2732, 2048],
    ['iPad Air 11"', 2360, 1640], ['iPad mini', 2266, 1488], ['iPad 10th gen', 2360, 1640],
  ];
  const cases = iPads.flatMap(([n, w, h]) => [[n + ' landscape', w, h], [n + ' portrait', h, w]] as [string, number, number][]);

  test.each(cases)('envelopeIsOnScreenAndCentred %s', (name, w, h) => {
    const vp = Viewport.fitting(w, h, makeRenderStyle());
    const half = v2(Viewport.envelope.x / 2, Viewport.envelope.y / 2);
    const lo = vp.pixel(sub2(Viewport.canvasCenter, half));
    const hi = vp.pixel(add2(Viewport.canvasCenter, half));
    expect(lo.x >= -0.5 && lo.y >= -0.5, `${name}: envelope starts off screen`).toBe(true);
    expect(hi.x <= w + 0.5 && hi.y <= h + 0.5, `${name}: envelope ends off screen`).toBe(true);
    const c = vp.pixel(Viewport.canvasCenter);
    expect(Math.abs(c.x - w / 2)).toBeLessThan(0.01);
    expect(Math.abs(c.y - h / 2)).toBeLessThan(0.01);
    // Width-bound: the envelope fills (nearly) the full width.
    expect((hi.x - lo.x) / w, `${name} should be width-bound`).toBeGreaterThan(0.9);
  });

  test('portraitIsLargerButStillFits', () => {
    const style = makeRenderStyle();
    const land = Viewport.fitting(2420, 1668, style);
    const port = Viewport.fitting(1668, 2420, style);
    expect(port.pixelsPerUnit).toBeGreaterThan(land.pixelsPerUnit * 1668 / 2420);
    expect(port.pixelsPerUnit * Viewport.envelope.x).toBeLessThanOrEqual(1668 + 0.5);
  });

  test('faceScaleScalesAboutCentre', () => {
    const style = makeRenderStyle();
    const a = Viewport.fitting(1000, 700, style);
    style.faceScale = 0.5;
    const b = Viewport.fitting(1000, 700, style);
    expect(Math.abs(b.pixelsPerUnit - a.pixelsPerUnit * 0.5)).toBeLessThan(1e-4);
    expect(b.pixel(Viewport.canvasCenter)).toEqual(a.pixel(Viewport.canvasCenter));
  });

  test('neutralEyesAreSymmetricAboutCentre', () => {
    const style = RenderStyle.neutralGeometry;
    const vp = Viewport.fitting(2420, 1668, style);
    const u = EyeGeometry.uniforms(makeFaceFrame(FacePose.defaults), vp, style);
    expect(Math.abs((u.left.center.x + u.right.center.x) / 2 - 1210)).toBeLessThan(0.01);
    expect(Math.abs(u.left.center.y - 834)).toBeLessThan(0.01);
    expect(Math.abs(u.right.center.y - 834)).toBeLessThan(0.01);
    expect(Math.abs((u.right.center.x - u.left.center.x) - 50 * style.eyeSpacing * vp.pixelsPerUnit)).toBeLessThan(0.01);
    // eyeScale scales eye size, not spacing.
    expect(Math.abs(u.left.halfExtents.x - 14 * style.eyeScale)).toBeLessThan(1e-5);
    expect(Math.abs(u.left.halfExtents.y - 20 * style.eyeScale)).toBeLessThan(1e-5);
  });
});

const unitViewport = () => new Viewport(v2(128, 64), 1, v2(0));
const unitStyle = () => ({ ...RenderStyle.neutralGeometry, eyeScale: 1, roundness: 1, ovalness: 0 });
const library = ExpressionLibrary.bundled();
const expr = (name: string) => library.get(name)!.pose;

/// y (eye-local) where the upper lid's lower edge crosses column x.
function upperLidEdge(e: EyeUniforms, x: number): number {
  let y = -e.halfExtents.y;
  while (y < e.halfExtents.y) {
    if (EyeSDF.lid(v2(x, y), e.upperLid, e.upperBend, e.upperClip) >= 0) return y;
    y += 0.01;
  }
  return y;
}

/// Vertical extent of the visible shape through the eye centre column (canvas units).
function centreThickness(e: EyeUniforms): number {
  let n = 0;
  const step = 0.005;
  for (let y = -e.halfExtents.y - 1; y < e.halfExtents.y + 1; y += step) {
    if (EyeSDF.visible(e, v2(0, y)).dVis < 0) n += 1;
  }
  return n * step;
}

describe('EyeGeometryTests', () => {
  test('faceTransformMovesAndRotatesEyes', () => {
    const pose = FacePose.defaults;
    pose.setFace('centerX', Units.poseX(10));
    pose.setFace('centerY', Units.poseY(-4));
    const u = EyeGeometry.uniforms(makeFaceFrame(pose), unitViewport(), unitStyle());
    expect(Math.abs(u.left.center.x - (64 - 25 + 10))).toBeLessThan(1e-4);
    expect(Math.abs(u.left.center.y - 28)).toBeLessThan(1e-4);

    const rot = FacePose.defaults;
    rot.setFace('angle', 90); // counter-clockwise on screen: the right eye moves up
    const r = EyeGeometry.uniforms(makeFaceFrame(rot), unitViewport(), unitStyle());
    expect(Math.abs(r.right.center.x - 64)).toBeLessThan(1e-3);
    expect(Math.abs(r.right.center.y - (32 - 25))).toBeLessThan(1e-3);
    expect(Math.abs(r.right.placement.z)).toBeLessThan(1e-5);
    expect(Math.abs(r.right.placement.w - 1)).toBeLessThan(1e-5);
  });

  test('cornerRadiiAreScaledAndClamped', () => {
    const pose = FacePose.defaults;
    pose.setEye('left', 'upperOuterRadiusX', 1.0);
    pose.setEye('left', 'upperOuterRadiusY', 1.0);
    pose.setEye('left', 'scaleX', 0.5); // half width 7 → rx 6.4 (scaled), within 7
    pose.setEye('left', 'scaleY', 0.2); // half height 4 → ry clamped to 4
    const e = EyeGeometry.eye('left', pose, unitViewport(), unitStyle());
    // Left eye: outer = −x = upper-left quadrant.
    expect(Math.abs(e.radiiTop.x - 6.4)).toBeLessThan(1e-4);
    expect(Math.abs(e.radiiTop.y - 4.0)).toBeLessThan(1e-4);
    expect(e.radiiTop.x <= e.halfExtents.x && e.radiiTop.y <= e.halfExtents.y).toBe(true);

    const big = FacePose.defaults;
    big.setEye('left', 'lowerInnerRadiusX', 1.0);
    big.setEye('left', 'scaleX', 0.3);
    const style = { ...unitStyle(), roundness: 3 };
    const c = EyeGeometry.eye('left', big, unitViewport(), style);
    expect(Math.abs(c.radiiBottom.z - c.halfExtents.x), 'clamped to half width').toBeLessThan(1e-4);
  });

  test('squashedEyeStaysAPill', () => {
    const pose = FacePose.defaults;
    pose.setEye('left', 'scaleY', 0.1); // half height 2
    const e = EyeGeometry.eye('left', pose, unitViewport(), unitStyle());
    // M2: r_y = max(r_y·sy, min(r_y·sx, halfH)) → 2, the full half height (rounded ends).
    expect(Math.abs(e.radiiTop.y - 2)).toBeLessThan(1e-4);
    expect(Math.abs(e.radiiBottom.w - 2)).toBeLessThan(1e-4);
  });

  test('innerOuterAreMirroredForTheRightEye', () => {
    const pose = FacePose.defaults;
    for (const side of ParamLayout.Side.allCases) {
      pose.setEye(side, 'upperInnerRadiusX', 0.9);
      pose.setEye(side, 'upperOuterRadiusX', 0.1);
    }
    const l = EyeGeometry.eye('left', pose, unitViewport(), unitStyle());
    const r = EyeGeometry.eye('right', pose, unitViewport(), unitStyle());
    // Inner faces the other eye: +x (upper-right) on the left eye, −x (upper-left) on the right eye.
    expect(l.radiiTop.z).toBeGreaterThan(l.radiiTop.x);
    expect(r.radiiTop.x).toBeGreaterThan(r.radiiTop.z);
    expect(Math.abs(l.radiiTop.z - r.radiiTop.x)).toBeLessThan(1e-5);
  });

  test('angerLidSlopesDownTowardsTheCentre', () => {
    const anger = expr('Anger');
    expect(anger.eye('left', 'upperLidAngle')).toBe(-30);
    const l = EyeGeometry.eye('left', anger, unitViewport(), unitStyle());
    const r = EyeGeometry.eye('right', anger, unitViewport(), unitStyle());
    // Left eye: the inner end (+x, towards screen centre) is lower (larger y, y down).
    expect(upperLidEdge(l, 8)).toBeGreaterThan(upperLidEdge(l, -8) + 4);
    // Right eye mirrors it via its +30° angle: inner end is −x.
    expect(upperLidEdge(r, -8)).toBeGreaterThan(upperLidEdge(r, 8) + 4);
    // Slope matches tan 30° (uniform scale, so no slope correction).
    const slope = (upperLidEdge(l, 8) - upperLidEdge(l, -8)) / 16;
    expect(Math.abs(slope - Math.tan(Math.PI / 6))).toBeLessThan(0.01);
  });

  test('lidSlopeIsCorrectedForNonUniformScale', () => {
    const pose = FacePose.defaults;
    pose.setEye('left', 'upperLidAngle', -30);
    pose.setEye('left', 'upperLidY', 0.5);
    pose.setEye('left', 'scaleY', 0.5);
    const e = EyeGeometry.eye('left', pose, unitViewport(), unitStyle());
    const slope = (upperLidEdge(e, 6) - upperLidEdge(e, -6)) / 12;
    expect(Math.abs(slope - Math.tan(Math.PI / 6) * 0.5)).toBeLessThan(0.01);
  });

  test.each([0.5, 0.8, 0.95, 1.0])('closedEyeNeverDisappears %s', (c) => {
    const e = EyeGeometry.eye('left', blinked(FacePose.defaults, c), unitViewport(), makeRenderStyle());
    expect(centreThickness(e), `closure ${c}`).toBeGreaterThanOrEqual(0.9 - 0.02);
  });

  test('extremeClosureStillShowsALine', () => {
    const pose = FacePose.defaults;
    for (const side of ParamLayout.Side.allCases) {
      pose.setEye(side, 'upperLidY', 0.7);
      pose.setEye(side, 'lowerLidY', 0.7);
      pose.setEye(side, 'upperLidBend', 0.5);
      pose.setEye(side, 'scaleY', 0.01);
    }
    const e = EyeGeometry.eye('left', pose, unitViewport(), makeRenderStyle());
    expect(centreThickness(e)).toBeGreaterThanOrEqual(0.9 - 0.02);
    const tall = FacePose.defaults;
    tall.addBoth('upperLidY', 0.6);
    tall.addBoth('lowerLidY', 0.6);
    const t = EyeGeometry.eye('left', tall, unitViewport(), makeRenderStyle());
    expect(centreThickness(t)).toBeGreaterThanOrEqual(0.9 - 0.02);
  });

  test('openEyesAreNotEroded', () => {
    for (const name of library.names) {
      for (const side of ParamLayout.Side.allCases) {
        const e = EyeGeometry.eye(side, expr(name), unitViewport(), makeRenderStyle());
        expect(e.erosion, `${name} ${side} unexpectedly eroded`).toBe(0);
      }
    }
  });

  test('arcDistanceMatchesBruteForce', () => {
    const rng = new TestRandom(0x5eed);
    for (let n = 0; n < 150; n++) {
      const ab = v2(rng.float(4, 20), rng.float(0.5, 12));
      const lo = rng.float(0, 1.4);
      const psi = v2(lo, Math.PI - rng.float(0, 1.4));
      for (let m = 0; m < 60; m++) {
        const p = v2(rng.float(-25, 25), rng.float(-15, 15));
        let best = Number.MAX_VALUE;
        for (let k = 0; k <= 2000; k++) {
          const t = psi.x + (psi.y - psi.x) * k / 2000;
          best = Math.min(best, Math.hypot(ab.x * Math.cos(t) - p.x, ab.y * Math.sin(t) - p.y));
        }
        const got = EyeSDF.arcDistance(p, ab, psi);
        expect(got, `under-estimate at ${JSON.stringify([p, ab, psi])}`).toBeGreaterThanOrEqual(best - 0.02);
        // Over-estimates are the safe direction (glow slightly dimmer): tiny near the arc, a few percent far away.
        expect(got, `over-estimate vs ${best}`).toBeLessThanOrEqual(best + 0.05 + 0.04 * best);
      }
    }
  });

  /// Inside the eye box, the lid depth used for the glow tracks the true distance to the visible shape:
  /// never much above it (no dark holes) and never far below it (no glow "legs" under the lids).
  test.each(['Happiness', 'Excitement', 'Confusion', 'Despair', 'Anger'])('lidDepthTracksDistanceToVisibleShape %s', (name) => {
    const e = EyeGeometry.eye('left', expr(name), unitViewport(), unitStyle());
    const visible: V2[] = [], covered: V2[] = [];
    const h = e.halfExtents;
    for (let y = -h.y; y <= h.y; y += 0.25) {
      for (let x = -h.x; x <= h.x; x += 0.25) {
        const p = v2(x, y);
        const v = EyeSDF.visible(e, p);
        if (v.dVis < 0) visible.push(p); else if (v.dShape < -0.5) covered.push(p);
      }
    }
    expect(visible.length).toBeGreaterThan(0);
    for (const p of covered) {
      if (Math.trunc(p.x * 4 + p.y * 7) % 5 !== 0) continue;
      const truth = Math.min(...visible.map((q) => dist2(q, p)));
      const dOpen = EyeSDF.visible(e, p).dOpen;
      expect(dOpen, `${name}: depth exceeds distance ${truth}`).toBeLessThanOrEqual(truth + 0.4);
      expect(dOpen, `${name}: depth far below distance ${truth}`).toBeGreaterThanOrEqual(truth * 0.6 - 0.5);
    }
  });
});

describe('GoldenSensitivityTests', () => {
  /// The golden comparison has teeth: flipping Anger's lid angles fails it.
  test('flippedLidAnglesFailTheGolden', () => {
    const entry = goldenEntries.find((e) => e.name === 'Anger')!;
    const pose = goldenPose(entry.params);
    for (const side of ParamLayout.Side.allCases) pose.setEye(side, 'upperLidAngle', -pose.eye(side, 'upperLidAngle'));
    expect(iou(raster(pose), golden(entry.rows))).toBeLessThan(minimumIoU);
  });
});

describe('OvalnessTests', () => {
  const uniforms = (ovalness: number) =>
    EyeGeometry.uniforms(makeFaceFrame(FacePose.defaults), unitViewport(), { ...RenderStyle.neutralGeometry, ovalness });

  test('fullOvalnessUsesHalfExtents', () => {
    const u = uniforms(1);
    const s = makeRenderStyle().eyeScale;
    expect(Math.abs(u.left.radiiTop.x - Canvas.eyeWidth / 2 * s)).toBeLessThan(1e-3);
    expect(Math.abs(u.left.radiiTop.y - Canvas.eyeHeight / 2 * s)).toBeLessThan(1e-3);
  });

  test('defaultIsRounderThanAuthored', () => {
    const a = uniforms(0), b = uniforms(makeRenderStyle().ovalness);
    expect(b.left.radiiTop.y).toBeGreaterThan(a.left.radiiTop.y);
    expect(b.left.radiiBottom.x).toBeGreaterThanOrEqual(a.left.radiiBottom.x);
  });
});
