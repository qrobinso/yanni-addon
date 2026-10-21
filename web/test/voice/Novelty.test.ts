// Port of Tests/FaceVoiceTests/NoveltyTests.swift.
import { expect, test } from 'vitest';
import {
  Novelty, NoteBuffer, PhraseGenerator, VoiceAffect, VoiceFingerprint, VoiceRNG, allVoiceReactions,
  type Phrase, type Signature, type VoiceReaction,
} from '../../src/voice';
import { notesOf } from './voiceTestSupport';

const R = allVoiceReactions;

test('neverRepeatsAndStaysNovelOver1000', () => {
  const g = new PhraseGenerator(VoiceFingerprint.default, 2024n);
  const rng = new VoiceRNG(9n);
  let lastP: Phrase | null = null;
  const history = new Map<VoiceReaction, Signature[]>();
  let below = 0;
  for (let i = 0; i < 1000; i++) {
    // Bursts of the same kind stress the same-kind check.
    const r = R[Math.floor(i / 4) % R.length];
    const a = VoiceAffect.make(rng.sym(1), rng.sym(1), rng.sym(1));
    const p = g.make(r, i % 8 < 4 ? VoiceAffect.neutral : a);
    if (lastP) expect(NoteBuffer.equals(notesOf(lastP), notesOf(p)), `identical consecutive at ${i}`).toBe(false);
    lastP = p;
    const s = Novelty.signature(p);
    for (const h of history.get(r) ?? []) if (Novelty.distance(s, h) < Novelty.threshold) below += 1;
    const list = [...(history.get(r) ?? [])];
    list.push(s);
    if (list.length > 3) list.shift();
    history.set(r, list);
  }
  expect(below <= 10, `phrases too close to recent same-kind: ${below}`).toBe(true);
});

test('sameAffectSameKindVaries', () => {
  for (const r of R) {
    const g = new PhraseGenerator(VoiceFingerprint.default, 5n);
    let prev = Novelty.signature(g.make(r, VoiceAffect.neutral));
    for (let k = 0; k < 50; k++) {
      const s = Novelty.signature(g.make(r, VoiceAffect.neutral));
      expect(Novelty.distance(s, prev) >= Novelty.threshold * 0.9, `${r} too similar`).toBe(true);
      prev = s;
    }
  }
});

test('rngDeterministicAndUniformish', () => {
  const a = new VoiceRNG(1n), b = new VoiceRNG(1n);
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    const x = a.unit();
    expect(x).toBe(b.unit());
    expect(x >= 0 && x < 1).toBe(true);
    sum += x;
  }
  expect(Math.abs(sum / 10000 - 0.5) < 0.02).toBe(true);
});
