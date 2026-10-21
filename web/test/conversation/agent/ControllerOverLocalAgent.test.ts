// Port of ConversationAgentTests/ControllerOverLocalAgentTests.swift: the controller's rows, end to end against
// `LocalAgentTransport` with the fake HA (design S8). port-note: Wyoming peers become the fake HA's stt/tts runs.
import { describe, expect, test } from 'vitest';
import { outcome, pin } from '../support/Fakes';
import { AsyncMailbox } from '../support/AgentTestKit';
import { FakeHA, result } from '../support/FakeHomeAssistant';
import type { JSONObject } from '../../../src/conversation/agent/JSONValue';
import { AgentControllerRig } from './AgentControllerRig';

const closing = (only: number, withRequest = 0): JSONObject =>
  ({ closing: { choice: 'only', probabilities: { only, withRequest, no: Math.max(1 - only - withRequest, 0) } } });
const lines = (rig: AgentControllerRig) => rig.log.map((e) => `${e.kind}: ${e.detail}`).join('\n');

describe('ControllerOverLocalAgentTests', () => {
  test('connectsOnPresenceAndAdoptsTheServicesInfo', async () => {
    const rig = new AgentControllerRig();
    expect(rig.transport.status.kind).toBe('disconnected');
    rig.person();
    expect(await rig.runUntil(3, () => rig.controller.session === 'ready')).toBe(true);
    expect(rig.controller.servicesInfo?.voiceId).toBe('ha:01PIPE:tts.piper:en_US-lessac-medium');
    expect(rig.controller.status.haVersion).toBe(rig.controller.servicesInfo?.haVersion);
    expect(rig.reachability).toEqual([true]);
    expect(rig.ha.runs('stt')).toEqual([]); // no mic audio at connect
  });

  test('aTurnGoesThinkingSpeakingFollowUpWithTheLocalTurnId', async () => {
    const rig = new AgentControllerRig();
    expect(await rig.toListening()).toBe(true);
    expect(rig.perception.has(pin(1))).toBe(true);
    await rig.userTurn();
    expect(rig.phase === 'thinking' || rig.phase === 'speaking').toBe(true);
    expect(await rig.runUntil(3, () => rig.controller.currentTurn === 't-1' || rig.phase === 'speaking')).toBe(true);
    expect(await rig.runUntil(5, () => rig.phase === 'speaking')).toBe(true);
    expect(rig.voice.isSpeaking).toBe(true);
    expect(await rig.runUntil(8, () => rig.phase === 'followUp'), lines(rig)).toBe(true);
    expect(rig.emotion.sentenceStarts.map((s) => s.index)).toEqual([0, 1]); // sentence starts timed by samples played
    expect(rig.emotion.received.some((m) => m.kind === 'decision' && m.payload.pass === 'utterance')).toBe(true);
    expect(rig.controller.status.lastTurn?.replyAudioMs).not.toBeNull();
    expect(await rig.runUntil(8, () => rig.phase === 'idle')).toBe(true); // the follow-up window ends
  });

  test('notForMeShowsTheFaceAndNeverCallsTheAgent', async () => {
    const rig = new AgentControllerRig();
    rig.ha.configure((c) => { c.onJev = async () => result(FakeHA.jevResponse({ addressed: 0.05 })); });
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(3, () => rig.state === 'notForMe')).toBe(true);
    await rig.run(0.5);
    expect(rig.ha.agentCalls).toBe(0);
    expect(rig.perception.outcomes).toEqual([outcome(1, false)]);
  });

  test('aDismissalClosesTheMicWithoutCallingTheAgent', async () => {
    const rig = new AgentControllerRig();
    rig.ha.configure((c) => { c.onJev = async () => result(FakeHA.jevResponse({ extra: closing(0.9) })); });
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(3, () => rig.phase === 'idle')).toBe(true);
    expect(rig.state).toBe('noticing');
    expect(rig.controller.micOpen).toBe(false);
    expect(await rig.runUntil(1, () => rig.engine.state.activeOneShots.includes('nodYes'))).toBe(true);
    await rig.run(1);
    expect(rig.ha.agentCalls).toBe(0); // no reply, and looking on doesn't reopen the mic
    expect(rig.phase).toBe('idle');
    expect(rig.controller.status.lastDismissal).toBe('closing p 0.90');
  });

  test('aRequestWithASignOffSkipsTheFollowUpWindow', async () => {
    const rig = new AgentControllerRig();
    rig.ha.configure((c) => { c.onJev = async () => result(FakeHA.jevResponse({ extra: closing(0.05, 0.85) })); });
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(5, () => rig.phase === 'speaking')).toBe(true);
    expect(await rig.runUntil(8, () => rig.phase !== 'speaking')).toBe(true);
    expect(rig.phase === 'idle' && !rig.controller.micOpen, lines(rig)).toBe(true);
    expect(rig.ha.agentCalls).toBe(1);
    expect(rig.log.some((e) => e.kind === 'state' && e.detail === 'followUp')).toBe(false);
  });

  test('didNotUnderstandShowsConfused', async () => {
    const rig = new AgentControllerRig();
    rig.ha.configure((c) => { c.onJev = async () => result(FakeHA.jevResponse({ understood: 0.1 })); });
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(3, () => rig.state === 'confused')).toBe(true);
    expect(rig.ha.agentCalls).toBe(0);
  });

  test('bargeInWhileSpeakingCutsTheReplyAndListensAgain', async () => {
    const rig = new AgentControllerRig();
    const hold = new AsyncMailbox<void>(); // chunk 1 is still being voiced when the person talks
    rig.ha.configure((c) => { c.onTTS = async (_t, run) => { if (run === 1) await hold.pop(); return FakeHA.ttsRun(`tts-${run}.wav`); }; });
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(6, () => rig.phase === 'speaking')).toBe(true);
    rig.speak();
    await rig.frame();
    expect(rig.phase).toBe('interrupted');
    expect(rig.audio.flushes).toBe(1);
    expect(rig.voice.cancels).toBeGreaterThanOrEqual(1);
    expect(await rig.runUntil(2, () => rig.has('interrupted'))).toBe(true); // the transport acknowledges the cut
    const second = rig.ha.runs('tts').at(-1)!.id as number;
    expect(await rig.runUntil(1, () => rig.ha.isUnsubscribed(second))).toBe(true);
    expect(rig.ha.runs('stt').length).toBe(2);
    hold.close();
  });

  test('speechWhileThinkingVoidsTheTurn', async () => {
    const rig = new AgentControllerRig();
    const hold = new AsyncMailbox<void>();
    rig.ha.configure((c) => { c.onJev = async () => { await hold.pop(); return result(FakeHA.jevResponse()); }; });
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(0.3, () => rig.ha.count('call_service:jev.ask') === 1)).toBe(true);
    rig.speak();
    await rig.frame();
    expect(rig.phase).toBe('listening');
    hold.close();
    await rig.run(1);
    expect(rig.ha.agentCalls).toBe(0); // the voided turn's late verdict reaches no agent (gate timeout included)
  });

  test('thinkingTimeoutGoesSheepishAndCancelsTheAgentRun', async () => {
    const rig = new AgentControllerRig();
    rig.ha.configure((c) => { c.onPipeline = () => new Promise<void>(() => {}); });
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(3, () => rig.ha.agentCalls === 1)).toBe(true);
    expect(await rig.runUntil(9, () => rig.state === 'sheepish')).toBe(true);
    expect(rig.log.some((e) => e.kind === 'thinking' && e.detail === 'timeout')).toBe(true);
    expect(await rig.runUntil(1, () => rig.ha.count('unsubscribe_events') === 1)).toBe(true); // cancel-turn stops HA's run
  });

  test('sttFailureGoesSheepish', async () => {
    const rig = new AgentControllerRig();
    expect(await rig.toListening()).toBe(true);
    rig.ha.configure((c) => { c.sttRefusal = 'stt-provider-missing'; c.sttRefuseTimes = 2; });
    await rig.userTurn();
    expect(await rig.runUntil(3, () => rig.state === 'sheepish')).toBe(true);
  });

  test('homeAssistantDropGoesSheepishAndReconnectsWithBackoff', async () => {
    const rig = new AgentControllerRig();
    expect(await rig.toListening()).toBe(true);
    const opens = rig.ha.opens;
    rig.ha.drop();
    expect(await rig.runUntil(2, () => rig.state === 'sheepish')).toBe(true);
    expect(rig.reachability.at(-1)).toBe(false);
    expect(await rig.runUntil(4, () => rig.ha.opens > opens && rig.controller.session === 'ready')).toBe(true);
    expect(rig.reachability.at(-1)).toBe(true);
  });

  test('engagementDeliversAnAnnouncementThroughAITask', async () => {
    const rig = new AgentControllerRig({ aiTask: 'ai_task.openai' });
    rig.announcements.add('laundry', 'The laundry is done.');
    rig.person();
    expect(await rig.runUntil(3, () => rig.transport.status.kind === 'ready')).toBe(true);
    rig.turnAudio.open(rig.clock.now);
    rig.person(1, true);
    expect(await rig.runUntil(8, () => rig.announcements.finished[0]?.outcome === 'spoken')).toBe(true);
    expect(rig.ha.agentCalls).toBe(0);
    expect(rig.ha.count('call_service:ai_task.generate_data')).toBe(1);
  });

  test('yanniModeWithoutTTSReportsUnavailableAndHoldsTheBatch', async () => {
    const rig = new AgentControllerRig({ replyVoice: 'yanni', tts: false });
    rig.announcements.add('laundry', 'The laundry is done.');
    rig.person();
    expect(await rig.runUntil(3, () => rig.transport.status.kind === 'ready')).toBe(true);
    rig.turnAudio.open(rig.clock.now);
    rig.person(1, true);
    expect(await rig.runUntil(3, () => rig.announcements.finished[0]?.outcome === 'unavailable')).toBe(true);
    // The queue still holds it (the coordinator requeues); the same person isn't offered it again for 10 min.
    rig.announcements.add('laundry', 'The laundry is done.');
    await rig.run(5);
    rig.lookAwayAndBack();
    await rig.run(3);
    expect(rig.announcements.taken.length).toBe(1);
  });
});
