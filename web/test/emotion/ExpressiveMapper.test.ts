// Port of Tests/FaceEmotionTests/ExpressiveMapperTests.swift.
import { describe, expect, test } from 'vitest';
import { ExpressivePlan } from '../../src/engine';
import {
  Decision, DecisionMapper, DecisionMessage, ExpressiveMapper, MapperSettings, type Answers, type ExpressiveDecision,
} from '../../src/emotion';
import { Rig, hasModifiers } from './support';

function req(v: ExpressiveDecision | null): ExpressiveDecision {
  expect(v).not.toBeNull();
  return v!;
}

export function answers(react: Record<string, number>, o: { intensity?: Record<string, number>;
  brow?: Record<string, number>; gaze?: Record<string, number>; pupil?: Record<string, number>;
  move?: Record<string, number> } = {}): Answers {
  return { react, intensity: o.intensity ?? { 4: 0.8, 5: 0.2 }, brow: o.brow ?? {}, gaze: o.gaze ?? {},
    pupil: o.pupil ?? {}, move: o.move ?? {} };
}

export const delighted = answers({ delight: 0.7, playful: 0.2, ignore: 0.1 }, {
  brow: { raise: 0.6, none: 0.4 }, gaze: { lookAt: 0.5, none: 0.3, lookAway: 0.2 },
  pupil: { stars: 0.55, hearts: 0.25, none: 0.2 }, move: { bounce: 0.6, perk: 0.3, none: 0.1 },
});

describe('ExpressiveMapperTests', () => {
  test('probabilities become a plan', () => {
    const m = new ExpressiveMapper();
    const x = req(m.map(delighted, 'gesture:wave', 'perception', null, 7));
    expect(x.react === 'delight' && Math.abs(x.confidence - 0.7) < 1e-6).toBe(true);
    expect(Math.abs(x.expectedIntensity - 4.2)).toBeLessThan(1e-4);
    const p = x.plan;
    expect(p.expression).toBe('Happiness');
    expect(Math.abs(p.intensity - ExpressivePlan.cueMaxOverlay)).toBeLessThan(1e-4);
    expect(Math.abs(p.hold - (0.8 + 0.25 * 4.2))).toBeLessThan(1e-4);
    expect(p.brow === 'raise' && p.gaze === 'lookAt' && p.move === 'laugh').toBe(true);
    expect(p.cue?.kind === 'delight' && p.cue?.id === 7 && p.cue?.source === 'perception').toBe(true);
    expect(p.cue?.key).toBe('delight:gesture:wave');
    const imp = x.impulse!;
    expect(imp.source === 'perception' && imp.strength > 0 && imp.strength <= 0.6).toBe(true);
  });

  test('below threshold or ignore does nothing', () => {
    const m = new ExpressiveMapper();
    expect(m.map(answers({ delight: 0.3, shy: 0.3, ignore: 0.4 }), 'k')).toBeNull();
    expect(m.map(answers({ ignore: 0.9, delight: 0.1 }), 'k')).toBeNull();
    expect(m.map(answers({ delight: 0.39, shy: 0.31, curiosity: 0.3 }), 'k')).toBeNull();
    expect(m.map({}, 'k')).toBeNull();
    expect(m.map(answers({ bogus: 0.9 }), 'k')).toBeNull();
  });

  test('weak sub-actions are none and brows take the family default', () => {
    const m = new ExpressiveMapper();
    const x = req(m.map(answers({ sympathetic: 0.8 }, { brow: { furrow: 0.3, none: 0.7 }, gaze: { eyeRoll: 0.34 },
      pupil: { hearts: 0.2 }, move: { nod: 0.3 } }), 'arrival'));
    expect(x.plan.brow === 'worried' && x.plan.gaze === 'none' && x.plan.cue === null && x.plan.move === null).toBe(true);
    expect(x.plan.expression).toBe('Concerned');
    expect(Math.abs(x.expectedIntensity - 4.2)).toBeLessThan(1e-4);
    const mid = req(m.map(answers({ sceptical: 0.6 }, { intensity: {} }), 'x'));
    expect(mid.expectedIntensity === 3 && mid.plan.brow === 'sceptical').toBe(true);
  });

  test('the same gesture never gets the same plan twice in a row', () => {
    const m = new ExpressiveMapper();
    const a = req(m.map(delighted, 'gesture:wave'));
    const b = req(m.map(delighted, 'gesture:wave'));
    expect(a.plan.equals(b.plan)).toBe(false);
    expect(b.plan.move === 'perkUp' && b.plan.cue?.kind === 'affection' && b.plan.gaze === 'lookAway').toBe(true);
    const c = req(m.map(delighted, 'gesture:wave'));
    expect(c.plan.equals(b.plan)).toBe(false);
    const other = req(m.map(delighted, 'gesture:clap'));
    expect(other.plan.move).toBe('laugh');
    const bare = answers({ shy: 0.9 });
    const s1 = req(m.map(bare, 'tickle')), s2 = req(m.map(bare, 'tickle'));
    expect(s1.plan.equals(s2.plan)).toBe(false);
  });

  test('sentence brow and gaze make a brow-only plan', () => {
    const st = new MapperSettings();
    const d = new Decision({ version: 3, pass: 'sentence', turnId: 't', sentenceIndex: 1,
      answers: { brow: { sceptical: 0.7, none: 0.3 }, gaze: { lookAway: 0.4, none: 0.6 } } });
    const p = ExpressiveMapper.sentencePlan(d, st)!;
    expect(p.expression === null && p.brow === 'sceptical' && p.gaze === 'none').toBe(true);
    const none = new Decision({ version: 3, pass: 'sentence', turnId: 't', sentenceIndex: 0, answers: { brow: { none: 0.9 } } });
    expect(ExpressiveMapper.sentencePlan(none, st)).toBeNull();
    const mapper = new DecisionMapper();
    expect(mapper.map(d, 0, null, 1, () => null).plan?.brow).toBe('sceptical');
    const a = new Decision({ version: 3, pass: 'utterance', turnId: 't', answers: { brow: { raise: 0.9 } } });
    expect(mapper.map(a, 0, null, 2, () => null).plan).toBeNull();
  });

  test('version three decodes', () => {
    const r = DecisionMessage.decode('{"yanni":1,"type":"decision","version":3,"pass":"sentence","turnId":"t","sentenceIndex":0,"answers":{"brow":{"raise":0.8}}}');
    if (r.kind !== 'message' || r.message.kind !== 'decision') throw new Error('not decoded');
    expect(r.message.decision.version).toBe(3);
    expect(r.message.decision.p('brow', 'raise')).toBe(Math.fround(0.8));
  });
});

interface OverlayView { plansStarted: number; overlayWeight: number }

describe('ExpressiveLayerTests', () => {
  test.skipIf(!hasModifiers('ExpressiveOverlay'))('the layer applies the impulse and plays the plan', () => {
    const rig = new Rig({ state: 'noticing' });
    rig.run(0.5);
    const before = rig.felt;
    const x = rig.layer.playExpressive(delighted, 'gesture:wave')!;
    expect(x.react).toBe('delight');
    rig.run(0.5);
    expect(rig.felt.x).toBeGreaterThan(before.x);
    const ov = rig.modifier<OverlayView>('ExpressiveOverlay');
    expect(ov.plansStarted === 1 && ov.overlayWeight > 0.3).toBe(true);
    expect(rig.layer.expressiveApplied).toBe(1);
    expect(rig.layer.lastExpressive?.startsWith('gesture:wave · delight')).toBe(true);
  });

  test('below threshold leaves the face alone', () => {
    const rig = new Rig({ state: 'noticing' });
    expect(rig.layer.playExpressive({ react: { ignore: 1 } }, 'arrival')).toBeNull();
    rig.run(0.3);
    if (hasModifiers('ExpressiveOverlay')) expect(rig.modifier<OverlayView>('ExpressiveOverlay').plansStarted).toBe(0);
    expect(rig.layer.expressiveApplied).toBe(0);
  });

  test('asleep nothing plays and the impulse is ignored', () => {
    const rig = new Rig({ state: 'asleep' });
    rig.run(0.2);
    const before = rig.felt;
    rig.layer.playExpressive(delighted, 'gesture:wave');
    rig.run(0.5);
    expect(rig.layer.expressiveApplied).toBe(0);
    expect(Math.abs(rig.felt.x - before.x)).toBeLessThan(0.05);
  });
});
