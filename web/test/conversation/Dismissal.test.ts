// Port of Tests/ConversationCoreTests/DismissalTests.swift.
// "Go away", "that's all": the controller closes the mic at once (spec § Conversation loop, "Ending by voice").
import { describe, expect, test } from 'vitest';
import type { AgentEvent } from '../../src/conversation/events/AgentEvents';
import type { OneShotKind } from '../../src/engine/Commands';
import { release } from './support/Fakes';
import { Rig } from './support/Rig';

function dismissed(turn = 't1', o: { p?: number | null; afterReply?: boolean; sheepish?: boolean } = {}): AgentEvent {
  const p = o.p === undefined ? 0.82 : o.p;
  return { kind: 'dismissed', payload: { turnId: turn, source: p === null ? 'local' : 'decision', probability: p,
    afterReply: o.afterReply ?? false, sheepish: o.sheepish ?? false } };
}

const oneShotPlayed = (rig: Rig, k: OneShotKind, within = 0.5): boolean =>
  rig.runUntil(within, () => rig.engine.state.activeOneShots.includes(k)) !== null;

describe('DismissalTests', () => {
  test('aDismissalClosesTheMicAndAcknowledgesWithANod', () => {
    const rig = new Rig();
    rig.toThinking('t1');
    rig.transport.agent(dismissed());
    expect(rig.phase).toBe('idle');
    expect(rig.state).toBe('noticing');
    expect(rig.transport.micEnabled || rig.audio.captureEnabled || rig.detector.listening).toBe(false);
    expect(rig.controller.currentTurn).toBeNull();
    expect(rig.perception.has(release)).toBe(true);
    expect(oneShotPlayed(rig, 'nodYes'), 'the "okay!" nod').toBe(true);
    expect(rig.controller.status.lastDismissal).toBe('closing p 0.82');
    expect(rig.lines).toContain('conversation: dismissed (closing p 0.82)');
    // Looking on doesn't reopen the mic: the engagement stays consumed.
    rig.run(3);
    expect(rig.phase).toBe('idle');
    expect(rig.transport.micEnabled).toBe(false);
  });

  test('lookingAwayAndBackStaysClosedDuringTheHoldButHoldToTalkWorks', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    rig.toThinking('t1');
    rig.transport.agent(dismissed('t1', { p: null }));
    expect(rig.controller.status.lastDismissal).toBe('local');
    rig.lookAway();
    rig.run(1);
    rig.person(1, { engaged: true });
    rig.run(5);
    expect(rig.phase, 'no look-to-talk for the dismiss hold').toBe('idle');
    expect(rig.controller.engageManually()).toEqual({ kind: 'engaged' });
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
  });

  test('theHoldEndsButSomeoneStillLookingMustLookAgain', () => {
    const rig = new Rig();
    rig.toThinking('t1');
    rig.transport.agent(dismissed());
    rig.lookAway();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    rig.run(rig.controller.timings.dismissGazeHold + 1);
    expect(rig.phase, 'the look made during the hold is used up').toBe('idle');
    rig.lookAway();
    rig.run(0.5);
    rig.person(1, { engaged: true });
    expect(rig.runUntil(2, () => rig.phase === 'listening')).not.toBeNull();
  });

  test('saidHarshlyTheAcknowledgementIsASheepishLookAway', () => {
    const rig = new Rig();
    rig.toThinking('t1');
    rig.transport.agent(dismissed('t1', { sheepish: true }));
    expect(rig.phase).toBe('idle');
    expect(oneShotPlayed(rig, 'lookAway')).toBe(true);
    expect(rig.engine.state.activeOneShots).not.toContain('nodYes');
  });

  test('aStaleDismissalIsIgnored', () => {
    const rig = new Rig();
    rig.toThinking('t2');
    rig.transport.agent(dismissed('t1'));
    expect(rig.phase).toBe('thinking');
  });

  test('aSignOffClosesTheMicAfterTheReplyInsteadOfTheFollowUpWindow', () => {
    const rig = new Rig();
    rig.toThinking('t1');
    rig.transport.agent(dismissed('t1', { p: 0.75, afterReply: true }));
    expect(rig.phase, 'the agent still answers').toBe('thinking');
    rig.run(0.3);
    rig.audio.startReply(rig.clock.now);
    rig.frame();
    expect(rig.phase).toBe('speaking');
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 300 } });
    rig.playReply(0.5, false);
    expect(rig.phase).toBe('idle');
    expect(rig.state).toBe('noticing');
    expect(rig.states).not.toContain('followUp');
    expect(rig.transport.micEnabled || rig.voice.isSpeaking).toBe(false);
    expect(rig.controller.status.lastDismissal).toBe('after the reply, closing p 0.75');
    expect(oneShotPlayed(rig, 'nodYes')).toBe(true);
  });

  test('aSignOffArrivingOnceTheReplyIsAudibleStillSkipsTheFollowUp', () => {
    const rig = new Rig();
    rig.toSpeaking('t1');
    rig.transport.agent(dismissed('t1', { p: 0.7, afterReply: true }));
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 300 } });
    rig.playReply(0.5, false);
    expect(rig.phase).toBe('idle');
    expect(rig.states).not.toContain('followUp');
  });

  test('aDismissalInTheFollowUpWindowEndsItToo', () => {
    const rig = new Rig();
    rig.toSpeaking('t1');
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 300 } });
    rig.playReply(0.5, false);
    expect(rig.state).toBe('followUp');
    rig.speak();
    rig.run(0.4);
    rig.endTurn();
    rig.transportTurnEnded('t2');
    rig.frame();
    expect(rig.phase).toBe('thinking');
    rig.transport.agent(dismissed('t2'));
    expect(rig.phase).toBe('idle');
    expect(rig.transport.micEnabled).toBe(false);
  });

  test('theLogNeverCarriesTheWords', () => {
    const rig = new Rig();
    rig.toThinking('t1');
    rig.transport.onEvent?.({ kind: 'caption', caption: { kind: 'partial', text: 'go away please' } });
    rig.transport.agent(dismissed());
    rig.run(1);
    expect(rig.log.some((e) => e.detail.includes('go away'))).toBe(false);
  });
});
