// Port of FaceRenderingTests/MoodColorRenderTests.swift (CPU tests only; the renderer and snapshot tests need a GPU).
import { describe, expect, test } from 'vitest';
import { makeFaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { Oklab } from '../../src/model/Oklab';
import { resolvedEyeColor, resolvedStyle } from '../../src/render/MoodColorMix';
import { makeRenderStyle } from '../../src/render/RenderStyle';

describe('MoodColorRender', () => {
  test('defaultFrameColourMatchesDefaultStyleColour', () => {
    expect(makeFaceFrame(FacePose.defaults).color).toEqual(makeRenderStyle().color);
  });

  test('moodColorAmountZeroUsesStyleColour', () => {
    const style = makeRenderStyle();
    style.color = { x: 0.2, y: 0.4, z: 0.9 };
    style.moodColorAmount = 0;
    const frame = makeFaceFrame(FacePose.defaults, { color: { x: 1, y: 0.1, z: 0.05 } });
    expect(resolvedEyeColor(style, frame)).toEqual(style.color);
    expect(resolvedStyle(style, frame).color).toEqual(style.color);
    style.moodColorAmount = 1;
    expect(resolvedEyeColor(style, frame)).toEqual(frame.color);
  });

  test('partialAmountKeepsStyleLightness', () => {
    const style = makeRenderStyle();
    style.moodColorAmount = 0.5;
    const L = Oklab.fromLinear(style.color).x;
    const frame = makeFaceFrame(FacePose.defaults, { color: Oklab.toLinear({ x: L, y: 0.05, z: 0.04 }) });
    const c = resolvedEyeColor(style, frame);
    expect(Math.abs(Oklab.fromLinear(c).x - L)).toBeLessThan(0.01);
    expect(c).not.toEqual(style.color);
    expect(c).not.toEqual(frame.color);
  });
});
