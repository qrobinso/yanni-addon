// Port of Tests/ConversationCoreTests/PerceptionTurnTests.swift.
// Perception's turn API (review H3): pin listening → speaking, unpin at the end, one outcome per engagement.
import { describe, expect, test } from 'vitest';
import { outcome, pin, release, unpin } from './support/Fakes';
import { Rig } from './support/Rig';

describe('PerceptionTurnTests', () => {
  test('pinnedOnlyOnceListeningStarts', () => {
    const rig = new Rig();
    rig.controller.settings.greetingEnabled = false;
    rig.person();
    rig.run(0.5);
    rig.perception.clear();
    rig.person(1, { engaged: true });
    rig.frame();
    expect(rig.state).toBe('engaged');
    expect(rig.perception.has(pin(1)), "engaged alone doesn't hold the turn").toBe(false);
    expect(rig.runUntil(1, () => rig.phase === 'listening')).not.toBeNull();
    expect(rig.perception.calls).toEqual([pin(1)]);
  });

  test('turnStaysPinnedThroughThinkingAndSpeaking', () => {
    const rig = new Rig();
    rig.toSpeaking();
    expect(rig.perception.has(unpin)).toBe(false);
    rig.lookAway();   // glances away mid-reply: Yanni keeps talking
    rig.playReply(1);
    expect(rig.state).toBe('speaking');
  });

  test('sessionDropUnpinsAndIsNeverAFalseEngagement', () => {
    const rig = new Rig();
    rig.toListening();
    rig.transport.autoReady = false;
    rig.transport.drop();
    expect(rig.state).toBe('sheepish');
    expect(rig.perception.has(unpin)).toBe(true);
    expect(rig.perception.outcomes).toEqual([outcome(1, true)]);
  });

  test('oneOutcomePerEngagement', () => {
    const rig = new Rig();
    rig.toSpeaking();
    rig.transport.agent({ kind: 'replyEnd', payload: { turnId: 't1', sentences: 1, audioMs: 100 } });
    rig.playReply(0.5, false);
    rig.run(6.2);
    expect(rig.state).toBe('noticing');
    expect(rig.perception.outcomes, 'speech heard, counted once').toEqual([outcome(1, true)]);
    expect(rig.perception.calls.slice(-2)).toEqual([unpin, release]);
  });

  test('confusedCountsAsSpokenNotForMeAsFalse', () => {
    const a = new Rig();
    a.toThinking('t1');
    a.transport.agent({ kind: 'didNotUnderstand', payload: { turnId: 't1', reason: 'empty' } });
    expect(a.perception.outcomes).toEqual([outcome(1, true)]);
    const b = new Rig();
    b.toThinking('t1');
    b.transport.agent({ kind: 'notForMe', payload: { turnId: 't1' } });
    expect(b.perception.outcomes).toEqual([outcome(1, false)]);
  });
});
