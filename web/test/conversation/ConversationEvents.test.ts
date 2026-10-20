// ConversationEvents has no Swift test target of its own; these pin the few pieces with logic.
import { describe, expect, test } from 'vitest';
import {
  agentEventName, agentEventTurnId, describeCaption, dismissedReason, distanceBand, makeDismissed,
  makeExpressiveFeatures, normalizedFeatures, timeOfDay,
} from '../../src/conversation/events';

describe('ConversationEvents', () => {
  test('dismissed reason wording', () => {
    expect(dismissedReason(makeDismissed({ turnId: 't', source: 'decision', probability: 0.823 }))).toBe('closing p 0.82');
    expect(dismissedReason(makeDismissed({ turnId: 't', source: 'local' }))).toBe('local');
    expect(dismissedReason(makeDismissed({ turnId: 't', source: 'decision', probability: 0.71, afterReply: true })))
      .toBe('after the reply, closing p 0.71');
  });

  test('event names and turn ids', () => {
    expect(agentEventName({ kind: 'didNotUnderstand', payload: { turnId: 'a', reason: 'empty' } })).toBe('did-not-understand');
    expect(agentEventTurnId({ kind: 'replyEnd', payload: { turnId: 'b', sentences: 1, audioMs: 10 } })).toBe('b');
    expect(agentEventTurnId({ kind: 'decisionModelUnavailable', payload: { reason: 'timeout' } })).toBeNull();
  });

  test('captions never print their text', () => {
    expect(describeCaption({ kind: 'transcript', turnId: 't1', text: 'secret words' })).toBe('transcript(t1, 12 chars)');
  });

  test('expressive features are rounded and capped', () => {
    const f = normalizedFeatures(makeExpressiveFeatures({
      event: 'gesture', people: 12, confidence: 0.876, presentSeconds: 12.6, gesture: 'x'.repeat(40),
      recent: ['a', 'b', 'c', 'd', 'e'],
    }));
    expect([f.people, f.confidence, f.presentSeconds, f.gesture?.length]).toEqual([9, 0.88, 15, 32]);
    expect(f.recent).toEqual(['b', 'c', 'd', 'e']);
    expect([distanceBand(0.5), distanceBand(2.5), distanceBand(3), distanceBand(NaN)]).toEqual(['near', 'mid', 'far', null]);
    expect([timeOfDay(4), timeOfDay(5), timeOfDay(12), timeOfDay(17), timeOfDay(22)])
      .toEqual(['night', 'morning', 'afternoon', 'evening', 'night']);
  });
});
