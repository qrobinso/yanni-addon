// The caption bubbles' pure layout and motion math (CaptionMetrics, CaptionMotion), without a DOM.
import { describe, expect, test } from 'vitest';
import { CaptionMetrics, cssLinear } from '../../src/conversation/captions/CaptionBubble';
import { CaptionMotion } from '../../src/conversation/captions/CaptionModel';
import { makeRenderStyle } from '../../src/render/RenderStyle';

// A fake measure: 0.55 em per character, wrapped, 1.2 em lines.
const measure = (text: string, font: number, width: number): number =>
  Math.max(1, Math.ceil(text.length * font * 0.55 / width)) * font * 1.2;

describe('CaptionMetrics', () => {
  const m = new CaptionMetrics(1180, 820, makeRenderStyle(), measure);

  test('sizes follow the screen', () => {
    expect(m.band).toBeCloseTo(820 * 0.3);
    expect(m.fontMax).toBeCloseTo(820 * 0.074);
    expect(m.fontMin).toBeCloseTo(820 * 0.026 < 18 ? 18 : 820 * 0.026);
    expect(m.maxWidth).toBeCloseTo(Math.min(1180 * 0.88, 820 * 1.6));
    expect(m.pillHeight).toBeCloseTo(41);
    expect(m.rim).toBeGreaterThanOrEqual(2);
    expect(m.rim).toBeLessThanOrEqual(9);
  });

  test('short words fit at the largest size, long ones shrink, endless ones overflow at the minimum', () => {
    const short = m.fit('hi', m.youMaxHeight);
    expect(short).toMatchObject({ font: m.fontMax, overflows: false });
    const long = m.fit('word '.repeat(40), m.youMaxHeight);
    expect(long.font).toBeLessThan(m.fontMax);
    expect(long.overflows).toBe(false);
    expect(m.size(long).height).toBeLessThanOrEqual(m.youMaxHeight + 1e-6);
    const endless = m.fit('word '.repeat(400), m.youMaxHeight);
    expect(endless.font).toBeCloseTo(m.fontMin);
    expect(endless.overflows).toBe(true);
    expect(m.size(endless).height).toBeCloseTo(m.youMaxHeight);   // capped at the room
  });

  test("Yanni's bubble gets 25 % of the height above the pill", () => {
    expect(m.replyMaxHeight(true)).toBeCloseTo(820 * 0.25 - m.gap - m.tail);
    expect(m.replyMaxHeight(false)).toBeCloseTo(m.youMaxHeight);
  });
});

describe('CaptionMotion', () => {
  test('the spring starts at rest, overshoots and settles at 1', () => {
    const s = (t: number) => CaptionMotion.spring(t, CaptionMotion.popY.response, CaptionMotion.popY.damping);
    expect(s(0)).toBe(0);
    let peak = 0;
    for (let t = 0; t < 2; t += 0.01) peak = Math.max(peak, s(t));
    expect(peak).toBeGreaterThan(1.2);   // damping 0.32: lots of bounce
    expect(s(3)).toBeCloseTo(1, 3);
  });

  test('removal samples end at 1', () => {
    const { duration, values } = CaptionMotion.samples(0.22, 0.8);
    expect(duration).toBeGreaterThan(0.1);
    expect(duration).toBeLessThan(1);
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(1);
  });

  test('linear colours become sRGB CSS', () => {
    expect(cssLinear({ x: 1, y: 0, z: 0.2159 })).toBe('rgb(255 0 128)');
  });
});
