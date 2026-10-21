// Port of Tests/FaceVoiceTests/AnswerVoiceTests.swift.
// The answer chirps: "mm-hm!" (yes), a bigger "mm-HM!" (absolutely yes), "uh-uh" (no), "nuh-uh" (absolutely not).
import { describe, expect, test } from 'vitest';
import { OneShotLibrary, type OneShotKind } from '../../src/engine';
import {
  Phrase, PhraseGenerator, VoiceDirector, VoiceFingerprint, VoiceReactionTables, type Note, type VoiceAffect,
  type VoiceReaction,
} from '../../src/voice';
import { notesOf, padGrid, peakDB, pitchAt } from './voiceTestSupport';

function phrases(r: VoiceReaction, perAffect = 6): [VoiceAffect, Note[]][] {
  const out: [VoiceAffect, Note[]][] = [];
  padGrid.forEach((a, i) => {
    const g = new PhraseGenerator(VoiceFingerprint.default, BigInt(4000 + i));
    for (let k = 0; k < perAffect; k++) out.push([a, notesOf(g.make(r, a))]);
  });
  return out;
}

const pairs: [OneShotKind, VoiceReaction][] = [['nodYes', 'mmHm'], ['nodYesBig', 'mmHmBig'], ['shakeNo', 'uhUh'],
  ['shakeNoBig', 'nuhUh']];

describe('AnswerVoiceTests', () => {
  test('answersMapToTheirChirpsBothWays', () => {
    for (const [k, r] of pairs) {
      expect(VoiceReactionTables.forOneShot(k)).toBe(r);
      expect(VoiceDirector.reactionForOneShot(k)).toBe(r);
      expect(VoiceDirector.pairedOneShot(r)).toBe(k);
      expect(PhraseGenerator.alignNoteIndexFor(r, 2)).toBe(0);
    }
  });

  /// The second note lands on the one-shot's second accent (the first note is aligned to the first by the director).
  test('secondNoteLandsOnTheSecondAccent', () => {
    for (const [k, r] of pairs) {
      const acc = OneShotLibrary.spec(k).accentTimes;
      for (const [, ns] of phrases(r, 3)) {
        expect(ns.length).toBe(2);
        expect(Math.abs(ns[1].start - (acc[1] - acc[0])), `${r} note 2 at ${ns[1].start}`).toBeLessThanOrEqual(0.0045);
        expect(ns[0].start + ns[0].duration, `${r} notes overlap`).toBeLessThanOrEqual(ns[1].start);
      }
    }
  });

  test('yesRisesAndNoFalls', () => {
    for (const r of ['mmHm', 'mmHmBig'] as VoiceReaction[]) {
      for (const [, ns] of phrases(r)) {
        expect(ns[1].contour.start, `${r} leaps up`).toBeGreaterThan(ns[0].contour.start + 2.5);
        expect(ns[1].contour.end, `${r} ends with an upward flick`).toBeGreaterThan(ns[1].contour.start);
      }
    }
    for (const r of ['uhUh', 'nuhUh'] as VoiceReaction[]) {
      for (const [, ns] of phrases(r)) {
        expect(ns[1].contour.start, `${r} steps down`).toBeLessThan(ns[0].contour.start - 2);
        expect(pitchAt(ns[1], 1), `${r} ends falling`).toBeLessThan(pitchAt(ns[1], 0));
      }
    }
  });

  test('emphaticChirpsAreBiggerFirmerAndLower', () => {
    let yesLeap = 0, bigLeap = 0, uh = 0, nuh = 0;
    let uhAttack = 0, nuhAttack = 0, yesDB = 0, bigDB = 0;
    const yes = phrases('mmHm'), big = phrases('mmHmBig'), no = phrases('uhUh'), noBig = phrases('nuhUh');
    for (const [, ns] of yes) yesLeap += ns[1].contour.start - ns[0].contour.start;
    for (const [, ns] of big) bigLeap += ns[1].contour.start - ns[0].contour.start;
    for (const [, ns] of no) { uh += ns[1].contour.start; uhAttack += ns[0].envelope.attackTau; }
    for (const [, ns] of noBig) { nuh += ns[1].contour.start; nuhAttack += ns[0].envelope.attackTau; }
    for (const [, ns] of yes) { const p = new Phrase(); for (const n of ns) p.notes.push(n); yesDB += peakDB(p); }
    for (const [, ns] of big) { const p = new Phrase(); for (const n of ns) p.notes.push(n); bigDB += peakDB(p); }
    expect(bigLeap, 'bigger leap').toBeGreaterThan(yesLeap * 1.3);
    expect(bigDB, 'louder').toBeGreaterThan(yesDB);
    expect(nuh, 'lower').toBeLessThan(uh);
    expect(nuhAttack, 'firmer').toBeLessThan(uhAttack);
  });
});
