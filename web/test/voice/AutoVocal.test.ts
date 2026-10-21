// Port of Tests/FaceVoiceTests/AutoVocalTests.swift.
import { describe, expect, test } from 'vitest';
import type { AgentState } from '../../src/engine';
import { VoiceDirector, type VoiceReaction } from '../../src/voice';
import { Rig, near, started } from './support';

describe('AutoVocalTests', () => {
  test('startedOneShotIsVocalizedOnItsAccent', () => {
    const rig = new Rig();
    const t = rig.now + 1.0 / 60.0;
    rig.injector.queued = [started('laugh', t, 1.1, [0.21, 0.5, 0.73])];
    rig.frame();
    const rec = rig.director.lastScheduled!;
    expect(rec).not.toBeNull();
    expect(rec.isAuto).toBe(true);
    expect(rec.phrase.reaction).toBe('giggle');
    expect(rec.pairedOneShot).toBe('laugh');
    const k = VoiceDirector.accentIndex(rec.phrase);
    const onset = rec.startHostTime + rec.phrase.notes[k].start + rig.output.outputLatency;
    expect(near(onset, t + 0.21 / 1.1 + 0.010)).toBe(true);
  });

  test('lateStartShiftsOrSkips', () => {
    const rig = new Rig();
    // Slightly late (< 150 ms against now + lead): shifted to now + lead.
    rig.injector.queued = [started('dance', rig.now - 0.03, 1, [0])];
    rig.frame();
    const rec = rig.director.lastScheduled!;
    expect(rec).not.toBeNull();
    expect(near(rec.startHostTime, rig.now + rig.director.lead, 1e-9)).toBe(true);
    // More than 150 ms late: skipped.
    const rig2 = new Rig();
    rig2.injector.queued = [started('dance', rig2.now - 1, 1, [0])];
    rig2.frame();
    expect(rig2.director.lastScheduled).toBeNull();
  });

  test('autoVocalizeOffIgnoresStartedOneShots', () => {
    const rig = new Rig();
    rig.director.settings.autoVocalize = false;
    rig.injector.queued = [started('bigSurprise', rig.now)];
    rig.frame();
    expect(rig.director.lastScheduled).toBeNull();
  });

  test('silentOneShotsAndHasMessagePerkUp', () => {
    const rig = new Rig();
    rig.injector.queued = [started('sorryBlink', rig.now), started('sideEye', rig.now), started('stretch', rig.now)];
    rig.frame();
    expect(rig.director.lastScheduled).toBeNull();
    rig.engine.setAgentState('hasMessage');
    rig.frame();
    rig.injector.queued = [started('perkUp', rig.now)];
    rig.frame();
    expect(rig.director.lastScheduled).toBeNull();
  });

  test('stateEntriesAreDetected', () => {
    const cases: [AgentState, VoiceReaction][] = [
      ['engaged', 'engaged'], ['notForMe', 'embarrassed'], ['sheepish', 'sheepish'],
      ['confused', 'confused'], ['waking', 'sleepy'],
    ];
    for (const [state, reaction] of cases) {
      const rig = new Rig();
      rig.engine.setAgentState(state);
      rig.frame();
      const rec = rig.director.lastScheduled!;
      expect(rec).not.toBeNull();
      expect(rec.phrase.reaction).toBe(reaction);
      expect(rec.isAuto).toBe(true);
    }
    const rig = new Rig();
    rig.engine.setAgentState('thinking');
    rig.frame();
    expect(rig.director.lastScheduled).toBeNull();
  });

  test('noAutoWhileSpeakingQuietOrMuted', () => {
    const rig = new Rig();
    rig.engine.setAgentState('speaking');
    rig.frame();
    rig.injector.queued = [started('bigSurprise', rig.now)];
    rig.frame();
    expect(rig.director.lastScheduled).toBeNull();

    const q = new Rig();
    q.director.settings.quietMode = true;
    q.engine.setAgentState('engaged');
    q.frame();
    expect(q.director.lastScheduled).toBeNull();

    const m = new Rig();
    m.director.settings.muted = true;
    m.engine.setAgentState('engaged');
    m.frame();
    expect(m.director.lastScheduled).toBeNull();

    const sp = new Rig();
    sp.director.isSpeaking = true;
    sp.engine.setAgentState('engaged');
    sp.frame();
    expect(sp.director.lastScheduled).toBeNull();
  });

  test('globalRateLimitAndCooldowns', () => {
    const rig = new Rig();
    rig.injector.queued = [started('bigSurprise', rig.now)];
    rig.frame();
    const first = rig.director.lastPhrase?.id;
    expect(first).toBeDefined();
    // Within 1.5 s: nothing.
    rig.advance(0.5);
    rig.injector.queued = [started('laugh', rig.now)];
    rig.frame();
    expect(rig.director.lastPhrase?.id).toBe(first);
    // After 1.5 s a different reaction is fine.
    rig.advance(1.2);
    rig.injector.queued = [started('laugh', rig.now)];
    rig.frame();
    const second = rig.director.lastPhrase?.id;
    expect(second).not.toBe(first);
    // Engaged has a 4 s cooldown even after the global interval.
    rig.advance(1.6);
    rig.engine.setAgentState('engaged'); rig.frame();
    const engaged = rig.director.lastPhrase?.id;
    expect(engaged).not.toBe(second);
    rig.advance(1.6);
    rig.engine.setAgentState('idle'); rig.frame();
    rig.engine.setAgentState('engaged'); rig.frame();
    expect(rig.director.lastPhrase?.id).toBe(engaged);
    rig.advance(2.6);
    rig.engine.setAgentState('idle'); rig.frame();
    rig.engine.setAgentState('engaged'); rig.frame();
    expect(rig.director.lastPhrase?.id).not.toBe(engaged);
  });

  test('oneShotAndStateEntrySameFrameGiveOnePhrase', () => {
    const rig = new Rig();
    rig.engine.setAgentState('engaged');
    rig.injector.queued = [started('perkUp', rig.now + 1.0 / 60.0)];
    rig.frame();
    const rec = rig.director.lastScheduled!;
    expect(rec).not.toBeNull();
    expect(rec.pairedOneShot).toBe('perkUp');   // the accent-aligned one wins
    expect(rig.director.lastPhrase?.id).toBe(1);
  });

  test('bedtimeQuietOnlySleepyAndSheepish', () => {
    const rig = new Rig();
    rig.director.isBedtime = true;
    rig.director.settings.bedtimeSounds = 'quiet';
    rig.engine.setAgentState('engaged'); rig.frame();
    expect(rig.director.lastScheduled).toBeNull();
    rig.engine.setAgentState('sheepish'); rig.frame();
    expect(rig.director.lastScheduled?.phrase.reaction).toBe('sheepish');

    const off = new Rig();
    off.director.isBedtime = true;
    off.engine.setAgentState('sheepish'); off.frame();
    expect(off.director.lastScheduled).toBeNull();
  });

  test('manualReactionsAreNotRateLimited', () => {
    const rig = new Rig();
    rig.director.react('engaged', false);
    const a = rig.director.lastPhrase?.id;
    rig.director.react('engaged', false);
    expect(rig.director.lastPhrase?.id).not.toBe(a);
  });
});
