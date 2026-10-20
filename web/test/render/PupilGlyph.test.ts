// Port of FaceRenderingTests/PupilGlyphTests.swift. Pupil transformation glyphs on the CPU mirror: containment,
// readability floors, distance-field quality, lid clipping, gaze following and the retracting notch / crescent /
// mood accent.
import { describe, expect, test } from 'vitest';
import { v2, v4, type V2, type V3 } from '../../src/core/vec';
import { ExpressionLibrary } from '../../src/model/Expression';
import { makeFaceFrame, type FaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { PupilShape, pupilShapeHasMoodAccent, pupilShapeMorphs } from '../../src/model/PupilShape';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { EyeSDF, type Sample } from '../../src/render/EyeSDF';
import { resolvedStyle } from '../../src/render/MoodColorMix';
import { PupilGlyph } from '../../src/render/PupilGlyphs';
import { makeRenderStyle, type RenderStyle } from '../../src/render/RenderStyle';
import type { FrameUniforms } from '../../src/render/RenderUniforms';
import { Viewport } from '../../src/render/Viewport';

const library = ExpressionLibrary.bundled();
const shapes: PupilShape[] = [PupilShape.star, PupilShape.heart, PupilShape.note, PupilShape.question, PupilShape.exclaim];
const shapeName = (s: PupilShape) => Object.entries(PupilShape).find(([, v]) => v === s)![0];
const w = 1194, h = 834;

const pose = (name = 'Neutral'): FacePose => library.get(name)?.pose.copy() ?? FacePose.defaults;

function frame(p: FacePose, shape: PupilShape, morph = 1, scale: V2 = v2(0.9)): FaceFrame {
  return makeFaceFrame(p, { pupilShape: v2(shape), pupilMorph: v2(shape === PupilShape.ellipse ? 0 : morph),
    pupilShapeScale: v4(scale.x, scale.y, scale.x, scale.y) });
}

function uniforms(f: FaceFrame, style: RenderStyle = makeRenderStyle()): FrameUniforms {
  const vp = Viewport.fitting(w, h, style);
  return EyeGeometry.uniforms(f, vp, resolvedStyle(style, f));
}

/// Every pixel of the left eye's cull square (step px), sampled.
function scan(u: FrameUniforms, step: number, body: (px: V2, s: Sample) => void): void {
  const e = u.left;
  const r = e.cullRadius, c = e.center;
  for (let y = c.y - r; y <= c.y + r; y += step) {
    for (let x = c.x - r; x <= c.x + r; x += step) {
      const px = v2(x, y);
      body(px, EyeSDF.sample(e, u, px));
    }
  }
}

const field = (e: FrameUniforms['left'], q: V2) => new EyeSDF.PupilField(e, q).d;

describe('PupilGlyph', () => {
  // MARK: Glyph geometry

  test.each(shapes)('glyphLiesInsideTheDefaultEllipse %s', (shape) => {
    const r = v2(1, PupilGlyph.aspect);
    let bad = 0;
    for (let y = -1.4; y <= 1.4; y += 0.01) {
      for (let x = -1.2; x <= 1.2; x += 0.01) {
        const p = v2(x, y);
        if (PupilGlyph.distance(shape, p) < 0 && !(EyeSDF.ellipse(p, r) < -0.02)) bad += 1;
      }
    }
    expect(bad, `${shapeName(shape)} pokes out`).toBe(0);
  });

  test('readabilityFloors', () => {
    const G = PupilGlyph;
    const minStroke = G.minStroke;
    expect(Math.abs(minStroke - 0.12 * 2 * 1.24)).toBeLessThan(1e-6);
    expect(2 * G.noteStroke).toBeGreaterThanOrEqual(minStroke);
    expect(2 * G.questionStroke).toBeGreaterThanOrEqual(minStroke);
    expect(2 * G.exclaimBottomRadius).toBeGreaterThanOrEqual(minStroke);
    expect(G.dotRadius).toBeGreaterThanOrEqual(G.minDot);
    expect(G.starRound).toBeGreaterThanOrEqual(0.12);
    // Measured: centre lines of every stroke sit at least half the minimum stroke inside.
    const depth = (s: PupilShape, p: V2) => -G.distance(s, p);
    const lerp2 = (a: V2, b: V2, t: number) => v2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    const arc = (c: V2, r: number, a: number) => v2(c.x + r * Math.cos(a), c.y + r * Math.sin(a));
    for (let t = 0; t <= 1; t += 0.05) {
      expect(depth(PupilShape.note, lerp2(G.noteStemTop, G.noteStemBottom, t))).toBeGreaterThanOrEqual(minStroke / 2 - 1e-3);
      const a = G.noteFlagAngles.x + (G.noteFlagAngles.y - G.noteFlagAngles.x) * t;
      expect(depth(PupilShape.note, arc(G.noteFlagCentre, G.noteFlagRadius, a))).toBeGreaterThanOrEqual(minStroke / 2 - 1e-3);
      const qa = G.questionAngles.x + (G.questionAngles.y - G.questionAngles.x) * t;
      expect(depth(PupilShape.question, arc(G.questionCentre, G.questionRadius, qa))).toBeGreaterThanOrEqual(minStroke / 2 - 1e-3);
      const bar = v2(0, G.exclaimTop.y + G.exclaimBarLength * t);
      expect(depth(PupilShape.exclaim, bar)).toBeGreaterThanOrEqual(minStroke / 2 - 1e-3);
    }
    // Dots: separate, round and big.
    expect(depth(PupilShape.question, G.questionDot)).toBeGreaterThanOrEqual(G.minDot - 1e-4);
    expect(depth(PupilShape.exclaim, G.exclaimDot)).toBeGreaterThanOrEqual(G.minDot - 1e-4);
    const gapQ = G.distance(PupilShape.question, v2(G.questionDot.x, G.questionDot.y - (G.dotRadius + 0.1)));
    const gapE = G.distance(PupilShape.exclaim, v2(G.exclaimDot.x, G.exclaimDot.y - (G.dotRadius + 0.1)));
    expect(gapQ > 0 && gapE > 0, 'the dot stands apart').toBe(true);
    // Star waist ≈ 0.5 (along the diagonal), tips at full reach.
    let r = 0.2;
    while (G.distance(PupilShape.star, v2(r / Math.SQRT2, r / Math.SQRT2)) < 0) r += 0.001;
    expect(r, 'star waist').toBeGreaterThan(0.45);
    expect(r, 'star waist').toBeLessThan(0.56);
    expect(G.distance(PupilShape.star, v2(0.93, 0))).toBeLessThan(0);
    expect(G.distance(PupilShape.star, v2(0, 1.13))).toBeLessThan(0);
  });

  /// |∇d| stays within 0.85…1.05 near every silhouette's boundary, across morph, shape scale and pupil size.
  test.each(shapes)('distanceFieldGradient %s', (shape) => {
    for (const morph of [0, 0.25, 0.5, 0.75, 1]) {
      for (const sc of [v2(1, 1), v2(0.9, 0.9), v2(0.95, 1)]) {
        for (const sizeMul of [0.65, 1, 1.25]) {
          const p = pose();
          p.setEye('left', 'size', p.eye('left', 'size') * sizeMul);
          p.setEye('right', 'size', p.eye('right', 'size') * sizeMul);
          const e = uniforms(frame(p, shape, morph, sc)).left;
          const pr = e.pupilRadii;
          let n = 0, bad = 0;
          for (let y = -pr.y * 1.1; y <= pr.y * 1.1; y += 0.05) {
            for (let x = -pr.x * 1.1; x <= pr.x * 1.1; x += 0.05) {
              const d = field(e, v2(x, y));
              if (Math.abs(d) < 0.12) {
                const hh = 0.004;
                const gx = (field(e, v2(x + hh, y)) - field(e, v2(x - hh, y))) / (2 * hh);
                const gy = (field(e, v2(x, y + hh)) - field(e, v2(x, y - hh))) / (2 * hh);
                const g = Math.sqrt(gx * gx + gy * gy);
                n += 1;
                if (g < 0.85 || g > 1.05) bad += 1;
              }
            }
          }
          const label = `${shapeName(shape)} morph ${morph} scale ${sc.x},${sc.y} size ×${sizeMul}: ${bad}/${n} off`;
          expect(n, label).toBeGreaterThan(20);
          expect(bad, label).toBeLessThanOrEqual(n * 0.03);
        }
      }
    }
  });

  // MARK: Rendered

  /// Shapes are drawn inside the default pupil (never clipped by the sclera) in every review pose, including the pop
  /// at full scale at maximum dilation.
  test.each(shapes)('containedInEveryPose %s', (shape) => {
    const dilated = pose(); dilated.setEye('left', 'size', dilated.eye('left', 'size') * 1.25);
    const startled = pose('Surprise'); startled.setEye('left', 'size', startled.eye('left', 'size') * 0.65);
    const squashed = pose('Happiness'); squashed.setEye('left', 'squash', 0.35);
    const tilt = pose(); tilt.setFace('angle', 12);
    for (const p of [pose(), dilated, startled, squashed, tilt]) {
      const u = uniforms(frame(p, shape, 1, v2(1, 1)));
      const e = u.left;
      let drawn = 0, outside = 0;
      scan(u, 2, (px, s) => {
        if (!(s.pupilDistance < 0)) return;
        drawn += 1;
        const l = EyeSDF.local(e, u, px);
        if (!(EyeSDF.ellipse(v2(l.x - e.pupilCenter.x, l.y - e.pupilCenter.y), e.pupilRadii) < 0.05)) outside += 1;
      });
      expect(outside, `${shapeName(shape)} outside the default pupil`).toBe(0);
      expect(drawn, `${shapeName(shape)} visible`).toBeGreaterThan(30);
    }
  });

  test.each(shapes)('clippedByTheLidsAndHiddenWhenClosed %s', (shape) => {
    // Upper lid well down: no glyph pixel shows above the lid edge.
    const p = pose();
    p.setEye('left', 'upperLidY', 0.42);
    let leaks = 0;
    scan(uniforms(frame(p, shape)), 2, (_, s) => { if (s.dVisible > 0 && s.pupil !== 0) leaks += 1; });
    expect(leaks).toBe(0);
    // Closed: nothing.
    p.setEye('left', 'upperLidY', 0.6);
    p.setEye('left', 'lowerLidY', 0.5);
    let any = 0;
    scan(uniforms(frame(p, shape)), 2, (_, s) => { any = Math.max(any, s.pupil); });
    expect(any, `${shapeName(shape)} visible on a closed eye`).toBe(0);
  });

  /// The glyph moves with the pupil: its centroid keeps the same offset from the pupil centre within 1 px.
  test.each(shapes)('followsGaze %s', (shape) => {
    const centroidOffset = (gaze: V2): V2 => {
      const p = pose();
      p.setEye('left', 'x', gaze.x); p.setEye('left', 'y', gaze.y);
      const u = uniforms(frame(p, shape));
      let sx = 0, sy = 0, wsum = 0;
      scan(u, 1, (px, s) => { if (s.pupil > 0) { sx += px.x * s.pupil; sy += px.y * s.pupil; wsum += s.pupil; } });
      const e = u.left, pc = e.pupilCenter, pl = e.placement, k = u.pixelsPerUnit;
      const cx = e.center.x + (pc.x * pl.z + pc.y * pl.w) * k;
      const cy = e.center.y + (-pc.x * pl.w + pc.y * pl.z) * k;
      const ws = Math.max(wsum, 1);
      return v2(sx / ws - cx, sy / ws - cy);
    };
    const base = centroidOffset(v2(0));
    for (const g of [v2(0.5, 0), v2(-0.5, 0), v2(0, 0.4), v2(0, -0.4)]) {
      const d = centroidOffset(g);
      expect(Math.hypot(d.x - base.x, d.y - base.y), `${shapeName(shape)} centroid drifts at gaze ${g.x},${g.y}`)
        .toBeLessThan(1);
    }
  });

  // MARK: Notch, crescent, mood accent

  function accentAreas(shape: PupilShape, morph: number, moodAccent = true) {
    const style = makeRenderStyle();
    style.shapeMoodAccent = moodAccent;
    const u = uniforms(frame(pose(), shape, morph, v2(1, 1)), style);
    let notch = 0, crescent = 0, accent = 0, notchMax = 0, crescentMax = 0;
    scan(u, 1, (_, s) => {
      notch += s.notch; crescent += s.crescent; accent += s.accent;
      notchMax = Math.max(notchMax, s.notch); crescentMax = Math.max(crescentMax, s.crescent);
    });
    return { notch, crescent, accent, notchMax, crescentMax };
  }

  test.each(shapes)('notchAndCrescentRetractGeometrically %s', (shape) => {
    const base = accentAreas(PupilShape.ellipse, 0);
    expect(base.notch).toBeGreaterThan(50);
    expect(base.crescent).toBeGreaterThan(50);
    const full = accentAreas(shape, 1);
    expect(full.notch, `${shapeName(shape)}: notch still showing`).toBe(0);
    expect(full.crescent, `${shapeName(shape)}: crescent still showing`).toBe(0);
    if (pupilShapeMorphs(shape)) {
      let prevN = Infinity, prevC = Infinity;
      for (const m of [0, 0.25, 0.5, 0.75]) {
        const a = accentAreas(shape, m);
        // Shrinking area, but never translucent: whatever remains is drawn at full coverage.
        expect(a.notch).toBeLessThanOrEqual(prevN + 1);
        expect(a.crescent).toBeLessThanOrEqual(prevC + 1);
        if (a.notch > 5) expect(a.notchMax, `${shapeName(shape)} m ${m}: translucent notch`).toBeGreaterThan(0.99);
        if (a.crescent > 5) expect(a.crescentMax, `${shapeName(shape)} m ${m}: translucent crescent`).toBeGreaterThan(0.99);
        prevN = a.notch; prevC = a.crescent;
      }
    }
  });

  test.each(shapes)('moodAccentOnlyOnStarsAndHearts %s', (shape) => {
    const on = accentAreas(shape, 1, true);
    const off = accentAreas(shape, 1, false);
    expect(off.accent).toBe(0);
    if (pupilShapeHasMoodAccent(shape)) expect(on.accent, `${shapeName(shape)} accent`).toBeGreaterThan(100);
    else expect(on.accent).toBe(0);
  });

  test('irisRingFadesWithTheMorph', () => {
    const style = makeRenderStyle();
    style.irisTint = 1;
    const u = uniforms(frame(pose(), PupilShape.heart, 1, v2(1, 1)), style);
    const colours: V3[] = [];
    scan(u, 3, (_, s) => {
      if (s.pupil > 0.999 && s.crescent === 0 && s.accent === 0 && s.notch === 0) colours.push(s.color);
    });
    const inkish = colours.filter((c) => Math.max(c.x, c.y, c.z) < 0.02);
    expect(colours.length > 0 && inkish.length === colours.length, 'iris ring tint showing on a full heart').toBe(true);
  });

  /// Notes, question and exclamation marks read the right way round in both eyes: the right eye draws the same glyph
  /// as the left (in its own eye frame), never a mirror image.
  test.each([PupilShape.note, PupilShape.question, PupilShape.exclaim])('neverMirroredOnTheRightEye %s', (shape) => {
    const u = uniforms(frame(pose(), shape));
    const l = new EyeSDF.PupilField(u.left, v2(0)), r = new EyeSDF.PupilField(u.right, v2(0));
    let differ = 0, total = 0;
    for (let y = -1.2; y <= 1.2; y += 0.02) {
      for (let x = -1; x <= 1; x += 0.02) {
        const inL = field(u.left, v2(x * l.k.x, y * l.k.y)) < 0;
        const inR = field(u.right, v2(x * r.k.x, y * r.k.y)) < 0;
        if (inL || inR) total += 1;
        if (inL !== inR) differ += 1;
      }
    }
    expect(total, `${shapeName(shape)}: ${differ}/${total} differ`).toBeGreaterThan(200);
    expect(differ, `${shapeName(shape)}: ${differ}/${total} differ`).toBeLessThan(total * 0.02);
    // And the glyph itself is not left-right symmetric, so a mirror would show.
    let asym = 0;
    for (let y = -1.2; y <= 1.2; y += 0.02) {
      for (let x = 0.02; x <= 1; x += 0.02) {
        if ((PupilGlyph.distance(shape, v2(x, y)) < 0) !== (PupilGlyph.distance(shape, v2(-x, y)) < 0)) asym += 1;
      }
    }
    if (shape !== PupilShape.exclaim) expect(asym).toBeGreaterThan(50);
  });

  /// The default pupil (shape id 0, morph 0, scale 1) renders exactly as before the transformations existed.
  test('identityFrameIsUnchanged', () => {
    const u = uniforms(makeFaceFrame(pose()));
    expect(u.left.shape).toEqual(v4(0, 0, 1, 1));
    expect(u.right.shape).toEqual(v4(0, 0, 1, 1));
    const e = u.left;
    const q = v2(0.3, -0.2);
    expect(field(e, q)).toBe(EyeSDF.ellipse(q, e.pupilRadii));
  });
});
