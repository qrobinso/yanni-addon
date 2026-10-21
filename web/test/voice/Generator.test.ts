// Port of Tests/FaceVoiceTests/GeneratorTests.swift.
import { expect, test } from 'vitest';
import { VocalContour } from '../../src/model';
import { Note, PhraseGenerator, PhraseShaping, VoiceAffect, VoiceFingerprint, allVoiceReactions } from '../../src/voice';
import { fresh, last, mean, noteList, padGrid, pitch, tonal, tonalNotes } from './voiceTestSupport';

const R = allVoiceReactions;
// Swift `Float.sign` (.plus for +0).
const sgn = (x: number): number => (x < 0 || Object.is(x, -0) ? -1 : 1);

test('deterministicPerSeed', () => {
  const a = new PhraseGenerator(VoiceFingerprint.default, 42n);
  const b = new PhraseGenerator(VoiceFingerprint.default, 42n);
  const c = new PhraseGenerator(VoiceFingerprint.default, 43n);
  let anyDiff = false;
  for (let i = 0; i < 200; i++) {
    const r = R[i % R.length];
    const aff = padGrid[i % padGrid.length];
    const pa = a.make(r, aff), pb = b.make(r, aff), pc = c.make(r, aff);
    expect(pa.equals(pb)).toBe(true);
    if (!pa.equals(pc)) anyDiff = true;
  }
  expect(anyDiff).toBe(true);
});

test('rangesAlwaysRespected', () => {
  const narrow = VoiceFingerprint.default; narrow.rangeSemitones = 5;
  const lowCap = VoiceFingerprint.default; lowCap.maxPitchHz = 900;   // ≈ +5.4 st
  for (const fp of [VoiceFingerprint.default, narrow, lowCap]) {
    const g = new PhraseGenerator(fp, 7n);
    const hiCap = Math.min(fp.rangeSemitones, 12 * Math.log2(fp.maxPitchHz / fp.basePitchHz));
    for (let i = 0; i < 1500; i++) {
      const r = R[i % R.length];
      const aff = padGrid[Math.floor(i / 13) % padGrid.length];
      const p = g.make(r, aff);
      expect(p.notes.length >= 1 && p.notes.length <= 8).toBe(true);
      let prevEnd = -1;
      for (const n of noteList(p)) {
        expect(n.duration >= 0.04 - 1e-5 && n.duration <= 0.9 + 1e-5, `${r} dur ${n.duration}`).toBe(true);
        expect(n.start >= prevEnd - 1e-4, `${r} overlapping notes`).toBe(true);
        prevEnd = n.start + n.duration;
        expect(n.gain > 0 && n.gain <= 1).toBe(true);
        const v = n.duration >= 0.16 ? n.modulation.vibratoDepth : 0;
        if (n.duration < 0.16) expect(n.modulation.vibratoDepth).toBe(0);
        for (let k = 0; k <= 200; k++) {
          const x = pitch(n, k / 200);
          if (!(x + v <= hiCap + 0.05)) expect.fail(`${r} pitch ${x} above ${hiCap}`);
          if (!(x - v >= -fp.rangeSemitones - 0.05)) expect.fail(`${r} pitch ${x} below range`);
        }
      }
    }
  }
});

test('fittingPreservesContourDirection', () => {
  // Same seed, wide vs narrow range: the first phrase draws identical randomness, so intervals must keep
  // their direction (compression + shift, never per-note clamps → no plateaus).
  const narrow = VoiceFingerprint.default;
  narrow.rangeSemitones = 3;
  let compressed = 0;
  for (let seed = 0; seed < 300; seed++) {
    for (const r of R) {
      const aff = padGrid[seed % padGrid.length];
      const wide = tonalNotes(fresh(r, aff, seed));
      const tight = tonalNotes(fresh(r, aff, seed, narrow));
      expect(wide.length).toBe(tight.length);
      if (wide.length !== tight.length) continue;
      for (let i = 0; i < wide.length; i++) {
        const gw = wide[i].contour.end - wide[i].contour.start;
        const gt = tight[i].contour.end - tight[i].contour.start;
        if (Math.abs(gw) > 0.05) expect(sgn(gw), `${r} glide flipped`).toBe(sgn(gt));
        if (i > 0) {
          const dw = wide[i].contour.start - wide[i - 1].contour.start;
          const dt = tight[i].contour.start - tight[i - 1].contour.start;
          if (Math.abs(dw) > 0.05) {
            expect(sgn(dw), `${r} interval flipped`).toBe(sgn(dt));
            expect(Math.abs(dt) > 0.01, `${r} plateau`).toBe(true);
            expect(Math.abs(dt) <= Math.abs(dw) + 1e-3).toBe(true);
            if (Math.abs(dt) < Math.abs(dw) - 1e-3) compressed += 1;
          }
        }
      }
    }
  }
  expect(compressed > 0).toBe(true);
});

test('fitCompressesThenShifts', () => {
  const fp = VoiceFingerprint.default;
  fp.rangeSemitones = 4;
  const notes = [new Note({ start: 0, duration: 0.1, contour: VocalContour.flat(2) }),
    new Note({ start: 0.12, duration: 0.1, contour: VocalContour.flat(14) }),
    new Note({ start: 0.24, duration: 0.1, contour: VocalContour.flat(8) })];
  PhraseShaping.fit(notes, fp);
  const ps = notes.map((n) => n.contour.start);
  expect(ps[0] < ps[2] && ps[2] < ps[1]).toBe(true);
  expect(ps[1] <= 4 && ps[0] >= -4).toBe(true);
  expect(Math.abs((ps[1] - ps[0]) - 7.96) < 0.01).toBe(true);         // span compressed to the available 8 st − margins
  // Ratio of intervals preserved.
  expect(Math.abs((ps[2] - ps[0]) / (ps[1] - ps[0]) - 0.5) < 1e-3).toBe(true);
});

test('accentsOnFirstPeakLastAndLongIntervals', () => {
  const g = new PhraseGenerator(VoiceFingerprint.default, 3n);
  for (let i = 0; i < 300; i++) {
    const r = R[i % R.length];
    const p = g.make(r, padGrid[i % padGrid.length]);
    const ns = noteList(p);
    const firstTonal = ns.findIndex(tonal);
    expect(firstTonal).toBeGreaterThanOrEqual(0);
    expect(ns[firstTonal].accent).toBe(true);
    expect(last(ns).accent).toBe(true);
    for (let k = 1; k < ns.length; k++) if (ns[k].start - ns[k - 1].start >= 0.18) expect(ns[k].accent).toBe(true);
    const ai = PhraseGenerator.alignNoteIndex(p);
    expect(ai >= 0 && ai < ns.length).toBe(true);
  }
});

test('timbreAndEnvelopeFilled', () => {
  const fp = VoiceFingerprint.default;
  const g = new PhraseGenerator(fp, 11n);
  for (let i = 0; i < 300; i++) {
    const r = R[i % R.length];
    const p = g.make(r, padGrid[i % padGrid.length]);
    for (const n of tonalNotes(p)) {
      expect(n.timbre.fmRatio).toBe(fp.fmRatio);
      expect(n.timbre.fmIndexPeak >= 2.5 - 1e-4 && n.timbre.fmIndexPeak <= 4 + 1e-4).toBe(true);
      expect(n.timbre.fmIndexSustain >= 0.6 * 0.8 && n.timbre.fmIndexSustain <= 1.0 + 1e-4).toBe(true);
      expect(n.timbre.filterEnvOctaves).toBe(1.5);
      expect(n.envelope.attackTau > 0 && n.envelope.attackTau < 0.06).toBe(true);
      expect(n.envelope.release >= 0.04 - 1e-4 && n.envelope.release <= 0.12 + 1e-4).toBe(true);
      expect(n.envelope.sustain >= 0.65 - 1e-4 && n.envelope.sustain <= 0.8 + 1e-4).toBe(true);
      if (n.modulation.vibratoDepth > 0) {
        expect(n.duration >= 0.16).toBe(true);
        expect(n.modulation.vibratoDelay >= 0.06).toBe(true);
      }
    }
  }
});

test('declinationLowersLaterNotes', () => {
  // Flat repeated template (danceBeat pattern aside): emote at P=0 should drift down on average.
  const drops: number[] = [];
  for (let seed = 0; seed < 400; seed++) {
    const ns = tonalNotes(fresh('emote', VoiceAffect.make(0, 0.8, 0.5), seed));
    if (ns.length < 4) continue;
    drops.push(last(ns).contour.start - ns[0].contour.start);
  }
  expect(mean(drops) < 0).toBe(true);
});

test('doesNotTouchFaceRandomness', () => {
  // The generator owns its RNG: making phrases is a pure function of (seed, calls).
  const a = new PhraseGenerator(VoiceFingerprint.default, 99n);
  a.make('delighted', VoiceAffect.neutral);
  const x = a.make('curious', VoiceAffect.neutral);
  const b = new PhraseGenerator(VoiceFingerprint.default, 99n);
  b.make('delighted', VoiceAffect.neutral);
  expect(b.make('curious', VoiceAffect.neutral).equals(x)).toBe(true);
});
