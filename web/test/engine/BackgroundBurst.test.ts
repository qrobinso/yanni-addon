// Port of Tests/FaceEngineTests/BackgroundBurstTests.swift.
import { describe, expect, test } from 'vitest';
import { v3, type V3 } from '../../src/core/vec';
import { Oklab } from '../../src/model';
import { BackgroundBurst, BackgroundBurstStyle, FaceCommand, MoodPalette, type OneShotKind } from '../../src/engine';
import * as T from './BackgroundBurstHarness';

/// One-shot colour bursts on the mood background (mood background design §4 "Colour bursts", §7): envelope and
/// return to exactly the mood colour, the mood spring untouched, the per-kind table, gating, rate limiting and
/// merging, the luminance-step bound, band / chroma / readability, Reduce Motion, frame-rate independence and cost.
describe('BackgroundBurst', () => {
  // MARK: Envelope

  test('laughSwellsHoldsAndReturnsToExactlyTheMoodColour', () => {
    const e = T.settled();
    e.playBackgroundBurst('laugh');
    const levels: number[] = [];
    const d = T.run(e, 2, (_, b) => { levels.push(b.burst.level); });
    const peakIndex = T.argMax(levels);
    const peakT = (peakIndex + 1) * T.fdt;
    expect(peakT >= 0.12 && peakT <= 0.32, `peak at ${peakT} s`).toBe(true);
    expect(T.maxOf(d), 'a laugh is clearly visible').toBeGreaterThan(0.05);
    // Rises monotonically, then falls monotonically (no overshoot, no flicker).
    for (let i = 1; i <= peakIndex; i++) expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1] - 1e-6);
    for (let i = peakIndex + 1; i < levels.length; i++) expect(levels[i]).toBeLessThanOrEqual(levels[i - 1] + 1e-6);
    expect(T.maxOf(levels)).toBeLessThanOrEqual(BackgroundBurstStyle.standard('laugh').strength + 1e-5);
    // Gone after attack + hold + release (≈ 1.26 s) and exactly the mood colour again.
    const end = Math.round((BackgroundBurst.attack + BackgroundBurst.defaultHold + BackgroundBurst.release) / T.fdt) + 2;
    expect(levels[end]).toBe(0);
    expect(levels[Math.trunc(1.0 / T.dt)], 'still releasing at 1 s').toBeGreaterThan(0);
    for (let i = end; i < d.length; i++) expect(d[i], `frame ${i}`).toBeLessThan(1e-5);
    expect(T.bg(e).burst.activeKind).toBeNull();
  });

  test('noFrameToFrameJumps', () => {
    const e = T.settled();
    let last: V3 | null = null;
    const steps: number[] = [];
    const kinds: OneShotKind[] = ['laugh', 'heartEyes', 'bigSurprise', 'shakeNoBig'];
    for (let i = 0; i < 180; i++) {
      if (i % 12 === 0) e.playBackgroundBurst(kinds[Math.trunc(i / 12) % 4]);
      const l = T.lab(e.tick(T.dt));
      if (last !== null) steps.push(T.dist(last, l));
      last = l;
    }
    // The fastest a burst may move: its longest path (a hue arc of up to ~180° at chroma ≲ 0.16, ≈ 0.3 in Oklab)
    // at smootherstep's peak slope (1.875 / attack) over one 60 fps frame ≈ 0.07. Above that is a jump.
    const worst = T.maxOf(steps);
    // And no isolated spikes: a step never stands far above both neighbours (a discontinuity would).
    for (let i = 1; i < steps.length - 1; i++) {
      if (!(steps[i] > 0.01)) continue;
      expect(steps[i], `spike at frame ${i}: ${steps.slice(i - 1, i + 2)}`)
        .toBeLessThanOrEqual(1.6 * Math.max(steps[i - 1], steps[i + 1]));
    }
    expect(worst, 'largest per-frame step ΔE').toBeLessThan(0.08);
  });

  test('theMoodSpringNeverSeesABurst', () => {
    const a = T.settled();
    const b = T.settled((c) => { c.colourBursts = false; });
    a.setMood({ pleasure: -0.6, arousal: 0.7, dominance: -0.6 });
    b.setMood({ pleasure: -0.6, arousal: 0.7, dominance: -0.6 });
    let shown = false;
    for (let i = 0; i < 240; i++) {
      if (i % 30 === 0) { a.playBackgroundBurst('laugh'); b.playBackgroundBurst('laugh'); }
      const fa = a.tick(T.dt), fb = b.tick(T.dt);
      expect(T.bg(a).currentLab).toEqual(T.bg(b).currentLab);
      expect(T.bg(a).targetLab).toEqual(T.bg(b).targetLab);
      if (T.dist(T.lab(fa), T.lab(fb)) > 0.02) shown = true;
    }
    expect(shown, 'the burst showed on top').toBe(true);
    expect(T.bg(b).burst.lastOnsetTime, 'bursts off: none started').toBe(-Infinity);
  });

  test('aOneShotsBurstPeaksOnItsFirstAccent', () => {
    const e = T.engine(true);
    T.run(e, 2);
    e.send(FaceCommand.playOneShot('laugh'));
    const levels: number[] = [];
    T.run(e, 1.5, (_, b) => { levels.push(b.burst.level); });
    const peak = (T.argMax(levels) + 1) * T.fdt;
    expect(T.maxOf(levels)).toBeGreaterThan(0.3);
    // laugh's first accent is at 0.21 s (± per-trigger jitter); the swell peaks on it.
    expect(peak > 0.14 && peak < 0.5, `peak at ${peak} s`).toBe(true);
  });

  // MARK: Hue arc

  test('theArcKeepsColourAndNeverFlips', () => {
    const lavender = Oklab.fromLinear(Oklab.linear(0xb78bbe));
    const marigold = Oklab.fromLinear(Oklab.linear(0xffb13b));
    const dir = BackgroundBurst.hueDelta(lavender, marigold, 0) < 0 ? -1 : 1;
    expect(BackgroundBurst.mixArc(lavender, marigold, 0, dir), 'level 0 is exactly the mood').toEqual(lavender);
    expect(BackgroundBurst.mixArc(lavender, marigold, 1, dir)).toEqual(marigold);
    // No grey midpoint: the chroma stays between the ends' (the straight Oklab mix would sag well below).
    const mid = BackgroundBurst.mixArc(lavender, marigold, 0.5, dir);
    const lo = Math.min(T.chroma(lavender), T.chroma(marigold));
    expect(T.chroma(mid)).toBeGreaterThanOrEqual(lo - 1e-4);
    const straight = v3((lavender.x + marigold.x) / 2, (lavender.y + marigold.y) / 2, (lavender.z + marigold.z) / 2);
    expect(T.chroma(straight)).toBeLessThan(T.chroma(mid) - 0.02);
    // A fixed direction holds even when the shortest way round switches sides (just past 180°).
    const a = v3(0.75, 0.1, 0), b1 = v3(0.75, -0.1, 0.004), b2 = v3(0.75, -0.1, -0.004);
    const d1 = BackgroundBurst.hueDelta(a, b1, 1);
    const d2 = BackgroundBurst.hueDelta(a, b2, 1);
    expect(d1 > 0 && d2 > 0 && Math.abs(d1 - d2) < 0.1, `${d1} ${d2}`).toBe(true);
  });

  test('layeredBurstsStayWithinTheLuminanceBound', () => {
    const kinds: OneShotKind[] = ['laugh', 'heartEyes', 'bigSurprise', 'curiousTilt'];
    for (const anchor of MoodPalette.background.anchors) {
      const e = T.engine();
      e.setMood({ pleasure: anchor.pad.x, arousal: anchor.pad.y, dominance: anchor.pad.z });
      T.run(e, 8);
      let worst = 0;
      for (let i = 0; i < 150; i++) {
        if (i % 22 === 0) e.playBackgroundBurst(kinds[Math.trunc(i / 22) % 4]);
        const f = e.tick(T.dt);
        const dy = Math.abs(BackgroundBurst.luminance(T.lab(f)) - BackgroundBurst.luminance(T.bg(e).currentLab));
        worst = Math.max(worst, dy);
      }
      expect(worst, `${anchor.name}: ΔY`).toBeLessThanOrEqual(BackgroundBurst.maxLuminanceStep + 0.005);
    }
  });
});
