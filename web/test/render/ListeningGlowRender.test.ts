// Port of FaceRenderingTests/ListeningGlowRenderTests.swift: the CPU tests (listening glow design §8): off leaves the
// uniforms untouched, the luminance step bound, the glow kept in the bottom band. The GPU tests need Metal.
import { describe, expect, test } from 'vitest';
import { v2, v3, v4, type V3 } from '../../src/core/vec';
import { FaceFrame, makeFaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { Oklab } from '../../src/model/Oklab';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { EyeSDF } from '../../src/render/EyeSDF';
import { makeRenderStyle, type RenderStyle } from '../../src/render/RenderStyle';
import { FrameUniforms, frameUniformFloats, packFrameUniforms } from '../../src/render/RenderUniforms';
import { Viewport } from '../../src/render/Viewport';
import { ListeningGlow } from '../../src/engine/ListeningGlow';
import { MoodBackground, MoodBackgroundConfig } from '../../src/engine/MoodBackground';
import { MoodPalette } from '../../src/engine/MoodPalette';

const peakHeight = ListeningGlow.peakHeight;

function colourStyle(): RenderStyle {
  const s = makeRenderStyle();
  s.backgroundVignette = 0.15;
  s.backgroundVignetteInner = 0.45;
  return s;
}

/// A frame with the glow at `level` over `bg` (undefined: black), its colours derived as the engine does.
function frame(level: number, bg?: V3, motion = 1): FaceFrame {
  const f = makeFaceFrame(FacePose.defaults, { brightness: 0.85, backgroundColor: bg ?? v3(0),
    backgroundStrength: bg === undefined ? 0 : 1, backgroundBrightness: 0.85 });
  const [a, b] = ListeningGlow.colours(bg === undefined ? v3(0) : Oklab.fromLinear(bg), bg === undefined ? 0 : 1,
    Oklab.fromLinear(FaceFrame.defaultColor));
  const c = (x: V3): V3 => { const l = Oklab.toLinear(x), k = (v: number) => Math.min(Math.max(v, 0), 1); return v3(k(l.x), k(l.y), k(l.z)); };
  f.glowLevel = level;
  f.glowHeight = ListeningGlow.peakHeight * Math.min(level, 1.2);
  f.glowMotion = motion;
  f.glowColor = c(a);
  f.glowColor2 = c(b);
  f.glowPhase = v4(0.4, 1.1, 2.3, 4.0);
  return f;
}

const anchorColours: V3[] = MoodPalette.background.anchors.map((a) =>
  Oklab.toLinearClamped(new MoodBackground().colourLab(a.pad, new MoodBackgroundConfig()), v3(0)));

const packed = (u: FrameUniforms) => packFrameUniforms(u, new Float32Array(frameUniformFloats));
const code = (c: number) => Math.round(EyeSDF.srgbEncode(c) * 255);

describe('ListeningGlowRender', () => {
  test('offLeavesTheUniformsUntouched', () => {
    const off = frame(0);
    off.glowHeight = 0.2;
    const vp = Viewport.fitting(400, 300, makeRenderStyle());
    const u = EyeGeometry.uniforms(off, vp, makeRenderStyle());
    const plain = EyeGeometry.uniforms(makeFaceFrame(FacePose.defaults, { brightness: 0.85, backgroundBrightness: 0.85 }),
      vp, makeRenderStyle());
    expect(Array.from(packed(u))).toEqual(Array.from(packed(plain)));
    expect([u.glow.x, u.glow.y, u.glow.z, u.glow.w]).toEqual([0, 0, 0, 0]);
  });

  test('luminanceStepIsBoundedOverBlackAndEveryMoodColour', () => {
    const w = 800, h = 600;
    for (const bg of [undefined, ...anchorColours]) {
      for (const level of [0.5, 1, 1.3]) {
        const style = bg === undefined ? makeRenderStyle() : colourStyle();
        const u = EyeGeometry.uniforms(frame(level, bg), Viewport.fitting(w, h, style), style);
        expect(u.glow.x).toBeGreaterThan(0);
        let worst = 0;
        for (let xi = 0; xi < 80; xi++) {
          for (const v of [0.5, 4, 20, 60]) {
            const p = v2(xi * 10 + 5, h - v);
            const base = EyeSDF.background(u, p);
            const lit = EyeSDF.glow(u, p, base);
            worst = Math.max(worst, Math.abs(EyeGeometry.luminance(lit) - EyeGeometry.luminance(base)));
          }
        }
        expect(worst, `ΔY ${worst}`).toBeLessThanOrEqual(EyeGeometry.glowMaxLuminanceStep + 1e-3);
      }
    }
  });

  test('theGlowStaysInTheBottomBand', () => {
    const w = 800, h = 600;
    // At level 1 nothing visible above 55 % of the height; swollen by the loudest voice (level 1.3, crests raised),
    // nothing above 70 %.
    for (const [level, top] of [[1, 0.55], [1.3, 0.7]]) {
      const f = frame(level);
      f.glowHeight = peakHeight * level;
      if (level > 1) f.glowRipple = 1;
      const u = EyeGeometry.uniforms(f, Viewport.fitting(w, h, makeRenderStyle()), makeRenderStyle());
      for (let xi = 0; xi < 160; xi++) {
        const p = v2(xi * 5 + 2.5, h * (1 - top));
        const base = EyeSDF.background(u, p);
        // Nothing visible: the same 8-bit code value (the soft body's far tail is far below one step).
        const lit = EyeSDF.glow(u, p, base);
        expect([code(lit.x), code(lit.y), code(lit.z)]).toEqual([code(base.x), code(base.y), code(base.z)]);
      }
    }
  });
});
