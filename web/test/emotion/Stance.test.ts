// Port of Tests/FaceEmotionTests/StanceTests.swift.
import { describe, expect, test } from 'vitest';
import type { OneShotKind } from '../../src/engine';
import { ExpressionLibrary } from '../../src/model';
import {
  ConversationSimulator, Decision, DecisionBeat, DecisionMapper, DecisionMessage, MapperSettings, P3, type DecisionEffects,
  type PAD3,
} from '../../src/emotion';
import { Rig } from './support';

function stanceDecision(o: { turn?: string; index: number; stance: Record<string, number>; reaction?: [string, number] | null;
  feel?: Record<string, number>; intensity?: number }): Decision {
  const answers = ConversationSimulator.answers(o.feel ?? { Happiness: 0.7 }, o.intensity ?? 4.5,
    { reaction: o.reaction ?? null, addressed: null });
  answers.stance = o.stance;
  return new Decision({ version: 2, pass: 'sentence', turnId: o.turn ?? 't1', sentenceIndex: o.index, answers });
}

const lib = ExpressionLibrary.bundled();
const pad = (n: string): PAD3 | null => { const p = lib.get(n)?.pad; return p ? { x: p.p, y: p.a, z: p.d } : null; };

describe('StanceMappingTests', () => {
  const answer = (s: Record<string, number>): OneShotKind | null =>
    DecisionMapper.stanceAnswer(stanceDecision({ index: 0, stance: s }), 0.7);

  test('summed yes and no, strong versus gentle, below threshold nothing', () => {
    expect(answer({ yes: 0.4, strongYes: 0.35, none: 0.25 })).toBe('nodYes');
    expect(answer({ yes: 0.25, strongYes: 0.5, none: 0.25 })).toBe('nodYesBig');
    expect(answer({ no: 0.8, none: 0.2 })).toBe('shakeNo');
    expect(answer({ no: 0.35, strongNo: 0.4, none: 0.25 })).toBe('shakeNoBig');
    expect(answer({ no: 0.69, none: 0.31 })).toBeNull();
    expect(answer({ yes: 0.35, no: 0.35, none: 0.3 })).toBeNull();
    expect(answer({ none: 1 })).toBeNull();
    expect(DecisionMapper.stanceAnswer(new Decision({ pass: 'sentence', turnId: 't', sentenceIndex: 0, answers: {} }), 0.7)).toBeNull();
  });

  test('question set version two is accepted', () => {
    const r = DecisionMessage.decode('{"yanni":1,"type":"decision","version":2,"pass":"sentence","turnId":"t","sentenceIndex":0,"answers":{"stance":{"yes":0.9,"none":0.1}}}');
    if (r.kind !== 'message' || r.message.kind !== 'decision') throw new Error('version 2 not decoded');
    expect(r.message.decision.version).toBe(2);
    expect(r.message.decision.p('stance', 'yes')).toBe(Math.fround(0.9));
  });

  test('stance is the beat over cue and hint, once per reply', () => {
    const m = new DecisionMapper();
    const map = (d: Decision): DecisionEffects => m.map(d, 100, 50, 1, pad);
    const a = map(stanceDecision({ index: 0, stance: { strongYes: 0.9, none: 0.1 }, reaction: ['affection', 0.9],
      feel: { Surprise: 0.9 }, intensity: 5 }));
    expect(DecisionBeat.equals(a.beat, DecisionBeat.oneShot('nodYesBig')) && a.stance === 'nodYesBig').toBe(true);
    expect(a.hint).toBe('bigSurprise');
    expect(m.hintReady('bigSurprise', 100)).toBe(true);
    expect(a.impulse).not.toBeNull();
    const b = map(stanceDecision({ index: 1, stance: { no: 0.9, none: 0.1 }, reaction: ['affection', 0.9] }));
    expect(b.stance).toBeNull();
    expect(b.beat.kind).toBe('cue');
    const c = map(stanceDecision({ turn: 't2', index: 0, stance: { no: 0.9, none: 0.1 } }));
    expect(c.beat).toEqual(DecisionBeat.oneShot('shakeNo'));
    const u = stanceDecision({ turn: 't3', index: 0, stance: { yes: 1 } });
    u.pass = 'utterance'; u.sentenceIndex = null;
    expect(map(u).stance).toBeNull();
  });

  test("Yanni's voice only plays the claimed stance", () => {
    const m = new DecisionMapper();
    m.stanceNeedsClaim = true;
    const map = (d: Decision): DecisionEffects => m.map(d, 100, 50, 1, pad);
    const late = stanceDecision({ index: 0, stance: { yes: 0.9, none: 0.1 } });
    expect(map(late).stance, 'nobody claimed it').toBeNull();
    const d1 = stanceDecision({ index: 1, stance: { yes: 0.9, none: 0.1 } });
    const d2 = stanceDecision({ index: 2, stance: { no: 0.9, none: 0.1 } });
    expect(m.claimStance(d1)).toBe('nodYes');
    expect(m.claimStance(d2), 'one per reply').toBeNull();
    expect(map(d2).stance).toBeNull();
    expect(map(d1).beat).toEqual(DecisionBeat.oneShot('nodYes'));
    expect(map(d1).stance, 'once').toBeNull();
  });
});

describe('StanceLayerTests', () => {
  /// Runs frames for `seconds`, collecting every host-timed and immediate one-shot and cue the layer sends.
  function collect(rig: Rig, seconds: number): { at: [OneShotKind, number][]; now: OneShotKind[]; cues: number } {
    const at: [OneShotKind, number][] = [], now: OneShotKind[] = [];
    let cues = 0;
    rig.run(seconds, 60, (r) => {
      for (const c of r.engine.state.commands) {
        if (c.kind === 'playOneShotAt') at.push([c.oneShot, c.hostTime]);
        else if (c.kind === 'playOneShot') now.push(c.oneShot);
        else if (c.kind === 'reactionCue') cues += 1;
      }
    });
    return { at, now, cues };
  }

  test('spoken stance nods at the sentence start once per reply', () => {
    const rig = new Rig({ state: 'speaking' });
    rig.run(0.2);
    rig.layer.receive(DecisionMessage.decision(stanceDecision({ index: 0, stance: { yes: 0.9, none: 0.1 }, reaction: ['delight', 0.9] })));
    rig.layer.receive(DecisionMessage.decision(stanceDecision({ index: 1, stance: { strongNo: 0.9, none: 0.1 } })));
    const t0 = rig.host + 0.3;
    rig.layer.sentenceAudioStarted('t1', 0, t0);
    rig.layer.sentenceAudioStarted('t1', 1, t0 + 1.5);
    const got = collect(rig, 2.2);
    expect(got.at.length, `one stance beat per reply: ${JSON.stringify(got.at)}`).toBe(1);
    expect(got.at[0]?.[0]).toBe('nodYes');
    expect(Math.abs((got.at[0]?.[1] ?? 0) - t0)).toBeLessThan(1e-9);
    expect(got.cues, 'the stance replaced the cue (R4)').toBe(0);
    expect(rig.layer.events.some((e) => e.kind === 'beat' && e.text === 'stance nodYes')).toBe(true);
  });

  test("Yanni's voice claims the stance for its chirp", () => {
    const rig = new Rig({ state: 'speaking' });
    rig.layer.stanceNeedsClaim = true;
    rig.run(0.2);
    const late = stanceDecision({ index: 0, stance: { yes: 0.9, none: 0.1 } });
    const d1 = stanceDecision({ index: 1, stance: { strongYes: 0.9, none: 0.1 }, feel: { Happiness: 0.9 } });
    const tag = rig.layer.sentenceTag(d1);
    expect(tag.answer).toBe('nodYesBig');
    expect(tag.pad !== null && tag.strength > 0.3).toBe(true);
    expect(rig.layer.sentenceTag(stanceDecision({ index: 2, stance: { no: 1 } })).answer, 'one per reply').toBeNull();
    rig.layer.receive(DecisionMessage.decision(late));
    rig.layer.receive(DecisionMessage.decision(d1));
    const t1 = rig.host + 1.2;
    rig.layer.sentenceAudioStarted('t1', 0, rig.host + 0.2);
    rig.layer.sentenceAudioStarted('t1', 1, t1);
    const got = collect(rig, 1.6);
    expect(got.at.map((x) => x[0]), 'only the claimed stance nods').toEqual(['nodYesBig']);
    expect(Math.abs((got.at[0]?.[1] ?? 0) - t1)).toBeLessThan(1e-9);
    expect(got.now).toEqual([]);
  });

  test("the sentence tag carries the impulse's feel", () => {
    const rig = new Rig({ state: 'speaking' });
    const d = stanceDecision({ index: 0, stance: { none: 1 }, feel: { Sadness: 0.9 }, intensity: 4 });
    const tag = rig.layer.sentenceTag(d);
    expect(tag.answer).toBeNull();
    const fx = DecisionMapper.feel(d, new MapperSettings(), pad);
    expect(tag.pad !== null && P3.equals(tag.pad, fx.pad) && tag.strength === fx.strength).toBe(true);
    expect(tag.pad?.x ?? 0).toBeLessThan(0);
    const none = rig.layer.sentenceTag(new Decision({ version: 2, pass: 'sentence', turnId: 't9', sentenceIndex: 0, answers: {} }));
    expect(none.pad === null && none.answer === null).toBe(true);
  });
});
