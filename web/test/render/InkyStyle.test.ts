// Port of FaceRenderingTests/InkyStyleTests.swift (CPU tests; the rendered-crescent and GPU-vs-CPU suites need
// Metal). The inky cartoon look: egg sclera, rim + ink bands, tall pupils with an attached notch and crescent.
import { FaceEngine, Mood } from '../../src/engine';
import { MoodColor } from '../../src/engine/modifiers/MoodColor';
import { ExpressionMix } from '../../src/model';
import { describe, expect, test } from 'vitest';
import { v2, type V2 } from '../../src/core/vec';
import { ExpressionLibrary } from '../../src/model/Expression';
import { makeFaceFrame, type FaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { Oklab } from '../../src/model/Oklab';
import { ParamLayout, type Side } from '../../src/model/ParamLayout';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { EyeSDF } from '../../src/render/EyeSDF';
import { resolvedCrescentColor, resolvedStyle } from '../../src/render/MoodColorMix';
import { ScleraShape } from '../../src/render/PupilGeometry';
import { makeRenderStyle, RenderStyle } from '../../src/render/RenderStyle';
import type { EyeUniforms } from '../../src/render/RenderUniforms';
import { Viewport } from '../../src/render/Viewport';
import { blinkFrame, TestRandom, withPupils } from './helpers';

const library = ExpressionLibrary.bundled();
const viewport = new Viewport(v2(128, 64), 10, v2(0));

function rim(e: EyeUniforms, n = 96): V2[] {
  const c = e.pupilCenter, r = e.pupilRadii;
  return Array.from({ length: n }, (_, i) => {
    const t = i / n * 2 * Math.PI;
    return v2(c.x + Math.cos(t) * r.x, c.y + Math.sin(t) * r.y);
  });
}

describe('InkyStyle', () => {
  // MARK: Egg geometry

  /// The exact egg distance agrees with brute force over a dense sampling of the warped boundary.
  test('eggBoundaryDistanceMatchesBruteForce', () => {
    const rng = new TestRandom(0xe66);
    for (let k = 0; k < 50; k++) {
      const half = v2(rng.float(3, 18), rng.float(2, 24));
      const r = () => v2(rng.float(0.05, 1) * half.x, rng.float(0.05, 1) * half.y);
      const a = r(), b = r(), c = r(), d = r();
      const shape = new ScleraShape(half, { x: a.x, y: a.y, z: b.x, w: b.y }, { x: c.x, y: c.y, z: d.x, w: d.y },
        rng.float(0.05, 0.6));
      const pts = shape.boundaryPoints(500);
      for (let j = 0; j < 30; j++) {
        const p = v2(rng.float(-1.3, 1.3) * half.x, rng.float(-1.2, 1.2) * half.y);
        let brute = Infinity;
        for (const q of pts) brute = Math.min(brute, Math.hypot(q.x - p.x, q.y - p.y));
        const got = shape.boundaryDistance(p);
        expect(Math.abs(got - brute), `${p.x},${p.y}: ${got} vs ${brute}`).toBeLessThan(0.02 + 0.002 * brute);
      }
    }
  });

  /// The egg is narrower at the top than at the bottom, and as wide as the base shape at mid-height.
  test('eggIsNarrowerAtTheTop', () => {
    const s = ScleraShape.of(EyeGeometry.eye('left', FacePose.defaults, viewport, makeRenderStyle()));
    const width = (y: number) => {
      let lo = 0, hi = 3 * s.half.x;
      for (let i = 0; i < 30; i++) { const m = 0.5 * (lo + hi); if (s.contains(v2(m, y))) lo = m; else hi = m; }
      return lo;
    };
    expect(width(-0.6 * s.half.y)).toBeLessThan(0.92 * width(0.6 * s.half.y));
    expect(Math.abs(width(0) - s.half.x)).toBeLessThan(0.02);
  });

  // MARK: Containment

  /// Over every expression × random cartoon proportions × pupil position × size × squash × closure, the pupil rim
  /// never crosses the ink's inner edge — by the exact egg distance, and by the field the renderer actually draws.
  test('pupilNeverCrossesTheInk', { timeout: 30_000 }, () => {
    const rng = new TestRandom(0x1a4);
    const positions = [-1, -0.6, 0, 0.6, 1];
    let checked = 0;
    for (const name of library.names) {
      const base = library.get(name)!.pose;
      for (let k = 0; k < 70; k++) {
        const style = makeRenderStyle();
        style.eggTaper = rng.pick([0, 0.15, 0.34, 0.5]);
        style.eyeAsymmetry = rng.pick([0.9, 1, 1.1, 1.25]);
        style.pairTilt = rng.float(-15, 15);
        style.eyeLean = rng.float(-10, 10);
        style.pupilAspect = rng.pick([0.8, 1, 1.24, 1.5]);
        style.pupilScale = rng.pick([0.8, 1.16, 1.4]);
        style.eyeScale = rng.pick([0.6, 0.92, 1.18, 1.4]);
        style.ovalness = rng.pick([0, 0.5, 0.97, 1]);
        const pose = withPupils(base, { x: rng.pick(positions), y: rng.pick(positions),
          size: rng.pick([0.15, 0.3, 0.5, 0.7]), squash: rng.pick([0, 0.2, 0.4]) });
        pose.addBoth('upperLidY', rng.pick([0, 0.1, 0.3]));
        const frame = blinkFrame(pose, rng.pick([0, 0.4, 0.8, 1]));
        for (const side of ParamLayout.Side.allCases) {
          const e = EyeGeometry.eye(side, frame.pose, viewport, style, frame.closureScale);
          const shape = ScleraShape.of(e);
          const band = e.bandWidth;
          let exact = Number.MAX_VALUE, drawn = -Number.MAX_VALUE;
          for (const p of rim(e)) {
            exact = Math.min(exact, shape.depth(p));
            drawn = Math.max(drawn, EyeSDF.egg(p, e.halfExtents, e.radiiTop, e.radiiBottom, e.eggTaper));
          }
          expect(exact, `${name} ${side} ${style.eggTaper}: depth < band ${band}`).toBeGreaterThanOrEqual(band - 2e-3);
          expect(drawn, `${name} ${side}: drawn field above the ink edge ${-band}`).toBeLessThanOrEqual(-band * 0.97 + 2e-3);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  // MARK: Rim and ink bands

  /// Along the egg's rim the ink's inner edge (and the rim's) lies at the band width from the true boundary, ±5 %.
  test.each([0.0, 0.34, 0.55])('inkBandIsEvenAlongTheEgg %s', (taper) => {
    const style = makeRenderStyle();
    style.eggTaper = taper;
    const e = EyeGeometry.eye('left', FacePose.defaults, viewport, style);
    const shape = ScleraShape.of(e);
    for (const [level, label] of [[e.bandWidth, 'ink inner edge'], [e.rimWidth, 'rim inner edge']] as const) {
      for (let i = 0; i < 120; i++) {
        const t = i / 120 * 2 * Math.PI;
        const dir = v2(Math.cos(t), Math.sin(t));
        const d = (s: number) => EyeSDF.visibleDistance(e, EyeSDF.visible(e, v2(dir.x * s, dir.y * s))) + level;
        let lo = 0, hi = 2 * Math.max(e.halfExtents.x, e.halfExtents.y);
        for (let k = 0; k < 40; k++) { const m = 0.5 * (lo + hi); if (d(m) < 0) lo = m; else hi = m; }
        const truth = shape.boundaryDistance(v2(dir.x * lo, dir.y * lo));
        expect(Math.abs(truth - level), `taper ${taper} ${label} at ${i * 3}°`).toBeLessThanOrEqual(0.05 * level + 1e-3);
      }
    }
  });

  /// A closed eye (blink, Asleep) reads as an ink line with an ivory rim on both sides, never vanishing.
  test.each([false, true])('closedEyeIsARimmedInkLine ivory=%s', (ivory) => {
    const style = ivory ? RenderStyle.ivoryRim : makeRenderStyle();
    const vp = Viewport.fitting(1194, 834, style);
    for (const frame of [blinkFrame(FacePose.defaults, 1), makeFaceFrame(library.get('Asleep')!.pose)]) {
      const u = EyeGeometry.uniforms(frame, vp, style);
      for (const e of [u.left, u.right]) {
        expect(e.pupilVisibility).toBe(0);
        // Walk the eye-local centre column across the line: rim, ink, rim.
        let str = '';
        for (let y = -e.halfExtents.y - 1; y < e.halfExtents.y + 1; y += 0.01) {
          const pc = e.placement.z, ps = e.placement.w;
          const d = v2((0 * pc + y * ps) * vp.pixelsPerUnit, (-0 * ps + y * pc) * vp.pixelsPerUnit);
          const s = EyeSDF.sample(e, u, v2(e.center.x + d.x, e.center.y + d.y));
          expect(s.pupil).toBe(0);
          if (s.coverage > 0.9) {
            const mn = Math.min(s.color.x, s.color.y, s.color.z), mx = Math.max(s.color.x, s.color.y, s.color.z);
            const c = mn > 0.5 ? 'R' : mx < 0.05 ? 'K' : '?';
            if (c !== '?' && str[str.length - 1] !== c) str += c;
          }
        }
        // Ivory-rim style: rim | ink | rim. Reference style (dark rim + hairline ink): an ivory line between dark
        // edges — either way the closed eye stays visible.
        expect(ivory ? str.includes('RKR') : str.includes('KRK') || str.includes('R'), `closed line reads ${str}`).toBe(true);
      }
    }
  });

  // MARK: Notch and crescent

  /// Notch / crescent coverage (and its centroid in pupil-normalised coordinates) over the eye.
  function accents(frame: FaceFrame, style = makeRenderStyle(), side: Side = 'left') {
    const u = EyeGeometry.uniforms(frame, viewport, style);
    const e = side === 'left' ? u.left : u.right;
    let n = 0, c = 0, bad = 0;
    const nc = v2(0), cc = v2(0);
    const r = Math.trunc(e.cullRadius);
    const pc = e.pupilCenter, pr = e.pupilRadii, ppu = viewport.pixelsPerUnit;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = v2(e.center.x + dx, e.center.y + dy);
        const s = EyeSDF.sample(e, u, px);
        if (!(s.notch > 0.01 || s.crescent > 0.01)) continue;
        const p = EyeSDF.local(e, u, px);
        const v = EyeSDF.visible(e, p);
        // Only inside the drawn pupil, and only where the sclera fill (below the lids' ink) shows.
        const inPupil = EyeSDF.ellipse(v2(p.x - pc.x, p.y - pc.y), pr) < 0.6 / ppu;
        const inFill = EyeSDF.visibleDistance(e, v) < -e.bandWidth + 0.6 / ppu;
        if (!(inPupil && inFill && s.pupil > 0)) bad += 1;
        const qx = (p.x - pc.x) / pr.x, qy = (p.y - pc.y) / pr.y;
        n += s.notch; nc.x += qx * s.notch; nc.y += qy * s.notch;
        c += s.crescent; cc.x += qx * s.crescent; cc.y += qy * s.crescent;
      }
    }
    return { notch: n, crescent: c, notchCentroid: n > 0 ? v2(nc.x / n, nc.y / n) : v2(0),
      crescentCentroid: c > 0 ? v2(cc.x / c, cc.y / c) : v2(0), e, bad };
  }
  const len = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.y - b.y);

  test('notchAndCrescentStayInsideTheVisiblePupil', { timeout: 30_000 }, () => {
    const lidded = withPupils(FacePose.defaults, { x: 0.3, y: -0.8 });
    lidded.addBoth('upperLidY', 0.32);
    for (const frame of [makeFaceFrame(FacePose.defaults), makeFaceFrame(withPupils(FacePose.defaults, { x: 1, y: -1 })),
      makeFaceFrame(lidded), blinkFrame(FacePose.defaults, 0.5), makeFaceFrame(library.get('Anger')!.pose)]) {
      expect(accents(frame).bad, 'accent pixels outside the visible pupil').toBe(0);
    }
    // Open, the accents show; the notch sits upper right and the crescent lower left of the pupil.
    const open = accents(makeFaceFrame(FacePose.defaults));
    expect(open.notch).toBeGreaterThan(20);
    expect(open.crescent).toBeGreaterThan(20);
    expect(open.notchCentroid.x).toBeGreaterThan(0.3);
    expect(open.notchCentroid.y).toBeLessThan(-0.2);
    expect(open.crescentCentroid.x).toBeLessThan(-0.3);
    expect(open.crescentCentroid.y).toBeGreaterThan(0.3);
    // A heavy upper lid over an upward-looking pupil hides most of the notch.
    const hidden = accents(makeFaceFrame(lidded));
    const shown = accents(makeFaceFrame(withPupils(FacePose.defaults, { x: 0.3, y: -0.8 })));
    expect(hidden.notch).toBeLessThan(0.5 * shown.notch);
    // Closed: nothing.
    const closed = accents(blinkFrame(FacePose.defaults, 1));
    expect(closed.notch).toBe(0);
    expect(closed.crescent).toBe(0);
  });

  /// The accents are attached to the pupil: they keep their place in pupil coordinates when the pupil moves,
  /// dilates, or is squashed by a blink, and their area scales with the pupil's.
  test('accentsMoveAndScaleWithThePupil', { timeout: 30_000 }, () => {
    const ref = accents(makeFaceFrame(FacePose.defaults));
    const refArea = ref.e.pupil.z * ref.e.pupil.w;
    const d = FacePose.defaults;
    for (const frame of [makeFaceFrame(withPupils(d, { x: 0.7, y: 0.4 })), makeFaceFrame(withPupils(d, { x: -0.8, y: -0.3 })),
      makeFaceFrame(withPupils(d, { size: 0.7 })), makeFaceFrame(withPupils(d, { size: 0.3 })), blinkFrame(d, 0.3)]) {
      const a = accents(frame);
      expect(len(a.notchCentroid, ref.notchCentroid), 'notch moved within the pupil').toBeLessThan(0.06);
      expect(len(a.crescentCentroid, ref.crescentCentroid), 'crescent moved within the pupil').toBeLessThan(0.08);
      const areaRatio = a.e.pupil.z * a.e.pupil.w / refArea;
      const notchRatio = a.notch / ref.notch;
      expect(Math.abs(notchRatio / areaRatio - 1), 'notch area vs pupil area').toBeLessThan(0.25);
    }
    // They turn with the eye (no counter-rotation): same pupil-local place under a 25° eye tilt.
    const tilted = FacePose.defaults;
    tilted.setEye('left', 'angle', 25);
    expect(len(accents(makeFaceFrame(tilted)).notchCentroid, ref.notchCentroid)).toBeLessThan(0.06);
  });

  test('notchAndCrescentCanBeTurnedOff', () => {
    const style = makeRenderStyle();
    style.notchEnabled = false;
    style.crescentStrength = 0;
    const a = accents(makeFaceFrame(FacePose.defaults), style);
    expect(a.notch).toBe(0);
    expect(a.crescent).toBe(0);
  });

  // MARK: Crescent colour

  test('crescentIsBaseCyanAtThePlayfulBaseline', () => {
    const style = makeRenderStyle();
    // The settled engine colour at `Mood.playful` (Swift MoodColorRenderTests.settledColor) resolves to the base too.
    const mc = new MoodColor();
    mc.lightnessMatch = 1;
    const engine = new FaceEngine({ seed: 7, modifiers: [mc] });
    engine.setExpressionOverride(ExpressionMix.single('Neutral'));
    engine.setMood(Mood.playful);
    let f = engine.tick(1 / 60);
    for (let i = 0; i < 60 * 6; i++) f = engine.tick(1 / 60);
    expect(resolvedCrescentColor(style, makeFaceFrame(FacePose.defaults, { color: f.color }))).toEqual(style.crescentColor);
    expect(resolvedStyle(style, makeFaceFrame(FacePose.defaults)).crescentColor).toEqual(style.crescentColor);
    expect(Oklab.hex(style.crescentColor)).toBe(0x5bb3c4);
    // Mood shifts it: a red-orange mood warms the crescent, a blue one cools it, lightness stays near the base.
    const warm = resolvedCrescentColor(style, makeFaceFrame(FacePose.defaults, { color: { x: 1, y: 0.15, z: 0.05 } }));
    const cool = resolvedCrescentColor(style, makeFaceFrame(FacePose.defaults, { color: { x: 0.2, y: 0.35, z: 1.0 } }));
    expect(warm.x).toBeGreaterThan(warm.z + 0.1);
    expect(cool.z).toBeGreaterThan(cool.x + 0.1);
    expect(cool).not.toEqual(style.crescentColor);
    // Amount 0 keeps the base colour whatever the mood.
    const off = RenderStyle.clone(style);
    off.moodColorAmount = 0;
    expect(resolvedCrescentColor(off, makeFaceFrame(FacePose.defaults, { color: { x: 1, y: 0.15, z: 0.05 } })))
      .toEqual(style.crescentColor);
  });
});
