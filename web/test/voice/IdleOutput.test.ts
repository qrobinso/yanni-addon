// Port of Tests/FaceVoiceTests/IdleOutputTests.swift.
// Idle output: a longer IO buffer after `idleAfter` of silence; the next phrase reads the (idle) lead first, then
// wakes the output, so nothing is clipped and face and sound stay together.
import { describe, expect, test } from 'vitest';
import { VoiceDirector, type VoiceOutput, type VoiceRendererLike } from '../../src/voice';
import { Rig, near } from './support';

/// The lead while idle: two idle buffers + 10 ms (above the 40 ms minimum).
const idleLead = 2 * 0.02 + 0.010;

/// Advances frames until the host clock reaches `t`.
function advanceUntil(rig: Rig, t: number): void { while (rig.now < t) rig.frame(); }

describe('IdleOutputTests', () => {
  test('idleAfterThirtySecondsOfSilence', () => {
    const rig = new Rig();
    rig.director.react('delighted', false);
    const until = rig.director.audibleUntilHostTime;
    expect(until).toBeGreaterThan(rig.now);
    advanceUntil(rig, until + VoiceDirector.idleAfter - 0.1);
    expect(rig.output.isIdle, 'not before 30 s of silence').toBe(false);
    expect(rig.output.idleCalls).toEqual([]);
    advanceUntil(rig, until + VoiceDirector.idleAfter + 0.1);
    expect(rig.output.isIdle).toBe(true);
    expect(rig.output.idleCalls).toEqual([true]);
    rig.advance(5);
    expect(rig.output.idleCalls, 'entered once; nothing per frame while idle').toEqual([true]);
  });

  test('silenceFromLaunchCountsFromTheFirstFrame', () => {
    const rig = new Rig();
    const t0 = rig.now;
    advanceUntil(rig, t0 + VoiceDirector.idleAfter - 0.1);
    expect(rig.output.isIdle).toBe(false);
    advanceUntil(rig, t0 + VoiceDirector.idleAfter + 0.1);
    expect(rig.output.isIdle).toBe(true);
  });

  test('mutedPhrasesStillKeepTheOutputActive', () => {
    const rig = new Rig();
    rig.director.settings.muted = true;
    rig.advance(20);
    rig.director.react('curious', false);
    rig.advance(20);
    expect(rig.output.isIdle, '30 s are counted from the last phrase, heard or not').toBe(false);
    rig.advance(11);
    expect(rig.output.isIdle).toBe(true);
  });

  test('phrasePlannedWhileIdleReadsTheLeadFirstAndIsNotClipped', () => {
    const rig = new Rig();
    rig.advance(VoiceDirector.idleAfter + 1);
    expect(rig.output.isIdle).toBe(true);
    rig.output.logEvents = true;
    rig.director.react('emote', false);
    const rec = rig.director.lastScheduled!;
    expect(rec).not.toBeNull();
    expect(rec.startHostTime, 'starts after the idle buffer can drain').toBeGreaterThanOrEqual(rig.now + idleLead - 1e-9);
    expect(near(rec.startHostTime, rig.now + idleLead, 1e-9)).toBe(true);
    const wake = rig.output.events.findIndex((e) => e.kind === 'setIdle' && e.value === false);
    expect(wake).toBeGreaterThanOrEqual(0);
    expect(rig.output.events.slice(0, wake).some((e) => e.kind === 'readBuffer' && e.value === 0.02),
      'lead read with the idle buffer, before waking').toBe(true);
    expect(rig.output.isIdle).toBe(false);
    expect(rig.output.idleCalls).toEqual([true, false]);
    // Face cues use the same start.
    const first = rig.cues[0];
    expect(first).toBeDefined();
    expect(near(first.hostTime, rec.startHostTime + rec.phrase.notes[0].start + rig.output.outputLatency, 1e-9)).toBe(true);
    // Back on the short buffer: the next phrase uses the normal lead.
    rig.advance(2);
    rig.director.react('emote', false);
    expect(near(rig.director.lastScheduled!.startHostTime, rig.now + VoiceDirector.minLead, 1e-9)).toBe(true);
    expect(rig.output.idleCalls, 'waking an active output is not repeated').toEqual([true, false]);
  });

  test('pairedOneShotWhileIdleStaysAligned', () => {
    const rig = new Rig();
    rig.advance(VoiceDirector.idleAfter + 1);
    expect(rig.output.isIdle).toBe(true);
    rig.director.react('delighted', true);
    const sent = rig.oneShotsAt[0];
    expect(sent).toBeDefined();
    const rec = rig.director.lastScheduled!;
    expect(rec.startHostTime).toBeGreaterThanOrEqual(rig.now + idleLead - 1e-9);
    expect(sent[1]).toBeGreaterThanOrEqual(rig.now + idleLead - 1e-9);
    const k = VoiceDirector.accentIndex(rec.phrase);
    const onset = rec.startHostTime + rec.phrase.notes[k].start + rig.output.outputLatency;
    const rate = rig.engine.state.modulation.speed;
    expect(near(onset, sent[1] + VoiceDirector.accentTime('delightedSquint') / rate + VoiceDirector.visualLead)).toBe(true);
  });

  test('autoPhraseWhileIdleUsesTheIdleLead', () => {
    const rig = new Rig();
    rig.advance(VoiceDirector.idleAfter + 1);
    expect(rig.output.isIdle).toBe(true);
    rig.injector.queued = [{ kind: 'dance', engineTime: 0, hostTime: rig.now - 0.03, rate: 1, accentTimes: [0], softVoice: false }];
    rig.frame();
    const rec = rig.director.lastScheduled!;
    expect(rec).not.toBeNull();
    expect(near(rec.startHostTime, rig.now + idleLead, 1e-9)).toBe(true);
    expect(rig.output.isIdle).toBe(false);
  });

  test('goesIdleAgainAfterTheNextSilence', () => {
    const rig = new Rig();
    rig.advance(VoiceDirector.idleAfter + 1);
    rig.director.react('emote', false);
    rig.advance(VoiceDirector.idleAfter + 2);
    expect(rig.output.idleCalls).toEqual([true, false, true]);
  });

  /// Outputs without an idle mode (protocol defaults) are never idle and ignore the calls.
  test('outputsWithoutIdleModeUseTheDefaults', () => {
    class Plain implements VoiceOutput {
      sampleRate = 48_000;
      outputLatency = 0;
      ioBufferDuration = 0.005;
      isRunning = true;
      onConfigurationChange: (() => void) | null = null;
      attach(_renderer: VoiceRendererLike): void {}
      start(): void {}
      stop(): void {}
    }
    const rig = new Rig(false);
    const plain = new Plain();
    rig.director.output = plain;
    rig.advance(VoiceDirector.idleAfter + 1);
    expect((plain as VoiceOutput).isIdle ?? false).toBe(false);
    rig.director.react('emote', false);
    expect(near(rig.director.lastScheduled!.startHostTime, rig.now + VoiceDirector.minLead, 1e-9)).toBe(true);
  });

  /// The real host on macOS: idle reports the idle buffer, waking restores the device's.
  test.skip('audioHostTracksIdleMode (the web VoiceAudioHost has no idle mode / idleIOBuffer and needs an AudioContext)', () => {});
});

describe('VoiceAllocationTests', () => {
  /// Steady state (no phrases, no one-shots): active, then idle. The frame that enters idle is excluded.
  test.skip('directorAfterFrameAllocatesNothing (allocation counting has no JS equivalent; Swift runs it only in optimised builds)', () => {});
});
