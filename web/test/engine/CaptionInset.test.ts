// Port of Tests/FaceEngineTests/CaptionInsetTests.swift.
import { describe, expect, test } from 'vitest';
import { CaptionInset } from '../../src/engine/modifiers/CaptionInset';
import { FaceEngine } from '../../src/engine';
import { FaceFrame } from '../../src/model';

/// The caption band's spring (caption bubbles design §5): in ≈ 0.35 s with a small overshoot, out ≈ 0.5 s without
/// one, Reduce Motion never overshoots, bounds, and an idle engine carries exactly 0.
function engine(): FaceEngine {
  const e = new FaceEngine({ seed: 3, modifiers: [new CaptionInset()] });
  for (let i = 0; i < 10; i++) e.tick(1 / 60);
  return e;
}

/// Runs `seconds` at 60 Hz; the inset per frame.
const run = (e: FaceEngine, seconds: number): number[] =>
  Array.from({ length: Math.trunc(seconds * 60) }, () => e.tick(1 / 60).captionInset);

const pairs = (v: number[]): [number, number][] => v.slice(1).map((b, i) => [v[i], b]);

describe('CaptionInset', () => {
  test('zeroUntilAsked', () => {
    const e = engine();
    expect(run(e, 1).every((x) => x === 0)).toBe(true);
  });

  test('springsInQuicklyWithASmallOvershootAndSettles', () => {
    const e = engine();
    e.setCaptionInset(CaptionInset.band);
    const v = run(e, 1.5);
    const band = CaptionInset.band;
    const peak = Math.max(...v);
    const peakAt = v.indexOf(peak) / 60;
    expect(peakAt > 0.25 && peakAt < 0.45, `peak at ${peakAt} s`).toBe(true);
    expect(peak > band && peak < band * 1.06, `a small overshoot (${peak})`).toBe(true);
    // Most of the way there by 0.25 s, settled exactly by the end.
    expect(v[Math.trunc(0.25 * 60)]).toBeGreaterThan(band * 0.9);
    expect(v[v.length - 1]).toBe(band);
    expect(v.every((x) => x >= 0 && x <= FaceFrame.maxCaptionInset)).toBe(true);
  });

  test('springsOutWithoutBouncingInAboutHalfASecond', () => {
    const e = engine();
    e.setCaptionInset(CaptionInset.band);
    run(e, 1.5);
    e.setCaptionInset(0);
    const v = run(e, 1.5);
    expect(v[Math.trunc(0.5 * 60)], `${v[30]} at 0.5 s`).toBeLessThan(CaptionInset.band * 0.06);
    expect(v[Math.trunc(0.2 * 60)], `no snap (${v[12]} at 0.2 s)`).toBeGreaterThan(CaptionInset.band * 0.15);
    expect(pairs(v).every(([a, b]) => b <= a), 'monotonic: no bounce').toBe(true);
    expect(v[v.length - 1]).toBe(0);
  });

  test('reduceMotionNeverOvershoots', () => {
    const e = engine();
    e.setCaptionInset(CaptionInset.band, true);
    const v = run(e, 2);
    expect(v.every((x) => x <= CaptionInset.band)).toBe(true);
    expect(pairs(v).every(([a, b]) => b >= a)).toBe(true);
    expect(v[v.length - 1]).toBeGreaterThan(CaptionInset.band * 0.999);
  });

  test('boundsAndBadInput', () => {
    const e = engine();
    e.setCaptionInset(5);
    expect(run(e, 2).every((x) => x <= FaceFrame.maxCaptionInset)).toBe(true);
    e.setCaptionInset(NaN);
    expect(run(e, 2).at(-1)).toBe(0);
    e.setCaptionInset(-1);
    expect(run(e, 0.5).every((x) => x === 0)).toBe(true);
  });
});
