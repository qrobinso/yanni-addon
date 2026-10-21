// Port of Tests/FaceVoiceTests/SynthTests.swift.
// Offline renders of the synthesizer: levels, pitch, envelopes, slurs, formants, stability.
import { describe, expect, test } from 'vitest';
import { VocalContour } from '../../src/model';
import { Note, makeTimbre, type Phrase } from '../../src/voice';
import { Fx } from './RendererFixtures';

const fs = 48000;

/// A typical phrase with default (generator-like) timbre, envelope and modulation.
function neutralPhrase(): Phrase {
  return Fx.phrase([
    new Note({ start: 0, duration: 0.12, contour: new VocalContour({ start: 0, end: 2, scoop: 1.2 }) }),
    new Note({ start: 0.15, duration: 0.25, contour: new VocalContour({ start: 2, end: 4, scoop: 1.2 }), slur: true }),
  ]);
}

/// Two notes at 1000 Hz then 1000·2^(2/12) Hz; returns the quadrature envelope around the boundary.
function boundary(slur: boolean): { x: Float32Array; env: Float32Array; boundary: number } {
  const p = Fx.phrase([
    Fx.sineNote({ start: 0, duration: 0.2, pitch: 0 }),
    Fx.sineNote({ start: 0.2, duration: 0.2, pitch: 0, slur }),
  ]);
  const x = Fx.renderPhrase(p, { base: 1000, seconds: 0.5, delay: 0 });
  return { x, env: Fx.quadratureEnvelope(x, 48), boundary: Math.trunc(0.2 * fs) };
}

const minOf = (x: Float32Array): number => x.reduce((a, b) => Math.min(a, b), Infinity);

describe('SynthTests', () => {
  test('neutralPhrasePeaksNearMinus6dBFS', () => {
    const x = Fx.renderPhrase(neutralPhrase(), { seconds: 0.6 });
    const p = Fx.peak(x);
    expect(Fx.allFinite(x)).toBe(true);
    expect(Fx.dB(p) > -9 && Fx.dB(p) < -3).toBe(true);
  });

  test('loudOverlapsAreFiniteAndBelowFullScale', () => {
    const r = Fx.renderer({ loudness: 1 });
    const t = makeTimbre({ square: 1, resonance: 1, cutoff: 1, noiseDB: -6, formantAmount: 1 });
    const n = new Note({ start: 0, duration: 0.4, contour: new VocalContour({ start: 0, end: 12 }), timbre: t, gain: 1, accent: true });
    for (let i = 0; i < 3; i++) r.enqueue(Fx.phrase([n], i), Fx.host0 + Fx.ticks(0.01 + 0.01 * i));
    const x = Fx.render(r, 0.6);
    expect(Fx.allFinite(x)).toBe(true);
    expect(Fx.peak(x)).toBeLessThanOrEqual(1);
  });

  test('steadySinePitchWithin10Cents', () => {
    const base = 440;
    const p = Fx.phrase([Fx.sineNote({ start: 0, duration: 0.8, pitch: 3 })]);
    const x = Fx.renderPhrase(p, { base, seconds: 0.9 });
    const hz = Fx.autocorrelationPitch(x.subarray(19200, 28800), fs);
    const target = base * Math.pow(2, 3.0 / 12);
    const cents = 1200 * Math.log2(hz / target);
    expect(Math.abs(cents)).toBeLessThan(10);
  });

  test('maxPitchCapLimitsFundamental', () => {
    const p = Fx.phrase([Fx.sineNote({ start: 0, duration: 0.5, pitch: 24 })]);
    const x = Fx.renderPhrase(p, { base: 660, maxHz: 1200, seconds: 0.5 });
    const hz = Fx.autocorrelationPitch(x.subarray(9600, 19200), fs, 300);
    expect(Math.abs(1200 * Math.log2(hz / 1200))).toBeLessThan(10);
  });

  test('envelopeTimingWithin1ms', () => {
    // 1000 Hz at 48 kHz: period 48 samples → exact quadrature envelope.
    const tau = 0.02, dur = 0.3, rel = 0.1;
    const p = Fx.phrase([Fx.sineNote({ start: 0, duration: dur, envelope: Fx.flatEnvelope({ attack: tau, release: rel }) })]);
    const delay = 0.01;
    const x = Fx.renderPhrase(p, { base: 1000, seconds: 0.5, delay });
    const e = Fx.quadratureEnvelope(x, 48);
    const start = Math.trunc(delay * fs);
    const steady = e[start + Math.trunc(0.25 * fs)];
    const firstFrom = (from: number, to: number, pred: (i: number) => boolean): number => {
      for (let i = from; i < to; i++) if (pred(i)) return i;
      throw new Error('not found');
    };
    // Attack: 1 − e^(−t/τ) reaches 63.2% at τ (the envelope estimate lags by ~6 samples).
    const tA = (firstFrom(start, start + 9600, (i) => e[i] >= 0.632 * steady) - start - 6) / fs;
    // Release: τr = release/5 → falls to 1/e of the level at `dur` after release/5.
    const endIdx = start + Math.trunc(dur * fs);
    const relThreshold = steady / Math.E;
    const relIdx = firstFrom(endIdx, x.length, (i) => e[i] <= relThreshold);
    const tR = (relIdx - endIdx - 6) / fs;
    expect(Math.abs(tA - tau)).toBeLessThan(0.001);
    expect(Math.abs(tR - rel / 5)).toBeLessThan(0.001);
    // Silent before start and after the release.
    expect(Fx.peak(x.subarray(0, start))).toBe(0);
    expect(Fx.peak(x.subarray(endIdx + Math.trunc(rel * fs) + 64))).toBeLessThan(1e-6);
  });

  test('glideDirection', () => {
    const up = Fx.phrase([Fx.sineNote({ start: 0, duration: 0.4, contour: new VocalContour({ start: 0, end: 7, glideEase: 0 }) })]);
    const down = Fx.phrase([Fx.sineNote({ start: 0, duration: 0.4, contour: new VocalContour({ start: 7, end: 0, glideEase: 0 }) })]);
    for (const [p, rising] of [[up, true], [down, false]] as const) {
      const x = Fx.renderPhrase(p, { base: 440, seconds: 0.45, delay: 0 });
      const early = Fx.zeroCrossingHz(x.subarray(960, 4800), fs);
      const late = Fx.zeroCrossingHz(x.subarray(14400, 18720), fs);
      expect(rising ? late > early * 1.3 : late < early / 1.3).toBe(true);
    }
  });

  test('slurHasNoReattackButNonSlurHardStops', () => {
    const s = boundary(true);
    const h = boundary(false);
    const level = s.env[s.boundary - 960];
    const sMin = minOf(s.env.subarray(s.boundary - 96, s.boundary + 960));
    const hMin = minOf(h.env.subarray(h.boundary - 96, h.boundary + 960));
    // Slur: dips toward ~0.35 but never re-attacks from silence.
    expect(sMin / level > 0.25 && sMin / level < 0.6).toBe(true);
    // Non-slur: the 3 ms stop takes the level to ~0 at the onset.
    expect(hMin / level).toBeLessThan(0.03);
    // Both are click-free.
    const bound = (1.3 * 2 * Math.PI * 1000 / fs) * level;
    expect(Fx.maxDelta(s.x)).toBeLessThan(bound);
    expect(Fx.maxDelta(h.x)).toBeLessThan(bound);
  });

  test('noClicksAcrossMixedNoteBoundaries', () => {
    const p = Fx.phrase([
      Fx.sineNote({ start: 0, duration: 0.08, pitch: 0 }),
      Fx.sineNote({ start: 0.08, duration: 0.1, pitch: 4, slur: true }),
      Fx.sineNote({ start: 0.2, duration: 0.07, pitch: -3 }),
      Fx.sineNote({ start: 0.27, duration: 0.2, pitch: 7, slur: true }),
      Fx.sineNote({ start: 0.47, duration: 0.1, pitch: 2 }),
    ]);
    const x = Fx.renderPhrase(p, { base: 600, seconds: 0.8 });
    const fmax = 600 * Math.pow(2, 7.0 / 12);
    const bound = (1.3 * 2 * Math.PI * fmax / fs) * Fx.peak(x);
    expect(Fx.maxDelta(x)).toBeLessThan(bound);
  });

  test('formantVowelShiftsEnergyTowardF2', () => {
    const render = (vowel: number): Float32Array => {
      const t = makeTimbre({
        sine: 0, fm: 1, fmIndexPeak: 3, fmIndexSustain: 3, cutoff: 1, filterEnvOctaves: 0,
        noiseDB: -200, formantAmount: 1, vowelStart: vowel, vowelEnd: vowel,
      });
      const n = new Note({ start: 0, duration: 0.4, contour: VocalContour.flat(0), timbre: t, modulation: Fx.noVibrato() });
      return Fx.renderPhrase(Fx.phrase([n]), { base: 300, seconds: 0.4, delay: 0 });
    };
    const ee = render(1), oo = render(0);
    const band = (x: Float32Array): number =>
      [2100.0, 2400, 2700].reduce((a, hz) => a + Fx.goertzel(x.subarray(4800, 16800), hz, fs), 0);
    const low = (x: Float32Array): number => Fx.goertzel(x.subarray(4800, 16800), 1200, fs);
    const ratio = 10 * Math.log10((band(ee) / low(ee)) / (band(oo) / low(oo)));
    expect(ratio).toBeGreaterThan(6);
  });

  test.each([16000.0, 24000, 44100, 48000])('stableAtSampleRates(rate: %d)', (rate) => {
    const t = makeTimbre({ cutoff: 1, filterEnvOctaves: 4, resonance: 1, square: 0.5, formantAmount: 1, noiseDB: -10 });
    const notes: Note[] = [];
    for (let i = 0; i < 6; i++) {
      const c = new VocalContour({ start: i * 3, end: i * 3 + 5 });
      notes.push(new Note({ start: i * 0.07, duration: 0.07, contour: c, timbre: t, slur: i % 2 === 1 }));
    }
    const x = Fx.renderPhrase(Fx.phrase(notes), { fs: rate, base: 1200, maxHz: 20000, seconds: 0.8 });
    expect(Fx.allFinite(x)).toBe(true);
    expect(Fx.peak(x)).toBeLessThanOrEqual(1);
    expect(Fx.peak(x)).toBeGreaterThan(0.05);
    expect(Fx.peak(x.subarray(Math.trunc(0.7 * rate)))).toBeLessThan(1e-6);
  });

  test('timeStretchDoublesDurationsAtSamePitch', () => {
    const p = Fx.phrase([Fx.sineNote({ start: 0, duration: 0.2, pitch: 0, envelope: Fx.flatEnvelope({ release: 0.05 }) })]);
    const lastAudible = (x: Float32Array): number => {
      for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) > 1e-3) return i;
      return 0;
    };
    const a = Fx.renderPhrase(p, { base: 440, seconds: 0.8, delay: 0, stretch: 1 });
    const b = Fx.renderPhrase(p, { base: 440, seconds: 0.8, delay: 0, stretch: 2 });
    const ratio = lastAudible(b) / lastAudible(a);
    expect(Math.abs(ratio - 2)).toBeLessThan(0.05);
    const pa = Fx.autocorrelationPitch(a.subarray(2400, 7200), fs);
    const pb = Fx.autocorrelationPitch(b.subarray(4800, 14400), fs);
    expect(Math.abs(1200 * Math.log2(pb / pa))).toBeLessThan(5);
  });

  test('mutedRendersSilenceAndVolumeScales', () => {
    const p = neutralPhrase();
    const r = Fx.renderer();
    r.setMuted(true);
    r.enqueue(p, Fx.host0);
    expect(Fx.peak(Fx.render(r, 0.5))).toBe(0);

    // Muting mid-phrase reaches silence within the 20 ms ramp.
    const r2 = Fx.renderer();
    r2.enqueue(Fx.phrase([Fx.sineNote({ start: 0, duration: 0.5 })]), Fx.host0);
    const x = Fx.render(r2, 0.4, { before: (n) => { if (n === 9728) r2.setMuted(true); } });
    expect(Fx.peak(x.subarray(0, 9728))).toBeGreaterThan(0.1);
    expect(Fx.peak(x.subarray(9728 + 1024))).toBe(0);
    expect(Fx.maxDelta(x)).toBeLessThan(0.1);

    // Half volume = −20 dB.
    const full = Fx.peak(Fx.renderPhrase(p, { seconds: 0.5 }));
    const r3 = Fx.renderer();
    r3.setVolume(0.5);
    r3.enqueue(p, Fx.host0 + Fx.ticks(0.01));
    const half = Fx.peak(Fx.render(r3, 0.5));
    expect(Math.abs(Fx.dB(half) - Fx.dB(full) + 20)).toBeLessThan(0.5);
  });
});
