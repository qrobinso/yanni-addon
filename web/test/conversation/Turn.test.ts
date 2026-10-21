// Port of Tests/ConversationCoreTests/TurnTests.swift.
// Listening → thinking → speaking → follow-up, barge-in, the gate hand-offs and every review-H4 row.
import { describe, expect, test } from 'vitest';
import type { DecisionPayload } from '../../src/conversation/events/AgentEvents';
import { outcome, release, unpin } from './support/Fakes';
import { mood, Rig } from './support/Rig';

const decision = (d: Partial<DecisionPayload> & Pick<DecisionPayload, 'turnId' | 'pass'>): DecisionPayload =>
  ({ sentenceIndex: null, version: 1, answers: {}, ...d });

describe('TurnTests', () => {
  test('speechKeepsListeningAndCountsAsActivity', () => {
    const rig = new Rig();
    rig.toListening();
    rig.speak();
    rig.run(7);
    expect(rig.phase, 'no listen timeout once speech started').toBe('listening');
    expect(rig.life.activity).toContain('speech');
  });

  test('listenTimeoutGoesBackToNoticing', () => {
    const rig = new Rig();
    rig.toListening();
    rig.run(4.9);
    expect(rig.phase).toBe('listening');
    rig.run(0.2);
    expect(rig.state).toBe('noticing');
    expect(rig.transport.micEnabled || rig.audio.captureEnabled).toBe(false);
    expect(rig.perception.outcomes).toEqual([outcome(1, false)]);
    expect(rig.perception.has(unpin)).toBe(true);
    expect(rig.perception.has(release), "staring on doesn't hand the turn to a waiter").toBe(false);
  });

  test('localTurnEndGoesToThinkingAndSendsTheMoodReport', () => {
    const rig = new Rig();
    rig.toListening();
    rig.controller.noteMoodReport(mood('Happiness'));
    const before = rig.moods.length;
    rig.speak();
    rig.endTurn();
    expect(rig.state, 'thinking at the local turn end, before the transport answers').toBe('thinking');
    expect(rig.controller.currentTurn).toBeNull();
    expect(rig.transport.intents).toEqual(['speech-start', 'turn-end']);
    expect(rig.moods.length, 'listening → thinking sends the report (review C4)').toBe(before + 1);
    expect(rig.audio.armedEpoch).not.toBeNull();
    rig.transportTurnEnded('t1', 9);
    expect(rig.controller.currentTurn, 'turn-ended adopted').toBe('t1');
    expect(rig.cancels).toEqual([]);
  });

  test('userSpeechDuringThinkingReturnsToListeningAndDiscardsTheTurn', () => {
    const rig = new Rig();
    rig.toThinking('t1');
    rig.speak();
    expect(rig.state).toBe('listening');
    expect(rig.emotion.cancelled).toEqual(['t1']);
    expect(rig.transport.intents[rig.transport.intents.length - 1]).toBe('speech-start');
    // Anything still arriving for t1 is ignored.
    rig.transport.agent({ kind: 'notForMe', payload: { turnId: 't1' } });
    rig.transport.agent({ kind: 'decision', payload: decision({ turnId: 't1', pass: 'utterance' }) });
    rig.frame();
    expect(rig.state).toBe('listening');
    expect(rig.emotion.received).toEqual([]);
    rig.endTurn();
    rig.transportTurnEnded('t2', 20);
    expect(rig.state).toBe('thinking');
    expect(rig.controller.currentTurn).toBe('t2');
  });

  test('replyStartFromTheReplyClockEntersSpeaking', () => {
    const rig = new Rig();
    rig.toThinking();
    rig.run(0.4);
    rig.transport.agent({ kind: 'sentenceStart', payload: { turnId: 't1', sentenceIndex: 0, offsetMs: 0 } });
    rig.frame();
    expect(rig.state, "a marker alone isn't heard audio").toBe('thinking');
    rig.audio.startReply(rig.clock.now);
    rig.frame();
    expect(rig.state).toBe('speaking');
    expect(rig.voice.isSpeaking).toBe(true);
    expect(rig.life.activity, 'a real reply is activity (review M3)').toContain('voiceReply');
    expect(Math.abs((rig.controller.lastReplyLatency ?? 0) - 0.65), 'end of speech → heard').toBeLessThan(0.05);
    expect(rig.perception.outcomes).toEqual([outcome(1, true)]);
  });

  test('speakingStartsOnlyFromTheReplyClockNeverFromAMarker', () => {
    const rig = new Rig();
    rig.toThinking();
    rig.transport.agent({ kind: 'sentenceStart', payload: { turnId: 't1', sentenceIndex: 0, offsetMs: 0 } });
    rig.run(2);
    expect(rig.state, 'no fallback: the reply clock stamps the first frame exactly').toBe('thinking');
    rig.audio.startReply(rig.clock.now);
    rig.frame();
    expect(rig.state).toBe('speaking');
  });

  test('thinkingTimeoutGoesSheepishAndCancelsTheTurn', () => {
    const rig = new Rig();
    rig.toThinking('t9');
    rig.run(7.9);
    expect(rig.state).toBe('thinking');
    rig.run(0.2);
    expect(rig.state).toBe('sheepish');
    expect(rig.cancels).toEqual([{ turnId: 't9', reason: 'thinking-timeout' }]);
    expect(rig.emotion.cancelled).toEqual(['t9']);
    expect(rig.transport.micEnabled).toBe(false);
    rig.run(4);
    expect(rig.state, 'a failed turn with the voice services still up recovers').toBe('noticing');
  });

  test('sessionDropMidTurnGoesSheepishThenRecoversOnReconnect', () => {
    const rig = new Rig({ autoReady: true });
    rig.toSpeaking();
    rig.transport.autoReady = false;
    rig.transport.drop();
    expect(rig.state).toBe('sheepish');
    expect(rig.audio.flushes).toBe(1);
    expect(rig.voice.isSpeaking).toBe(false);
    rig.run(1.1);
    expect(rig.transport.connects.length, 'reconnect after 1 s').toBe(2);
    rig.transport.becomeReady();
    rig.frame();
    expect(rig.state, 'sheepish exits on reconnect (review H4)').toBe('noticing');
  });

  test('endOfReplyIsReplyEndPlusItsAudioPlayed', () => {
    const rig = new Rig();
    rig.toSpeaking();
    rig.playReply(1.5);
    expect(rig.state, 'no reply-end yet').toBe('speaking');
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 2, audioMs: 2500 } });
    rig.playReply(0.9, false);
    expect(rig.state, '2.4 s of 2.5 s played, quiet or not').toBe('speaking');
    rig.playReply(0.15);
    expect(rig.state).toBe('followUp');
    expect(rig.voice.isSpeaking).toBe(false);
  });

  test('theDrainCapIsOnlyAWatchdogPastTheExpectedEnd', () => {
    const rig = new Rig();
    rig.toSpeaking();
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 1000 } });
    rig.run(4.9);
    expect(rig.state, 'the reply clock stalled: wait audioMs + drainCap').toBe('speaking');
    rig.run(0.2);
    expect(rig.state).toBe('followUp');
  });

  test('followUpWindowEndsInNoticingAndReleasesTheTurn', () => {
    const rig = new Rig();
    rig.toSpeaking();
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 300 } });
    rig.playReply(0.5, false);
    expect(rig.state).toBe('followUp');
    rig.run(5.5);
    expect(rig.state).toBe('followUp');
    rig.run(0.4);
    expect(rig.state).toBe('noticing');
    expect(rig.perception.calls.slice(-2)).toEqual([unpin, release]);
    expect(rig.transport.micEnabled).toBe(false);
  });

  test('speechInFollowUpListensAgain', () => {
    const rig = new Rig();
    rig.toSpeaking();
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 300 } });
    rig.playReply(0.5, false);
    rig.run(2);
    rig.speak();
    expect(rig.state).toBe('listening');
    rig.endTurn();
    expect(rig.state).toBe('thinking');
    rig.transportTurnEnded('t2', 5);
    expect(rig.controller.currentTurn).toBe('t2');
  });

  test('bargeInFlushesCancelsAndHandsBackToListening', () => {
    const rig = new Rig();
    rig.toSpeaking('t1');
    rig.playReply(0.5);
    rig.speak();
    expect(rig.state).toBe('interrupted');
    expect(rig.audio.flushes).toBe(1);
    expect(rig.voice.cancels).toBe(1);
    expect(rig.emotion.cancelled).toEqual(['t1']);
    // Late Pass B tags and markers for the interrupted turn are dropped (decisions discarded by turnId).
    rig.transport.agent({ kind: 'decision', payload: decision({ turnId: 't1', pass: 'sentence', sentenceIndex: 1,
      answers: { feel: { Happiness: 1 } } }) });
    expect(rig.emotion.received).toEqual([]);
    // The face's sorry-blink hands off to listening on its own.
    expect(rig.runUntil(2, () => rig.state === 'listening')).not.toBeNull();
    expect(rig.phase).toBe('listening');
    rig.endTurn();
    rig.transportTurnEnded('t2', 7);
    rig.frame();
    expect(rig.audio.flushes, 'the playout queue ends its flush itself').toBe(1);
    expect(rig.state).toBe('thinking');
  });

  test('theTransportsInterruptedAlsoBargesIn', () => {
    const rig = new Rig();
    rig.toSpeaking('t1');
    rig.transport.agent({ kind: 'interrupted', payload: { turnId: 't1' } });
    expect(rig.state).toBe('interrupted');
  });

  test('notForMeHandsBackToListeningBeforeTheFacesIdleHandOff', () => {
    const rig = new Rig();
    rig.toThinking('t1');
    rig.transport.agent({ kind: 'notForMe', payload: { turnId: 't1' } });
    expect(rig.state).toBe('notForMe');
    expect(rig.perception.outcomes).toEqual([outcome(1, false)]);
    expect(rig.runUntil(4, () => rig.state !== 'notForMe')).not.toBeNull();
    expect(rig.state, "never the face's own notForMe → idle").toBe('listening');
    expect(rig.states).not.toContain('idle');
    expect(rig.transport.micEnabled).toBe(true);
  });

  test('notForMeWithThePersonGoneEndsInNoticing', () => {
    const rig = new Rig();
    rig.toThinking('t1');
    rig.transport.agent({ kind: 'notForMe', payload: { turnId: 't1' } });
    rig.lookAway();
    expect(rig.runUntil(4, () => rig.state !== 'notForMe')).not.toBeNull();
    expect(rig.state).toBe('noticing');
    expect(rig.transport.micEnabled).toBe(false);
  });

  test('didNotUnderstandShowsConfusedThenListens', () => {
    const rig = new Rig();
    rig.toThinking('t1');
    rig.transport.agent({ kind: 'didNotUnderstand', payload: { turnId: 't1', reason: 'unclear' } });
    expect(rig.state).toBe('confused');
    const t = rig.runUntil(4, () => rig.state !== 'confused');
    expect(t).not.toBeNull();
    expect(rig.state).toBe('listening');
    expect(t!, `when the shake one-shot ends, not the fallback (${t} s)`).toBeLessThan(2.5);
  });

  test('gateForAStaleTurnIsIgnored', () => {
    const rig = new Rig();
    rig.toThinking('t2');
    rig.transport.agent({ kind: 'notForMe', payload: { turnId: 't1' } });
    expect(rig.state).toBe('thinking');
  });

  test('gateWorksWithoutAnEmotionLayer', () => {
    const rig = new Rig();
    rig.controller.emotion = null;
    rig.toThinking('t1');
    rig.transport.agent({ kind: 'notForMe', payload: { turnId: 't1' } });
    expect(rig.state).toBe('notForMe');
  });

  test('decisionsAreForwardedToTheEmotionSinkUntouched', () => {
    const rig = new Rig();
    rig.toThinking('t1');
    const d = decision({ turnId: 't1', pass: 'utterance',
      answers: { feel: { Happiness: 0.7, Neutral: 0.3 }, addressed: { yes: 0.95, no: 0.05 } } });
    rig.transport.agent({ kind: 'decision', payload: d });
    rig.transport.agent({ kind: 'decisionModelUnavailable', payload: { reason: 'timeout' } });
    expect(rig.emotion.received).toEqual([
      { kind: 'decision', payload: d }, { kind: 'decisionModelUnavailable', payload: { reason: 'timeout' } },
    ]);
  });

  test('sentenceStartsAreTimedBySamplesPlayed', () => {
    const rig = new Rig();
    rig.audio.snapshot.outputLatency = 0.02;
    rig.toThinking('t1');
    // Markers arrive in order, before their audio.
    rig.transport.agent({ kind: 'sentenceStart', payload: { turnId: 't1', sentenceIndex: 0, offsetMs: 0 } });
    rig.transport.agent({ kind: 'sentenceStart', payload: { turnId: 't1', sentenceIndex: 1, offsetMs: 1000 } });
    rig.run(0.1);
    const replyHost = rig.clock.now;
    rig.audio.startReply(replyHost);
    rig.frame();
    expect(rig.state).toBe('speaking');
    rig.playReply(0.5);
    expect(rig.emotion.sentenceStarts.map((s) => s.index)).toEqual([0]);
    rig.playReply(0.6);
    expect(rig.emotion.sentenceStarts.map((s) => s.index)).toEqual([0, 1]);
    const s1 = rig.emotion.sentenceStarts[rig.emotion.sentenceStarts.length - 1];
    // Sentence 1 is 1000 ms of audio after the reply's first frame (± one frame of extrapolation).
    const s0 = rig.emotion.sentenceStarts[0];
    expect(Math.abs((s1.hostTime - s0.hostTime) - 1.0), `${s1.hostTime - s0.hostTime}`).toBeLessThan(0.02);
    expect(s1.turnId).toBe('t1');
  });

  test('moodReportTriggersAndRateLimit', () => {
    const rig = new Rig();
    rig.controller.noteMoodReport(mood('Happiness'));
    rig.person();
    rig.frame();
    expect(rig.moods.map((m) => m.label), 'sent on session ready').toEqual(['Happiness']);
    rig.controller.noteMoodReport(mood('Excitement'));
    expect(rig.moods.length, 'label change within 1 s waits').toBe(1);
    rig.run(1.0);
    expect(rig.moods.map((m) => m.label)).toEqual(['Happiness', 'Excitement']);
    rig.controller.noteMoodReport(mood('Excitement'));
    rig.run(2);
    expect(rig.moods.length, 'same label: nothing new').toBe(2);
    rig.run(59);
    expect(rig.moods.length, '60 s heartbeat').toBe(3);
    // listening → thinking and speaking → follow-up.
    rig.person(1, { engaged: true });
    rig.runUntil(2, () => rig.phase === 'listening');
    rig.speak();
    rig.endTurn();
    expect(rig.moods.length).toBe(4);
    rig.transportTurnEnded('t1', 3);
    rig.audio.startReply(rig.clock.now);
    rig.frame();
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 100 } });
    rig.playReply(0.5, false);
    expect(rig.state).toBe('followUp');
    expect(rig.moods.length).toBe(5);
    expect(rig.moods.every((m) => m.version === 1 && m.moodLabel === 'cheerful'), 'verbatim').toBe(true);
  });

  test('speechLevelDrivesTheFaceWhileSpeaking', () => {
    const rig = new Rig();
    rig.toSpeaking();
    rig.audio.level = 0.6;
    rig.frame();
    expect(Math.abs(rig.engine.state.speechLevel - 0.6)).toBeLessThan(1e-6);
    rig.speak();
    expect(rig.engine.state.speechLevel).toBe(0);
  });

  test('externalStateChangeAbortsWithoutFighting', () => {
    const rig = new Rig();
    rig.toListening();
    rig.engine.setAgentState('idle');   // e.g. the preview panel
    rig.frame();
    expect(rig.phase).toBe('idle');
    expect(rig.state).toBe('idle');
    expect(rig.transport.micEnabled).toBe(false);
  });

  test('faceNeverStuckEveryConversationStateExits', () => {
    // Each conversation state reaches a resting state without any help from the transport (only timeouts).
    const rig = new Rig();
    rig.toThinking();
    rig.transport.autoReady = false;
    const t = rig.runUntil(20, () => rig.state === 'noticing' || rig.state === 'idle');
    expect(t, 'thinking → sheepish → noticing on timeouts alone').not.toBeNull();
  });

  test('statusCarriesTheLastTurnBreakdown', () => {
    const rig = new Rig();
    rig.toThinking();
    rig.run(0.2);
    rig.transport.agent({ kind: 'sentenceStart', payload: { turnId: 't1', sentenceIndex: 0, offsetMs: 0 } });
    rig.run(0.1);
    rig.audio.startReply(rig.clock.now);
    rig.frame();
    expect(rig.state).toBe('speaking');
    // Every time is from the VAD's end of speech, 0.2 s before the verdict.
    const t = rig.controller.status.lastTurn;
    expect(t).not.toBeNull();
    expect(t?.reason).toEqual({ kind: 'complete', probability: 0.9 });
    expect(t?.inferenceMs).toBe(12);
    expect(Math.abs((t?.verdict ?? 0) - 0.2)).toBeLessThan(1e-6);
    expect(Math.abs((t?.turnEndSent ?? 0) - 0.2)).toBeLessThan(1e-6);
    expect(Math.abs((t?.turnEndedReceived ?? 0) - 0.2)).toBeLessThan(1e-6);
    expect(Math.abs((t?.firstReplyMarker ?? 0) - 0.42)).toBeLessThan(0.05);
    expect(Math.abs((t?.heard ?? 0) - 0.53)).toBeLessThan(0.05);
    expect(t?.replyAudioMs).toBeNull();
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 900 } });
    expect(rig.controller.status.lastTurn?.replyAudioMs).toBe(900);
  });
});
