// Port of Tests/ConversationCoreTests/SessionTests.swift.
// Connect / disconnect rules (voice-loop design §8, review H4 "connect on presence", L8, M3).
import { describe, expect, test } from 'vitest';
import type { ServicesInfo } from '../../src/conversation/events/AgentEvents';
import type { AgentState } from '../../src/engine/AgentState';
import { dryRun, unpin } from './support/Fakes';
import { Rig } from './support/Rig';

describe('SessionTests', () => {
  test('dormantWithoutVoiceServicesKeepsDryRunAndNeverConnects', () => {
    const rig = new Rig({ configured: false });
    rig.person(1, { engaged: true });
    rig.run(2);
    expect(rig.controller.session).toBe('dormant');
    expect(rig.transport.connects).toEqual([]);
    expect(rig.perception.has(dryRun(true))).toBe(true);
    expect(rig.phase).toBe('idle');
    expect(rig.state, 'the face works exactly as without voice services').toBe('noticing');
  });

  test('liveControllerTurnsTheDryRunOff', () => {
    const rig = new Rig();
    rig.frame();
    const dry = rig.perception.calls.filter((c) => c.kind === 'dryRun');
    expect(dry[dry.length - 1]).toEqual(dryRun(false));
  });

  test('connectsOnPresenceNotOnTheNoticingState', () => {
    const rig = new Rig();
    rig.engine.setAgentState('noticing');   // noticing without confirmed presence: no session
    rig.run(1);
    expect(rig.transport.connects).toEqual([]);
    rig.life.isPresent = true;
    rig.frame();
    expect(rig.transport.connects.length).toBe(1);
    expect(rig.audio.conversationMode, 'voice processing warms up at presence').toBe(true);
    expect(rig.controller.session).toBe('ready');
    expect(rig.reachability).toEqual([true]);
  });

  test('noConnectionWhileAsleepDrowsyOrHalfAwake', () => {
    for (const s of ['asleep', 'drowsy', 'halfAwake', 'waking'] as AgentState[]) {
      const rig = new Rig();
      rig.engine.setAgentState(s);
      rig.life.isPresent = true;
      rig.run(1);
      expect(rig.transport.connects, s).toEqual([]);
      expect(rig.audio.conversationMode).toBe(false);
    }
  });

  test('bedtimeConnectsOnlyOnEngagement', () => {
    const rig = new Rig();
    rig.life.isBedtime = true;
    rig.person();
    rig.run(1);
    expect(rig.transport.connects, "a night wake doesn't connect on mere presence").toEqual([]);
    rig.person(1, { engaged: true });
    rig.frame();
    expect(rig.transport.connects.length).toBe(1);
  });

  test('disconnectsTwentySecondsAfterEveryoneLeft', () => {
    const rig = new Rig();
    rig.person();
    rig.run(1);
    rig.leave();
    rig.engine.setAgentState('idle');
    rig.run(19);
    expect(rig.transport.disconnects).toBe(0);
    rig.run(1.1);
    expect(rig.transport.disconnects).toBe(1);
    rig.run(rig.controller.timings.audioModeHold);
    expect(rig.audio.conversationMode, 'conversation audio ends once the hold runs out').toBe(false);
  });

  test('disconnectsAfterNinetySecondsPresentWithoutEngagingAndReconnectsOnEngagement', () => {
    const rig = new Rig();
    rig.person(1, { facing: 0 });
    rig.run(89);
    expect(rig.transport.disconnects).toBe(0);
    expect(rig.audio.conversationMode).toBe(true);
    rig.run(2);
    expect(rig.transport.disconnects).toBe(1);
    expect(rig.audio.conversationMode, 'the audio mode holds past the session, so re-engaging is quick').toBe(true);
    rig.person(1, { engaged: true, facing: 0 });
    rig.frame();
    expect(rig.transport.connects.length).toBe(2);
    expect(rig.runUntil(1, () => rig.phase === 'listening')).not.toBeNull();
  });

  test('someoneFacingYanniKeepsTheSessionWarmAndRewarmsIt', () => {
    const rig = new Rig();
    rig.person(1, { facing: 1 });
    rig.run(120);
    expect(rig.transport.disconnects, 'facing Yanni keeps voice processing warm').toBe(0);
    rig.person(1, { facing: 0 });
    rig.run(91);
    expect(rig.transport.disconnects).toBe(1);
    rig.person(1, { facing: 0.8 });
    rig.frame();
    expect(rig.transport.connects.length, 'turning to face Yanni warms it again before any engagement').toBe(2);
    expect(rig.audio.conversationMode).toBe(true);
  });

  test('disconnectsWhenTheAppGoesInactive', () => {
    const rig = new Rig();
    rig.toListening();
    rig.controller.isAppActive = false;
    rig.frame();
    expect(rig.transport.disconnects).toBe(1);
    expect(rig.phase).toBe('idle');
    expect(rig.audio.captureEnabled || rig.transport.micEnabled).toBe(false);
  });

  test('goingInactiveNeverLeavesTheFaceInAConversationState', () => {
    const rig = new Rig();
    rig.toListening();
    expect(rig.state).toBe('listening');
    rig.controller.isAppActive = false;
    // No frame: the background may stop the frame clock before the next one.
    expect(rig.phase).toBe('idle');
    expect(rig.state, 'back to noticing at once, never stuck listening').toBe('noticing');
    expect(rig.transport.disconnects).toBe(1);
    expect(rig.audio.captureEnabled || rig.transport.micEnabled).toBe(false);
    expect(rig.audio.conversationMode).toBe(false);
    rig.run(1);
    expect(rig.transport.connects.length, 'no reconnect while inactive').toBe(1);
    rig.controller.isAppActive = true;
    rig.run(0.5);
    expect(rig.transport.connects.length, 'back in the foreground with someone here: connects again').toBe(2);
  });

  test('forceSleepEndsTheConversationAndDisconnects', () => {
    const rig = new Rig();
    rig.toListening();
    rig.engine.setAgentState('drowsy');   // the life cycle's force sleep
    rig.frame();
    expect(rig.phase).toBe('idle');
    expect(rig.state, 'the controller never overrides the life cycle').toBe('drowsy');
    expect(rig.transport.disconnects).toBe(1);
    expect(rig.perception.has(unpin)).toBe(true);
  });

  test('reconnectBacksOffOneTwoFourSeconds', () => {
    const rig = new Rig({ autoReady: false });
    rig.person();
    rig.frame();
    expect(rig.transport.connects.length).toBe(1);
    rig.transport.fail();
    expect(rig.reachability).toEqual([false]);
    rig.run(0.9);
    expect(rig.transport.connects.length).toBe(1);
    rig.run(0.2);
    expect(rig.transport.connects.length).toBe(2);
    rig.transport.fail();
    rig.run(1.9);
    expect(rig.transport.connects.length).toBe(2);
    rig.run(0.2);
    expect(rig.transport.connects.length).toBe(3);
    rig.transport.fail();
    rig.run(3.9);
    expect(rig.transport.connects.length).toBe(3);
    rig.run(0.2);
    expect(rig.transport.connects.length).toBe(4);
    rig.transport.becomeReady();
    expect(rig.reachability).toEqual([false, true]);
  });

  test('connectionEventsAreNotActivity', () => {
    const rig = new Rig();
    rig.person();
    rig.run(1);
    expect(rig.life.activity, 'review M3: only real turns and replies count').toEqual([]);
  });

  test('servicesInfoIsAdoptedAndTheThinkingTimeoutIsTheLocalSetting', () => {
    const info: ServicesInfo = { haVersion: '2026.10.1', voiceId: 'wyoming:192.168.1.20:en_US-lessac-medium',
      decisionModel: 'up', replyVoice: 'spoken', ttsAvailable: true };
    const rig = new Rig({ info });
    const seen: ServicesInfo[] = [];
    rig.controller.onServicesInfo = (i) => seen.push(i);
    rig.controller.settings.thinkingTimeout = 9;
    rig.toThinking();
    expect(seen).toEqual([info]);
    expect(rig.controller.status.haVersion).toBe('2026.10.1');
    expect(rig.controller.status.replyVoice).toBe('spoken');
    rig.run(8.5);
    expect(rig.phase, 'the owner set 9 s').toBe('thinking');
    rig.run(0.6);
    expect(rig.phase).toBe('sheepish');
  });

  test('theDefaultThinkingTimeoutIsEightSeconds', () => {
    const rig = new Rig();
    expect(rig.controller.settings.thinkingTimeout).toBe(8);
    rig.toThinking();
    rig.run(7.8);
    expect(rig.phase).toBe('thinking');
    rig.run(0.3);
    expect(rig.phase).toBe('sheepish');
  });

  test('contextIsSentOnReadyAndOnChange', () => {
    const rig = new Rig();
    rig.person();
    rig.frame();
    const contexts = rig.sentClient((i) => (i.kind === 'context' ? i.payload : null));
    expect(contexts).toEqual([{ quietMode: false, peopleCount: 1 }]);
    rig.controller.settings.quietMode = true;
    rig.run(2.1);
    const after = rig.sentClient((i) => (i.kind === 'context' ? i.payload : null));
    expect(after[after.length - 1]).toEqual({ quietMode: true, peopleCount: 1 });
  });
});
