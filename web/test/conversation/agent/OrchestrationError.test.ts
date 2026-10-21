// Port of ConversationAgentTests/OrchestrationErrorTests.swift.
// port-note: Wyoming refusals / drops become the fake HA's stt refusals and tts run errors; "token rejected" becomes
// "HA isn't connected" (the add-on authenticates); the Wyoming clip render test is covered by the HA one in
// HomeAssistantSpeech.test.ts (ClipStore isn't ported).
import { describe, expect, test } from 'vitest';
import { agentErrorEquals, describeError } from '../../../src/conversation/events/AgentEvents';
import { makeProactiveItem, type AgentIntent } from '../../../src/conversation/events/AgentIntents';
import { makeAgentTunables } from '../../../src/conversation/core/VoiceServicesEndpoint';
import { at } from '../../../src/conversation/agent/JSONValue';
import { sensorState } from '../../../src/conversation/agent/Ports';
import { AsyncMailbox } from '../support/AgentTestKit';
import { FakeHA, haError, result } from '../support/FakeHomeAssistant';
import { AgentFixtures } from './FixtureSupport';
import { OrchRig } from './OrchestratorRig';

describe('OrchestrationErrorTests', () => {
  test('sttFailedWhenTheASRHostRefusesTwice', async () => {
    const rig = new OrchRig();
    expect(await rig.connect()).toBe(true);
    rig.ha.configure((c) => { c.sttRefusal = 'stt-provider-missing'; c.sttRefuseTimes = 2; });
    await rig.userTurn();
    expect(await rig.drive(3, () => rig.has('error:stt-failed'))).toBe(true);
    expect(rig.turnEnded()).toBeUndefined();
    expect(rig.ha.agentCalls).toBe(0);
  });

  test('oneRefusalIsRetriedAtOnce', async () => {
    const rig = new OrchRig();
    expect(await rig.connect()).toBe(true);
    rig.ha.configure((c) => { c.sttRefusal = 'stt-provider-missing'; c.sttRefuseTimes = 1; });
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
  });

  test('sttFailedOnAServerErrorOrATranscriptTimeout', async () => {
    const rig = new OrchRig();
    rig.ha.configure((c) => { c.onSTT = async () => FakeHA.runError('stt-stream-failed'); });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(3, () => rig.has('error:stt-failed'))).toBe(true);

    const slow = new OrchRig();
    const hold = new AsyncMailbox<void>();
    slow.ha.configure((c) => { c.onSTT = async () => { await hold.pop(); return FakeHA.sttEnd('x'); }; });
    expect(await slow.connect()).toBe(true);
    await slow.userTurn();
    expect(await slow.drive(2.5, () => slow.has('error:stt-failed'))).toBe(false); // not before the 3 s timeout
    expect(await slow.drive(1, () => slow.has('error:stt-failed'))).toBe(true);
    hold.close();
  });

  test('llmFailedAndLLMTimeoutFromThePipeline', async () => {
    for (const [code, expected] of [['intent-failed', 'error:llm-failed'], ['timeout', 'error:llm-timeout']]) {
      const rig = new OrchRig();
      rig.ha.configure((c) => {
        c.onPipeline = async (_m, emit) =>
          FakeHA.stream([FakeHA.event('run-start'), FakeHA.event('error', { code, message: 'x' }), FakeHA.event('run-end')], emit);
      });
      expect(await rig.connect()).toBe(true);
      await rig.userTurn();
      expect(await rig.drive(3, () => rig.has(expected))).toBe(true);
      expect(rig.ha.runs('tts')).toEqual([]);
    }
    const rig = new OrchRig();
    const events = AgentFixtures.pipelineEvents('pipeline-run-error.json');
    rig.ha.configure((c) => { c.onPipeline = async (_m, emit) => FakeHA.stream(events, emit); });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(3, () => rig.has('error:llm-failed'))).toBe(true);
  });

  test('ttsFailedWhenNothingWasHeard', async () => {
    const rig = new OrchRig();
    rig.ha.configure((c) => { c.onTTS = async () => FakeHA.runError('tts-failed'); });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.has('error:tts-failed'))).toBe(true);
    expect(rig.replyEnds()).toEqual([]);
  });

  // port-note: through HA a chunk is fetched whole, so "a drop after audio" is the second chunk's run failing.
  test('aTTSDropAfterAudioEndsTheReplyGracefully', async () => {
    const rig = new OrchRig();
    expect(await rig.connect()).toBe(true);
    rig.ha.configure((c) => { c.onTTS = async (_t, run) => (run === 0 ? FakeHA.ttsRun('tts-0.wav') : FakeHA.runError('tts-failed')); });
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
    expect(rig.has('error:tts-failed')).toBe(false); // review R6: something was heard, so the reply just ends
    expect(rig.replyEnds()[0].sentences).toBe(1);
    expect(rig.sentenceStarts().length).toBe(1);
  });

  test('homeAssistantDownMidTurnFailsTheSession', async () => {
    const rig = new OrchRig();
    const hold = new AsyncMailbox<void>();
    rig.ha.configure((c) => { c.onJev = async () => { await hold.pop(); return result(FakeHA.jevResponse()); }; });
    rig.services.tunables = makeAgentTunables({ gateTimeout: 1.5 });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(1, () => rig.turnEnded() !== undefined)).toBe(true);
    rig.ha.drop();
    expect(await rig.drive(1, () => rig.statuses.some((s) => s.kind === 'failed'))).toBe(true);
    expect(rig.has('error:llm-failed')).toBe(true);
    hold.close();
  });

  test('tokenRejectedAndUnreachableServices', async () => {
    const rig = new OrchRig();
    rig.ha.connected = false;
    expect(await rig.connect()).toBe(false);
    expect(rig.statuses.at(-1)).toEqual({ kind: 'failed', reason: 'home assistant unreachable' });

    const noASR = new OrchRig();
    noASR.ha.configure((c) => { c.pipelines = { pipelines: [{ id: '01PIPE', name: 'Home', tts_engine: 'tts.piper' }], preferred_pipeline: '01PIPE' }; });
    expect(await noASR.connect()).toBe(false);
    expect(noASR.statuses.at(-1)).toEqual({ kind: 'failed', reason: 'the pipeline has no speech-to-text' });

    const noTTS = new OrchRig({ tts: false });
    expect(await noTTS.connect()).toBe(false); // Spoken mode needs a speech voice
    const yanni = new OrchRig({ replyVoice: 'yanni', tts: false });
    expect(await yanni.connect()).toBe(true); // Yanni mode needs no TTS
  });

  test('withoutHAJevEveryUtteranceIsAddressedAndNothingIsReported', async () => {
    const rig = new OrchRig();
    rig.ha.configure((c) => { c.jevEntries = []; });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
    expect(rig.ha.count('call_service:jev.ask')).toBe(0);
    expect(rig.eventNames.some((n) => n.startsWith('decision') || n.startsWith('unavailable'))).toBe(false);
  });
});

describe('OrchestrationProactiveTests', () => {
  const request = (ids = ['laundry']): AgentIntent => ({ kind: 'proactive',
    payload: { ids, items: [makeProactiveItem('The laundry is done.')], audience: { people: 1, engaged: true } } });

  test('announcementsGoThroughAITaskNeverTheAgent', async () => {
    const rig = new OrchRig({ aiTask: 'ai_task.openai' });
    expect(await rig.connect()).toBe(true);
    rig.orch.handle(request());
    expect(await rig.drive(5, () => rig.has('proactiveDone:spoken'))).toBe(true);
    expect(rig.ha.agentCalls).toBe(0);
    expect(rig.ha.count('call_service:ai_task.generate_data')).toBe(1);
    const instructions = at(rig.ha.log.find((m) => m.domain === 'ai_task'), 'service_data', 'instructions') as string;
    expect(instructions.includes('<<<ITEMS\n- announcement: The laundry is done.')).toBe(true);
    expect(rig.eventNames.filter((n) => !n.startsWith('decision')))
      .toEqual(['servicesInfo', 'turnStarted', 'sentenceStart', 'replyEnd', 'proactiveDone:spoken']);
    expect(rig.ha.log.filter((m) => m.domain === 'jev').every((m) => at(m, 'service_data', 'state', 'utterance') === undefined))
      .toBe(true); // Pass A is skipped, Pass B runs
  });

  test('theTemplateWithoutAnAITaskEntityOrOnFailure', async () => {
    const rig = new OrchRig();
    expect(await rig.connect()).toBe(true);
    rig.orch.handle(request());
    expect(await rig.drive(5, () => rig.has('proactiveDone:spoken'))).toBe(true);
    const said = rig.ttsTexts()[0];
    expect(said === 'Hey!' || said === 'Hey! The laundry is done.').toBe(true);
    expect(rig.ha.agentCalls).toBe(0);
    expect(rig.ha.count('call_service:ai_task.generate_data')).toBe(0);

    const failing = new OrchRig({ aiTask: 'ai_task.gone' });
    failing.ha.configure((c) => { c.onAITask = async () => haError('service_validation_error', 'not found'); });
    expect(await failing.connect()).toBe(true);
    failing.orch.handle(request());
    expect(await failing.drive(5, () => failing.has('proactiveDone:spoken'))).toBe(true);
    expect(failing.ha.agentCalls).toBe(0);
  });

  test('yanniModeSpeaksAnnouncementsWithTTSOrReportsUnavailable', async () => {
    const withTTS = new OrchRig({ replyVoice: 'yanni' });
    expect(await withTTS.connect()).toBe(true);
    withTTS.orch.handle(request());
    expect(await withTTS.drive(5, () => withTTS.has('proactiveDone:spoken'))).toBe(true);
    expect(withTTS.ha.runs('tts').length).toBeGreaterThan(0);

    const noTTS = new OrchRig({ replyVoice: 'yanni', tts: false });
    expect(await noTTS.connect()).toBe(true);
    noTTS.orch.handle(request());
    expect(await noTTS.drive(1, () => noTTS.has('proactiveDone:unavailable'))).toBe(true);
    expect(noTTS.has('turnStarted')).toBe(false);
  });

  test('bargeInDuringAnAnnouncementReportsInterrupted', async () => {
    const rig = new OrchRig();
    const hold = new AsyncMailbox<void>();
    rig.ha.configure((c) => { c.onTTS = async (_t, run) => { if (run === 1) await hold.pop(); return FakeHA.ttsRun(`tts-${run}.wav`); }; });
    expect(await rig.connect()).toBe(true);
    rig.orch.handle({ kind: 'proactive', payload: { ids: ['a'], items: [makeProactiveItem('First thing. Second thing.')],
      audience: { people: 1, engaged: true } } });
    expect(await rig.drive(5, () => rig.sentenceStarts().length === 1)).toBe(true);
    await rig.startSpeaking();
    expect(await rig.drive(1, () => rig.has('proactiveDone:interrupted') && rig.has('interrupted'))).toBe(true);
    hold.close();
  });
});

describe('ClipAndContextTests', () => {
  test('moodAndContextArePublishedAsTheConversationContextSensor', () => {
    const rig = new OrchRig();
    rig.orch.handle({ kind: 'context', payload: { quietMode: true, peopleCount: 2 } });
    rig.orch.handle({ kind: 'mood', payload: { version: 1, felt: { p: 0.4, a: 0.3, d: 0.1 }, mood: { p: 0.2, a: 0.1, d: 0.1 },
      label: 'Happiness', moodLabel: 'playful', boredom: 0, conditions: [] } });
    expect(sensorState(rig.ctx.published.at(-1)!)).toBe('Yanni feels happiness, mood lately playful; 2 people here; quiet mode on');
    rig.clock.advance(121);
    rig.orch.handle({ kind: 'context', payload: { quietMode: false, peopleCount: 1 } });
    expect(sensorState(rig.ctx.published.at(-1)!)).toBe('1 person here'); // a stale mood report is left out
  });

  // port-note: JS errors only expose their name (no NSError domain/code, no CustomStringConvertible).
  test('errorDescriptionsAreLogSafe', () => {
    class Custom extends Error { override name = 'SpeechModelDownloading'; }
    expect(describeError(new Custom('said words'))).toBe('SpeechModelDownloading');
    expect(describeError(new Error('said words')).includes('said words')).toBe(false);
    expect(agentErrorEquals({ code: 'stt-failed', turnId: null, detail: 'x' }, { code: 'stt-failed', turnId: null, detail: null })).toBe(true);
  });
});
