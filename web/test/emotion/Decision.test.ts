// Port of Tests/FaceEmotionTests/DecisionTests.swift.
import { describe, expect, test } from 'vitest';
import { ExpressionLibrary } from '../../src/model';
import {
  Decision, DecisionBeat, DecisionMapper, DecisionMessage, DecisionScheduler, MapperSettings, P3, type DecisionEffects,
  type PAD3,
} from '../../src/emotion';
import { approx, decision, maxAbs } from './support';

const lib = ExpressionLibrary.bundled();
const pad = (n: string): PAD3 | null => { const p = lib.get(n)?.pad; return p ? { x: p.p, y: p.a, z: p.d } : null; };

describe('DecisionMessageTests', () => {
  test('decodes the wire format', () => {
    const json = `{"yanni": 1, "type": "decision", "version": 1, "pass": "sentence", "turnId": "t7", "sentenceIndex": 2,
      "answers": {"feel": {"Happiness": 0.62, "Surprise": 0.21}, "intensity": {"4": 0.6, "5": 0.4},
                  "reaction": {"none": 0.2, "affection": 0.8}}}`;
    const r = DecisionMessage.decode(json);
    if (r.kind !== 'message' || r.message.kind !== 'decision') throw new Error('not decoded');
    const d = r.message.decision;
    expect(d.pass === 'sentence' && d.turnId === 't7' && d.sentenceIndex === 2).toBe(true);
    expect(d.top('feel')?.name).toBe('Happiness');
    expect(d.top('reaction')?.name).toBe('affection');
    const again = DecisionMessage.decode(DecisionMessage.jsonData(DecisionMessage.decision(d)));
    if (again.kind !== 'message' || again.message.kind !== 'decision') throw new Error('round trip');
    expect(again.message.decision.equals(d)).toBe(true);
  });

  test('gate and failure messages', () => {
    expect(DecisionMessage.decode('{"yanni":1,"type":"notForMe","turnId":"a"}'))
      .toEqual({ kind: 'message', message: { kind: 'gate', gate: { kind: 'notForMe', turnId: 'a' } } });
    expect(DecisionMessage.decode('{"type":"didNotUnderstand","turnId":"b"}'))
      .toEqual({ kind: 'message', message: { kind: 'gate', gate: { kind: 'didNotUnderstand', turnId: 'b' } } });
    expect(DecisionMessage.decode('{"type":"decisionModelUnavailable","since":3}'))
      .toEqual({ kind: 'message', message: { kind: 'decisionModelUnavailable' } });
    expect(DecisionMessage.decode('{"type":"reply-end","turnId":"b"}')).toEqual({ kind: 'notOurs', type: 'reply-end' });
  });

  test('versions and malformed', () => {
    expect(DecisionMessage.decode('{"yanni":2,"type":"decision"}')).toEqual({ kind: 'unsupportedVersion', version: 2 });
    expect(DecisionMessage.decode('{"type":"decision","version":9,"pass":"utterance","turnId":"x"}'))
      .toEqual({ kind: 'unsupportedVersion', version: 9 });
    expect(DecisionMessage.decode('[1,2]').kind).toBe('malformed');
    expect(DecisionMessage.decode('{"type":"decision","version":1,"pass":"sentence","turnId":"x"}').kind).toBe('malformed');
  });
});

describe('DecisionMapperTests', () => {
  const map = (d: Decision, m: DecisionMapper, now = 100, id = 7): DecisionEffects => m.map(d, now, 55, id, pad);

  test('pad, confidence and strength', () => {
    const m = new DecisionMapper();
    const fx = map(new Decision({ pass: 'utterance', turnId: 't', answers: { feel: { Happiness: 0.5, Sadness: 0.5 },
      intensity: { 5: 1 } } }), m);
    const h = pad('Happiness')!, s = pad('Sadness')!;
    expect(maxAbs(P3.sub(fx.pad, P3.scale(P3.add(h, s), 0.5)))).toBeLessThan(1e-5);
    expect(approx(fx.confidence, 0, 1e-5)).toBe(true);
    expect(approx(fx.expectedIntensity, 5, 1e-5)).toBe(true);
    const sure = map(new Decision({ pass: 'utterance', turnId: 't', answers: { feel: { Happiness: 1, Sadness: 0 },
      intensity: { 4: 1 } } }), m);
    expect(approx(sure.confidence, 1, 1e-5)).toBe(true);
    expect(approx(sure.strength, Math.min(1, 0.8 * new MapperSettings().strengthGain), 1e-5)).toBe(true);
    const odd = map(new Decision({ pass: 'utterance', turnId: 't', answers: { feel: { Happiness: 0.5, Zorp: 0.5 } } }), m);
    expect(maxAbs(P3.sub(odd.pad, h))).toBeLessThan(1e-5);
  });

  test('cue fields and one beat per decision', () => {
    const m = new DecisionMapper();
    const fx = map(decision({ feel: { Happiness: 0.75 }, intensity: 4.5, intent: 'compliment', reaction: ['affection', 0.82] }), m);
    if (fx.beat.kind !== 'cue') throw new Error('no cue');
    const c = fx.beat.cue;
    expect(c.kind === 'affection' && approx(c.confidence, 0.82, 1e-5) && c.source === 'conversation').toBe(true);
    expect(c.directedAtYanni && c.hostTime === 55 && c.key === 'affection:session' && c.id === 7).toBe(true);
    expect(approx(c.valence, fx.pad.x, 1e-6)).toBe(true);
    expect(fx.hint).toBe('delightedSquint');
    const m2 = new DecisionMapper();
    const weak = map(decision({ feel: { Happiness: 0.75 }, intensity: 4.5, intent: 'compliment', reaction: ['affection', 0.6] }), m2);
    expect(DecisionBeat.equals(weak.beat, DecisionBeat.oneShot('delightedSquint'))).toBe(true);
    const undirected = map(decision({ feel: { Happiness: 0.75 }, intensity: 4.5, reaction: ['affection', 0.9], addressed: 0.6 }), m2);
    expect(undirected.beat.kind === 'cue' && !undirected.beat.cue.directedAtYanni).toBe(true);
    const passB = map(decision({ pass: 'sentence', feel: { Happiness: 0.75 }, intensity: 4.5, reaction: ['affection', 0.9] }), m2);
    expect(passB.beat.kind === 'cue' && passB.beat.cue.directedAtYanni).toBe(true);
  });

  test('hint table and cooldowns', () => {
    const m = new DecisionMapper();
    const joke = (): Decision => decision({ feel: { Happiness: 0.7 }, intensity: 4.5, intent: 'joke' });
    expect(map(joke(), m).beat).toEqual(DecisionBeat.oneShot('laugh'));
    expect(map(joke(), m, 110).beat).toEqual(DecisionBeat.none);
    expect(map(joke(), m, 121).beat).toEqual(DecisionBeat.oneShot('laugh'));
    expect(map(decision({ feel: { Surprise: 0.7 }, intensity: 4.5 }), m).beat).toEqual(DecisionBeat.oneShot('bigSurprise'));
    expect(map(decision({ feel: { Annoyance: 0.7 }, intensity: 4.5, intent: 'teasing' }), m).beat).toEqual(DecisionBeat.oneShot('mockOffense'));
    expect(map(decision({ feel: { Confusion: 0.7 }, intensity: 4.5 }), m).beat).toEqual(DecisionBeat.oneShot('curiousTilt'));
    const m2 = new DecisionMapper();
    expect(map(decision({ feel: { Happiness: 0.7 }, intensity: 3, intent: 'joke' }), m2).beat).toEqual(DecisionBeat.none);
    expect(map(decision({ feel: { Happiness: 0.5 }, intensity: 4.5, intent: 'joke' }), m2).beat).toEqual(DecisionBeat.none);
    expect(map(decision({ pass: 'sentence', feel: { Happiness: 0.7 }, intensity: 4.5 }), m2).beat).toEqual(DecisionBeat.none);
  });

  test('hint cooldown charged only when it plays', () => {
    const m = new DecisionMapper();
    const fx = map(decision({ feel: { Happiness: 0.75 }, intensity: 4.5, intent: 'compliment', reaction: ['affection', 0.9] }), m);
    expect(fx.hint).toBe('delightedSquint');
    expect(m.hintReady('delightedSquint', 100)).toBe(true);
  });

  test('sad news never gets a playful beat', () => {
    const m = new DecisionMapper();
    const fx = map(decision({ feel: { Sadness: 0.7 }, intensity: 4.5, intent: 'badNews', reaction: ['delight', 0.95] }), m);
    expect(fx.beat).toEqual(DecisionBeat.none);
    expect(fx.valence).toBeLessThan(-0.2);
    const surprised = map(decision({ feel: { Sadness: 0.4, Surprise: 0.6 }, intensity: 4.5, reaction: ['reveal', 0.9] }), m);
    expect(surprised.beat.kind).not.toBe('cue');
  });
});

describe('DecisionSchedulerTests', () => {
  const h = (feel = { Happiness: 0.7 }): Record<string, number> => feel;

  test('pass A on arrival unless late', () => {
    const s = new DecisionScheduler();
    const a = decision({ feel: h() });
    expect(s.receive(a, 1, 10)).toEqual({ kind: 'scheduled', at: 1 });
    expect(s.popDue(1)?.decision).toBe(a);
    s.sentenceAudioStarted('t1', 0, 2, null, 2);
    expect(s.receive(a, 2.5, null)).toEqual({ kind: 'dropped', reason: 'late' });
  });

  test('pass B waits for its audio start', () => {
    const s = new DecisionScheduler();
    const b = decision({ pass: 'sentence', index: 1, feel: h() });
    expect(s.receive(b, 1, null)).toEqual({ kind: 'waiting' });
    expect(s.hasDue(5)).toBe(false);
    expect(s.sentenceAudioStarted('t1', 1, 2.3, 12.3, 2)).toEqual([{ kind: 'scheduled', at: 2.3 }]);
    expect(s.hasDue(2.29)).toBe(false);
    const due = s.popDue(2.3);
    expect(due?.decision === b && due?.hostTime === 12.3).toBe(true);
  });

  test('pass B after its audio is late', () => {
    const s = new DecisionScheduler();
    s.sentenceAudioStarted('t1', 0, 1, null, 1);
    expect(s.receive(decision({ pass: 'sentence', index: 0, feel: h() }), 1.05, null)).toEqual({ kind: 'scheduled', at: 1.05 });
    expect(s.receive(decision({ pass: 'sentence', index: 0, feel: h() }), 1.5, null)).toEqual({ kind: 'dropped', reason: 'late' });
  });

  test('barge-in drops the turn', () => {
    const s = new DecisionScheduler();
    s.receive(decision({ pass: 'sentence', index: 1, feel: h() }), 1, null);
    s.cancel('t1');
    expect(s.takeDropped().map((x) => x.reason)).toEqual(['cancelled']);
    expect(s.sentenceAudioStarted('t1', 1, 2, null, 2)).toEqual([]);
    expect(s.receive(decision({ feel: h() }), 3, null)).toEqual({ kind: 'dropped', reason: 'cancelled' });
    expect(s.hasDue(100)).toBe(false);
  });

  test('new turn makes older ones stale', () => {
    const s = new DecisionScheduler();
    s.receive(decision({ pass: 'sentence', turn: 't1', index: 3, feel: h() }), 1, null);
    s.receive(decision({ turn: 't2', feel: h() }), 2, null);
    expect(s.takeDropped().map((x) => x.reason)).toEqual(['stale']);
    expect(s.receive(decision({ turn: 't1', feel: h() }), 3, null)).toEqual({ kind: 'dropped', reason: 'stale' });
  });

  test('waiting tags expire', () => {
    const s = new DecisionScheduler();
    s.pendingExpiry = 20;
    s.receive(decision({ pass: 'sentence', index: 4, feel: h() }), 1, null);
    s.expire(20);
    expect(s.hasDropped).toBe(false);
    s.expire(21.5);
    expect(s.takeDropped().map((x) => x.reason)).toEqual(['expired']);
  });

  test('gated turn drops later decisions', () => {
    const s = new DecisionScheduler();
    s.gate('t1');
    expect(s.isClosed('t1')).toBe(true);
    expect(s.receive(decision({ feel: h() }), 1, null)).toEqual({ kind: 'dropped', reason: 'gated' });
  });
});
