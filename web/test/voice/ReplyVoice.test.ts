// Port of Tests/FaceVoiceTests/ReplyVoiceTests.swift.
// The reply voice in the director: rules, timing, stance chirps, barge-in.
import { describe, expect, test } from 'vitest';
import { makeSentenceTag } from '../../src/engine';
import {
  BabbleText, ReplyBabbleSettings, VoiceAffect, lastNoteEnd, makeReplyChunk, type VoicedReplyChunk,
} from '../../src/voice';
import { Rig, renderFrom, rms } from './support';
import { longReply } from './voiceTestSupport';

const text = 'Sure, I turned on the kitchen lights.';

describe('ReplyVoiceTests', () => {
  test('babblePlaysWithSoundsOffQuietModeAndAtBedtime', () => {
    for (let setting = 0; setting < 3; setting++) {
      const rig = new Rig();
      switch (setting) {
        case 0: rig.director.settings.muted = true; break;
        case 1: rig.director.settings.quietMode = true; break;
        default: rig.director.isBedtime = true;          // bedtime sounds off: chirps are silent
      }
      expect(rig.director.rendererMuted).toBe(true);
      const v = rig.director.voiceReplyChunk(makeReplyChunk({ text, index: 0, isLast: true }));
      expect(!v.dropped && v.phrases.length > 0).toBe(true);
      expect(v.phrases.every((p) => p.enqueued && p.audible && p.onReply)).toBe(true);
      const out = renderFrom(rig.director.replyRenderer, rig.now, 2.2);
      expect(rms(out), `the reply is heard (setting ${setting})`).toBeGreaterThan(0.003);
      // A chirp at the same moment stays silent.
      rig.director.react('engaged', false);
      const chirp = renderFrom(rig.director.renderer, rig.now, 0.5);
      expect(out.every((x) => Number.isFinite(x) && Math.abs(x) <= 1)).toBe(true);
      expect(chirp.every((x) => Math.abs(x) < 1e-4), 'chirps stay muted').toBe(true);
    }
  });

  test('nightWakePlaysAtTheNightFactor', () => {
    const level = (bedtime: boolean): number => {
      const rig = new Rig();
      rig.director.isBedtime = bedtime;
      expect(rig.director.replyGain).toBe(bedtime ? 0.5 : 1);
      expect(rig.director.replyRenderer.gain).toBe(bedtime ? 0.5 : 1);
      rig.director.voiceReplyChunk(makeReplyChunk({ text, index: 0, seed: 77n }));
      return rms(renderFrom(rig.director.replyRenderer, rig.now, 2.2));
    };
    const day = level(false), night = level(true);
    expect(night).toBeGreaterThan(0);
    expect(Math.abs(night / day - 0.5), `night / day = ${night / day}`).toBeLessThan(0.03);
  });

  test('bargeInCancelsTheReply', () => {
    const rig = new Rig();
    const v = rig.director.voiceReplyChunk(makeReplyChunk({ text: 'Okay, here is a long answer about the weather tomorrow.', index: 0 }));
    expect(rig.director.isReplying).toBe(true);
    expect(rig.director.audibleUntilHostTime).toBeGreaterThanOrEqual(v.endHostTime + 0.15 - 1e-5);
    const fs = rig.director.replyRenderer.sampleRate;
    const cutAt = Math.trunc(0.5 * fs);
    const out = renderFrom(rig.director.replyRenderer, rig.now, 1.0, (n) => {
      if (n >= cutAt && n < cutAt + 256) rig.director.cancel();
    });
    expect(rms(out.subarray(Math.trunc(0.2 * fs), cutAt))).toBeGreaterThan(0.003);
    expect(out.subarray(cutAt + Math.trunc(0.04 * fs)).every((x) => Math.abs(x) < 1e-4), 'silent within 40 ms').toBe(true);
    expect(rig.cancels.length).toBe(1);
    rig.advance(0.2);
    expect(rig.director.isReplying).toBe(false);
    expect(rig.director.replyDuration).toBe(0);
  });

  test('tagMovesTheVoiceAndTheDeadlineFallsBackToTheMood', () => {
    const rig = new Rig();
    rig.engine.setMood({ pleasure: -0.2, arousal: 0.1, dominance: 0 });
    const mood = rig.director.affectSnapshot();
    const late = rig.director.voiceReplyChunk(makeReplyChunk({ text, index: 0, tag: null }));
    expect(late.usedMood && VoiceAffect.equals(late.affect, mood)).toBe(true);
    expect(late.phrases.every((p) => VoiceAffect.equals(p.phrase.affect, mood))).toBe(true);
    const pad = { x: 0.8, y: 0.6, z: 0.3 };
    const full = rig.director.babbleAffect(makeSentenceTag(pad, 1));
    expect(Math.abs(full.pleasure - pad.x) < 1e-5 && Math.abs(full.arousal - pad.y) < 1e-5 &&
      Math.abs(full.dominance - pad.z) < 1e-5).toBe(true);
    const half = rig.director.babbleAffect(makeSentenceTag(pad, 0.5));
    expect(Math.abs(half.pleasure - (mood.pleasure + pad.x) / 2)).toBeLessThan(1e-5);
    expect(rig.director.babbleAffect(makeSentenceTag(null, 1))).toEqual(mood);
    // R10: 300 ms per chunk; chunk 0 waits 150 ms with hosted Jev.
    const s = new ReplyBabbleSettings();
    expect(s.tagDeadlineFor(0, false)).toBe(0.3);
    expect(s.tagDeadlineFor(0, true)).toBe(0.15);
    expect(s.tagDeadlineFor(1, true)).toBe(0.3);
  });

  test('chunksFollowEachOtherAndTheReplyCapHolds', () => {
    const rig = new Rig();
    rig.director.beginReplyTurn('turn-1');
    const chunks: VoicedReplyChunk[] = [];
    const sentences = BabbleText.sentenceStrings(longReply);
    sentences.forEach((s, i) => {
      chunks.push(rig.director.voiceReplyChunk(makeReplyChunk({ text: s, index: i, isLast: i === sentences.length - 1 })));
    });
    const voiced = chunks.filter((c) => !c.dropped);
    expect(voiced.length >= 3 && voiced.length < sentences.length).toBe(true);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.dropped && lastChunk.capped).toBe(true);
    expect(voiced[0].offset).toBe(0);
    for (let k = 1; k < voiced.length; k++) {
      const prevEnd = Math.max(...voiced[k - 1].phrases.map((p) => p.startHostTime + p.latency + lastNoteEnd(p.phrase)));
      expect(voiced[k].firstNoteHostTime, 'a sentence breath').toBeGreaterThanOrEqual(prevEnd + 0.25 * 0.9 - 1e-6);
      expect(Math.abs(voiced[k].offset - (voiced[k].startHostTime - voiced[0].startHostTime))).toBeLessThan(1e-9);
    }
    expect(rig.director.replyDuration).toBeLessThanOrEqual(6 + 1e-3);
    expect(Math.abs(rig.director.replyDuration - (voiced[voiced.length - 1].endHostTime - voiced[0].startHostTime))).toBeLessThan(1e-9);
    expect(voiced.every((c) => c.plan.sentenceDurations.every((d) => d <= 1.5 + 1e-3))).toBe(true);
  });
});
