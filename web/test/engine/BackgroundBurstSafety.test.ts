// Port of Tests/FaceEngineTests/BackgroundBurstSafetyTests.swift.
import { describe, expect, test } from 'vitest';
import type { V3 } from '../../src/core/vec';
import { BackgroundBurst, BackgroundBurstStyle, MoodBackground, MoodPalette, OneShotKind, type Mood } from '../../src/engine';
import * as T from './BackgroundBurstHarness';

const colourKinds = OneShotKind.allCases.filter((k) => !BackgroundBurstStyle.standard(k).isNone);

/// The mood background's anchors as settled moods (expression neutral → the background PAD is the mood).
const moods: [string, Mood][] = MoodPalette.background.anchors.map((a) =>
  [a.name, { pleasure: a.pad.x, arousal: a.pad.y, dominance: a.pad.z }]);

function sweep(o: { rm?: boolean; gap?: number }, check: (note: string, shown: V3, mood: V3) => void): void {
  for (const [name, mood] of moods) {
    for (const kind of colourKinds) {
      const e = T.engine(false, (c) => { c.reduceMotion = o.rm ?? false; c.readabilityGap = o.gap ?? 0.12; });
      e.setMood(mood);
      T.run(e, 8);
      e.playBackgroundBurst(kind);
      T.run(e, 1.6, (f, b) => check(`${kind} over ${name}`, T.lab(f), b.currentLab));
    }
  }
}

/// Colour bursts: photosensitivity (rate limit, merging, the luminance-step bound), band / chroma / readability,
/// Reduce Motion, frame-rate independence and per-frame cost.
describe('BackgroundBurstSafety', () => {
  // MARK: Rate limit and merging

  test('onsetsAreRateLimitedAndOverlapsMerge', () => {
    const e = T.settled();
    const onsets: number[] = [];
    let last = -Infinity;
    const kinds: OneShotKind[] = ['laugh', 'heartEyes', 'bigSurprise', 'shakeNoBig', 'noteEyes', 'curiousTilt'];
    for (let i = 0; i < 240; i++) {
      e.playBackgroundBurst(kinds[i % kinds.length]); // a request every frame for 4 s
      e.tick(T.dt);
      const t = T.bg(e).burst.lastOnsetTime;
      if (t !== last) { onsets.push(t); last = t; }
    }
    expect(onsets.length, 'bursts keep coming').toBeGreaterThanOrEqual(8);
    for (let i = 0; i + 1 < onsets.length; i++) {
      expect(onsets[i + 1] - onsets[i], 'gap').toBeGreaterThanOrEqual(BackgroundBurst.minOnsetGap - 1e-9);
    }
    // Never more than 3 onsets in any 1 s window.
    onsets.forEach((t, i) => {
      let n = 0;
      for (let j = i; j < onsets.length && onsets[j] < t + 1; j++) n++;
      expect(n).toBeLessThanOrEqual(3);
    });
  });

  test('theSameTintRetargetsInsteadOfRestarting', () => {
    const e = T.settled();
    e.playBackgroundBurst('laugh');
    const levels: number[] = [];
    for (let i = 0; i < 90; i++) {
      if (i === 30) e.playBackgroundBurst('nodYesBig'); // same marigold family, mid-release
      e.tick(T.dt);
      levels.push(T.bg(e).burst.level);
    }
    // The level never drops back toward 0 at the retarget.
    expect(T.minOf(levels.slice(29, 36)), `levels ${levels.slice(29, 36)}`).toBeGreaterThan(0.5 * levels[29]);
  });

  // MARK: Luminance step, band, chroma, readability

  test('eachBurstMovesLuminanceLessThanTheBound', () => {
    let worst = 0;
    sweep({}, (note, shown, mood) => {
      const dy = Math.abs(BackgroundBurst.luminance(shown) - BackgroundBurst.luminance(mood));
      worst = Math.max(worst, dy);
      expect(dy, `${note}: ΔY`).toBeLessThanOrEqual(BackgroundBurst.maxLuminanceStep + 0.005);
    });
    expect(worst, 'bursts are visible (worst ΔY)').toBeGreaterThan(0.03);
  }, 120_000);

  test('burstsStayInTheBandUnderTheChromaCapAndReadable', () => {
    for (const gap of [0.12, 0.18]) {
      const top = 0.968 - gap;
      sweep({ gap }, (note, shown) => {
        expect(shown.x, `${note}: L`).toBeLessThanOrEqual(Math.min(MoodBackground.band[1], top) + 2e-3);
        expect(shown.x, `${note}: L`).toBeGreaterThanOrEqual(MoodBackground.band[0] - 2e-3);
        expect(T.chroma(shown), `${note}: C`).toBeLessThanOrEqual(MoodBackground.chromaCap + 2e-3);
      });
    }
  }, 240_000);

  // MARK: Reduce Motion

  test('reduceMotionIsSofterLongerAndLower', () => {
    const profile = (rm: boolean): { peak: number; peakT: number; end: number; dy: number } => {
      const e = T.settled((c) => { c.reduceMotion = rm; });
      e.playBackgroundBurst('laugh');
      const levels: number[] = [];
      let dy = 0;
      T.run(e, 3, (f, b) => {
        levels.push(b.burst.level);
        dy = Math.max(dy, Math.abs(BackgroundBurst.luminance(T.lab(f)) - BackgroundBurst.luminance(b.currentLab)));
      });
      const p = T.argMax(levels);
      let end = -1;
      for (let i = levels.length - 1; i >= 0; i--) if (levels[i] > 0) { end = i; break; }
      return { peak: levels[p], peakT: (p + 1) * T.fdt, end: (end + 1) * T.fdt, dy };
    };
    const n = profile(false), r = profile(true);
    expect(r.peak, `peak ${r.peak} vs ${n.peak}`).toBeLessThan(n.peak * 0.75);
    expect(r.peakT, 'softer swell').toBeGreaterThanOrEqual(0.3);
    expect(r.end, `longer (${r.end} vs ${n.end} s)`).toBeGreaterThan(n.end + 0.4);
    expect(r.dy, 'ΔY').toBeLessThanOrEqual(BackgroundBurst.maxLuminanceStep * 0.5 + 0.003);
  });

  // MARK: Frame rate

  test('sixtyAndOneTwentyFPSAgree', () => {
    const a = T.settled(), b = T.settled();
    a.playBackgroundBurst('heartEyes');
    b.playBackgroundBurst('heartEyes');
    let worst = 0;
    for (let i = 0; i < 120; i++) {
      if (i === 20) { a.playBackgroundBurst('bigSurprise'); b.playBackgroundBurst('bigSurprise'); }
      const fa = a.tick(T.dt);
      b.tick(T.dt / 2);
      const fb = b.tick(T.dt / 2);
      worst = Math.max(worst, T.dist(T.lab(fa), T.lab(fb)));
    }
    expect(worst, '60 vs 120 fps ΔE').toBeLessThan(0.01);
  });

  // MARK: Cost

  // Swift counts malloc blocks (libmalloc zone statistics); JS has no allocation counter.
  test.skip('burstsAllocateNothingPerFrame (no allocation counter in JS)', () => {});
});
