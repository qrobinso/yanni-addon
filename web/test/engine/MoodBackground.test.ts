// Port of Tests/FaceEngineTests/MoodBackgroundTests.swift.
import { describe, expect, test } from 'vitest';
import { v3, type V3 } from '../../src/core/vec';
import { SplitMix64 } from '../../src/core/random';
import { ExpressionLibrary, ExpressionMix, Oklab, type FaceFrame } from '../../src/model';
import {
  FaceAffect, FaceCommand, FaceEngine, MoodBackground, MoodBackgroundConfig, MoodPalette, Phase, type FaceState,
  type Modifier, type Mood, type MoodBackgroundMode, type MoodPaletteAnchor,
} from '../../src/engine';
import { Brightness } from '../../src/engine/modifiers/Brightness';
import { MoodColor } from '../../src/engine/modifiers/MoodColor';
import { LidsHarness } from './harness';

const palette = MoodPalette.background;
const cfg = new MoodBackgroundConfig();
const library = ExpressionLibrary.bundled();
const DT = 1 / 60;

const dist = (a: V3, b: V3): number => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
const chroma = (l: V3): number => Math.sqrt(l.y * l.y + l.z * l.z);
const anchor = (name: string): MoodPaletteAnchor => palette.anchors.find((a) => a.name === name)!;
const pad = (m: Mood): V3 => v3(m.pleasure, m.arousal, m.dominance);
const contains = (r: readonly [number, number], x: number): boolean => r[0] <= x && x <= r[1];
const grid: V3[] = (() => {
  const steps: number[] = [];
  for (let i = 0; i <= 8; i++) steps.push(-1 + i * 0.25);
  return steps.flatMap((p) => steps.flatMap((a) => steps.map((d) => v3(p, a, d))));
})();

/// An engine with only MoodColor (plus Brightness), the background in mood mode.
function engine(mode: MoodBackgroundMode = 'mood', configure: (c: MoodBackgroundConfig) => void = () => {}): FaceEngine {
  const e = new FaceEngine({ seed: 3, modifiers: [new MoodColor(), new Brightness()] });
  const c = e.moodBackground;
  c.mode = mode;
  configure(c);
  e.moodBackground = c;
  return e;
}

const background = (e: FaceEngine): MoodBackground => (e.director.modifier('MoodColor') as MoodColor).background;
const lab = (f: FaceFrame): V3 => Oklab.fromLinear(f.backgroundColor);
const ticks = (e: FaceEngine, n: number): void => { for (let i = 0; i < n; i++) e.tick(DT); };

/// Seconds until the background has covered 95 % of the way from its start to its settled target.
function settleTime(e: FaceEngine, change: (e: FaceEngine) => void, fps = 60, limit = 15): [number, boolean] {
  const start = lab(e.tick(1 / fps));
  change(e);
  const frames: V3[] = [];
  let fast = false;
  for (let i = 0; i < Math.trunc(limit * fps); i++) {
    frames.push(lab(e.tick(1 / fps)));
    fast = fast || background(e).isFast(e.state.time);
  }
  const end = background(e).targetLab;
  const total = dist(start, end);
  let i = -1;
  for (let j = frames.length - 1; j >= 0; j--) if (dist(frames[j], end) > 0.05 * total) { i = j; break; }
  return [(i + 1) / fps, fast];
}

const presence = (e: FaceEngine): number => e.state.output.backgroundPresence;

/// Stands in for TouchReactions: writes a full reaction overlay weight every frame.
class OverlayWriter implements Modifier {
  readonly name = 'OverlayWriter';
  readonly phase = Phase.behaviour;
  isEnabled = true;
  update(s: FaceState): void { if (s.reactionOverlay !== null) s.reactionOverlayWeight = 1; }
}

/// The mood background (mood background design §7 and its review): palette mapping, band and chroma cap,
/// readability, dynamics, one-shot calm, frame-rate independence, life-cycle presence and per-frame cost.
describe('MoodBackground', () => {
  // MARK: Palette

  test('authoredAnchorsSitInTheBandUnderTheCap', () => {
    for (const a of palette.anchors) {
      expect(contains(MoodBackground.band, a.lab.x), `${a.name} L ${a.lab.x}`).toBe(true);
      expect(chroma(a.lab), `${a.name} C`).toBeLessThanOrEqual(MoodBackground.chromaCap);
    }
  });

  test.each(MoodPalette.background.anchors.map((a) => a.name))('eachAnchorsPADGivesItsOwnColour %s', (name) => {
    const a = anchor(name);
    const got = background(engine()).colourLab(a.pad, cfg);
    expect(dist(got, a.lab), `${name}: ΔE_ok`).toBeLessThan(0.02);
  });

  test('playfulBaselineIsLavender', () => {
    const got = new MoodBackground().colourLab(pad({ pleasure: 0.2, arousal: 0.15, dominance: 0.1 }), cfg);
    expect(dist(got, Oklab.fromLinear(Oklab.linear(0xb78bbe)))).toBeLessThan(1e-3);
    const e = engine();
    let f = e.tick(DT);
    for (let i = 0; i < 60; i++) f = e.tick(DT);
    expect(Oklab.hex(f.backgroundColor)).toBe(0xb78bbe);
  });

  test('blendsStayInTheBandUnderTheCapAndInGamut', () => {
    const bg = new MoodBackground();
    const band = MoodBackground.lightnessBand(cfg);
    for (const p of grid) {
      const c = bg.colourLab(p, cfg);
      expect(contains(band, c.x), `L ${c.x}`).toBe(true);
      expect(chroma(c)).toBeLessThanOrEqual(MoodBackground.chromaCap + 1e-4);
      expect(Oklab.isInGamut(c, 1e-3), 'out of gamut').toBe(true);
    }
  });

  test('blendsAreSmooth', () => {
    // Along every axis, a 0.05 PAD step never jumps the colour.
    const bg = new MoodBackground();
    let worst = 0;
    for (const p of grid) {
      for (const axis of ['x', 'y', 'z'] as const) {
        const q = { ...p };
        q[axis] = Math.min(q[axis] + 0.05, 1);
        worst = Math.max(worst, dist(bg.colourLab(p, cfg), bg.colourLab(q, cfg)));
      }
    }
    expect(worst, 'largest step').toBeLessThan(0.06);
  });

  test('readabilityGapAgainstTheScleraEverywhere', () => {
    const bg = new MoodBackground();
    for (const gap of [0.12, 0.18]) {
      const c = cfg.copy();
      c.readabilityGap = gap;
      for (const p of [...grid, ...palette.anchors.map((a) => a.pad)]) {
        const l = bg.colourLab(p, c).x;
        expect(c.scleraLightness - l, `gap ${gap}`).toBeGreaterThanOrEqual(gap - 1e-4);
      }
    }
    // A pale fixed colour is pulled down too.
    const c = cfg.copy();
    c.fixedColor = v3(1, 0.98, 0.9);
    expect(c.scleraLightness - MoodBackground.fixedLab(c).x).toBeGreaterThanOrEqual(0.12 - 1e-4);
  });

  test('angryIsAWarmGreyNotScreenOff', () => {
    const a = anchor('angry').lab;
    const hue = Math.atan2(a.z, a.y) * 180 / Math.PI;
    expect(a.x > 0.6 && chroma(a) > 0.008 && hue > 30 && hue < 90, `hue ${hue}`).toBe(true);
  });

  test('tiredIsADistinctSlate', () => {
    const t = anchor('tired').lab, c = anchor('content').lab;
    const hue = Math.atan2(t.z, t.y) * 180 / Math.PI;
    expect(hue < -80 && hue > -120, `tired hue ${hue}`).toBe(true);
    expect(dist(t, c)).toBeGreaterThan(0.06);
  });

  // MARK: Dynamics

  test('gentleMoodChangeSettlesInAboutThreeSeconds', () => {
    const e = engine();
    ticks(e, 60);
    const [t, fast] = settleTime(e, (e) => e.setMood({ pleasure: 0.45, arousal: 0.2, dominance: 0.15 }));
    expect(fast).toBe(false);
    expect(t > 2.4 && t < 3.6, `settled in ${t} s`).toBe(true);
  });

  test('suddenMoodStepTakesTheFastPath', () => {
    const e = engine();
    ticks(e, 60);
    const [t, fast] = settleTime(e, (e) => e.setMood({ pleasure: -0.6, arousal: 0.7, dominance: -0.6 }));
    expect(fast).toBe(true);
    expect(t, 'settled in').toBeLessThan(2.2);
  });

  test('expressionChangeEaseInEndToEnd', () => {
    // The expression's share goes through the low-pass and the spring: ≈ 5–6 s end to end, never the fast path.
    const e = engine();
    e.setExpressionOverride(ExpressionMix.neutral);
    ticks(e, 60);
    const [t, fast] = settleTime(e, (e) => e.setExpressionOverride(ExpressionMix.single('Fear')));
    expect(fast).toBe(false);
    expect(t > 4 && t < 7.5, `settled in ${t} s`).toBe(true);
  });

  test('halfSecondReactionShiftsLessThanAQuarter', () => {
    const e = engine();
    e.setExpressionOverride(ExpressionMix.neutral);
    ticks(e, 120);
    const start = lab(e.tick(DT));
    // Where the reaction would take the background if it lasted.
    const p = FaceAffect.combine(e.state.mood, FaceAffect.padDelta(ExpressionMix.single('Surprise'), library), 0.5);
    const goal = background(e).colourLab(p, e.moodBackground);
    e.setExpressionOverride(ExpressionMix.single('Surprise'));
    let worst = 0;
    for (let i = 0; i < 60 * 6; i++) {
      if (i === 30) e.setExpressionOverride(ExpressionMix.neutral);
      worst = Math.max(worst, dist(lab(e.tick(DT)), start));
    }
    const total = dist(start, goal);
    expect(total).toBeGreaterThan(0.03);
    expect(worst, `shift ${worst / total}`).toBeLessThan(0.25 * total);
  });

  test('touchReactionOverlayNeverMovesTheBackground', () => {
    const h = new LidsHarness([new OverlayWriter(), new MoodColor()]);
    h.s.backgroundConfig.mode = 'mood';
    h.run(1);
    const before = Oklab.fromLinear(h.s.output.backgroundColor);
    const crescentBefore = { ...h.s.eyeColor };
    h.s.reactionOverlay = ExpressionMix.single('Anger');
    h.run(4);
    expect(dist(Oklab.fromLinear(h.s.output.backgroundColor), before)).toBeLessThan(1e-4);
    expect(dist(h.s.eyeColor, crescentBefore), 'the crescent still reacts').toBeGreaterThan(0.05);
  });

  test('microPADNoiseBarelyMovesIt', () => {
    const e = engine();
    ticks(e, 120);
    const base = lab(e.tick(DT));
    const rng = new SplitMix64(9);
    let worst = 0;
    for (let i = 0; i < 60 * 5; i++) {
      e.setMood({ pleasure: 0.2 + rng.uniform(-0.01, 0.01), arousal: 0.15 + rng.uniform(-0.01, 0.01),
        dominance: 0.1 + rng.uniform(-0.01, 0.01) });
      worst = Math.max(worst, dist(lab(e.tick(DT)), base));
    }
    expect(worst, 'noise moved the background').toBeLessThan(0.004);
  });

  test('neverJumpsBetweenFrames', () => {
    // Through preset changes, mode switches and a startle, the colour moves smoothly frame to frame.
    const e = engine();
    let last = lab(e.tick(DT));
    let lastK = e.state.output.backgroundStrength;
    let worst = 0, worstK = 0;
    const setMode = (e: FaceEngine, m: MoodBackgroundMode): void => { const c = e.moodBackground; c.mode = m; e.moodBackground = c; };
    const script: [number, (e: FaceEngine) => void][] = [
      [30, (e) => e.setMood({ pleasure: -0.6, arousal: 0.7, dominance: -0.6 })],
      [200, (e) => e.setExpressionOverride(ExpressionMix.single('Happiness'))],
      [320, (e) => e.setMood({ pleasure: 0.8, arousal: 0.4, dominance: 0.3 })],
      [500, (e) => setMode(e, 'fixed')],
      [650, (e) => setMode(e, 'black')],
      [800, (e) => setMode(e, 'mood')],
    ];
    for (let i = 0; i < 1000; i++) {
      for (const [at, act] of script) if (at === i) act(e);
      const f = e.tick(DT);
      worst = Math.max(worst, dist(lab(f), last));
      worstK = Math.max(worstK, Math.abs(f.backgroundStrength - lastK));
      last = lab(f);
      lastK = f.backgroundStrength;
    }
    expect(worst, 'largest per-frame colour step').toBeLessThan(0.012);
    expect(worstK, 'largest per-frame strength step').toBeLessThan(0.03);
  });

  test('sixtyAndOneTwentyFPSAgree', () => {
    const run = (fps: number): V3[] => {
      const e = engine();
      const out: V3[] = [];
      const every = Math.trunc(fps / 10);
      for (let i = 0; i < Math.trunc(8 * fps); i++) {
        if (i === Math.trunc(0.5 * fps)) e.setMood({ pleasure: -0.6, arousal: -0.4, dominance: -0.4 });
        if (i === Math.trunc(4 * fps)) e.setExpressionOverride(ExpressionMix.single('Happiness'));
        const f = e.tick(1 / fps);
        if (i % every === every - 1) out.push(lab(f));
      }
      return out;
    };
    const a = run(60), b = run(120);
    expect(a.length).toBe(b.length);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, dist(a[i], b[i]));
    expect(worst, '60 vs 120 fps differ').toBeLessThan(0.01);
  });

  test('speedAndReduceMotionScaleTheSpring', () => {
    const time = (configure: (c: MoodBackgroundConfig) => void): number => {
      const e = engine('mood', configure);
      ticks(e, 60);
      return settleTime(e, (e) => e.setMood({ pleasure: 0.45, arousal: 0.2, dominance: 0.15 }))[0];
    };
    const normal = time(() => {});
    expect(time((c) => { c.speed = 2; })).toBeLessThan(normal * 0.6);
    expect(time((c) => { c.reduceMotion = true; })).toBeGreaterThan(normal * 1.6);
  });

  // MARK: Modes and strength

  test('modesAndStrength', () => {
    const e = engine('black');
    ticks(e, 60);
    expect(e.state.output.backgroundStrength).toBe(0);
    const c = e.moodBackground;
    c.mode = 'mood';
    e.moodBackground = c;
    ticks(e, 60 * 3);
    expect(Math.abs(e.state.output.backgroundStrength - 1)).toBeLessThan(0.01);
    c.mode = 'fixed';
    c.fixedColor = v3(0.1, 0.3, 0.2);
    e.moodBackground = c;
    ticks(e, 60 * 6);
    expect(dist(e.state.output.backgroundColor, c.fixedColor)).toBeLessThan(0.01);
  });

  // MARK: Life cycle (single owner of the background's sleep fade)

  test('asleepFadesToBlackWithoutBleedOrJumps', () => {
    const e = new FaceEngine({ seed: 4 });
    const c = e.moodBackground; c.mode = 'mood'; e.moodBackground = c;
    e.setAgentState('idle');
    ticks(e, 60);
    expect(presence(e)).toBe(1);
    e.setAgentState('drowsy');
    ticks(e, 60 * 3);
    expect(presence(e), 'drowsy dims through brightness, not presence').toBe(1);
    expect(e.state.output.backgroundBrightness, 'drowsy is dimmer').toBeLessThan(0.8);
    e.setAgentState('asleep');
    let last = presence(e), worst = 0;
    for (let i = 0; i < 60 * 8; i++) {
      e.tick(DT);
      const p = presence(e);
      expect(p, 'presence rose while falling asleep').toBeLessThanOrEqual(last + 1e-6);
      worst = Math.max(worst, last - p);
      last = p;
    }
    expect(last, 'asleep is black').toBeLessThan(0.005);
    expect(worst, 'fade stepped by').toBeLessThan(0.02);
    // Sleeping frames never carry the colour (no bleed from a second fade owner).
    for (let i = 0; i < 60; i++) expect(e.tick(DT).backgroundPresence).toBeLessThan(0.005);
  });

  test('wakingReturnsInAboutOneAndAHalfSeconds', () => {
    const e = new FaceEngine({ seed: 4 });
    const c = e.moodBackground; c.mode = 'mood'; e.moodBackground = c;
    e.setAgentState('asleep');
    ticks(e, 60 * 2);
    e.setAgentState('waking');
    let t = 0;
    while (presence(e) < 0.95 && t < 5) { e.tick(DT); t += DT; }
    expect(t > 0.9 && t < 2, `returned in ${t} s`).toBe(true);
  });

  test('bedtimeIsBlackUnlessColourAtBedtime', () => {
    const e = engine();
    e.setBedtime(true);
    ticks(e, 60 * 6);
    expect(presence(e)).toBeLessThan(0.01);
    const c = e.moodBackground; c.colourAtBedtime = true; e.moodBackground = c;
    ticks(e, 60 * 3);
    expect(presence(e)).toBeGreaterThan(0.98);
  });

  test('resourceSuppressionFadesWithoutASnap', () => {
    const e = engine();
    ticks(e, 60);
    e.setBackgroundSuppressed(true);
    let last = presence(e), worst = 0;
    for (let i = 0; i < 60 * 5; i++) {
      e.tick(DT);
      worst = Math.max(worst, Math.abs(presence(e) - last));
      last = presence(e);
    }
    expect(last).toBeLessThan(0.01);
    expect(worst).toBeLessThan(0.02);
    e.setBackgroundSuppressed(false);
    ticks(e, 60 * 3);
    expect(presence(e)).toBeGreaterThan(0.98);
  });

  test('backgroundBrightnessIgnoresOneShotGlow', () => {
    const e = new FaceEngine({ seed: 4 });
    e.setAgentState('engaged');
    ticks(e, 60 * 3);
    const level = (e.director.modifier('Brightness') as Brightness).level;
    e.send(FaceCommand.playOneShot('bigSurprise'));
    let glowed = false;
    for (let i = 0; i < 60; i++) {
      const f = e.tick(DT);
      if (f.brightness > f.backgroundBrightness + 0.01) glowed = true;
      expect(Math.abs(f.backgroundBrightness - level)).toBeLessThan(0.01);
    }
    expect(glowed, 'the eyes still glow').toBe(true);
  });

  // MARK: Cost

  // Swift counts malloc blocks (libmalloc zone statistics); JS has no allocation counter.
  test.skip('noPerFrameAllocationInTheBackground (no allocation counter in JS)', () => {});
});
