// Port of ConversationAgentTests/DismissalTests.swift: Pass A's `closing` and the local matcher in the orchestrator
// (decision model design §4 "Closing"). Named AgentDismissal so it doesn't clash with ConversationCore's Dismissal tests.
import { describe, expect, test } from 'vitest';
import { dismissedReason } from '../../../src/conversation/events/AgentEvents';
import type { JSONObject } from '../../../src/conversation/agent/JSONValue';
import { FakeHA, haError, result } from '../support/FakeHomeAssistant';
import { OrchRig } from './OrchestratorRig';

const closing = (only: number, withRequest = 0): JSONObject =>
  ({ closing: { choice: 'only', probabilities: { only, withRequest, no: Math.max(1 - only - withRequest, 0) } } });

const transcripts = (rig: OrchRig): number => rig.outs.filter((o) => o.kind === 'caption' && o.caption.kind === 'transcript').length;

describe('DismissalOrchestrationTests', () => {
  test('aDismissalNeverReachesTheAgentOrTheScreen', async () => {
    const rig = new OrchRig();
    rig.transcript = 'okay go away';
    rig.ha.configure((c) => { c.onJev = async () => result(FakeHA.jevResponse({ extra: closing(0.82) })); });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(3, () => rig.has('dismissed:decision'))).toBe(true);
    await rig.drive(0.5, () => false);
    expect(rig.ha.agentCalls).toBe(0);
    expect(rig.replyEnds()).toEqual([]); // no reply, no TTS
    expect(transcripts(rig)).toBe(0);
    const d = rig.events.flatMap((e) => (e.kind === 'dismissed' ? [e.payload] : []))[0];
    expect(d.probability).toBe(0.82);
    expect(dismissedReason(d)).toBe('closing p 0.82');
    expect(d.afterReply).toBe(false);
    const names = rig.eventNames;
    expect(names.indexOf('decisionA')).toBeLessThan(names.indexOf('dismissed:decision'));
  });

  test('closingBelowTheThresholdIsANormalTurn', async () => {
    const rig = new OrchRig();
    rig.ha.configure((c) => { c.onJev = async () => result(FakeHA.jevResponse({ extra: closing(0.55) })); });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
    expect(rig.ha.agentCalls).toBe(1);
    expect(rig.eventNames.some((n) => n.startsWith('dismissed'))).toBe(false);
  });

  test('aRequestWithASignOffStillRunsTheAgentAndSaysSoFirst', async () => {
    const rig = new OrchRig();
    rig.transcript = "turn off the lights and that's all";
    rig.ha.configure((c) => { c.onJev = async () => result(FakeHA.jevResponse({ extra: closing(0.1, 0.8) })); });
    expect(await rig.connect()).toBe(true);
    await rig.userTurn();
    expect(await rig.drive(5, () => rig.replyEnds().length > 0)).toBe(true);
    expect(rig.ha.agentCalls).toBe(1);
    expect(transcripts(rig)).toBe(1);
    const names = rig.eventNames;
    expect(names.indexOf('dismissed:afterReply')).toBeLessThan(names.indexOf('sentenceStart'));
  });

  test.each([true, false])('withoutTheDecisionModelTheLocalMatcherCatchesShortDismissals (disabled %s)', async (disabled) => {
    for (const [text, dismissed] of [['Go away!', true], ["what's the weather like today?", false]] as const) {
      const rig = new OrchRig();
      rig.transcript = text;
      rig.ha.configure((c) => {
        if (disabled) c.jevEntries = []; else c.onJev = async () => haError('unknown_error', 'down');
      });
      expect(await rig.connect()).toBe(true);
      await rig.userTurn();
      if (dismissed) {
        expect(await rig.drive(3, () => rig.has('dismissed:local')), text).toBe(true);
        await rig.drive(0.5, () => false);
        expect(rig.ha.agentCalls).toBe(0);
      } else {
        expect(await rig.drive(5, () => rig.ha.agentCalls === 1), text).toBe(true);
        expect(rig.has('dismissed:local')).toBe(false);
      }
    }
  });
});
