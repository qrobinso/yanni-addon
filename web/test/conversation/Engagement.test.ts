// Port of Tests/ConversationCoreTests/EngagementTests.swift.
// Engaged → listening: unmute rule (L6), greeting, privacy (L7), engaged entries (H4), sheepish rate limit (L9).
import { describe, expect, test } from 'vitest';
import type { AgentState } from '../../src/engine/AgentState';
import { VoiceDirector, VoiceRenderer } from '../../src/voice';
import type { VoiceOutput } from '../../src/voice/host/VoiceOutput';
import { pin } from './support/Fakes';
import { Rig } from './support/Rig';

/** A `VoiceOutput` that claims to run, so the director counts its chirps as audible. */
class RunningOutput implements VoiceOutput {
  sampleRate = 48000;
  outputLatency = 0.01;
  ioBufferDuration = 0.005;
  isRunning = true;
  onConfigurationChange: (() => void) | null = null;
  attach(): void {}
  start(): void {}
  stop(): void {}
}

describe('EngagementTests', () => {
  test('engagementShowsEngagedAndUnmutesAtTheRule', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    rig.person();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    rig.frame();
    const engagedAt = rig.clock.now;
    expect(rig.state).toBe('engaged');
    rig.voice.audibleUntilHostTime = engagedAt + 0.42;   // the engaged chirp (incl. the director's tail)
    const opened = rig.runUntil(2, () => rig.transport.micEnabled);
    expect(opened).not.toBeNull();
    const unmuteAt = engagedAt + 0.42 + 0.1;
    expect(rig.clock.now, 'never before audibleUntil + 0.1').toBeGreaterThanOrEqual(unmuteAt - 1e-9);
    expect(rig.clock.now, `exactly at the rule (${opened})`).toBeLessThan(unmuteAt + Rig.dt + 1e-9);
    expect(rig.audio.captureEnabled).toBe(true);
    expect(rig.state).toBe('listening');
    expect(rig.engages).toEqual([{ personCount: 1, firstEngagement: true }]);
    expect(rig.perception.has(pin(1))).toBe(true);
  });

  test('unmuteNeverBeforeTheMinimumDelay', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    rig.person();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    rig.frame();
    const engagedAt = rig.clock.now;
    expect(rig.runUntil(2, () => rig.transport.micEnabled)).not.toBeNull();
    expect(rig.clock.now).toBeGreaterThanOrEqual(engagedAt + 0.25 - 1e-9);
    expect(rig.clock.now).toBeLessThan(engagedAt + 0.25 + Rig.dt + 1e-9);
  });

  test('nightWakeUnmutesAfterPointThreeWithoutGreeting', () => {
    const rig = new Rig();
    rig.life.isBedtime = true;
    rig.person();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    rig.frame();
    const engagedAt = rig.clock.now;
    expect(rig.runUntil(2, () => rig.transport.micEnabled)).not.toBeNull();
    expect(rig.clock.now).toBeGreaterThanOrEqual(engagedAt + 0.3 - 1e-9);
    expect(rig.audio.clips, 'no greeting at bedtime').toEqual([]);
    expect(Math.abs(rig.audio.gain - 0.8 * 0.5), 'TTS at voiceVolume × nightVoiceFactor').toBeLessThan(1e-6);
  });

  test('privacyNoMicBeforeEngagedListening', () => {
    const rig = new Rig();
    rig.person();
    rig.run(5);
    expect(rig.controller.session).toBe('ready');
    expect(rig.audio.captureChanges, 'capture stays gated while merely noticing').toEqual([]);
    expect(rig.transport.micChanges).toEqual([]);
    rig.person(1, { engaged: true });
    rig.frame();
    expect(rig.audio.captureEnabled, 'still gated during the engaged chirp').toBe(false);
    rig.run(1);
    expect(rig.audio.captureChanges).toEqual([true]);
  });

  test('greetingOnFirstEngagementAfterArrivalOnlyAndUnmuteWaitsForIt', () => {
    const rig = new Rig();
    rig.person();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    rig.frame();
    const engagedAt = rig.clock.now;
    rig.voice.audibleUntilHostTime = engagedAt + 0.4;
    expect(rig.runUntil(3, () => rig.transport.micEnabled)).not.toBeNull();
    const clip = rig.audio.clips[0];
    expect(clip).toBeDefined();
    expect(clip.at, 'the greeting follows the chirp').toBeGreaterThanOrEqual(engagedAt + 0.4 - 0.15);
    expect(rig.clock.now, 'unmute after the greeting').toBeGreaterThanOrEqual(clip.at + rig.audio.clipDuration + 0.1 - 1e-9);
    const greeted = rig.sentClient((i) => (i.kind === 'greeted' ? i.payload : null));
    expect(greeted).toEqual([{ text: 'hi!' }]);
    // Second engagement in the same visit: no greeting.
    rig.lookAway();
    rig.run(6);
    expect(rig.phase).toBe('idle');
    rig.person(1, { engaged: true });
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
    expect(rig.audio.clips.length).toBe(1);
    expect(rig.engages[rig.engages.length - 1]?.firstEngagement).toBe(false);
  });

  test('noGreetingInQuietModeOrWithSoundsOff', () => {
    for (const mode of [0, 1]) {
      const rig = new Rig();
      if (mode === 0) rig.controller.settings.quietMode = true; else rig.controller.settings.soundsOff = true;
      rig.person();
      rig.run(0.5);
      rig.person(1, { engaged: true });
      expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
      expect(rig.audio.clips).toEqual([]);
      expect(rig.greetings.picks).toBe(0);
    }
  });

  test('engagedFromIdleAndFromHasMessage', () => {
    for (const start of ['idle', 'hasMessage'] as AgentState[]) {
      const rig = new Rig();
      rig.person();
      rig.engine.setAgentState(start);
      rig.run(0.2);
      rig.person(1, { engaged: true });
      rig.frame();
      expect(rig.state, `from ${start}`).toBe('engaged');
    }
  });

  test('staringAfterListenTimeoutDoesNotReengage', () => {
    const rig = new Rig();
    rig.toListening();
    rig.run(5.1);
    expect(rig.phase).toBe('idle');
    expect(rig.state).toBe('noticing');
    rig.run(3);
    expect(rig.state, 'the same engagement is consumed until it ends').toBe('noticing');
    rig.lookAway();
    rig.frame();
    rig.person(1, { engaged: true });
    rig.frame();
    expect(rig.state, 'a fresh engagement starts again').toBe('engaged');
  });

  test('notConnectedThreeSecondsAfterEngagedGoesSheepish', () => {
    const rig = new Rig({ autoReady: false });
    rig.person();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    rig.run(2.9);
    expect(rig.state, 'engaged while still connecting').toBe('engaged');
    rig.run(0.2);
    expect(rig.state).toBe('sheepish');
    expect(rig.transport.micEnabled).toBe(false);
  });

  test('sheepishExitsOnReconnectAndRetriesTheStillEngagedPerson', () => {
    const rig = new Rig({ autoReady: false });
    rig.person();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    rig.run(3.1);
    expect(rig.state).toBe('sheepish');
    rig.transport.becomeReady();
    rig.frame();
    rig.frame();
    expect(rig.state, 'reconnect → try again (review H4)').toBe('engaged');
    expect(rig.runUntil(1, () => rig.phase === 'listening')).not.toBeNull();
  });

  test('sheepishRetriesAtMostOncePerWindow', () => {
    const rig = new Rig({ autoReady: false });
    rig.person();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    rig.run(3.1);
    expect(rig.state).toBe('sheepish');
    rig.lookAway();
    rig.frame();
    rig.person(1, { engaged: true });
    rig.run(1);
    expect(rig.state, "a new engagement within 30 s doesn't retry (review L9)").toBe('sheepish');
    rig.lookAway();
    rig.run(29);
    rig.person(1, { engaged: true });
    rig.frame();
    expect(rig.state).toBe('engaged');
  });

  test('suppressedClosesLookToTalk', () => {
    const rig = new Rig();
    rig.controller.isSuppressed = true;
    rig.person();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    rig.run(1);
    expect(rig.state).toBe('noticing');
    rig.controller.isSuppressed = false;
    rig.frame();
    expect(rig.state).toBe('engaged');
  });

  test('realVoiceDirectorChirpDelaysUnmute', () => {
    // Integration: the real director plans the engaged chirp on the state entry; unmute waits for it.
    const rig = new Rig();
    const director = new VoiceDirector(rig.engine, new VoiceRenderer(48000), new RunningOutput());
    director.clock = rig.clock.fn;
    rig.controller.voice = director;
    rig.person();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    let engagedAt = 0;
    for (let i = 0; i < 3; i++) {
      rig.frame();
      director.afterFrame(rig.clock.now);
      if (rig.state === 'engaged' && engagedAt === 0) engagedAt = rig.clock.now;
    }
    const chirpEnd = director.audibleUntilHostTime;
    expect(chirpEnd, 'an engaged chirp was planned').toBeGreaterThan(engagedAt + 0.2);
    while (!rig.transport.micEnabled && rig.clock.now < engagedAt + 3) {
      rig.frame();
      director.afterFrame(rig.clock.now);
    }
    expect(rig.clock.now).toBeGreaterThanOrEqual(chirpEnd + 0.1 - 1e-9);
  });
});
