// Port of Tests/ConversationCoreTests/LocalTurnTests.swift.
// The controller with the device's own turn detection (on-device turn detection design §8, §9, §16).
import { describe, expect, test } from 'vitest';
import { TurnDetector } from '../../src/conversation/core/TurnDetection';
import { dryRun } from './support/Fakes';
import { Rig } from './support/Rig';

describe('LocalTurnTests', () => {
  test('bargeInRunsInTheDesignOrderThenSendsSpeechStart', () => {
    const rig = new Rig();
    rig.toSpeaking('t1');
    rig.playReply(0.3);
    const trace: string[] = [];
    rig.audio.onCall = (c) => trace.push(c);
    rig.voice.onCall = (c) => trace.push(c);
    rig.emotion.onCall = (c) => trace.push(c);
    rig.transport.onCall = (c) => trace.push(`${c}@${rig.engine.state.agentState}`);
    rig.speak();
    expect(trace).toEqual(['flush', 'voice.cancel', 'emotion.cancelTurn', 'intent:speech-start@interrupted']);
    expect(rig.voice.isSpeaking).toBe(false);
    expect(rig.engine.state.speechLevel).toBe(0);
    expect(rig.controller.currentTurn).toBeNull();
  });

  /** The listening glow (listening glow design §2): on with the mic, swelling while the person speaks, off when it closes. */
  test('theListeningGlowFollowsTheMicAndTheVoice', () => {
    const rig = new Rig();
    expect(rig.engine.state.glowTarget).toBe(0);
    rig.toListening();
    expect(rig.controller.micOpen && rig.engine.state.glowTarget === 1 && rig.engine.state.glowVoice === 0).toBe(true);
    rig.speak();
    expect(rig.engine.state.glowVoice).toBe(1);
    rig.run(1);
    rig.endTurn();
    expect(rig.engine.state.glowVoice).toBe(0);
    rig.leave();
    rig.runUntil(30, () => !rig.controller.micOpen);
    expect(rig.controller.micOpen).toBe(false);
    expect(rig.engine.state.glowTarget).toBe(0);
  });

  /** The mic level reaches the glow only while the person's turn is live: listening, none of Yanni's sounds audible. */
  test('theMicLevelMovesTheGlowOnlyWhileThePersonsTurnIsLive', () => {
    const rig = new Rig();
    rig.detector.inputLevel = 0.6;
    rig.frame();
    expect(rig.engine.state.glowMic, 'mic closed').toBe(0);
    rig.toListening();
    rig.frame();
    expect(rig.engine.state.glowMic).toBeCloseTo(0.6, 6);
    rig.voice.audibleUntilHostTime = rig.clock.now + 0.5;   // a chirp may be audible: the echo rule
    rig.frame();
    expect(rig.engine.state.glowMic).toBe(0);
    rig.run(0.6);
    expect(rig.engine.state.glowMic).toBeCloseTo(0.6, 6);
    rig.speak();
    rig.run(0.5);
    expect(rig.engine.state.glowMic, "still the person's turn").toBeCloseTo(0.6, 6);
    rig.endTurn();
    rig.frame();
    expect(rig.phase, `turn over: ${rig.phase}`).not.toBe('listening');
    expect(rig.engine.state.glowMic).toBe(0);
  });

  test('theTransportsInterruptedAfterALocalBargeInIsANoOp', () => {
    const rig = new Rig();
    rig.toSpeaking('t1');
    rig.speak();
    expect(rig.state).toBe('interrupted');
    rig.transport.agent({ kind: 'interrupted', payload: { turnId: 't1' } });
    rig.frame();
    expect(rig.audio.flushes).toBe(1);
    expect(rig.voice.cancels).toBe(1);
    expect(rig.emotion.cancelled).toEqual(['t1']);
    expect(rig.state === 'interrupted' || rig.state === 'listening').toBe(true);
    expect(rig.transport.intents).toEqual(['speech-start', 'turn-end', 'speech-start']);
  });

  test('thinkingShowsAtTheLocalTurnEndThenTheTurnIdIsAdopted', () => {
    const rig = new Rig();
    rig.toListening();
    rig.speak();
    rig.run(1);
    const before = rig.audio.armedEpoch;
    rig.endTurn();
    expect(rig.state).toBe('thinking');
    expect(rig.audio.armedEpoch, 'the reply start is armed at the local turn end').not.toBe(before);
    expect(rig.log.some((e) => e.kind === 'turn' && e.detail === 'turn-end sent')).toBe(true);
    rig.run(0.1);
    rig.transportTurnEnded('t7');
    expect(rig.controller.currentTurn).toBe('t7');
    expect(Math.abs((rig.controller.status.lastTurn?.turnEndedReceived ?? 0) - 0.2 - 6 * Rig.dt)).toBeLessThan(1e-6);
    // The reply flows as before.
    rig.audio.startReply(rig.clock.now);
    rig.frame();
    expect(rig.state).toBe('speaking');
  });

  test('speechWhileThinkingVoidsTheTurnAndALateTurnEndedIsSuperseded', () => {
    const rig = new Rig();
    rig.toListening();
    rig.speak();
    rig.endTurn();
    expect(rig.state).toBe('thinking');
    rig.run(0.3);
    rig.speak();                                // before the transport's turn-ended
    expect(rig.state).toBe('listening');
    expect(rig.transport.intents).toEqual(['speech-start', 'turn-end', 'speech-start']);
    rig.transportTurnEnded('t1');                  // crossed on the wire
    expect(rig.cancels).toEqual([{ turnId: 't1', reason: 'superseded' }]);
    expect(rig.state, 'no thinking for a stale turn').toBe('listening');
    // Nothing for t1 plays.
    rig.transport.agent({ kind: 'sentenceStart', payload: { turnId: 't1', sentenceIndex: 0, offsetMs: 0 } });
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 500 } });
    rig.transportTurnEnded('t1');
    expect(rig.cancels.length, 'a discarded turnId is answered once').toBe(1);
    rig.run(0.5);
    expect(rig.state).toBe('listening');
  });

  test('aTurnEndedAfterTheThinkingTimeoutIsSuperseded', () => {
    const rig = new Rig();
    rig.toListening();
    rig.speak();
    rig.endTurn();
    rig.run(8.1);
    expect(rig.state).toBe('sheepish');
    expect(rig.cancels, 'no turnId to cancel yet').toEqual([]);
    rig.transportTurnEnded('t3');
    expect(rig.cancels).toEqual([{ turnId: 't3', reason: 'superseded' }]);
    expect(rig.state).toBe('sheepish');
  });

  test('aTurnEndedNobodyAskedForIsSuperseded', () => {
    const rig = new Rig();
    rig.toListening();
    rig.transportTurnEnded('t9');
    expect(rig.state).toBe('listening');
    expect(rig.cancels).toEqual([{ turnId: 't9', reason: 'superseded' }]);
  });

  test('micGatedMidUtteranceSendsNoTurnEnd', () => {
    const rig = new Rig();
    rig.toListening();
    rig.speak();
    rig.run(0.5);
    expect(rig.detector.listening).toBe(true);
    rig.engine.setAgentState('idle');            // the conversation is taken away (e.g. the panel)
    rig.frame();
    expect(rig.phase).toBe('idle');
    expect(rig.detector.listening, 'the detector stops and drops the turn').toBe(false);
    rig.detector.emit({ kind: 'turnDiscarded', at: rig.clock.now });
    rig.endTurn();                              // a straggler after the gate
    expect(rig.transport.intents).toEqual(['speech-start']);
    expect(rig.log.some((e) => e.detail.startsWith('mic closed mid-utterance'))).toBe(true);
  });

  test('detectorListensExactlyWhileTheMicIsOpen', () => {
    const rig = new Rig();
    rig.person();
    rig.run(0.2);
    expect(rig.detector.prepares, 'models warm at Noticing (conversation mode)').toBe(1);
    expect(rig.detector.listeningChanges).toEqual([]);
    rig.person(1, { engaged: true });
    rig.runUntil(2, () => rig.phase === 'listening');
    expect(rig.detector.listeningChanges).toEqual([true]);
    rig.run(5.1);
    expect(rig.state).toBe('noticing');
    expect(rig.detector.listeningChanges).toEqual([true, false]);
  });

  test('modelsNotLoadedYetDoNotKeepTheControllerDormant', () => {
    const rig = new Rig();
    rig.detector.status.availability = { kind: 'notLoaded' };   // the real runtime before Noticing
    expect(rig.controller.isActive).toBe(true);
    rig.person();
    rig.run(0.2);
    expect(rig.detector.prepares, 'Noticing loads the models').toBe(1);
  });

  test('listenCuePlaysOnceAsTheMicOpensAndCountsForTheEchoRule', () => {
    const rig = new Rig();
    const cue = '/cue.wav';
    rig.controller.listenCue = cue;
    rig.person(1, { engaged: true });
    rig.runUntil(3, () => rig.phase === 'listening');
    rig.run(0.5);
    const played = rig.audio.clips.filter((c) => c.url === cue);
    expect(played.length, 'one pop per mic opening').toBe(1);
    expect(rig.detector.localAudibleUntil, 'the pop is local sound for the echo rule').toBeGreaterThanOrEqual(played[0].at);
  });

  test('listenCueFollowsSoundsOff', () => {
    const rig = new Rig();
    rig.controller.listenCue = '/cue.wav';
    rig.controller.settings = { ...rig.controller.settings, soundsOff: true };
    rig.person(1, { engaged: true });
    rig.runUntil(3, () => rig.phase === 'listening');
    expect(rig.audio.clips).toEqual([]);
  });

  test('localSoundIsPublishedForTheEchoRule', () => {
    const rig = new Rig();
    rig.voice.audibleUntilHostTime = 1234.5;
    rig.person();
    rig.frame();
    expect(rig.detector.localAudibleUntil).toBe(1234.5);
  });

  test('turnWatchdogEndsAStalledTurnWithoutATurnEnd', () => {
    const rig = new Rig();
    rig.toListening();
    rig.speak();
    rig.run(29.9);
    expect(rig.phase).toBe('listening');
    rig.run(0.2);
    expect(rig.state).toBe('noticing');
    expect(rig.transport.micEnabled || rig.detector.listening).toBe(false);
    expect(rig.transport.intents).toEqual(['speech-start']);
  });

  test('pausesKeepTheWatchdogAlive', () => {
    const rig = new Rig();
    rig.toListening();
    rig.speak();
    rig.run(20);
    rig.detector.emit({ kind: 'pause', pause: { probability: 0.2, inferenceMs: 9 } });
    rig.run(20);
    expect(rig.phase).toBe('listening');
  });

  test('unavailableTurnDetectionMakesTheControllerDormant', () => {
    const rig = new Rig();
    rig.detector.status.availability = { kind: 'unavailable', reason: 'model failed to load' };
    rig.person();
    rig.run(0.5);
    expect(rig.controller.session).toBe('dormant');
    expect(rig.transport.connects).toEqual([]);
    expect(rig.controller.status.dormantReason).toBe('turn detection unavailable (model failed to load)');
    expect(rig.perception.has(dryRun(true))).toBe(true);
    rig.detector.status.availability = { kind: 'ready' };
    rig.run(0.2);
    expect(rig.transport.connects.length).toBe(1);
    expect(rig.controller.status.dormantReason).toBeNull();
  });

  test('noDetectorInstalledIsDormantToo', () => {
    const rig = new Rig();
    const facade = new TurnDetector();
    rig.controller.turn = facade;
    rig.person();
    rig.run(0.5);
    expect(rig.controller.status.dormantReason).toBe('turn detection not installed');
    expect(rig.transport.connects).toEqual([]);
    facade.backend = rig.detector;             // the runtime plugs in
    rig.detector.status.availability = { kind: 'ready' };
    rig.run(0.2);
    expect(rig.transport.connects.length).toBe(1);
    rig.person(1, { engaged: true });
    rig.runUntil(2, () => rig.phase === 'listening');
    expect(rig.detector.listening, 'the facade forwards to the backend').toBe(true);
    rig.speak();
    expect(rig.transport.intents, 'signals flow back through the facade').toEqual(['speech-start']);
  });

  test('selfTriggerRejectionsAreCountedPerSession', () => {
    const rig = new Rig();
    rig.toListening();
    rig.detector.emit({ kind: 'selfTriggerRejected', at: rig.clock.now, peak: 0.8 });
    rig.detector.emit({ kind: 'selfTriggerRejected', at: rig.clock.now, peak: 0.7 });
    expect(rig.controller.status.selfTriggerRejections).toBe(2);
    expect(rig.controller.status.turnDetection?.availability).toEqual({ kind: 'ready' });
    expect(rig.transport.intents).toEqual([]);
    expect(rig.phase).toBe('listening');
  });

  test('nightWakeAndQuietModeAreUnchanged', () => {
    const rig = new Rig();
    rig.life.isBedtime = true;
    rig.controller.settings.quietMode = true;
    rig.person(1, { engaged: true });
    rig.runUntil(3, () => rig.phase === 'listening');
    expect(rig.phase).toBe('listening');
    expect(rig.audio.clips, 'no greeting').toEqual([]);
    expect(Math.abs(rig.audio.gain - 0.4), 'TTS × 0.5').toBeLessThan(1e-6);
    expect(rig.detector.listening).toBe(true);
    rig.speak();
    rig.endTurn();
    expect(rig.state).toBe('thinking');
  });
});
