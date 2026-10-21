// Port of ConversationAgentTests/OrchestrationTests.swift.
// port-note: the rig speaks through the fake HA's pipeline (no Wyoming): ASR/TTS "peers" become stt/tts runs.
import { describe, expect, test } from 'vitest';
import { makeAgentTunables } from '../../../src/conversation/core/VoiceServicesEndpoint';
import { at, stringValue } from '../../../src/conversation/agent/JSONValue';
import { AsyncMailbox, int16 } from '../support/AgentTestKit';
import { FakeHA, result } from '../support/FakeHomeAssistant';
import { AgentFixtures } from './FixtureSupport';
import { OrchRig } from './OrchestratorRig';

describe('OrchestrationTurnTests', () => {
  test('connectAuthenticatesDescribesAndReportsServicesInfo', async () => {
    const rig = new OrchRig();
    expect(await rig.connect()).toBe(true);
    expect(rig.statuses.slice(0, 2)).toEqual([{ kind: 'connecting' }, { kind: 'ready' }]);
    const first = rig.events[0];
    expect(first?.kind).toBe('servicesInfo');
    if (first?.kind !== 'servicesInfo') return;
    expect(first.payload.voiceId).toBe('ha:01PIPE:tts.piper:en_US-lessac-medium');
    expect(first.payload.decisionModel === 'up' && first.payload.ttsAvailable).toBe(true);
    expect(rig.ha.runs('stt')).toEqual([]); // no ASR run before speech-start
  });

  test('aWholeTurnStreamsTheReplyThroughTTSWithExactTiming', async () => {
    const rig = new OrchRig();
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
    expect(rig.eventNames.filter((n) => n !== 'decisionB'))
      .toEqual(['servicesInfo', 'turnEnded', 'decisionA', 'sentenceStart', 'sentenceStart', 'replyEnd']);
    expect(rig.turnEnded()).toEqual({ turnId: 't-1', transcriptChars: 30 });
    // The gate is sequential: jev.ask before the agent run.
    const types = rig.ha.logTypes;
    const jev = types.indexOf('call_service:jev.ask');
    const run = rig.ha.log.findIndex((m) => m.type === 'assist_pipeline/run' && m.start_stage === 'intent');
    expect(jev).toBeGreaterThanOrEqual(0);
    expect(jev).toBeLessThan(run);
    // The user text reaches the agent unmodified (review R2).
    expect(at(rig.ha.runs('intent')[0], 'input', 'text')).toBe("what's the weather like today?");
    // Timing from the real queued sample counts (16 kHz → 48 kHz).
    const starts = rig.sentenceStarts();
    expect(starts.map((s) => s.sentenceIndex)).toEqual([0, 1]);
    expect(starts[0].offsetMs).toBe(0);
    const end = rig.replyEnds()[0];
    expect(end.sentences).toBe(2);
    expect(end.audioMs).toBe(Math.round(rig.sink.framesQueued / 48));
    expect(starts[1].offsetMs > 0 && starts[1].offsetMs < end.audioMs).toBe(true);
    expect(rig.decisions()[0]?.version).toBe(4);
    expect(await rig.drive(1, () => rig.decisions().filter((d) => d.pass === 'sentence').length === 2)).toBe(true);
  });

  test('preRollStartsThreeHundredMillisecondsBeforeTheOnset', async () => {
    const rig = new OrchRig();
    expect(await rig.connect()).toBe(true);
    const onset = await rig.startSpeaking();
    const expected = rig.audio.sampleIndex(onset - 0.3)!;
    await rig.talk(0.1);
    await rig.endTurn();
    expect(await rig.drive(3, () => rig.turnEnded() !== undefined)).toBe(true);
    expect(rig.ha.sttAudio[0]?.[0]).toBe(int16(expected));
    expect(rig.ha.binarySizes.every((n) => n <= 641)).toBe(true); // ≤ 640 bytes of PCM plus the handler byte
  });

  test('emptyTranscriptMeansDidNotUnderstandWithoutJevOrAgent', async () => {
    const rig = new OrchRig();
    rig.transcript = '  …  ';
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(3, () => rig.has('didNotUnderstand:empty'))).toBe(true);
    expect(rig.ha.count('call_service:jev.ask')).toBe(0);
    expect(rig.ha.agentCalls).toBe(0);
  });

  test.each([[0.1, 0.9, 'notForMe'], [0.9, 0.2, 'didNotUnderstand:unclear']] as const)(
    'notForMeAndUnclearNeverReachTheAgent (%s, %s)', async (addressed, understood, expected) => {
      const rig = new OrchRig();
      rig.ha.configure((c) => { c.onJev = async () => result(FakeHA.jevResponse({ addressed, understood })); });
      expect(await rig.connect()).toBe(true);
      await rig.userTurn();
      expect(await rig.drive(3, () => rig.has(expected))).toBe(true);
      await rig.drive(0.5, () => false);
      expect(rig.ha.agentCalls).toBe(0); // S4: zero agent calls
      const names = rig.eventNames;
      expect(names.indexOf('decisionA')).toBeLessThan(names.indexOf(expected)); // decision precedes the gate event
    });

  test('noAgentMessageBeforeTheVerdictAndFailOpenOnTimeout', async () => {
    const rig = new OrchRig();
    const hold = new AsyncMailbox<void>();
    rig.ha.configure((c) => { c.onJev = async () => { await hold.pop(); return result(FakeHA.jevResponse({ addressed: 0 })); }; });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(0.4, () => rig.ha.count('call_service:jev.ask') === 1)).toBe(true);
    expect(rig.ha.agentCalls).toBe(0); // nothing reaches the agent while Pass A is pending
    // 600 ms after the send the gate fails open: the agent runs, unavailable is reported once.
    expect(await rig.drive(2, () => rig.ha.agentCalls === 1)).toBe(true);
    expect(rig.eventNames.filter((n) => n.startsWith('unavailable'))).toEqual(['unavailable:timeout']);
    expect(rig.has('decisionA')).toBe(false); // no decision on a timeout
    hold.push(); // the late "not for me" answer is ignored
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
    expect(rig.has('notForMe')).toBe(false);
  });

  test('passBNeverDelaysTheVoice', async () => {
    const rig = new OrchRig();
    const hold = new AsyncMailbox<void>();
    rig.ha.configure((c) => {
      c.onJev = async (data) => {
        if (at(data, 'state', 'yanni_says') !== undefined) await hold.pop(); // Pass B never answers
        return result(FakeHA.jevResponse());
      };
    });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
    expect(rig.sink.framesQueued > 0 && rig.sentenceStarts().length === 2).toBe(true);
    expect(rig.has('decisionB')).toBe(false);
    hold.close();
  });

  test('bargeInMidReplyClosesTTSUnsubscribesAndAcknowledges', async () => {
    const rig = new OrchRig();
    const hold = new AsyncMailbox<void>();
    rig.ha.configure((c) => {
      c.onTTS = async (_t, run) => { if (run === 1) await hold.pop(); return FakeHA.ttsRun(`tts-${run}.wav`); }; // chunk 1 waits
    });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.sentenceStarts().length === 1)).toBe(true);
    expect(await rig.drive(1, () => rig.ha.runs('tts').length === 2)).toBe(true);
    await rig.startSpeaking(); // barge-in
    expect(await rig.drive(2, () => rig.has('interrupted'))).toBe(true);
    const second = rig.ha.runs('tts').at(-1)!.id as number;
    expect(await rig.drive(1, () => rig.ha.isUnsubscribed(second))).toBe(true);
    hold.push();
    await rig.drive(0.5, () => false);
    expect(rig.replyEnds()).toEqual([]); // nothing more for a cut reply
    expect(rig.ha.runs('stt').length).toBe(2); // the new turn's ASR run is open
  });

  test('speechWhileThinkingVoidsTheTurn', async () => {
    const rig = new OrchRig();
    const hold = new AsyncMailbox<void>();
    rig.ha.configure((c) => { c.onJev = async () => { await hold.pop(); return result(FakeHA.jevResponse()); }; });
    rig.services.tunables = makeAgentTunables({ gateTimeout: 1.5 });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(0.5, () => rig.ha.count('call_service:jev.ask') === 1)).toBe(true);
    await rig.startSpeaking();
    hold.push();
    await rig.drive(2, () => false);
    expect(rig.ha.agentCalls === 0 && !rig.has('decisionA') && !rig.has('interrupted')).toBe(true);
    expect(rig.ha.runs('stt').length).toBe(2);
  });

  test('micClosedWhileCapturingDropsTheTurnWithoutAudioStop', async () => {
    const rig = new OrchRig();
    expect(await rig.connect()).toBe(true);
    await rig.startSpeaking();
    await rig.talk(0.1);
    rig.orch.micClosed();
    await rig.drive(0.5, () => false);
    const run = rig.ha.runs('stt')[0]!.id as number;
    expect(rig.ha.sttAudio).toEqual([]); // no end-of-audio frame
    expect(rig.ha.isUnsubscribed(run)).toBe(true);
    expect(rig.eventNames).toEqual(['servicesInfo']);
  });

  test('wholeRepliesAndTheProcessFallbackAndConversationIDs', async () => {
    const rig = new OrchRig();
    rig.ha.configure((c) => { c.onPipeline = async (_m, emit) => FakeHA.stream(FakeHA.wholeRun('Turned off the kitchen lights.'), emit); });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length === 1)).toBe(true);
    expect(rig.orch.currentConversationID).toBe('01CONVWHOLE');
    // Unknown command → conversation/process for good, with the id read back.
    rig.ha.configure((c) => { c.pipelineSupported = false; });
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length === 2)).toBe(true);
    const process = rig.ha.log.filter((m) => m.type === 'conversation/process').at(-1)!;
    expect(process.conversation_id === '01CONVWHOLE' && process.agent_id === 'conversation.jev').toBe(true);
    expect(rig.orch.currentConversationID).toBe('01CONV');
    // engage starts a new conversation session.
    rig.orch.handle({ kind: 'engage', payload: { personCount: 1, firstEngagement: false } });
    expect(rig.orch.currentConversationID).toBeNull();
  });

  test('streamedDeltasIgnoreThinkingAndToolContent', async () => {
    const rig = new OrchRig();
    const events = AgentFixtures.pipelineEvents('pipeline-run-streamed.json');
    rig.ha.configure((c) => { c.onPipeline = async (_m, emit) => FakeHA.stream(events, emit); });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
    expect(rig.ttsTexts()).toEqual(["It's sunny and warm,", 'about 21 degrees.', 'Perfect for a walk!']);
    expect(stringValue(at(rig.ha.runs('tts')[0], 'start_stage'))).toBe('tts');
  });
});
