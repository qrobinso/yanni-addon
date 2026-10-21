// Port of Tests/FaceVoiceTests/BabbleTests.swift.
// Text-driven babble (direct Home Assistant design §7.2, §18 FaceVoiceTests).
import { describe, expect, test } from 'vitest';
import { BabbleText, NoteBuffer, SyllableCounter, VoiceAffect, lastNoteEnd } from '../../src/voice';
import { babble, babbleCorpus, last, lastPhraseNotes, longReply, notesOf, padGrid } from './voiceTestSupport';

describe('SyllableTests', () => {
  test('countsWordsRoughlyRight', () => {
    const cases: [string, number][] = [['hello', 2], ['the', 1], ['kitchen', 2], ['make', 1], ['table', 2], ['free', 1],
      ['you', 1], ['beautiful', 3], ['temperature', 4], ['lights', 1], ['123', 3],
      ["it's", 1], ['turned', 1], ['wanted', 2], ['makes', 1], ['boxes', 2],
      ['minutes', 2], ['你好世界', 2]];
    for (const [w, n] of cases) expect(SyllableCounter.countWord(w), w).toBe(n);
    expect(SyllableCounter.count('I turned on the kitchen lights.')).toBe(7);   // I turned on the kit-chen lights
    expect(SyllableCounter.count('...')).toBe(0);
  });

  test('splitsSentencesClausesAndEndings', () => {
    const t = new BabbleText('Sure, I turned on the lights. Want anything else? Dr. Smith is here! Done');
    expect(t.sentences.length).toBe(4);
    expect(t.sentences.map((s) => s.ending)).toEqual(['statement', 'question', 'exclamation', 'statement']);
    expect(t.sentences[0].clauses.length === 2 && t.sentences[0].clauses[0].endsWithComma).toBe(true);
    expect(t.sentences[0].clauses[1].endsWithComma).toBe(false);
    expect(t.sentences[2].clauses[0].words.length).toBe(4);   // "Dr." didn't end the sentence
    expect(BabbleText.sentenceStrings('Hi there. How are you? Fine!')).toEqual(['Hi there.', 'How are you?', 'Fine!']);
    expect(new BabbleText('3.5 degrees.').sentences.length).toBe(1);
  });
});

describe('BabbleShapeTests', () => {
  test('noteCountScalesWithSyllables', () => {
    for (const a of [VoiceAffect.make(0.2, -0.6, 0), VoiceAffect.neutral, VoiceAffect.make(0.4, 0.8, 0.3)]) {
      let prev = 0;
      for (const text of babbleCorpus) {
        // Caps lifted: the raw rule, about one note per 1–2 syllables.
        const p = babble(text, a, { cap: 30, budget: 60 });
        const s = p.syllables;
        expect(p.babbleNoteCount >= prev, `${text}: ${p.babbleNoteCount} < ${prev}`).toBe(true);
        expect(p.babbleNoteCount >= Math.max(2, Math.trunc(s / 2)) && p.babbleNoteCount <= Math.max(2, s + p.sentences),
          `${s} syllables → ${p.babbleNoteCount} notes`).toBe(true);
        prev = p.babbleNoteCount;
      }
    }
    // Excited speaks more notes for the same text than calm.
    const text = babbleCorpus[4];
    expect(babble(text, VoiceAffect.make(0, 0.9, 0), { cap: 30 }).babbleNoteCount
      > babble(text, VoiceAffect.make(0, -0.9, 0), { cap: 30 }).babbleNoteCount).toBe(true);
  });

  test('phrasesHoldAtMostEightNotesAndSentencesAtLeastTwo', () => {
    padGrid.forEach((a, i) => {
      for (const text of [...babbleCorpus, longReply]) {
        const p = babble(text, a, { seed: BigInt(i), cap: i % 2 === 0 ? 1.5 : 30, budget: 60 });
        for (const it of p.items) {
          expect(it.phrase.notes.length >= 1 && it.phrase.notes.length <= NoteBuffer.capacity).toBe(true);
          expect(it.phrase.reaction).toBe('babble');
        }
        for (let s = 0; s < p.sentences; s++) {
          const n = p.items.filter((it) => it.sentence === s).reduce((acc, it) => acc + it.phrase.notes.length, 0);
          expect(n >= 2, `sentence ${s} has ${n} notes`).toBe(true);
        }
        // Phrases never overlap, notes never overlap.
        let prevEnd = -1;
        for (const it of p.items) {
          for (const n of notesOf(it.phrase)) {
            expect(it.offset + n.start >= prevEnd - 1e-4).toBe(true);
            prevEnd = it.offset + n.start + n.duration;
          }
        }
      }
    });
  });

  test('capsHoldForLongText', () => {
    padGrid.forEach((a, i) => {
      const p = babble(longReply, a, { seed: BigInt(i) * 31n, budget: 6 });
      expect(p.sentences >= 1).toBe(true);
      for (const d of p.sentenceDurations) expect(d <= 1.5 + 1e-3, `sentence ${d} s`).toBe(true);
      expect(p.duration <= 6 + 1e-3, `reply ${p.duration} s`).toBe(true);
      expect(p.droppedSentences > 0 && p.compressed).toBe(true);
    });
    // A tighter cap is honoured too, and babble compresses rather than transcribing.
    const tight = babble(babbleCorpus[6], VoiceAffect.neutral, { cap: 0.8, budget: 60 });
    expect(tight.sentenceDurations.every((d) => d <= 0.8 + 1e-3)).toBe(true);
    expect(tight.babbleNoteCount < tight.syllables).toBe(true);
  });

  test('questionEndsRising', () => {
    padGrid.forEach((a, i) => {
      const p = babble('Do you want the lights on?', a, { seed: BigInt(i) });
      const l = last(lastPhraseNotes(p));
      expect(l.contour.end - l.contour.start >= 3, `rise ${l.contour.end - l.contour.start}`).toBe(true);
      expect(l.contour.glideOnset > 0.2 && l.contour.droop === 0).toBe(true);
    });
  });

  test('exclamationEndsBrightAndAccented', () => {
    padGrid.forEach((a, i) => {
      const ns = lastPhraseNotes(babble('That is wonderful news!', a, { seed: BigInt(i) }));
      const l = last(ns);
      expect(l.accent).toBe(true);
      expect(l.gain >= Math.max(...ns.map((n) => n.gain)) * 0.97, 'final note is the loudest').toBe(true);
      const others = ns.slice(0, -1).map((n) => n.timbre.cutoff);
      const m = others.reduce((x, y) => x + y, 0) / Math.max(others.length, 1);
      expect(l.timbre.cutoff >= Math.min(1, m + 0.05) - 1e-4, 'brighter (the cutoff saturates at 1)').toBe(true);
      expect(l.contour.end > l.contour.start, 'a little upward flick').toBe(true);
    });
  });

  test('commaLiftsAndPauses', () => {
    padGrid.forEach((a, i) => {
      const p = babble('Okay then, the lights are on now.', a, { seed: BigInt(i) });
      expect(p.items.length >= 2).toBe(true);
      const first = p.items[0], second = p.items[1];
      const lift = last(notesOf(first.phrase));
      expect(lift.contour.end - lift.contour.start >= 0.7, 'lift before the comma').toBe(true);
      const gap = second.offset - (first.offset + lastNoteEnd(first.phrase));
      expect(gap >= 0.18 * 0.9 - 0.02, `comma pause ${gap}`).toBe(true);
    });
  });

  test('statementDroops', () => {
    padGrid.forEach((a, i) => {
      const l = last(lastPhraseNotes(babble('The lights are on.', a, { seed: BigInt(i), isLast: true })));
      expect(l.contour.end - l.contour.start < 1).toBe(true);
      expect(l.contour.droop >= 1, `final droop ${l.contour.droop}`).toBe(true);
    });
  });
});
