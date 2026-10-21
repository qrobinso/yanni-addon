// Port of Tests/FaceVoiceTests/BabbleVariationTests.swift.
// Babble feeling (PAD through the shared mapping), identity, determinism and novelty.
import { describe, expect, test } from 'vitest';
import {
  BabbleSeed, Novelty, NoteBuffer, PhraseGenerator, VoiceAffect, VoiceFingerprint, makeBabbleRequest,
  type BabblePlan, type Note, type Signature,
} from '../../src/voice';
import { babble, babbleCorpus, last, longReply, notesOf, padGrid, pitchAt } from './voiceTestSupport';

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe('BabbleFeelingTests', () => {
  const text = 'I turned on the kitchen lights for you, and the hallway too.';

  const mean = (a: VoiceAffect, f: (p: BabblePlan) => number, seeds = 40): number => {
    let s = 0;
    for (let i = 0; i < seeds; i++) s += f(babble(text, a, { seed: BigInt(i) * 977n + 3n, gen: BigInt(i) + 11n, cap: 30, budget: 60 }));
    return s / seeds;
  };
  const notes = (p: BabblePlan): Note[] => p.items.flatMap((it) => notesOf(it.phrase));

  test('pleasureBrightensAndRaises', () => {
    const sad = VoiceAffect.make(-0.8, 0, 0);
    const happy = VoiceAffect.make(0.8, 0, 0);
    const cut = (p: BabblePlan): number => { const n = notes(p); return sum(n.map((x) => x.timbre.cutoff)) / n.length; };
    const reg = (p: BabblePlan): number => { const n = notes(p); return sum(n.map((x) => (x.contour.start + x.contour.end) / 2)) / n.length; };
    const vowel = (p: BabblePlan): number => { const n = notes(p); return sum(n.map((x) => x.timbre.vowelEnd)) / n.length; };
    expect(mean(happy, cut) > mean(sad, cut) + 0.2, 'brighter when happy').toBe(true);
    expect(mean(happy, reg) > mean(sad, reg) + 1, 'higher when happy').toBe(true);
    expect(mean(happy, vowel) > mean(sad, vowel), 'toward "ee" when happy').toBe(true);
  });

  test('arousalQuickensAndWidens', () => {
    const calm = VoiceAffect.make(0.2, -0.8, 0.1);
    const excited = VoiceAffect.make(0.2, 0.8, 0.1);
    const dur = (p: BabblePlan): number => { const n = notes(p); return sum(n.map((x) => x.duration)) / n.length; };
    const step = (p: BabblePlan): number => {
      let s = 0, k = 0;
      for (const it of p.items) {
        const n = notesOf(it.phrase);
        for (let i = 1; i < n.length; i++) { s += Math.abs(n[i].contour.start - n[i - 1].contour.start); k += 1; }
      }
      return k > 0 ? s / k : 0;
    };
    expect(mean(excited, dur) < mean(calm, dur) * 0.8, 'quicker notes').toBe(true);
    expect(mean(excited, (p) => p.babbleNoteCount) > mean(calm, (p) => p.babbleNoteCount), 'more notes').toBe(true);
    expect(mean(excited, step) > mean(calm, step), 'wider steps').toBe(true);
    expect(mean(excited, (p) => p.duration) < mean(calm, (p) => p.duration), 'a quicker reply').toBe(true);
  });

  test('dominanceFirmsAndLowDominanceWobbles', () => {
    const firm = VoiceAffect.make(0.1, 0.2, 0.9);
    const unsure = VoiceAffect.make(0.1, 0.2, -0.9);
    const wob = (p: BabblePlan): number => sum(notes(p).map((x) => x.contour.wobbleDepth));
    const att = (p: BabblePlan): number => { const n = notes(p); return sum(n.map((x) => x.envelope.attackTau)) / n.length; };
    const loud = (p: BabblePlan): number => Math.max(...notes(p).map((x) => x.gain));
    expect(mean(unsure, wob) > mean(firm, wob)).toBe(true);
    expect(mean(firm, att) < mean(unsure, att)).toBe(true);
    expect(mean(firm, loud) > mean(unsure, loud)).toBe(true);
  });

  test('theFingerprintIsTheSameCreature', () => {
    const fp = VoiceFingerprint.default;
    fp.fmRatio = 2.0 / 3; fp.sine = 0.2; fp.fm = 0.8; fp.vibratoRateHz = 5.5; fp.rangeSemitones = 6;
    const g = new PhraseGenerator(fp, 3n);
    const p = g.makeBabble(makeBabbleRequest({ text: longReply, affect: VoiceAffect.make(0.6, 0.9, 0), seed: 9n }));
    for (const it of p.items) {
      for (const n of notesOf(it.phrase)) {
        expect(n.timbre.fmRatio === fp.fmRatio && n.timbre.sine === fp.sine && n.timbre.fm === fp.fm).toBe(true);
        expect(n.timbre.formantAmount).toBe(fp.formantAmount);
        for (let k = 0; k <= 20; k++) {
          const x = pitchAt(n, k / 20);
          expect(x <= fp.rangeSemitones + 0.05 && x >= -fp.rangeSemitones - 0.05, 'fitted into the range').toBe(true);
        }
      }
    }
  });
});

describe('BabbleDeterminismTests', () => {
  test('sameSeedSamePhrases', () => {
    babbleCorpus.forEach((text, i) => {
      const o = { seed: 42n, gen: 5n, answer: i % 3 === 0 ? 'mmHm' as const : null };
      const a = babble(text, padGrid[i % padGrid.length], o);
      const b = babble(text, padGrid[i % padGrid.length], o);
      expect(a).toEqual(b);
    });
  });

  test('otherSeedsOrALaterReplyNeverSoundTheSame', () => {
    const text = 'Sure, I turned on the kitchen lights.';
    // Different turns (seeds), fresh generators: different babble.
    const seen: Note[][] = [];
    for (let seed = 0; seed < 30; seed++) {
      const notes = babble(text, VoiceAffect.neutral, { seed: BabbleSeed.make(`turn-${seed}`), gen: 7n }).items.flatMap((it) => notesOf(it.phrase));
      expect(seen.some((s) => NoteBuffer.equals(s, notes)), `seed ${seed} repeated an earlier reply`).toBe(false);
      seen.push(notes);
    }
    // The same generator, the same text, even the same seed again: novelty keeps them apart.
    const g = new PhraseGenerator(VoiceFingerprint.default, 7n);
    let prev: Signature[] = [];
    for (let k = 0; k < 12; k++) {
      const p = g.makeBabble(makeBabbleRequest({ text, affect: VoiceAffect.neutral, seed: 1n }));
      const sigs = p.items.map((it) => Novelty.signature(it.phrase));
      if (prev.length > 0) {
        expect(sigs).not.toEqual(prev);
        for (let i = 0; i < Math.min(sigs.length, prev.length); i++) expect(Novelty.distance(sigs[i], prev[i]) > 0.01).toBe(true);
      }
      prev = sigs;
    }
  });

  test('turnSeedsAreStable', () => {
    expect(BabbleSeed.make('01HZXYZ')).toBe(BabbleSeed.make('01HZXYZ'));
    expect(BabbleSeed.make('01HZXYZ')).not.toBe(BabbleSeed.make('01HZXY0'));
    expect(BabbleSeed.make('t', 0)).not.toBe(BabbleSeed.make('t', 1));
  });

  test('genericBabbleBehavesLikeAReaction', () => {
    const g = new PhraseGenerator(VoiceFingerprint.default, 2n);
    for (let i = 0; i < 200; i++) {
      const p = g.make('babble', padGrid[i % padGrid.length]);
      expect(p.notes.length >= 2 && p.notes.length <= 8).toBe(true);
      const l = last(notesOf(p));
      expect(l.contour.end - l.contour.start < 1.5, 'a statement, not a question').toBe(true);
    }
  });
});
