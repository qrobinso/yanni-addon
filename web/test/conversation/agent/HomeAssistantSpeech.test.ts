// Port of ConversationAgentTests/HomeAssistantSpeechTests.swift: speech through Home Assistant's pipeline (design
// §6.8) and the recogniser seam with `FakeSpeechToText`.
// port-note: `theStandardAppleRecognizerWithoutTheSpeechTargetIsUnavailable` is dropped (no Apple recogniser), and the
// "no Wyoming at all" check with it.
import { describe, expect, test } from 'vitest';
import { makeAgentTunables, makeHAEndpoint } from '../../../src/conversation/core/VoiceServicesEndpoint';
import { ClipRenderer, HAClipVoice, MemoryClipStorage } from '../../../src/conversation/agent/ClipRenderer';
import { HAClient } from '../../../src/conversation/agent/homeassistant/HAClient';
import { pipelines } from '../../../src/conversation/agent/homeassistant/HACommands';
import { FetchHAMediaFetcher, HATextToSpeech } from '../../../src/conversation/agent/homeassistant/HASpeech';
import { arrayValue, at, stringValue } from '../../../src/conversation/agent/JSONValue';
import { intValue } from '../../../src/conversation/agent/JSONValue+Agent';
import { SystemAgentClock } from '../../../src/conversation/agent/AgentTunables';
import { AsyncMailbox, int16 } from '../support/AgentTestKit';
import { FakeHA, FakeHomeAssistant, result, WAVMediaDecoder } from '../support/FakeHomeAssistant';
import { AgentFixtures } from './FixtureSupport';
import { OrchRig } from './OrchestratorRig';

describe('HomeAssistantSpeechTests', () => {
  test('aWholeTurnRunsThroughThePipelineInOrder', async () => {
    const rig = new OrchRig({ speech: 'homeAssistant' });
    expect(await rig.connect()).toBe(true);
    const info = rig.events[0];
    expect(info?.kind === 'servicesInfo' && info.payload.voiceId === 'ha:01PIPE:tts.piper:en_US-lessac-medium' && info.payload.ttsAvailable).toBe(true);
    expect(rig.ha.runs('stt')).toEqual([]); // no audio leaves before speech-start

    const onset = await rig.startSpeaking();
    const expectedFirst = rig.audio.sampleIndex(onset - 0.3)!;
    await rig.talk(0.4);
    await rig.endTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
    expect(rig.eventNames.filter((n) => n !== 'decisionB'))
      .toEqual(['servicesInfo', 'turnEnded', 'decisionA', 'sentenceStart', 'sentenceStart', 'replyEnd']);

    // The stt run: HA's VAD off, 16 kHz, the preferred pipeline; the frames carry exactly the turn audio.
    const sttRun = rig.ha.runs('stt')[0];
    expect(at(sttRun, 'input', 'no_vad')).toBe(true);
    expect(at(sttRun, 'input', 'sample_rate')).toBe(16000);
    expect(sttRun.pipeline).toBeUndefined();
    const audio = rig.ha.sttAudio[0];
    expect(audio[0]).toBe(int16(expectedFirst));
    expect(audio.slice(1).every((v, i) => v === int16(audio[i] + 1))).toBe(true); // consecutive samples, nothing lost or repeated

    // Separate runs, in order: speech-to-text, the gate, the agent, then the voice.
    const log = rig.ha.log;
    const stt = log.findIndex((m) => m.start_stage === 'stt');
    const jev = log.findIndex((m) => m.service === 'ask');
    const intent = log.findIndex((m) => m.start_stage === 'intent');
    const tts = log.findIndex((m) => m.start_stage === 'tts');
    expect(stt >= 0 && stt < jev && jev < intent && intent < tts).toBe(true);
    expect(rig.ha.runs('stt').every((m) => m.end_stage === 'stt')).toBe(true); // never one stt→intent run
    expect(rig.ha.runs('tts').length).toBe(2);
    expect(rig.ha.fetches).toEqual(['/api/tts_proxy/tts-0.wav', '/api/tts_proxy/tts-1.wav']);

    // Timing from the decoded, resampled frames actually queued.
    const starts = rig.sentenceStarts();
    const end = rig.replyEnds()[0];
    expect(starts[0].offsetMs).toBe(0);
    expect(starts.length).toBe(2);
    expect(end.audioMs).toBe(Math.round(rig.sink.framesQueued / 48));
    expect(Math.abs(end.audioMs - 1000)).toBeLessThanOrEqual(20); // two 0.5 s chunks
    expect(Math.abs(starts[1].offsetMs - 500)).toBeLessThanOrEqual(10);
  });

  test('notForMeNeverReachesTheAgentOrTheVoice', async () => {
    const rig = new OrchRig({ speech: 'homeAssistant' });
    rig.ha.configure((c) => { c.onJev = async () => result(FakeHA.jevResponse({ addressed: 0.05 })); });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(3, () => rig.has('notForMe'))).toBe(true);
    await rig.drive(0.5, () => false);
    expect(rig.ha.agentCalls).toBe(0);
    expect(rig.ha.runs('tts')).toEqual([]);
  });

  test('bargeInMidTTSUnsubscribesTheRunAndAcknowledges', async () => {
    const rig = new OrchRig({ speech: 'homeAssistant' });
    const hold = new AsyncMailbox<void>();
    rig.ha.configure((c) => { c.onTTS = async (_t, run) => { if (run === 1) await hold.pop(); return FakeHA.ttsRun(`tts-${run}.wav`); }; });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.sentenceStarts().length === 1 && rig.ha.runs('tts').length === 2)).toBe(true);
    await rig.startSpeaking(); // barge-in
    expect(await rig.drive(2, () => rig.has('interrupted'))).toBe(true);
    const second = rig.ha.runs('tts').at(-1)!.id as number;
    expect(await rig.drive(1, () => rig.ha.isUnsubscribed(second))).toBe(true);
    hold.push();
    await rig.drive(0.5, () => false);
    expect(rig.replyEnds()).toEqual([]); // nothing more for a cut reply
    expect(rig.ha.runs('stt').length).toBe(2); // the new turn's stt run started
  });

  test('anSTTErrorIsSTTFailedAndNoTextIsEmpty', async () => {
    const failing = new OrchRig({ speech: 'homeAssistant' });
    failing.ha.configure((c) => { c.onSTT = async () => FakeHA.runError('stt-stream-failed'); });
    expect(await failing.connect()).toBe(true);
    await failing.userTurn();
    expect(await failing.drive(3, () => failing.has('error:stt-failed'))).toBe(true);
    expect(failing.ha.count('call_service:jev.ask') + failing.ha.agentCalls).toBe(0);

    // The fixture's own events: `stt-no-text-recognized` is an empty transcript.
    const events = AgentFixtures.pipelineEvents('pipeline-run-stt-no-text.json').filter((e) => at(e, 'type') !== 'run-start');
    const empty = new OrchRig({ speech: 'homeAssistant' });
    empty.ha.configure((c) => { c.onSTT = async () => events; });
    expect(await empty.connect()).toBe(true);
    await empty.userTurn();
    expect(await empty.drive(3, () => empty.has('didNotUnderstand:empty'))).toBe(true);
    expect(empty.ha.count('call_service:jev.ask') + empty.ha.agentCalls).toBe(0);

    const refused = new OrchRig({ speech: 'homeAssistant' });
    refused.ha.configure((c) => { c.sttRefusal = 'stt-provider-missing'; });
    expect(await refused.connect()).toBe(true);
    await refused.userTurn();
    expect(await refused.drive(3, () => refused.has('error:stt-failed'))).toBe(true);
    expect(refused.ha.runs('stt').length).toBe(2); // one retry
  });

  test('aFailedFetchIsTTSFailedAndATTSErrorToo', async () => {
    const rig = new OrchRig({ speech: 'homeAssistant' });
    rig.ha.configure((c) => { c.ttsMedia = () => null; });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.has('error:tts-failed'))).toBe(true);

    const events = AgentFixtures.pipelineEvents('pipeline-run-tts-error.json');
    const erroring = new OrchRig({ speech: 'homeAssistant' });
    erroring.ha.configure((c) => { c.onTTS = async () => events; });
    expect(await erroring.connect()).toBe(true);
    await erroring.userTurn();
    expect(await erroring.drive(5, () => erroring.has('error:tts-failed'))).toBe(true);
    expect(erroring.ha.fetches).toEqual([]);
  });

  test('aPipelineWithoutSpeechToTextOrVoiceFailsTheConnect', async () => {
    const rig = new OrchRig({ speech: 'homeAssistant' });
    rig.ha.configure((c) => { c.pipelines = { pipelines: [{ id: '01PIPE', name: 'Home', tts_engine: 'tts.piper' }], preferred_pipeline: '01PIPE' }; });
    expect(await rig.connect()).toBe(false);
    expect(rig.statuses).toContainEqual({ kind: 'failed', reason: 'the pipeline has no speech-to-text' });

    const noVoice = new OrchRig({ speech: 'homeAssistant' });
    noVoice.ha.configure((c) => { c.pipelines = { pipelines: [{ id: '01PIPE', name: 'Home', stt_engine: 'stt.x' }], preferred_pipeline: '01PIPE' }; });
    expect(await noVoice.connect()).toBe(false);
    expect(noVoice.statuses).toContainEqual({ kind: 'failed', reason: 'the pipeline has no speech voice' });

    const yanni = new OrchRig({ replyVoice: 'yanni', speech: 'homeAssistant' });
    yanni.ha.configure((c) => { c.pipelines = { pipelines: [{ id: '01PIPE', name: 'Home', stt_engine: 'stt.x' }], preferred_pipeline: '01PIPE' }; });
    expect(await yanni.connect()).toBe(true); // Yanni's voice needs no TTS
  });

  test('greetingClipsRenderThroughTTSRunsUnderThePipelineKey', async () => {
    const ha = new FakeHomeAssistant();
    const client = new HAClient(ha, new SystemAgentClock());
    await client.connect(makeHAEndpoint(), 2, 0, 1);
    const pipeline = (await pipelines(client)).pipelines[0];
    const voice = new HAClipVoice(new HATextToSpeech(client, null, ha, new WAVMediaDecoder(), makeAgentTunables()), pipeline);
    const storage = new MemoryClipStorage();
    const renderer = new ClipRenderer(storage);
    expect(await renderer.renderIfNeeded(voice, true)).toEqual({ kind: 'deferred' });
    expect(await renderer.renderIfNeeded(voice, false)).toEqual({ kind: 'rendered', count: 4 });
    expect(await renderer.renderIfNeeded(voice, false)).toEqual({ kind: 'upToDate' });
    expect((await renderer.manifest())?.voiceId).toBe('ha:01PIPE:tts.piper:en_US-lessac-medium');
    expect(ha.runs('tts').length).toBe(4);
    const changed = new HAClipVoice(voice.tts, { ...pipeline, ttsVoice: 'en_GB-alba-medium' });
    expect(await renderer.renderIfNeeded(changed, false)).toEqual({ kind: 'rendered', count: 4 }); // a voice change re-renders
    const wav = storage.files.get('hi.wav')!;
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(wav.length).toBeGreaterThan(44);
    client.close();
  });

  test('theFixturesDecodeAndOnlyAPIPathsAreFetched', () => {
    const stt = AgentFixtures.haMessages('pipeline-run-stt.json');
    const handler = stt.map((m) => intValue(at(m.msg, 'event', 'data', 'runner_data', 'stt_binary_handler_id'))).find((h) => h !== null)!;
    const frames = (arrayValue(AgentFixtures.raw('pipeline-run-stt.json')) ?? []).map((m) => stringValue(at(m, 'binary'))).filter((b): b is string => b !== null);
    expect(frames.length).toBe(2);
    expect(frames.every((f) => f.startsWith(handler.toString(16).padStart(2, '0')))).toBe(true);
    expect(frames.at(-1)).toBe('01');
    expect(stt.some((m) => stringValue(at(m.msg, 'event', 'data', 'stt_output', 'text')) !== null)).toBe(true);
    const url = AgentFixtures.pipelineEvents('pipeline-run-tts.json').map((e) => stringValue(at(e, 'data', 'tts_output', 'url'))).find((u) => u !== null)!;
    const base = 'https://ha.local:8123';
    expect(FetchHAMediaFetcher.url(url.replace('<TOKEN>', 'abc'), base)).toBe('https://ha.local:8123/api/tts_proxy/abc.mp3');
    for (const bad of ['https://evil.example/api/tts_proxy/x.mp3', '/api/../config', '/local/x.mp3', '/api/tts_proxy/x?y=1']) {
      expect(FetchHAMediaFetcher.url(bad, base), bad).toBeNull();
    }
  });
});

describe('RecognizerSeamTests', () => {
  test('aFakeRecognizerDrivesTheTurn', async () => {
    const rig = new OrchRig({ speech: 'fakeRecognizer' });
    expect(await rig.connect()).toBe(true);
    expect(rig.stt.sessions).toEqual([]); // nothing starts before speech-start
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
    const session = rig.stt.sessions[0];
    expect(session.finished && session.samples.length > 0).toBe(true);
    expect(rig.ha.runs('stt')).toEqual([]);
    const health = rig.orch.currentHealth;
    expect(health.asrProgram === 'fake-stt' && health.asr === 'up' && health.asrRoute === 'home assistant').toBe(true);
  });

  test('aRecognizerThatCantStartOrIsDownFails', async () => {
    const rig = new OrchRig({ speech: 'fakeRecognizer' });
    rig.stt.configure({ failStart: true });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(3, () => rig.has('error:stt-failed'))).toBe(true);

    const down = new OrchRig({ speech: 'fakeRecognizer' });
    down.stt.configure({ health: { kind: 'down', why: 'speech recognizer unreachable' } });
    expect(await down.connect()).toBe(false);
    expect(down.statuses).toContainEqual({ kind: 'failed', reason: 'speech recognizer unreachable' });
  });

  test('thePreRollAndLiveChunksReachTheSessionInOrder', async () => {
    const rig = new OrchRig({ speech: 'fakeRecognizer' });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.turnEnded() !== undefined)).toBe(true);
    const s = rig.stt.sessions[0].samples;
    expect(s.slice(1).every((v, i) => v === int16(s[i] + 1))).toBe(true); // no gaps, no repeats
    // 0.1 s before the onset is in the ring already (0.3 s pre-roll clipped to it… plus 0.4 s of talking).
    expect(Math.abs(s.length - Math.trunc((0.4 + 0.4) * 16000))).toBeLessThanOrEqual(640);
  });

  test('aFailedFinishIsSttFailedAndAnEmptyTranscriptIsNotUnderstood', async () => {
    const failing = new OrchRig({ speech: 'fakeRecognizer' });
    failing.stt.configure({ failFinish: true });
    expect(await failing.connect()).toBe(true);
    await failing.userTurn();
    expect(await failing.drive(3, () => failing.has('error:stt-failed'))).toBe(true);
    expect(failing.eventNames.some((n) => n.startsWith('didNotUnderstand'))).toBe(false);

    const empty = new OrchRig({ speech: 'fakeRecognizer' });
    empty.stt.configure({ transcript: ' ' });
    expect(await empty.connect()).toBe(true);
    await empty.userTurn();
    expect(await empty.drive(3, () => empty.has('didNotUnderstand:empty'))).toBe(true);
  });

  test('bargeInClosesTheRecognizerSession', async () => {
    const rig = new OrchRig({ speech: 'fakeRecognizer' });
    expect(await rig.connect()).toBe(true);
    await rig.startSpeaking();
    await rig.talk(0.1);
    await rig.startSpeaking(); // a new speech start voids the first turn
    expect(await rig.drive(1, () => rig.stt.sessions[0]?.closed === true)).toBe(true);
    expect(rig.stt.sessions[0].finished).toBe(false);
  });

  test('aPreparingRecognizerConnectsAndItsTurnsFailUntilReady', async () => {
    const rig = new OrchRig({ speech: 'fakeRecognizer' });
    rig.stt.configure({ health: { kind: 'preparing', progress: 0.4 }, failStart: true });
    expect(await rig.connect()).toBe(true);
    let health = rig.orch.currentHealth;
    expect(health.asr === 'preparing' && health.asrDetail === 'preparing 40 %').toBe(true);
    await rig.userTurn();
    expect(await rig.drive(3, () => rig.has('error:stt-failed'))).toBe(true);
    expect(rig.has('turnEnded') || rig.events.some((e) => e.kind === 'didNotUnderstand')).toBe(false);

    // The download goes on: Status follows it, then the recogniser is up and turns work.
    rig.stt.configure({ health: { kind: 'preparing', progress: 0.8 } });
    expect(await rig.drive(2, () => rig.outs.some((o) => o.kind === 'health' && o.health.asrDetail === 'preparing 80 %'))).toBe(true);
    rig.stt.configure({ health: { kind: 'up', engine: 'fake-stt' }, failStart: false });
    expect(await rig.drive(2, () => rig.outs.some((o) => o.kind === 'health' && o.health.asr === 'up'))).toBe(true);
    health = rig.orch.currentHealth;
    expect(health.asrDetail === null && health.asrProgram === 'fake-stt').toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
  });

  test('anUnusableRecognizerConnectsAndSaysWhy', async () => {
    const rig = new OrchRig({ speech: 'fakeRecognizer' });
    rig.stt.configure({ health: { kind: 'unavailable', why: 'not available for this language' }, failStart: true });
    expect(await rig.connect()).toBe(true);
    const health = rig.orch.currentHealth;
    expect(health.asr === 'down' && health.asrDetail === 'not available for this language').toBe(true);
    await rig.userTurn();
    expect(await rig.drive(3, () => rig.has('error:stt-failed'))).toBe(true);
    expect(rig.stt.sessions).toEqual([]);
  });

  test('micClosedMidUtteranceDropsTheSession', async () => {
    const rig = new OrchRig({ speech: 'fakeRecognizer' });
    expect(await rig.connect()).toBe(true);
    await rig.startSpeaking();
    await rig.talk(0.1);
    rig.orch.micClosed();
    expect(await rig.drive(1, () => rig.stt.sessions[0]?.closed === true)).toBe(true);
    expect(rig.stt.sessions[0].finished).toBe(false);
    expect(rig.turnEnded()).toBeUndefined();
  });
});
