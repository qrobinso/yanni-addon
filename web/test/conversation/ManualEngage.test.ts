// Port of Tests/ConversationCoreTests/ManualEngageTests.swift.
// Hold to talk and the space bar (`engageManually`): engage without gaze, ignored mid-conversation, dormant says why,
// waits for a tap wake, retries from sheepish, never opens with an announcement.
import { describe, expect, test } from 'vitest';
import type { ConversationPhase } from '../../src/conversation/core/ConversationController';
import { pin } from './support/Fakes';
import { Rig } from './support/Rig';

describe('ManualEngageTests', () => {
  test('engagesWithoutGazeAndListens', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    rig.person();   // present, nobody looking
    rig.run(0.5);
    expect(rig.controller.engageManually()).toEqual({ kind: 'engaged' });
    expect(rig.state, 'the engaged state at once (its perk and chirp)').toBe('engaged');
    expect(rig.controller.engagementTrigger).toBe('manual');
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
    expect(rig.transport.micEnabled && rig.audio.captureEnabled).toBe(true);
    expect(rig.engages.length).toBe(1);
    expect(rig.perception.outcomes, 'a manual engagement is never a look-to-talk outcome').toEqual([]);
    // The turn runs as usual.
    rig.speak();
    rig.run(0.5);
    rig.endTurn();
    rig.frame();
    expect(rig.phase).toBe('thinking');
  });

  test('engagesWithNobodyInViewAndConnectsTheSession', () => {
    const rig = new Rig();
    rig.run(1);
    expect(rig.controller.session).toBe('disconnected');
    expect(rig.controller.engageManually()).toEqual({ kind: 'engaged' });
    expect(rig.runUntil(3, () => rig.phase === 'listening')).not.toBeNull();
    expect(rig.controller.session).toBe('ready');
  });

  test('theLookingPersonHoldsTheTurn', () => {
    const rig = new Rig();
    rig.controller.isSuppressed = true;   // keep look-to-talk from engaging first
    rig.person(7, { engaged: true });
    rig.run(0.5);
    rig.controller.isSuppressed = false;
    expect(rig.controller.engageManually()).toEqual({ kind: 'engaged' });
    expect(rig.controller.turnPerson).toBe(7);
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
    expect(rig.perception.has(pin(7))).toBe(true);
    // Over: the same gaze doesn't immediately re-engage (already consumed).
    rig.run(6);
    expect(rig.phase).toBe('idle');
    expect(rig.engages.length).toBe(1);
  });

  test.each(['listening', 'thinking', 'speaking'] as ConversationPhase[])('ignoredMidConversation(%s)', (during) => {
    const rig = new Rig();
    switch (during) {
      case 'listening': rig.toListening(); break;
      case 'thinking': rig.toThinking(); break;
      default: rig.toSpeaking();
    }
    expect(rig.phase).toBe(during);
    const engages = rig.engages.length;
    const mic = rig.transport.micEnabled;
    expect(rig.controller.engageManually()).toEqual({ kind: 'ignored', phase: during });
    rig.frame();
    expect(rig.phase, 'nothing changes').toBe(during);
    expect(rig.engages.length).toBe(engages);
    expect(rig.transport.micEnabled).toBe(mic);
  });

  test('dormantSaysWhyAndChangesNothing', () => {
    const rig = new Rig({ configured: false });
    rig.person();
    rig.run(0.5);
    expect(rig.controller.engageManually()).toEqual({ kind: 'unavailable', reason: 'voice services not set up' });
    rig.run(1);
    expect(rig.phase).toBe('idle');
    expect(rig.state).toBe('noticing');
    expect(rig.transport.micEnabled).toBe(false);
    const off = new Rig();
    off.controller.settings.enabled = false;
    off.frame();
    expect(off.controller.engageManually()).toEqual({ kind: 'unavailable', reason: 'voice conversation off' });
  });

  test('closedWhileSettingsOpenOrForceSleep', () => {
    const rig = new Rig();
    rig.controller.isSuppressed = true;
    expect(rig.controller.engageManually()).toEqual({ kind: 'unavailable', reason: 'settings open' });
    rig.controller.isSuppressed = false;
    rig.life.isForceSleepActive = true;
    expect(rig.controller.engageManually()).toEqual({ kind: 'unavailable', reason: 'force sleep' });
    rig.run(1);
    expect(rig.phase).toBe('idle');
  });

  test('waitsForTheTapWakeThenEngages', () => {
    const rig = new Rig();
    rig.engine.setAgentState('asleep');
    rig.run(0.5);
    expect(rig.controller.engageManually()).toEqual({ kind: 'pending' });
    rig.engine.setAgentState('waking');   // the wake tap's gentle wake
    rig.run(1);
    expect(rig.phase, 'still waking').toBe('idle');
    rig.engine.setAgentState('noticing');
    rig.frame();
    expect(rig.state).toBe('engaged');
    expect(rig.controller.engagementTrigger).toBe('manual');
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
  });

  test('aWakeThatNeverComesLapses', () => {
    const rig = new Rig();
    rig.engine.setAgentState('asleep');   // bedtime: one tap isn't enough
    rig.run(0.5);
    expect(rig.controller.engageManually()).toEqual({ kind: 'pending' });
    rig.run(4.5);
    rig.engine.setAgentState('noticing');
    rig.run(1);
    expect(rig.phase, 'lapsed after the wake window').toBe('idle');
    expect(rig.engages).toEqual([]);
  });

  test('retriesAtOnceFromSheepish', () => {
    const rig = new Rig({ autoReady: false });
    rig.person();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    rig.run(3.1);
    expect(rig.state).toBe('sheepish');
    rig.lookAway();
    rig.frame();
    expect(rig.controller.engageManually(), 'asked by hand: no 30 s retry window').toEqual({ kind: 'engaged' });
    expect(rig.state).toBe('engaged');
  });

  test('neverOpensWithAnAnnouncement', () => {
    const rig = new Rig();
    rig.announcements.add('a1', 'the laundry is done');
    rig.person();
    rig.run(0.5);
    expect(rig.controller.engageManually()).toEqual({ kind: 'engaged' });
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
    expect(rig.announcements.taken).toEqual([]);
    expect(rig.proactives).toEqual([]);
  });

  test('nightWakeEngagesQuietly', () => {
    const rig = new Rig();
    rig.life.isBedtime = true;
    rig.person();
    rig.run(0.5);
    expect(rig.controller.engageManually()).toEqual({ kind: 'engaged' });
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
    expect(rig.audio.clips, 'no greeting at bedtime').toEqual([]);
  });

  test('aTapWhileListeningStopsEverything', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    rig.person();
    rig.run(0.5);
    expect(rig.controller.engageManually()).toEqual({ kind: 'engaged' });
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
    expect(rig.controller.cancelByTap()).toBe(true);
    rig.frame();
    expect(rig.phase).toBe('idle');
    expect(rig.transport.micEnabled || rig.audio.captureEnabled || rig.detector.listening).toBe(false);
    rig.run(2);
    expect(rig.phase, "it doesn't reopen on its own").toBe('idle');
    expect(rig.controller.cancelByTap(), 'nothing to cancel with the mic closed').toBe(false);
  });

  test('aTapWhileThinkingCancelsTheTurn', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    rig.person();
    rig.run(0.5);
    rig.controller.engageManually();
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
    rig.speak();
    rig.run(0.5);
    rig.endTurn();
    rig.frame();
    expect(rig.phase).toBe('thinking');
    expect(rig.controller.cancelByTap()).toBe(true);
    expect(rig.phase).toBe('idle');
    expect(rig.controller.currentTurn).toBeNull();
  });

  test('aTapWhileSpeakingStopsTheReply', () => {
    const rig = new Rig();
    rig.toSpeaking('t1');
    rig.playReply(0.3);
    const flushes = rig.audio.flushes;
    expect(rig.controller.cancelByTap()).toBe(true);
    expect(rig.phase).toBe('idle');
    expect(rig.audio.flushes).toBeGreaterThan(flushes);
    expect(rig.voice.isSpeaking).toBe(false);
    expect(rig.cancels.some((c) => c.turnId === 't1')).toBe(true);
  });
});
