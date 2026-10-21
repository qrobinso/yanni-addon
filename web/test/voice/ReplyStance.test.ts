// Port of Tests/FaceVoiceTests/ReplyStanceTests.swift.
// Stance answers in Yanni's voice (review R4/R5): the answer chirp opens the chunk on the nod's accents, once per
// reply; no auto chirp doubles it; in Spoken mode the nod stays silent.
import { describe, expect, test } from 'vitest';
import { OneShotLibrary, makeSentenceTag, type OneShotKind } from '../../src/engine';
import { AnswerAccents } from '../../src/engine/AnswerCurves';
import { ReplyConstants, VoiceDirector, lastNoteEnd, makeReplyChunk, type VoiceReaction } from '../../src/voice';
import { Rig, near, renderFrom, rms } from './support';

const pairs: [OneShotKind, VoiceReaction][] = [['nodYes', 'mmHm'], ['nodYesBig', 'mmHmBig'], ['shakeNo', 'uhUh'],
  ['shakeNoBig', 'nuhUh']];

describe('ReplyStanceTests', () => {
  test('answerChirpOpensTheChunkOnTheNodsAccents', () => {
    for (const [kind, reaction] of pairs) {
      const rig = new Rig();
      const v = rig.director.voiceReplyChunk(makeReplyChunk({ text: 'Yes, the door is locked.', index: 0,
        tag: makeSentenceTag(null, 0, kind) }), true);
      expect(v.answer).toBe(kind);
      const chirp = v.phrases[0];
      expect(chirp).toBeDefined();
      expect(chirp.phrase.reaction === reaction && chirp.pairedOneShot === kind).toBe(true);
      // The nod starts at the chunk's start; the chirp's notes are heard on its accents (+ the face's lead).
      expect(rig.oneShotsAt.length).toBe(1);
      expect(rig.oneShotsAt[0][0] === kind && near(rig.oneShotsAt[0][1], v.startHostTime, 1e-9)).toBe(true);
      const acc = OneShotLibrary.spec(kind).accentTimes;
      const rate = rig.director.oneShotRate;
      const heard0 = chirp.startHostTime + chirp.latency + chirp.phrase.notes[0].start;
      expect(near(heard0, v.startHostTime + acc[0] / rate + VoiceDirector.visualLead, 1e-6)).toBe(true);
      const heard1 = chirp.startHostTime + chirp.latency + chirp.phrase.notes[1].start;
      expect(Math.abs(heard1 - (heard0 + (acc[1] - acc[0])))).toBeLessThan(0.006);
      // Then a 150 ms gap, then the babble.
      const chirpEnd = heard0 + lastNoteEnd(chirp.phrase);
      const babbleStart = v.phrases[1].startHostTime + v.phrases[1].latency;
      expect(Math.abs(babbleStart - (chirpEnd + 0.15))).toBeLessThan(1e-6);
      expect(v.phrases.slice(1).every((p) => p.phrase.reaction === 'babble')).toBe(true);
      // The face cues for the chirp name the nod (VocalSync softens its hops under it).
      expect(rig.cues.filter((c) => c.pairedOneShot === kind).length).toBe(chirp.phrase.notes.length);
    }
  });

  test('atMostOneAnswerPerReply', () => {
    const rig = new Rig();
    rig.director.beginReplyTurn('t1');
    const a = rig.director.voiceReplyChunk(makeReplyChunk({ text: 'Yes.', index: 0, tag: makeSentenceTag(null, 0, 'nodYes') }));
    const b = rig.director.voiceReplyChunk(makeReplyChunk({ text: 'No, not that one.', index: 1, tag: makeSentenceTag(null, 0, 'shakeNo') }));
    expect(a.answer === 'nodYes' && b.answer === null).toBe(true);
    expect(b.phrases.every((p) => p.phrase.reaction === 'babble')).toBe(true);
    // A new reply may answer again.
    rig.director.beginReplyTurn('t2');
    const c = rig.director.voiceReplyChunk(makeReplyChunk({ text: 'Nope.', index: 0, tag: makeSentenceTag(null, 0, 'shakeNoBig') }));
    expect(c.answer === 'shakeNoBig' && c.phrases[0]?.phrase.reaction === 'nuhUh').toBe(true);
    // Without a stance, the chunk starts on its first note.
    const d = rig.director.voiceReplyChunk(makeReplyChunk({ text: 'Okay.', index: 1 }));
    expect(d.answer === null && near(d.startHostTime, d.firstNoteHostTime, 1e-9)).toBe(true);
  });

  /// The emotion layer starts the nod at the chunk's start; the director must not add its auto "mm-hm".
  test('theNodNeverGetsASecondChirp', () => {
    const rig = new Rig();
    rig.advance(2);
    const v = rig.director.voiceReplyChunk(makeReplyChunk({ text: 'Yes, done.', index: 0, tag: makeSentenceTag(null, 0, 'nodYes') }));
    const count = v.phrases.length;
    const id = rig.director.lastPhrase?.id;
    rig.injector.queued = [{ kind: 'nodYes', engineTime: 0, hostTime: v.startHostTime, rate: 1,
      accentTimes: [...AnswerAccents.nodYes], softVoice: false }];
    rig.frame();
    rig.frame();
    expect(rig.director.lastPhrase?.id, `no auto chirp while the reply plays (${count} phrases)`).toBe(id);
  });

  test('spokenModeNodIsSilent', () => {
    const rig = new Rig();
    rig.advance(2);
    rig.director.isSpeaking = true;          // TTS speaking
    rig.injector.queued = [{ kind: 'nodYes', engineTime: 0, hostTime: rig.now + 0.02, rate: 1,
      accentTimes: [...AnswerAccents.nodYes], softVoice: false }];
    rig.frame();
    rig.frame();
    expect(rig.director.lastPhrase).toBeNull();
    // Contrast: the same nod while nobody speaks gets its chirp.
    rig.director.isSpeaking = false;
    rig.injector.queued = [{ kind: 'nodYes', engineTime: 0, hostTime: rig.now + 0.02, rate: 1,
      accentTimes: [...AnswerAccents.nodYes], softVoice: false }];
    rig.frame();
    expect(rig.director.lastPhrase?.reaction).toBe('mmHm');
  });

  test('greetingAndCantThinkUseTheExistingChirps', () => {
    expect(ReplyConstants.greetingReaction).toBe('engaged');
    expect(ReplyConstants.cantThinkReaction).toBe('sheepish');
    const rig = new Rig();
    rig.director.settings.muted = true;
    const p = rig.director.replyChirp(ReplyConstants.cantThinkReaction);
    expect(p.onReply && p.enqueued && p.phrase.reaction === 'sheepish').toBe(true);
    expect(rms(renderFrom(rig.director.replyRenderer, rig.now, 0.8)), 'heard with Sounds off').toBeGreaterThan(0.002);
  });
});

describe('ReplyAllocationTests', () => {
  /// After a babble reply has finished, the per-frame path allocates nothing (both renderers polled).
  test.skip('afterFrameAllocatesNothingAfterAReply (allocation counting has no JS equivalent; Swift runs it only in optimised builds)', () => {});
});
