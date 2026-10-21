// Port of Tests/FaceVoiceTests/DirectorTests.swift.
import { describe, expect, test } from 'vitest';
import { ExpressionMix } from '../../src/model';
import { MoodColor } from '../../src/engine/modifiers/MoodColor';
import { VoiceAffect, VoiceDirector, type VoiceReaction } from '../../src/voice';
import { Rig, near } from './support';

describe('DirectorTests', () => {
  test('affectSnapshotIsSharedByPhraseAndCues', () => {
    const rig = new Rig();
    rig.engine.setMood({ pleasure: -0.4, arousal: 0.6, dominance: 0.2 });
    const lib = rig.engine.state.library;
    const other = lib.names.find((n) => n !== 'Neutral' && lib.get(n)?.pad != null);
    expect(other).toBeDefined();
    const mix = ExpressionMix.single(other!, 1);
    rig.engine.setExpressionOverride(mix);
    rig.director.react('curious', false);
    const phrase = rig.director.lastPhrase!;
    expect(phrase).not.toBeNull();
    const delta = MoodColor.padDelta(mix, lib);
    const c = (v: number): number => Math.min(Math.max(v, -1), 1);
    const expected = VoiceAffect.make(c(-0.4 + 0.5 * delta.x), c(0.6 + 0.5 * delta.y), c(0.2 + 0.5 * delta.z));
    expect(phrase.affect).toEqual(expected);
    expect(rig.cues.length).toBeGreaterThan(0);
    for (const cue of rig.cues) expect(cue.valence).toBe(phrase.affect.pleasure);
  });

  test('cueTimesFollowNotesLatencyAndOffset', () => {
    const rig = new Rig();
    rig.director.settings.avOffset = 0.02;
    rig.director.react('delighted', false);
    const rec = rig.director.lastScheduled!;
    expect(rec).not.toBeNull();
    const cues = rig.cues;
    expect(cues.length).toBe(rec.phrase.notes.length);
    cues.forEach((c, i) => {
      const n = rec.phrase.notes[i];
      expect(near(c.hostTime, rec.startHostTime + n.start + 0.012 + 0.02, 1e-6)).toBe(true);
      expect(c.duration).toBe(n.duration);
      expect(c.contour.equals(n.contour)).toBe(true);
    });
    expect(cues[0]?.accent).toBe(true);   // first note always hops
  });

  test('leadRespectsIOBuffer', () => {
    const rig = new Rig();
    rig.director.react('emote', false);
    expect(near(rig.director.lastScheduled!.startHostTime, rig.now + 0.040, 1e-9)).toBe(true);
    rig.output.ioBufferDuration = 0.023;
    rig.director.react('emote', false);
    expect(near(rig.director.lastScheduled!.startHostTime, rig.now + 0.056, 1e-9)).toBe(true);
    expect(near(rig.director.lead, 0.056, 1e-9)).toBe(true);
  });

  test.each<VoiceReaction>(['startled', 'engaged', 'delighted', 'giggle', 'danceBeat', 'sleepy'])(
    'pairedOneShotAccentAlignment(%s)', (reaction) => {
      const rig = new Rig();
      rig.director.react(reaction, true);
      const kind = VoiceDirector.pairedOneShot(reaction);
      expect(kind).not.toBeNull();
      const sent = rig.oneShotsAt[0];
      expect(sent).toBeDefined();
      expect(sent[0]).toBe(kind);
      const rec = rig.director.lastScheduled!;
      expect(rec.pairedOneShot).toBe(kind);
      expect(rec.startHostTime).toBeGreaterThanOrEqual(rig.now + rig.director.lead - 1e-9);
      expect(sent[1]).toBeGreaterThanOrEqual(rig.now + rig.director.lead - 1e-9);
      const k = VoiceDirector.accentIndex(rec.phrase);
      const onset = rec.startHostTime + rec.phrase.notes[k].start + rig.output.outputLatency;
      const rate = rig.engine.state.modulation.speed;
      // Face leads: the accent note is heard 10 ms after the one-shot's accent.
      expect(near(onset, sent[1] + VoiceDirector.accentTime(kind!) / rate + 0.010)).toBe(true);
      for (const c of rig.cues) expect(c.pairedOneShot).toBe(kind);
    });

  test('avOffsetDelaysFaceRelativeToSoundForPairedOneShots', () => {
    const rig = new Rig();
    rig.director.settings.avOffset = 0.03;
    rig.director.react('startled', true);
    const sent = rig.oneShotsAt[0];
    expect(sent).toBeDefined();
    const rec = rig.director.lastScheduled!;
    const k = VoiceDirector.accentIndex(rec.phrase);
    const onset = rec.startHostTime + rec.phrase.notes[k].start + rig.output.outputLatency;
    expect(near(onset, sent[1] + VoiceDirector.accentTime('bigSurprise') + 0.010 - 0.03)).toBe(true);
    expect(near(rig.cues[k].hostTime, onset + 0.03, 1e-6)).toBe(true);
  });

  test('noFaceMeansNoOneShot', () => {
    const rig = new Rig();
    rig.director.react('startled', false);
    expect(rig.oneShotsAt).toEqual([]);
    rig.director.react('sheepish', true);   // no pairing
    expect(rig.oneShotsAt).toEqual([]);
    expect(rig.cues.length).toBeGreaterThan(0);
  });

  test('rejectedOneShotCancelsLonePhrase', () => {
    const rig = new Rig();
    rig.director.react('startled', true);
    // The injector never reports it started: rejected after T + grace.
    let sawCancel = false;
    for (let i = 0; i < 15; i++) {
      rig.frame();
      if (rig.cancels.length > 0) sawCancel = true;
    }
    expect(rig.director.rejectedOneShotCount).toBe(1);
    expect(sawCancel).toBe(true);
    expect(rig.director.audibleUntilHostTime).toBeLessThanOrEqual(rig.now + 0.150 + 1e-9);
  });

  test('rejectedOneShotKeepsPhraseWhenOthersPending', () => {
    const rig = new Rig();
    rig.director.react('curious', false);
    rig.director.react('startled', true);
    let sawCancel = false;
    for (let i = 0; i < 15; i++) {
      rig.frame();
      if (rig.cancels.length > 0) sawCancel = true;
    }
    expect(rig.director.rejectedOneShotCount).toBe(1);
    expect(sawCancel).toBe(false);
  });

  test('confirmedOneShotIsNotAutoVocalizedOrCancelled', () => {
    const rig = new Rig();
    rig.director.react('startled', true);
    const t = rig.oneShotsAt[0][1];
    const id = rig.director.lastPhrase?.id;
    while (rig.now + 1.0 / 60.0 < t) rig.frame();
    rig.injector.queued = [{ kind: 'bigSurprise', engineTime: 0, hostTime: rig.now + 1.0 / 60.0, rate: 1,
      accentTimes: [0.19], softVoice: false }];
    rig.frame();
    expect(rig.director.lastPhrase?.id).toBe(id);   // no extra auto phrase
    rig.advance(0.3);
    expect(rig.director.rejectedOneShotCount).toBe(0);
  });

  test('timeStretchIsInverseTimeScale', () => {
    const rig = new Rig();
    rig.engine.timeScale = 0.25;
    rig.director.react('delighted', false);
    const rec = rig.director.lastScheduled!;
    expect(rec.timeStretch).toBe(4);
    rig.cues.forEach((c, i) => {
      const n = rec.phrase.notes[i];
      expect(near(c.hostTime, rec.startHostTime + n.start * 4 + 0.012, 1e-6)).toBe(true);
      expect(c.duration).toBe(n.duration * 4);
    });
    rig.engine.timeScale = 1;
    expect(rig.director.timeStretch).toBe(1);
  });

  test('slowMotionAccentAlignmentScalesWithStretch', () => {
    const rig = new Rig();
    rig.engine.timeScale = 0.5;
    rig.director.react('engaged', true);
    const sent = rig.oneShotsAt[0];
    expect(sent).toBeDefined();
    const rec = rig.director.lastScheduled!;
    const k = VoiceDirector.accentIndex(rec.phrase);
    const onset = rec.startHostTime + rec.phrase.notes[k].start * 2 + 0.012;
    expect(near(onset, sent[1] + VoiceDirector.accentTime('perkUp') * 2 + 0.010)).toBe(true);
  });

  test('audibleUntilCoversPhrasePlusTail', () => {
    const rig = new Rig();
    expect(rig.director.audibleUntilHostTime).toBe(0);
    rig.director.react('curious', false);
    const rec = rig.director.lastScheduled!;
    const expected = rec.startHostTime + rec.phrase.duration + 0.012 + 0.150;
    expect(near(rig.director.audibleUntilHostTime, expected, 1e-9)).toBe(true);
  });

  test('cancelSendsCancelVocalCues', () => {
    const rig = new Rig();
    rig.director.react('curious', false);
    rig.director.cancel();
    expect(rig.cancels).toEqual([rig.now]);
    expect(rig.director.audibleUntilHostTime).toBeLessThanOrEqual(rig.now + 0.150);
  });

  test('repeatLastReplaysIdenticalPhrase', () => {
    const rig = new Rig();
    rig.director.react('delighted', false);
    const first = rig.director.lastPhrase!;
    expect(first).not.toBeNull();
    rig.director.repeatLast();
    const second = rig.director.lastPhrase!;
    expect(second).not.toBeNull();
    expect(second.notes).toEqual(first.notes);
    expect(second.affect).toEqual(first.affect);
    expect(second.reaction).toBe(first.reaction);
    expect(second.id).not.toBe(first.id);
  });

  test('noOutputStillSendsCues', () => {
    const rig = new Rig(false);
    rig.director.react('engaged', false);
    const rec = rig.director.lastScheduled!;
    expect(rec).not.toBeNull();
    expect(rec.audible).toBe(false);
    expect(rig.cues.length).toBe(rec.phrase.notes.length);
    expect(rig.director.audibleUntilHostTime).toBe(0);
  });

  test('configurationChangeRebuildsRendererAtNewRate', () => {
    const rig = new Rig();
    rig.output.sampleRate = 24_000;
    rig.output.onConfigurationChange?.();
    expect(rig.director.renderer.sampleRate).toBe(24_000);
    expect(rig.output.attached[rig.output.attached.length - 1]).toBe(rig.director.renderer);
  });
});
