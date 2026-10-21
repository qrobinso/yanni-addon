// Port of ConversationAgentTests/ExpressiveAskTests.swift: expressive asks through `jev.ask` (expressive decisions
// design §4–§6): the privacy payload, the answer mapping, the fallback and the expressive gate's own breaker.
import { describe, expect, test } from 'vitest';
import { makeAgentTunables } from '../../../src/conversation/core/VoiceServicesEndpoint';
import {
  distanceBand, ExpressiveFeaturesStatics, makeExpressiveFeatures, timeOfDay, type ExpressiveFeatures,
} from '../../../src/conversation/events/ExpressiveEvents';
import { DecisionQuestions } from '../../../src/conversation/agent/DecisionQuestions';
import { HAError } from '../../../src/conversation/agent/homeassistant/HAChannel';
import { JevGate } from '../../../src/conversation/agent/JevGate';
import { at, type JSONObject, type JSONValue } from '../../../src/conversation/agent/JSONValue';
import { jsonString } from '../../../src/conversation/agent/JSONValue+Agent';
import { ManualAgentClock } from '../support/AgentTestKit';
import { FakeHA } from '../support/FakeHomeAssistant';

const full: ExpressiveFeatures = makeExpressiveFeatures({
  event: 'gesture', gesture: 'heartHands', confidence: 0.9134, priority: null, people: 14, distance: 'near', facing: true,
  eyeContact: false, presentSeconds: 37.4, mood: 'Happiness', state: 'noticing', timeOfDay: 'evening', bedtime: false,
  recent: ['arrival', 'gesture:wave', 'eyeContact', 'tickle', 'gesture:clap'],
});

const response = (): JSONValue => ({ answers: {
  react: { choice: 'delight', probabilities: { delight: 0.7, shy: 0.2, ignore: 0.1 }, confidence: 0.7 },
  intensity: { score: 3, probabilities: { 0: 0.0, 1: 0.1, 2: 0.2, 3: 0.5, 4: 0.2 } },
  brow: { probabilities: { raise: 0.6, none: 0.4 } },
  gaze: { probabilities: { lookAt: 0.5, none: 0.5 } },
  pupil: { probabilities: { hearts: 0.8, none: 0.2 } },
  move: { probabilities: { bogus: 0.9 } },
}, latency_ms: 80 });

describe('ExpressiveAskTests', () => {
  test('thePayloadHoldsOnlyTheDocumentedFields', () => {
    const q = DecisionQuestions.bundled();
    const o = q.expressiveState(full) as JSONObject;
    const doc = ExpressiveFeaturesStatics.documentedKeys;
    expect(Object.keys(o).every((k) => doc.has(k))).toBe(true);
    expect(new Set(Object.keys(o))).toEqual(new Set([...doc].filter((k) => k !== 'priority')));
    expect(o.people).toBe(9); // capped
    expect(o.confidence).toBe(0.91);
    expect(o.present_s).toBe(35); // rounded to 5 s
    expect((o.recent as JSONValue[]).length).toBe(4);
    expect(o.eye_contact).toBe(false);
    // Nothing that could identify or locate anyone: no ids, positions, names, text.
    const text = jsonString(o);
    for (const banned of ['"id"', 'position', 'speaker', 'utterance', 'transcript', 'image', '"at"', 'metres']) {
      expect(text.includes(banned), banned).toBe(false);
    }
    // A sparse request carries only the always-present keys.
    const s = q.expressiveState(makeExpressiveFeatures({ event: 'tickle' })) as JSONObject;
    expect(new Set(Object.keys(s))).toEqual(new Set(['character', 'event', 'people', 'mood', 'state', 'time_of_day', 'bedtime', 'recent']));
  });

  test('answersMapAndOnlyTheExpressiveSetGoesOut', async () => {
    const gate = new JevGate(DecisionQuestions.bundled(), makeAgentTunables(), new ManualAgentClock());
    const states: JSONValue[] = [], questions: JSONValue[] = [];
    gate.setAsk(async (s, q) => { states.push(s); questions.push(q); return response(); });
    const r = await gate.expressive(full);
    expect(r.kind).toBe('answered');
    if (r.kind !== 'answered') return;
    expect(r.answers.react?.delight).toBe(0.7);
    expect(r.answers.intensity?.['4']).toBe(0.5);
    expect(r.answers.pupil?.hearts).toBe(0.8);
    expect(r.answers.move).toBeUndefined(); // an unknown option omits its key
    expect(new Set(Object.keys(questions[0] as JSONObject))).toEqual(new Set(['react', 'intensity', 'brow', 'gaze', 'pupil', 'move']));
    expect(at(states[0], 'event')).toBe('gesture');
  });

  test('noJevOrAnOldSetIsDisabled', async () => {
    const gate = new JevGate(DecisionQuestions.bundled(), makeAgentTunables(), new ManualAgentClock());
    expect(await gate.expressive(full)).toEqual({ kind: 'disabled' });
    const v2 = new DecisionQuestions(2, 'x', {}, {});
    const old = new JevGate(v2, makeAgentTunables(), new ManualAgentClock());
    old.setAsk(async () => response());
    expect(await old.expressive(full)).toEqual({ kind: 'disabled' });
  });

  test('failuresOpenTheExpressiveBreakerWithoutSending', async () => {
    const clock = new ManualAgentClock();
    const gate = new JevGate(DecisionQuestions.bundled(), makeAgentTunables(), clock);
    let sent = 0;
    gate.setAsk(async () => { sent += 1; throw HAError.closed(); });
    for (let i = 0; i < 3; i++) expect(await gate.expressive(full)).toEqual({ kind: 'failed' });
    expect(gate.breakerOpen).toBe(true);
    expect(await gate.expressive(full)).toEqual({ kind: 'breakerOpen' });
    expect(sent).toBe(3);
    // The conversation gate is a separate instance: its Pass A still goes out.
    const convo = new JevGate(DecisionQuestions.bundled(), makeAgentTunables(), clock);
    convo.setAsk(async () => FakeHA.jevResponse());
    expect((await convo.passA('hi', [])).kind).toBe('answered');
  });

  test('bandsAndTimesOfDay', () => {
    expect(distanceBand(0.6)).toBe('near');
    expect(distanceBand(2)).toBe('mid');
    expect(distanceBand(4)).toBe('far');
    expect(distanceBand(NaN)).toBeNull();
    expect([6, 13, 19, 23, 2].map(timeOfDay)).toEqual(['morning', 'afternoon', 'evening', 'night', 'night']);
  });
});
