// Port of Tests/FaceEngineTests/ListeningGlowTests.swift.
import { describe, expect, test } from 'vitest';
import type { V3, V4 } from '../../src/core/vec';
import { v3 } from '../../src/core/vec';
import { SplitMix64 } from '../../src/core/random';
import { FaceFrame, Oklab } from '../../src/model';
import {
  FaceEngine, ListeningGlow, MoodBackground, MoodBackgroundConfig, MoodPalette, type MoodBackgroundMode,
} from '../../src/engine';
import { Brightness } from '../../src/engine/modifiers/Brightness';
import { MoodColor } from '../../src/engine/modifiers/MoodColor';

const DT = 1 / 60;

function engine(mode: MoodBackgroundMode = 'black', seed = 3): FaceEngine {
  const e = new FaceEngine({ seed, modifiers: [new MoodColor(), new Brightness()] });
  const c = e.moodBackground;
  c.mode = mode;
  e.moodBackground = c;
  for (let i = 0; i < 120; i++) e.tick(DT);
  return e;
}

const glow = (e: FaceEngine): ListeningGlow => (e.director.modifier('MoodColor') as MoodColor).glow;
const hue = (lab: V3): number => Math.atan2(lab.z, lab.y);
const chroma = (lab: V3): number => Math.sqrt(lab.y * lab.y + lab.z * lab.z);
const isZero4 = (p: V4): boolean => p.x === 0 && p.y === 0 && p.z === 0 && p.w === 0;
const eq4 = (a: V4, b: V4): boolean => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
function angle(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

/// Steady state with the glow open, then `level` per frame; returns the frames.
function micRun(o: { reduceMotion?: boolean; motion?: number; seconds: number }, level: (i: number) => number)
  : [FaceEngine, FaceFrame[]] {
  const e = engine();
  const c = e.listeningGlow;
  c.reduceMotion = o.reduceMotion ?? false;
  c.motion = o.motion ?? 1;
  e.listeningGlow = c;
  e.setListeningGlow(1);
  for (let i = 0; i < 180; i++) e.tick(DT);
  const out: FaceFrame[] = [];
  for (let i = 0; i < Math.trunc(o.seconds * 60); i++) {
    e.setListeningLevel(level(i));
    out.push(e.tick(DT));
  }
  return [e, out];
}

/// The listening glow (listening glow design §8): envelope timing and overshoot, determinism and frame-rate
/// independence, Reduce Motion, the owner's switch, the governor's motion budget, and the colour derivation.
describe('ListeningGlow', () => {
  test('offByDefaultAndTheFrameCarriesNoGlow', () => {
    const f = engine().tick(DT);
    expect(f.glowLevel === 0 && f.glowHeight === 0 && isZero4(f.glowPhase)).toBe(true);
  });

  test('riseSpringsUpWithASlightOvershoot', () => {
    const e = engine();
    e.setListeningGlow(1);
    let peak = 0, peakAt = 0;
    for (let i = 1; i <= 120; i++) {
      e.tick(DT);
      const v = glow(e).currentLevel;
      if (v > peak) { peak = v; peakAt = i / 60; }
    }
    expect(peakAt >= 0.4 && peakAt <= 0.6, `peak at ${peakAt} s`).toBe(true);
    expect(peak >= 1.03 && peak <= 1.12, `overshoot ${peak}`).toBe(true);
    expect(Math.abs(glow(e).currentLevel - 1), 'settles').toBeLessThan(0.02);
  });

  test('fadeIsGoneWithinASecondAndExactlyZero', () => {
    const e = engine();
    e.setListeningGlow(1);
    for (let i = 0; i < 180; i++) e.tick(DT);
    e.setListeningGlow(0);
    let last = glow(e).currentLevel;
    for (let i = 1; i <= 72; i++) {
      const f = e.tick(DT);
      const v = glow(e).currentLevel;
      expect(v, 'monotonic fade').toBeLessThanOrEqual(last + 1e-6);
      last = v;
      if (i === 48) { expect(v, '0.8 s').toBeLessThan(0.05); expect(f.glowLevel).toBeLessThan(0.06); }
    }
    expect(glow(e).currentLevel).toBe(0);
    expect(e.tick(DT).glowLevel).toBe(0);
  });

  test('reopeningMidFadeRisesFromWhereItIs', () => {
    const e = engine();
    e.setListeningGlow(1);
    for (let i = 0; i < 60; i++) e.tick(DT);
    e.setListeningGlow(0);
    for (let i = 0; i < 15; i++) e.tick(DT);
    const mid = glow(e).currentLevel;
    expect(mid > 0.2 && mid < 0.9).toBe(true);
    e.setListeningGlow(1);
    let prev = mid;
    for (let i = 0; i < 30; i++) {
      e.tick(DT);
      const v = glow(e).currentLevel;
      expect(Math.abs(v - prev), 'no jump').toBeLessThan(0.1);
      prev = v;
    }
  });

  test('deterministicAndFrameRateIndependent', () => {
    const run = (fps: number, seed = 3): number[] => {
      const e = engine('mood', seed);
      e.setListeningGlow(1);
      const out: number[] = [];
      for (let i = 1; i <= Math.trunc(3 * fps); i++) {
        if (i === Math.trunc(1.5 * fps)) e.setListeningVoice(1);
        const f = e.tick(1 / fps);
        if (i % Math.trunc(fps / 10) === 0) out.push(f.glowLevel, f.glowHeight, f.glowPhase.y, f.glowColor.x);
      }
      return out;
    };
    const a = run(60), b = run(60), c = run(120);
    expect(a).toEqual(b);
    expect(a.every((x, i) => Math.abs(x - c[i]) < 0.01)).toBe(true);
  });

  test('voiceSwellsAndSpeedsTheFlow', () => {
    const e = engine();
    e.setListeningGlow(1);
    for (let i = 0; i < 120; i++) e.tick(DT);
    const quiet = e.tick(DT);
    e.setListeningVoice(1);
    let f = quiet;
    for (let i = 0; i < 60; i++) f = e.tick(DT);
    expect(f.glowHeight).toBeGreaterThan(quiet.glowHeight * 1.08);
    expect(glow(e).currentVoice).toBeGreaterThan(0.95);
  });

  test('everyMotionIsSlowerThanHalfAHertz', () => {
    const w = ListeningGlow.waveHz;
    const fastestWave = Math.max(Math.max(Math.abs(w.x), Math.abs(w.y)), Math.max(Math.abs(w.z), Math.abs(w.w)));
    const fastest = Math.max(fastestWave, ListeningGlow.pulseHz) * (1 + ListeningGlow.voiceSpeedUp);
    expect(fastest).toBeLessThanOrEqual(0.5);
    // Talking speeds the waves up (still ≤ 0.5 Hz); the voice ripple (3 × wave 3, 2 × wave 2 in the shader)
    // stays under 1 Hz, far below the 3 Hz flash band.
    const talking = 1 + ListeningGlow.voiceSpeedUp + ListeningGlow.micSpeedUp;
    expect(fastestWave * talking).toBeLessThanOrEqual(0.5);
    expect(Math.max(3 * Math.abs(w.w), 2 * Math.abs(w.z)) * talking).toBeLessThanOrEqual(1);
  });

  // MARK: Mic level

  test('micLevelGrowsBrightensAndRipplesWithinTheBottomBand', () => {
    const [, quiet] = micRun({ seconds: 1 }, () => 0);
    const [e, loud] = micRun({ seconds: 1 }, () => 1);
    const q = quiet[quiet.length - 1], l = loud[loud.length - 1];
    expect(glow(e).currentMic).toBeGreaterThan(0.95);
    expect(l.glowHeight, `taller: ${l.glowHeight} vs ${q.glowHeight}`).toBeGreaterThan(q.glowHeight * 1.2);
    expect(l.glowLevel, 'brighter').toBeGreaterThan(q.glowLevel * 1.1);
    expect(q.glowRipple === 0 && l.glowRipple > 0.9 && l.glowRipple <= l.glowMotion).toBe(true);
    // Bounded: the loudest voice and the speech swell together keep the crest in the bottom band.
    e.setListeningVoice(1);
    let tallest = 0;
    for (let i = 0; i < 240; i++) tallest = Math.max(tallest, e.tick(DT).glowHeight);
    expect(tallest, 'crest of the screen height').toBeLessThanOrEqual(0.3);
  });

  test('reduceMotionMicIsGentleBrightnessOnly', () => {
    const [, quiet] = micRun({ reduceMotion: true, seconds: 1 }, () => 0);
    const [, loud] = micRun({ reduceMotion: true, seconds: 1 }, () => 1);
    const q = quiet[quiet.length - 1], l = loud[loud.length - 1];
    expect(l.glowHeight === q.glowHeight && l.glowRipple === 0 && isZero4(l.glowPhase)).toBe(true);
    expect(l.glowLevel > q.glowLevel && l.glowLevel <= q.glowLevel * (1 + ListeningGlow.micLevelGain)).toBe(true);
  });

  test('governorMotionZeroMeansNoRipple', () => {
    const [, f] = micRun({ motion: 0, seconds: 1 }, () => 1);
    expect(f[f.length - 1].glowRipple).toBe(0);
  });

  /// The flash bound: a 0↔1 square-wave level at 3 Hz or faster moves the glow's level by at most 12 % peak to peak.
  test('noFlashFromTheVoice', () => {
    for (const hz of [3.0, 4.0, 5.0, 8.0, 12.0]) {
      const half = 60 / (2 * hz);
      const [, f] = micRun({ motion: 0, seconds: 4 }, (i) => (Math.trunc(i / half) % 2 === 0 ? 1 : 0));
      const tail = f.slice(-120).map((x) => x.glowLevel);
      const lo = Math.min(...tail), hi = Math.max(...tail);
      expect((hi - lo) / lo, `${hz} Hz`).toBeLessThanOrEqual(0.12);
    }
  });

  test('randomLevelsMoveTheGlowSmoothly', () => {
    // Swift draws Float.random(in: 0...1) from its own SplitMix64 generator; any uniform source exercises the bound.
    const rng = new SplitMix64(7);
    const [, f] = micRun({ seconds: 6 }, () => rng.unit());
    let maxStep = 0;
    for (let i = 0; i + 1 < f.length; i++) {
      const a = f[i], b = f[i + 1];
      maxStep = Math.max(maxStep, Math.abs(b.glowLevel - a.glowLevel) / a.glowLevel);
      expect(b.glowRipple >= 0 && b.glowRipple <= 1).toBe(true);
    }
    expect(maxStep, 'per-frame level step').toBeLessThan(0.03);
  });

  test('reduceMotionFadesInPlaceWithoutOvershootOrUndulation', () => {
    const e = engine();
    const c = e.listeningGlow;
    c.reduceMotion = true;
    e.listeningGlow = c;
    e.setListeningGlow(1);
    const heights = new Set<number>();
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      const f = e.tick(DT);
      peak = Math.max(peak, glow(e).currentLevel);
      expect(f.glowMotion === 0 && isZero4(f.glowPhase)).toBe(true);
      heights.add(f.glowHeight);
    }
    expect(peak).toBeLessThanOrEqual(1.0001);
    expect(heights.size, `height fixed: ${[...heights]}`).toBe(1);
  });

  test('governorMotionZeroFreezesTheWaves', () => {
    const e = engine();
    const c = e.listeningGlow;
    c.motion = 0;
    e.listeningGlow = c;
    e.setListeningGlow(1);
    for (let i = 0; i < 60; i++) e.tick(DT);
    const a = e.tick(DT), b = e.tick(DT);
    expect(a.glowMotion === 0 && eq4(a.glowPhase, b.glowPhase)).toBe(true);
  });

  test('switchedOffIgnoresTheMicAndFadesAShowingGlow', () => {
    const e = engine();
    e.setListeningGlow(1);
    for (let i = 0; i < 60; i++) e.tick(DT);
    const c = e.listeningGlow;
    c.enabled = false;
    e.listeningGlow = c;
    const first = e.tick(DT).glowLevel;
    expect(first, 'fades, never snaps').toBeGreaterThan(0.5);
    for (let i = 0; i < 90; i++) e.tick(DT);
    expect(e.tick(DT).glowLevel).toBe(0);
  });

  test('nonFiniteInputsReadAsZero', () => {
    const e = engine();
    e.setListeningGlow(NaN);
    e.setListeningVoice(Infinity);
    e.setListeningLevel(NaN);
    expect(e.state.glowTarget === 0 && e.state.glowVoice === 0 && e.state.glowMic === 0).toBe(true);
  });

  // MARK: Colour

  test('overEveryMoodColourTheGlowStandsOutAndIsRicher', () => {
    for (const gap of [0.12, 0.18]) {
      const cfg = new MoodBackgroundConfig();
      cfg.readabilityGap = gap;
      for (const a of MoodPalette.background.anchors) {
        const bg = new MoodBackground().colourLab(a.pad, cfg);
        const [g, g2] = ListeningGlow.colours(bg, 1, Oklab.fromLinear(FaceFrame.defaultColor));
        // Lighter over a darker background, a slightly deeper, richer light over a light one; always clearly
        // apart from the background (ΔE).
        const dl = g.x - bg.x;
        expect(dl >= -0.09 && dl <= 0.13, `${a.name}: ΔL ${dl}`).toBe(true);
        if (bg.x < 0.6) expect(dl, `${a.name}: lighter over a dark background`).toBeGreaterThanOrEqual(0.015);
        const de = Math.sqrt((g.x - bg.x) ** 2 + (g.y - bg.y) ** 2 + (g.z - bg.z) ** 2);
        expect(de, `${a.name}: ΔE`).toBeGreaterThanOrEqual(0.06);
        // Warm golds trade some chroma for lightness: sRGB has little orange chroma that light.
        expect(chroma(g), `${a.name}: chroma`).toBeGreaterThanOrEqual(Math.max(0.6 * chroma(bg), 0.09));
        expect(Oklab.isInGamut(g, 1e-3) && Oklab.isInGamut(g2, 1e-3)).toBe(true);
        const turn = angle(hue(g), hue(g2));
        expect(Math.abs(turn - ListeningGlow.bandHueTurn), `${a.name}: band hue ${turn}`).toBeLessThan(0.05);
      }
    }
  });

  test('overBlackTheGlowFollowsTheCrescent', () => {
    for (const hex of [0x5ff6ff, 0xf38258, 0x9c7df0, 0x7de8a8]) {
      const cr = Oklab.fromLinear(Oklab.linear(hex));
      const [g] = ListeningGlow.colours(v3(0), 0, cr);
      expect(angle(hue(g), hue(cr))).toBeLessThan(0.05);
      expect(g.x >= 0.72 && g.x <= 0.86).toBe(true);
    }
  });

  test('aNearGreyBackgroundStillGetsColour', () => {
    const grey = Oklab.fromLinear(Oklab.linear(0x9a928c));
    const [g] = ListeningGlow.colours(grey, 1, Oklab.fromLinear(FaceFrame.defaultColor));
    expect(chroma(g)).toBeGreaterThan(0.1);
  });

  test('colourEasesThroughAModeChange', () => {
    const e = engine('mood');
    e.setListeningGlow(1);
    for (let i = 0; i < 120; i++) e.tick(DT);
    const c = e.moodBackground;
    c.mode = 'black';
    e.moodBackground = c;
    let prev = Oklab.fromLinear(e.state.output.glowColor);
    let maxStep = 0;
    for (let i = 0; i < 300; i++) {
      const lab = Oklab.fromLinear(e.tick(DT).glowColor);
      maxStep = Math.max(maxStep, Math.sqrt((lab.x - prev.x) ** 2 + (lab.y - prev.y) ** 2 + (lab.z - prev.z) ** 2));
      prev = lab;
    }
    expect(maxStep, 'per-frame ΔE').toBeLessThan(0.02);
  });

  // Swift counts malloc blocks (libmalloc zone statistics); JS has no allocation counter.
  test.skip('noAllocationPerFrame (no allocation counter in JS)', () => {});
});
