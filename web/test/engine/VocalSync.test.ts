// Port of Tests/FaceEngineTests/VocalSyncTests.swift.
import { describe, expect, test } from 'vitest';
import { VocalRig } from './VocalRig';
import { Canvas, ExpressionLibrary, ParamLayout, VocalContour } from '../../src/model';
import {
  FaceCommand, FaceEngine, FaceState, Phase, makeVocalCue, type OneShotKind, type VocalCueKind,
} from '../../src/engine';
import { VocalSync } from '../../src/engine/modifiers/VocalSync';

const iY = ParamLayout.index('centerY');
const iX = ParamLayout.index('centerX');

/// Everything VocalSync writes, normalised by each channel's working range (so 1e-3 = 0.1 % of range).
class VocalOutput {
  y: number; x: number; faceSX: number; faceSY: number; eyeX: number; eyeY: number;
  upper: number; lower: number; close: number; bright: number;
  constructor(s: FaceState) {
    this.y = s.delta.raw[iY] * Canvas.yFactor;
    this.x = s.delta.raw[iX] * Canvas.xFactor;
    this.faceSX = s.faceScaleMul.x; this.faceSY = s.faceScaleMul.y;
    this.eyeX = s.eyeScaleMul.x; this.eyeY = s.eyeScaleMul.y;
    this.upper = s.lidCoverage.x; this.lower = s.lidCoverage.y;
    this.close = s.lidClose; this.bright = s.brightness;
  }
  distance(o: VocalOutput): number {
    return Math.max(Math.abs(this.y - o.y) / 2.5, Math.abs(this.x - o.x) / 0.6, Math.abs(this.faceSX - o.faceSX) / 0.06,
      Math.abs(this.faceSY - o.faceSY) / 0.06, Math.abs(this.eyeX - o.eyeX) / 0.06, Math.abs(this.eyeY - o.eyeY) / 0.06,
      Math.abs(this.upper - o.upper) / 0.1, Math.abs(this.lower - o.lower) / 0.15, Math.abs(this.close - o.close) / 0.35,
      Math.abs(this.bright - o.bright) / 0.05);
  }
  get allFinite(): boolean {
    return [this.y, this.x, this.faceSX, this.faceSY, this.eyeX, this.eyeY, this.upper, this.lower, this.close, this.bright]
      .every(Number.isFinite);
  }
}

/// A busy script exercising every channel, sampled on the 60 fps grid.
function script(fps: number): VocalOutput[] {
  const rig = new VocalRig(fps);
  const perSixty = fps / 60;
  const out: VocalOutput[] = [];
  const rise = new VocalContour({ start: 0, end: 12, glideOnset: 0.2, scoop: 1.5 });
  const fall = new VocalContour({ start: 0, end: -10 });
  for (let frame = 0; frame < 60 * 4 * perSixty; frame++) {
    if (frame % perSixty === 0) {
      switch (frame / perSixty) {
        case 3:
          rig.cue(0.0371, { duration: 0.12, contour: VocalContour.flat(2), intensity: 0.8, valence: 0.6, accent: true });
          rig.cue(0.1913, { duration: 0.25, contour: rise, intensity: 0.6, valence: 0.6 });
          rig.cue(0.4517, { duration: 0.18, contour: VocalContour.flat(9), intensity: 1, articulation: 0.9, valence: 0.5,
            kind: 'startle', accent: true });
          break;
        case 60:
          rig.cue(0.0123, { duration: 0.6, contour: fall, intensity: 0.5, articulation: 0.1, kind: 'sleepy' });
          rig.cue(0.7011, { duration: 0.5, contour: new VocalContour({ start: 3, end: 1, wobbleDepth: 0.8, wobbleRate: 3.7 }),
            intensity: 0.6, kind: 'wobble', accent: true, paired: 'laugh' });
          break;
        case 150:
          rig.cue(0.0257, { duration: 0.3, contour: VocalContour.flat(5), intensity: 0.9, kind: 'curious' });
          rig.cue(0.1489, { duration: 0.3, contour: VocalContour.flat(7), intensity: 0.9, kind: 'curious' });
          break;
        case 160:
          rig.engine.send(FaceCommand.cancelVocalCues(rig.host));
          break;
        default: break;
      }
    }
    rig.frame();
    if ((frame + 1) % perSixty === 0) out.push(new VocalOutput(rig.s));
  }
  return out;
}

function hopPeak(intensity: number, paired?: OneShotKind): number {
  const rig = new VocalRig(120);
  rig.cue(0.05, { intensity, accent: true, paired });
  let peak = 0;
  rig.run(0.6, () => { peak = Math.min(peak, rig.vs.readout.hop); });
  return -peak;
}

function peakLower(pitch: number, valence: number): number {
  const rig = new VocalRig(60);
  rig.cue(0.02, { duration: 0.4, contour: VocalContour.flat(pitch), valence });
  let m = 0;
  rig.run(0.8, () => { m = Math.max(m, rig.s.lidCoverage.y); });
  return m;
}

function widenPeak(kind: VocalCueKind, paired?: OneShotKind): { scale: number; upper: number } {
  const rig = new VocalRig(60);
  rig.cue(0.02, { duration: 0.3, kind, paired });
  let sc = 1, up = 0;
  rig.run(0.8, () => { sc = Math.max(sc, rig.s.eyeScaleMul.x); up = Math.min(up, rig.s.lidCoverage.x); });
  return { scale: sc, upper: up };
}

describe('VocalSync', () => {
  // MARK: Timing

  test.each([60, 120])('cueFiresOnFirstFrameReachingOnset (fps %d)', (fps) => {
    const rig = new VocalRig(fps);
    const delay = 0.1234;
    const onset = rig.host + delay - VocalSync.visualLead;
    rig.cue(delay);
    let fired: number | undefined;
    for (let i = 0; i < 60; i++) {
      rig.frame();
      if (fired === undefined && rig.vs.activations === 1) fired = rig.host;
    }
    expect(fired).toBeDefined();
    const h = fired!;
    expect(h).toBeGreaterThanOrEqual(onset);
    expect(h - rig.dt).toBeLessThan(onset);
  });

  test('sixtyAndOneTwentyFpsMatch', () => {
    const a = script(60), b = script(120);
    expect(a.length).toBe(b.length);
    let worst = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) worst = Math.max(worst, a[i].distance(b[i]));
    expect(worst, `worst 60/120 difference ${worst} of range`).toBeLessThanOrEqual(1e-3);
    // The script actually moved things.
    expect(Math.max(...a.map((o) => Math.abs(o.y)))).toBeGreaterThan(0.5);
  });

  test('cuesStayHostTimedAfterDtClampHiccup', () => {
    // Reference: no hiccup. Test: one 100 ms frame (engine dt clamps to 50 ms) while a note is sounding.
    function run(hiccup: boolean): { fireHost?: number; samples: VocalOutput[]; onset: number } {
      const rig = new VocalRig(60);
      rig.cue(0.05, { duration: 0.6, contour: new VocalContour({ start: 0, end: 12 }), intensity: 0.8, accent: true });
      const start = rig.host;
      const onsetB = start + 0.45 - VocalSync.visualLead;
      rig.cue(0.45, { duration: 0.2, contour: VocalContour.flat(4), intensity: 1, accent: true });
      let fire: number | undefined;
      const samples: VocalOutput[] = [];
      while (rig.host < start + 1.2) {
        if (hiccup && Math.abs(rig.host - (start + 0.2)) < 1e-6) rig.frame(0.1); else rig.frame(1.0 / 60);
        if (fire === undefined && rig.vs.activations === 2) fire = rig.host;
        if (rig.host > start + 0.75 && rig.host < start + 1.2) samples.push(new VocalOutput(rig.s));
      }
      return { fireHost: fire, samples, onset: onsetB };
    }
    const ref = run(false), hic = run(true);
    // Note B fires on the first frame whose host time reaches its onset (engine time lags 50 ms here).
    expect(hic.fireHost).toBeDefined();
    const f = hic.fireHost!;
    expect(f >= hic.onset && f - 1.0 / 60 < hic.onset).toBe(true);
    expect(Math.abs(f - ref.fireHost!)).toBeLessThan(1e-6);
    // Same frame grid after the hiccup (100 ms = 6 frames): by B's settle the motion matches the reference.
    expect(ref.samples.length).toBe(hic.samples.length);
    let worst = 0;
    const a = ref.samples.slice(-10), b = hic.samples.slice(-10);
    for (let i = 0; i < Math.min(a.length, b.length); i++) worst = Math.max(worst, a[i].distance(b[i]));
    expect(worst, `post-hiccup difference ${worst}`).toBeLessThan(0.02);
  });

  test('worksWithoutHostTime', () => {
    const vs = new VocalSync();
    const e = new FaceEngine({ modifiers: [vs] });
    e.tick(1.0 / 60);
    // Host times in some unrelated base: the earliest cue maps to now, the next one 0.3 s later.
    e.send(FaceCommand.vocalCue(makeVocalCue({ hostTime: 123_456, duration: 0.1, contour: VocalContour.flat(0), intensity: 1,
      articulation: 0.5, valence: 0 })));
    e.send(FaceCommand.vocalCue(makeVocalCue({ hostTime: 123_456.3, duration: 0.1, contour: VocalContour.flat(0), intensity: 1,
      articulation: 0.5, valence: 0 })));
    e.tick(1.0 / 60);
    expect(vs.activations).toBe(1);
    let frames = 0;
    while (vs.activations < 2 && frames < 100) { e.tick(1.0 / 60); frames += 1; }
    expect(Math.abs((frames + 1) / 60 - 0.3)).toBeLessThanOrEqual(1.0 / 60 + 1e-9);
  });

  // MARK: Hops

  test('hopsScaleWithIntensity', () => {
    const lo = hopPeak(0), hi = hopPeak(1);
    expect(Math.abs(lo - 0.5), `${lo}`).toBeLessThan(0.08);
    expect(Math.abs(hi - 1.5), `${hi}`).toBeLessThan(0.2);
    expect(hopPeak(0.5) > lo && hopPeak(0.5) < hi).toBe(true);
  });

  test('hopIsUpAndSquashesOnOnsetWithoutStretch', () => {
    const rig = new VocalRig(120);
    rig.cue(0.02, { intensity: 1, accent: true });
    let minY = 0, minSY = 1, maxSY = 1;
    rig.run(0.5, () => {
      minY = Math.min(minY, rig.faceYCanvas);
      minSY = Math.min(minSY, rig.s.faceScaleMul.y / rig.s.faceScaleMul.x);
      maxSY = Math.max(maxSY, rig.s.faceScaleMul.y / rig.s.faceScaleMul.x);
    });
    expect(minY).toBeLessThan(-1); // up
    expect(minSY < 0.99 && minSY > 0.96).toBe(true); // onset squash ≈ 0.97
    expect(maxSY).toBeLessThan(1.01); // no vocal stretch (energy scales both axes equally)
  });

  test('hopsRateLimitedToFiveHertz', () => {
    const rig = new VocalRig(60);
    for (let i = 0; i < 10; i++) rig.cue(0.05 + i * 0.1, { duration: 0.08, intensity: 0.8, accent: true });
    rig.run(1.5);
    expect(rig.vs.activations).toBe(10);
    expect(rig.vs.hopCount).toBe(5);

    const plain = new VocalRig(60);
    for (let i = 0; i < 10; i++) plain.cue(0.05 + i * 0.1, { duration: 0.08, intensity: 0.8 });
    plain.run(1.5);
    expect(plain.vs.hopCount).toBe(1); // only the first (no previous onset); 100 ms inter-onset never hops

    const spaced = new VocalRig(60);
    for (let i = 0; i < 4; i++) spaced.cue(0.05 + i * 0.2, { duration: 0.1 });
    spaced.run(1.2);
    expect(spaced.vs.hopCount).toBe(4); // ≥ 180 ms inter-onset hops without an accent
  });

  test('hopSoftenedWhenPairedOneShotOwnsTranslate', () => {
    const base = hopPeak(1);
    const laugh = hopPeak(1, 'laugh'); // owns translate
    const tilt = hopPeak(1, 'curiousTilt'); // doesn't
    expect(Math.abs(laugh / base - 0.3)).toBeLessThan(0.02);
    expect(Math.abs(tilt - base)).toBeLessThan(1e-4);
  });

  // MARK: Pitch follow

  test('pitchFollowSign', () => {
    function extremes(second: number): { pitch: number; y: number; eyeY: number } {
      const rig = new VocalRig(60);
      rig.cue(0.02, { duration: 0.15, contour: VocalContour.flat(2) });
      rig.cue(0.17, { duration: 0.4, contour: VocalContour.flat(2 + second) });
      let p = 0, y = 0, eye = 1;
      rig.run(0.5, () => {
        if (Math.abs(rig.vs.readout.pitch) > Math.abs(p)) { p = rig.vs.readout.pitch; y = rig.faceYCanvas; eye = rig.s.eyeScaleMul.y; }
      });
      return { pitch: p, y, eyeY: eye };
    }
    const up = extremes(12), down = extremes(-12);
    expect(up.pitch > 9 && up.pitch < 13.5).toBe(true);
    expect(up.y < -0.4 && up.eyeY > 1.01).toBe(true);
    expect(down.pitch).toBeLessThan(-9);
    expect(down.y > 0.4 && down.eyeY < 0.99).toBe(true);
  });

  // MARK: Squint / widen / sleepy / wobble

  test('squintOnlyForHighPositiveNotes', () => {
    expect(peakLower(10, 0.6)).toBeGreaterThan(0.12);
    expect(peakLower(10, 0.6)).toBeLessThanOrEqual(VocalSync.squintMax + 1e-4);
    expect(peakLower(10, -0.6)).toBeLessThan(1e-4);
    expect(peakLower(1, 0.6)).toBeLessThan(1e-4);
  });

  test('widenForStartleAndCurious', () => {
    for (const k of ['startle', 'curious'] as const) {
      const w = widenPeak(k);
      expect(w.scale > 1.035 && w.scale < 1.06).toBe(true);
      expect(w.upper < -0.08 && w.upper > -0.13).toBe(true);
    }
    const plain = widenPeak('plain');
    expect(Math.abs(plain.scale - 1) < 1e-4 && Math.abs(plain.upper) < 1e-4).toBe(true);
    const surprise = widenPeak('startle', 'bigSurprise');
    expect(Math.abs(surprise.scale - 1)).toBeLessThan(1e-4);
  });

  test('sleepyLidDroopFollowsFallingPitch', () => {
    const rig = new VocalRig(60);
    const fall = new VocalContour({ start: 0, end: -10, glideEase: 0 });
    rig.cue(0.02, { duration: 0.5, contour: fall, intensity: 0.5, articulation: 0.1, kind: 'sleepy' });
    const series: number[] = [];
    rig.run(1.2, () => { series.push(rig.s.lidClose); });
    const peak = Math.max(...series);
    expect(peak > 0.2 && peak <= VocalSync.sleepyMaxClose + 1e-5).toBe(true);
    // Rises while the pitch falls (first ~0.4 s), released after the note.
    const early = series[6], mid = series[18];
    expect(mid).toBeGreaterThan(early + 0.05);
    expect(series[series.length - 1]).toBeLessThan(0.01);

    // Crisp articulation or a gentle slope: no droop.
    for (const [art, end] of [[0.9, -10], [0.1, -2]]) {
      const r = new VocalRig(60);
      r.cue(0.02, { duration: 0.5, contour: new VocalContour({ start: 0, end }), articulation: art, kind: 'sleepy' });
      let m = 0;
      r.run(1, () => { m = Math.max(m, r.s.lidClose); });
      expect(m).toBeLessThan(0.01);
    }
  });

  test('wobbleTremblesHorizontally', () => {
    const rig = new VocalRig(120);
    rig.cue(0.02, { duration: 0.8, contour: new VocalContour({ start: 0, end: 0, wobbleDepth: 1, wobbleRate: 4 }), kind: 'wobble' });
    let lo = 0, hi = 0, maxStep = 0, last = 0;
    rig.run(1.2, () => {
      const x = rig.faceXCanvas;
      lo = Math.min(lo, x); hi = Math.max(hi, x); maxStep = Math.max(maxStep, Math.abs(x - last)); last = x;
    });
    expect(lo < -0.1 && hi > 0.1).toBe(true);
    expect(lo >= -0.3 - 1e-5 && hi <= 0.3 + 1e-5).toBe(true);
    expect(maxStep, `${maxStep}`).toBeLessThan(0.13);
    expect(Math.abs(last)).toBeLessThan(1e-3);
  });

  // MARK: Cancel and robustness

  test('cancelFadesWithoutJumpsAndDropsPending', () => {
    const rig = new VocalRig(60);
    rig.cue(0.02, { duration: 1.0, contour: new VocalContour({ start: 0, end: 12 }), intensity: 1, valence: 0.8, kind: 'startle',
      accent: true });
    rig.cue(0.6, { duration: 0.3, intensity: 1, accent: true });
    rig.run(0.3);
    const before = new VocalOutput(rig.s);
    let prev = before;
    rig.engine.send(FaceCommand.cancelVocalCues(rig.host));
    let worstStep = 0;
    rig.run(0.8, () => {
      const o = new VocalOutput(rig.s);
      worstStep = Math.max(worstStep, o.distance(prev));
      prev = o;
    });
    // An 80 ms spring-smoothed fade: no single frame carries more than ~a third of the change (a snap = all of it).
    const total = before.distance(prev);
    expect(total).toBeGreaterThan(0.5);
    expect(worstStep, `largest per-frame change ${worstStep} of total ${total}`).toBeLessThan(0.35 * total);
    expect(rig.vs.activations).toBe(1); // the pending note never started
    expect(rig.vs.activeCueCount === 0 && rig.vs.pendingCueCount === 0).toBe(true);
    expect(prev.distance(new VocalOutput(new FaceState(ExpressionLibrary.bundled(), 0)))).toBeLessThan(0.01);
  });

  test('noNaNUnderHostileInput', () => {
    const rig = new VocalRig(60);
    const wild = new VocalContour({ start: 1e6, end: -1e6, glideOnset: 2, glideEase: -3, scoop: 1e3, scoopTau: 0,
      wobbleDepth: 50, wobbleRate: 1e4, trillDepth: 30, trillRate: 1e5, droop: 1e3, droopFraction: 0 });
    rig.cue(0, { duration: 0, contour: wild, intensity: 50, articulation: -4, valence: 9, kind: 'sleepy', accent: true });
    rig.cue(0.01, { duration: 1e9, contour: wild, intensity: 1, kind: 'wobble' });
    rig.engine.send(FaceCommand.vocalCue(makeVocalCue({ hostTime: NaN, duration: NaN, contour: VocalContour.flat(NaN), intensity: NaN,
      articulation: NaN, valence: NaN })));
    for (let i = 0; i < 40; i++) rig.cue(i * 0.003, { duration: 0.05, contour: VocalContour.flat(Infinity), intensity: 1 });
    for (let i = 0; i < 300; i++) {
      rig.frame(i % 37 === 0 ? 0 : (i % 53 === 0 ? 0.3 : 1.0 / 60));
      expect(new VocalOutput(rig.s).allFinite).toBe(true);
    }
    expect(rig.vs.dropped).toBeGreaterThan(0);
  });

  test('registeredAfterOneShotApplyInMotionPhase', () => {
    const names = new FaceEngine().director.ordered.map((m) => m.name);
    const i = names.indexOf('VocalSync');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(names[i - 1]).toBe('OneShotApply');
    expect(FaceEngine.makeDefaultModifiers().some((m) => m instanceof VocalSync && m.phase === Phase.motion)).toBe(true);
  });
});
