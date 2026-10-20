// Port of Tests/FaceEmotionTests/LayerTests.swift (the allocation suite is Swift-only). Tests that need the real face
// (expression transition, pupils, mood colour, touch, the pupil arbiter) skip until those modifiers are registered.
import { describe, expect, test } from 'vitest';
import { FaceAffect, FaceEngine, Mood, makePersonTarget, type FaceState } from '../../src/engine';
import { ExpressionMix, ParamLayout } from '../../src/model';
import {
  DecisionMessage, EmotionDynamics, EmotionImpulse, EmotionLayer, EmotionSettings, MemoryMoodStore, P3, PersistedMood,
  PersonalityPreset, makeEnvironment, makeNudge, type PAD3,
} from '../../src/emotion';
import { Rig, approx, decision, hasModifiers, maxAbs, pad } from './support';

const toward = (p: PAD3, s: number, src: Parameters<typeof EmotionImpulse.toward>[2] = 'debug', label = ''): {
  kind: 'impulse'; impulse: EmotionImpulse } => ({ kind: 'impulse', impulse: EmotionImpulse.toward(p, s, src, label) });
const v3 = (v: { x: number; y: number; z: number }): PAD3 => ({ x: v.x, y: v.y, z: v.z });
interface ETView { shownEmotionWeight: number }

describe('LayerOutputTests', () => {
  test('at baseline the face is exactly as without the layer', () => {
    const rig = new Rig();
    const plain = new FaceEngine();
    plain.setMood(Mood.playful);
    plain.setAgentState('idle');
    plain.tick(1 / 60, 1000);
    let host = 1000;
    for (let i = 0; i < 600; i++) { host += 1 / 60; plain.tick(1 / 60, host); }
    rig.run(10);
    expect(Mood.equals(rig.engine.state.mood, plain.state.mood)).toBe(true);
    expect(rig.engine.state.emotionWeight).toBe(0);
    expect(rig.engine.state.output.pose.equals(plain.state.output.pose)).toBe(true);
    expect(P3.equals(rig.engine.state.output.color, plain.state.output.color)).toBe(true);
  });

  test.skipIf(!hasModifiers('ExpressionTransition', 'MoodColor'))('impulse moves mood, expression, colour and affect', () => {
    const rig = new Rig();
    rig.run(1);
    const colour0 = v3(rig.engine.state.eyeColor);
    rig.layer.apply(toward(pad(0.8, 0.4, 0.3), 0.8, 'debug', 'test'));
    rig.run(0.5);
    expect(rig.engineMood.x).toBeGreaterThan(0.5);
    expect(rig.engine.state.emotionWeight).toBeGreaterThan(0.3);
    expect(rig.engine.state.emotionMix?.entries[0]?.name).toBe('Happiness');
    expect(rig.engine.state.targetMix.equals(ExpressionMix.neutral)).toBe(true);
    expect(rig.modifier<ETView>('ExpressionTransition').shownEmotionWeight).toBeGreaterThan(0.15);
    rig.run(1);
    expect(P3.equals(rig.engine.state.eyeColor, colour0)).toBe(false);
    rig.run(12);
    expect(rig.engine.state.emotionWeight).toBe(0);
    expect(maxAbs(P3.sub(rig.felt, rig.layer.dynamics.baseline))).toBeLessThan(0.06);
  });

  test.skipIf(!hasModifiers('ExpressionTransition'))('authority-zero states show the profile exactly', () => {
    const rig = new Rig({ state: 'sheepish' });
    rig.run(0.5);
    rig.layer.apply(toward(pad(0.8, 0.4, 0.3), 1));
    rig.run(1);
    expect(rig.engine.state.emotionWeight).toBeGreaterThan(0);
    expect(rig.modifier<ETView>('ExpressionTransition').shownEmotionWeight).toBe(0);
  });

  test.skipIf(!hasModifiers('ExpressionTransition'))('override beats emotion', () => {
    const rig = new Rig();
    rig.layer.apply(toward(pad(0.8, 0.4, 0.3), 1));
    rig.run(0.5);
    rig.engine.setExpressionOverride(ExpressionMix.single('Sadness'));
    rig.run(0.2);
    expect(rig.modifier<ETView>('ExpressionTransition').shownEmotionWeight).toBe(0);
  });

  test.skipIf(!hasModifiers('ExpressionTransition', 'Pupils', 'MoodColor', 'MoodModulation'))('mood changes never snap', () => {
    const rig = new Rig();
    rig.run(0.5);
    rig.layer.apply(toward(pad(-0.6, -0.4, -0.4), 1));
    const et = rig.modifier<ETView>('ExpressionTransition');
    const pupils = rig.modifier<{ level: number }>('Pupils');
    const snap = (s: FaceState): { mood: PAD3; w: number; pose: number[]; color: PAD3; pupil: number; speed: number } =>
      ({ mood: rig.engineMood, w: et.shownEmotionWeight, pose: Array.from(s.basePose.raw), color: v3(s.eyeColor),
        pupil: pupils.level, speed: s.modulation.speed });
    let last = snap(rig.engine.state);
    rig.run(6, 60, (r) => {
      const s = r.engine.state;
      expect(maxAbs(P3.sub(r.engineMood, last.mood))).toBeLessThan(0.2);
      expect(Math.abs(et.shownEmotionWeight - last.w)).toBeLessThan(0.05);
      expect(maxAbs(P3.sub(s.eyeColor, last.color))).toBeLessThan(0.02);
      expect(Math.abs(pupils.level - last.pupil)).toBeLessThan(0.02);
      expect(Math.abs(s.modulation.speed - last.speed)).toBeLessThan(0.02);
      let biggest = 0;
      for (let i = 0; i < ParamLayout.count; i++) biggest = Math.max(biggest, Math.abs(s.basePose.raw[i] - last.pose[i]));
      expect(biggest).toBeLessThan(3);
      last = snap(s);
    });
  });

  test('baseline changes ease', () => {
    const rig = new Rig();
    rig.layer.personality = 'bubbly';
    let last = rig.engineMood;
    rig.run(8, 60, (r) => {
      expect(maxAbs(P3.sub(r.engineMood, last))).toBeLessThan(0.02);
      last = r.engineMood;
    });
    expect(maxAbs(P3.sub(rig.felt, PersonalityPreset.baseline('bubbly')))).toBeLessThan(0.01);
  });
});

describe('LayerCadenceTests', () => {
  function timeline(fps: number | null, slices?: number[]): EmotionDynamics {
    const rig = new Rig();
    rig.tickEngine = false;
    let t = 0;
    const events: [number, PAD3, number][] = [[0.5, pad(0.8, 0.4, 0.3), 0.7], [1.5, pad(-0.3, 0.3, -0.5), 0.5],
      [2.0, pad(0.8, 0.9, 0.4), 1]];
    let next = 0, k = 0;
    while (t < 4 - 1e-9) {
      while (next < events.length && events[next][0] <= t + 1e-9) {
        rig.layer.apply(toward(events[next][1], events[next][2]));
        next += 1;
      }
      const dt = slices ? slices[k % slices.length] : 1 / fps!;
      k += 1;
      t += dt;
      rig.host += dt;
      rig.layer.afterFrame(rig.host);
    }
    return rig.layer.dynamics;
  }

  test('same timeline, any slicing', () => {
    const a = timeline(60);
    const b = timeline(120);
    const c = timeline(null, [0.004, 0.021, 0.0333, 0.0137, 0.05, 0.0119, 0.0161, 0.025, 0.006, 0.0154, 0.25, 0.05]);
    const e = timeline(4);
    for (const x of [b, e]) {
      expect(x.steps).toBe(a.steps);
      expect(maxAbs(P3.sub(x.felt, a.felt))).toBeLessThanOrEqual(1e-6);
      expect(maxAbs(P3.sub(x.mood, a.mood))).toBeLessThanOrEqual(1e-6);
      expect(maxAbs(P3.sub(x.emotion, a.emotion))).toBeLessThanOrEqual(1e-6);
    }
    expect(maxAbs(P3.sub(c.felt, a.felt))).toBeLessThan(0.02);
  });

  test('call gaps are clamped to a quarter second', () => {
    const rig = new Rig();
    rig.tickEngine = false;
    rig.host += 5;
    rig.layer.afterFrame(rig.host);
    expect(Math.abs(rig.layer.layerTime - 0.25)).toBeLessThan(1e-9);
  });

  test('impulses land on their step', () => {
    const rig = new Rig();
    rig.tickEngine = false;
    rig.run(0.5);
    rig.layer.apply(toward(pad(0.8, 0.4, 0.3), 1));
    const before = rig.layer.dynamics.steps;
    rig.run(1 / 60);
    expect(rig.layer.dynamics.steps).toBeGreaterThan(before);
    expect(rig.layer.dynamics.drive.x > 0 || rig.layer.dynamics.emotion.x > 0).toBe(true);
  });
});

describe('LayerInputTests', () => {
  test('state transitions fire their rules', () => {
    const rig = new Rig();
    rig.run(0.2);
    rig.engine.setAgentState('engaged');
    rig.run(0.5);
    expect(rig.layer.dynamics.emotion.x).toBeGreaterThan(0.05);
    const count = (): number => rig.layer.events.filter((e) => e.text.startsWith('engaged')).length;
    const fired = count();
    for (let i = 0; i < 5; i++) {
      rig.engine.setAgentState('idle'); rig.run(0.3);
      rig.engine.setAgentState('engaged'); rig.run(0.3);
    }
    expect(count()).toBe(fired);
  });

  test('sheepish and not-for-me touch mood only', () => {
    const rig = new Rig();
    rig.run(0.2);
    rig.engine.setAgentState('sheepish');
    rig.run(0.5);
    expect(maxAbs(rig.layer.dynamics.emotion)).toBeLessThan(1e-6);
    expect(rig.layer.dynamics.mood.x).toBeLessThan(0);
  });

  test("sheepish colour stays near the state's own", () => {
    const rig = new Rig();
    rig.run(0.2);
    rig.layer.setCondition('voiceServicesUnreachable', true);
    rig.engine.setAgentState('sheepish');
    rig.run(8);
    const plain = new FaceEngine();
    plain.setMood(Mood.playful);
    plain.setAgentState('sheepish');
    for (let i = 0; i < 500; i++) plain.tick(1 / 60);
    const a = FaceAffect.effectivePAD(rig.engine.state), b = FaceAffect.effectivePAD(plain.state);
    expect(maxAbs(P3.sub(a, b))).toBeLessThanOrEqual(0.15);
  });

  test('conditions shift felt, not mood, and relieve on clear', () => {
    const rig = new Rig();
    rig.layer.setCondition('voiceServicesUnreachable', true);
    rig.run(5);
    expect(rig.layer.dynamics.rest.z).toBeLessThan(-0.1);
    expect(maxAbs(rig.layer.dynamics.mood)).toBeLessThan(1e-6);
    rig.layer.setCondition('voiceServicesUnreachable', false);
    rig.run(0.3);
    expect(rig.layer.dynamics.emotion.x).toBeGreaterThan(0.05);
    rig.run(5);
    expect(maxAbs(rig.layer.dynamics.rest)).toBeLessThan(0.01);
  });

  test('eight-hour outage keeps mood at baseline', () => {
    const rig = new Rig();
    rig.tickEngine = false;
    rig.layer.setCondition('voiceServicesUnreachable', true);
    rig.layer.setCondition('decisionModelDown', true);
    rig.run(8 * 3600, 4);
    expect(maxAbs(rig.layer.dynamics.mood)).toBeLessThan(0.05);
    expect(approx(rig.layer.dynamics.rest.z, (-0.12 - 0.06) * 0.3, 0.01)).toBe(true);
  }, 120_000);

  test.skipIf(!hasModifiers('TouchReactions'))('tap tiers push small relative impulses', () => {
    const rig = new Rig();
    rig.run(0.2);
    const p0 = rig.felt.x;
    for (let i = 0; i < 4; i++) {
      rig.engine.send({ kind: 'tap', at: { x: 0.2, y: 0 } });
      rig.run(0.25);
    }
    expect(rig.layer.events.some((e) => e.text.startsWith('hey'))).toBe(true);
    expect(rig.layer.events.some((e) => e.text.startsWith('hmph'))).toBe(true);
    expect(rig.felt.x).toBeLessThan(p0);
    expect(rig.felt.x).toBeGreaterThan(p0 - 0.4);
  });

  test('perception impulses are gated', () => {
    const rig = new Rig();
    rig.run(0.2);
    rig.engine.setBedtime(true);
    rig.layer.apply(toward(pad(0.7, 0.7, 0.3), 0.6, 'perception', 'wave'));
    rig.run(0.5);
    expect(maxAbs(rig.layer.dynamics.emotion)).toBeLessThan(1e-6);
    rig.engine.setBedtime(false);
    rig.engine.setAgentState('asleep');
    rig.layer.apply(toward(pad(0.7, 0.7, 0.3), 0.6, 'perception', 'wave'));
    rig.run(0.5);
    expect(maxAbs(rig.layer.dynamics.emotion)).toBeLessThan(1e-6);
    rig.engine.setAgentState('idle');
    rig.run(0.2);
    rig.layer.apply(toward(pad(0.7, 0.7, 0.3), 0.6, 'perception', 'wave'));
    rig.run(0.3);
    expect(rig.layer.dynamics.emotion.x).toBeGreaterThan(0.1);
  });

  test.skipIf(!hasModifiers('TouchReactions'))('perception impulses ignored while sulking', () => {
    const rig = new Rig();
    rig.run(0.2);
    for (let i = 0; i < 7; i++) { rig.engine.send({ kind: 'tap', at: { x: 0, y: 0 } }); rig.run(0.1); }
    expect(rig.engine.state.isSulking).toBe(true);
    rig.layer.apply(toward(pad(0.7, 0.7, 0.3), 0.6, 'perception', 'wave'));
    rig.run(1 / 60);
    expect(rig.layer.impulses.some((i) => i.label === 'wave')).toBe(false);
    expect(rig.layer.events.some((e) => e.text.includes('ignored (sulking)'))).toBe(true);
  });

  test('nudges clamp, look and respect sleep', () => {
    const rig = new Rig();
    rig.run(0.2);
    rig.layer.apply({ kind: 'nudge', nudge: makeNudge('sadness', 1, 'left') });
    rig.run(1 / 60);
    expect(rig.engine.state.gazeTarget.point.x < 0 || rig.layer.events.some((e) => e.text.includes('look left'))).toBe(true);
    rig.run(0.5);
    expect(rig.felt.x).toBeGreaterThan((0.2 + -0.3) / 2 - 0.02);
    expect(rig.felt.x).toBeLessThan(0.15);
    const n = rig.layer.events.length;
    rig.layer.apply({ kind: 'nudge', nudge: makeNudge('Zorp') });
    expect(rig.layer.events[rig.layer.events.length - 1].text.includes('unknown') && rig.layer.events.length === n + 1).toBe(true);
    rig.engine.setAgentState('asleep');
    rig.run(0.1);
    rig.layer.apply({ kind: 'nudge', nudge: makeNudge('Happiness') });
    expect(rig.layer.events[rig.layer.events.length - 1].text.includes('ignored')).toBe(true);
  });

  test('arrival after long alone and leaving while engaged', () => {
    const rig = new Rig();
    rig.tickEngine = false;
    rig.layer.environment = () => makeEnvironment(0, false);
    rig.run(130, 10);
    rig.layer.environment = () => makeEnvironment(0, true);
    rig.run(0.5, 10);
    expect(rig.layer.events.some((e) => e.text.startsWith('arrival'))).toBe(true);
    rig.engine.setPeople([makePersonTarget(1, { x: 0, y: 0 })], 1, 1);
    rig.run(1, 10);
    rig.engine.setPeople([], null, null);
    rig.layer.environment = () => makeEnvironment(0, false);
    rig.run(0.5, 10);
    expect(rig.layer.events.some((e) => e.text.startsWith('left while engaged'))).toBe(true);
  });

  test('non-finite impulses are ignored', () => {
    const rig = new Rig();
    rig.layer.apply(toward(pad(NaN, 0, 0), 1));
    rig.layer.apply({ kind: 'impulse', impulse: EmotionImpulse.make({ kind: 'relative', pad: P3.zero }, NaN, 'debug') });
    rig.run(0.5);
    expect(P3.equals(rig.felt, rig.layer.dynamics.baseline)).toBe(true);
  });

  test('many impulses in one step merge', () => {
    const rig = new Rig();
    rig.tickEngine = false;
    for (let i = 0; i < 20; i++) rig.layer.apply(toward(pad(0.8, 0.9, 0.4), 1));
    let peak = P3.zero;
    rig.run(1, 60, (r) => { peak = { x: Math.max(peak.x, r.felt.x), y: Math.max(peak.y, r.felt.y), z: Math.max(peak.z, r.felt.z) }; });
    expect(peak.x <= 0.82 && peak.y <= 0.92).toBe(true);
  });
});

describe('LayerDecisionTests', () => {
  test('appraisal reacts before replying and the beat follows the impulse', () => {
    const rig = new Rig({ state: 'thinking' });
    rig.run(0.2);
    rig.layer.receive(DecisionMessage.decision(decision({ feel: { Happiness: 0.7 }, intensity: 4.5, intent: 'joke' })));
    rig.run(1 / 60);
    expect(rig.layer.dynamics.drive.x).toBeGreaterThan(0);
    rig.run(0.3);
    expect(rig.engine.state.activeOneShots.includes('laugh') ||
      rig.layer.events.some((e) => e.kind === 'beat' && e.text === 'laugh')).toBe(true);
    const i = rig.layer.events.findIndex((e) => e.kind === 'impulse');
    const b = rig.layer.events.findIndex((e) => e.kind === 'beat');
    expect(i >= 0 && b >= 0 && i < b).toBe(true);
  });

  test('a sentence tag applies when heard', () => {
    const rig = new Rig({ state: 'speaking' });
    rig.run(0.2);
    rig.layer.receive(DecisionMessage.decision(decision({ pass: 'sentence', index: 0, feel: { Surprise: 0.8 }, intensity: 4.5 })));
    rig.run(0.5);
    expect(maxAbs(rig.layer.dynamics.drive)).toBe(0);
    rig.layer.sentenceAudioStarted('t1', 0, rig.host + 0.3);
    rig.run(0.25);
    expect(maxAbs(rig.layer.dynamics.drive)).toBe(0);
    rig.run(0.1);
    expect(rig.layer.dynamics.drive.y).toBeGreaterThan(0);
  });

  test('barge-in discards the turn', () => {
    const rig = new Rig({ state: 'speaking' });
    rig.run(0.2);
    rig.layer.receive(DecisionMessage.decision(decision({ pass: 'sentence', index: 1, feel: { Excitement: 0.8 }, intensity: 4.5 })));
    rig.layer.cancelTurn('t1');
    rig.layer.sentenceAudioStarted('t1', 1, rig.host);
    rig.run(0.5);
    expect(maxAbs(rig.layer.dynamics.drive)).toBe(0);
    expect(rig.layer.decisionsDropped).toBeGreaterThanOrEqual(1);
  });

  test('the gate hands off to the controller', () => {
    const rig = new Rig({ state: 'thinking' });
    rig.run(0.2);
    rig.layer.receive(DecisionMessage.gate({ kind: 'notForMe', turnId: 't9' }));
    expect(rig.gates).toEqual([{ kind: 'notForMe', turnId: 't9' }]);
    rig.run(0.3);
    expect(rig.engine.state.agentState).toBe('notForMe');
    rig.layer.cancelTurn('t10');
    rig.layer.receive(DecisionMessage.gate({ kind: 'didNotUnderstand', turnId: 't10' }));
    expect(rig.gates.length).toBe(1);
  });

  test('decision model down dips dominance until the next decision', () => {
    const rig = new Rig({ state: 'thinking' });
    rig.run(0.2);
    rig.layer.receive(DecisionMessage.decisionModelUnavailable);
    rig.layer.receive(DecisionMessage.decisionModelUnavailable);
    rig.run(0.4);
    expect(rig.layer.isActive('decisionModelDown')).toBe(true);
    const z = rig.layer.dynamics.emotion.z;
    expect(z < -0.05 && z > -0.2).toBe(true);
    rig.layer.receive(DecisionMessage.decision(decision({ feel: { Neutral: 0.7 } })));
    expect(rig.layer.isActive('decisionModelDown')).toBe(false);
  });

  test('unknown versions are ignored and counted', () => {
    const rig = new Rig();
    const d = decision({ feel: { Happiness: 0.9 } });
    d.version = 99;
    rig.layer.receive(DecisionMessage.decision(d));
    rig.layer.receiveData('{"yanni":1,"type":"decision","version":42,"pass":"utterance","turnId":"q"}');
    rig.run(0.3);
    expect(rig.layer.versionMismatches).toBe(2);
    expect(maxAbs(rig.layer.dynamics.drive)).toBe(0);
  });

  test('sad news from a cheerful mood never reads playful', () => {
    const rig = new Rig({ state: 'thinking' });
    rig.run(0.2);
    rig.layer.baselineOverride = null;
    rig.layer.setSlowMood(pad(0.4, 0.2, 0.15));
    rig.run(1);
    rig.layer.receive(DecisionMessage.decision(decision({ feel: { Sadness: 0.7 }, intensity: 4, intent: 'badNews',
      reaction: ['delight', 0.9] })));
    const t0 = rig.layer.layerTime;
    const playful = new Set(['Happiness', 'Excitement', 'Amazement', 'Contentment', 'Curious']);
    let sawSad = false;
    rig.run(8, 60, (r) => {
      const l = r.layer.classifierState.labelName;
      if (l !== null && ['Sadness', 'Concerned', 'Disappointment'].includes(l)) sawSad = true;
      if (r.layer.layerTime > t0 + 0.5 && l !== null && r.engine.state.emotionWeight > 0.02) {
        expect(playful.has(l), `playful label ${l} after sad news`).toBe(false);
      }
    });
    expect(sawSad).toBe(true);
    expect(rig.layer.events.some((e) => e.kind === 'cue' || e.text === 'laugh' || e.text === 'delightedSquint')).toBe(false);
    if (hasModifiers('PupilReactions')) {
      expect(rig.modifier<{ somberUntil: number }>('PupilReactions').somberUntil).toBeGreaterThan(rig.engine.state.time);
    }
  });
});

describe('FallbackBeatTests', () => {
  const cueDecision = (turn: string): ReturnType<typeof decision> =>
    decision({ turn, feel: { Happiness: 0.75 }, intensity: 4.5, intent: 'compliment', reaction: ['affection', 0.9] });

  test.skipIf(!hasModifiers('PupilReactions'))('rarity rejection falls back to the hint', () => {
    const rig = new Rig();
    rig.run(0.2);
    rig.layer.receive(DecisionMessage.decision(cueDecision('a')));
    rig.run(0.5);
    expect(rig.layer.events.some((e) => e.text.includes('accepted'))).toBe(true);
    rig.run(4);
    rig.layer.receive(DecisionMessage.decision(cueDecision('b')));
    rig.run(0.3);
    expect(rig.layer.events.some((e) => e.kind === 'beat' && e.text.includes('→ delightedSquint'))).toBe(true);
  });

  test.skipIf(!hasModifiers('PupilReactions'))('context rejection has no fallback', () => {
    const rig = new Rig({ state: 'sheepish' });
    rig.run(0.2);
    rig.layer.receive(DecisionMessage.decision(cueDecision('a')));
    rig.run(0.5);
    expect(rig.layer.events.some((e) => e.text.includes('no fallback'))).toBe(true);
    expect(rig.layer.events.some((e) => e.kind === 'beat')).toBe(false);
  });

  test('fallback reason allow-list', () => {
    const allowed = EmotionLayer.fallbackReasons;
    for (const r of ['globalCooldown', 'shapeCooldown', 'habituated', 'repeatKey', 'recentCancel', 'busy', 'otherActivity',
      'disabled', 'shapeDisabled'] as const) expect(allowed.has(r)).toBe(true);
    for (const r of ['negativeContext', 'somber', 'annoyed', 'bedtime', 'sulking', 'blockedState', 'stale', 'notDirected',
      'lowConfidence'] as const) expect(allowed.has(r)).toBe(false);
  });
});

describe('MoodReportTests', () => {
  test('schema matches the contract', () => {
    const rig = new Rig();
    rig.layer.sessionConnected();
    const r = rig.reports[rig.reports.length - 1];
    const obj = JSON.parse(r.jsonData()) as Record<string, unknown>;
    expect(new Set(Object.keys(obj))).toEqual(new Set(['type', 'version', 'felt', 'mood', 'label', 'moodLabel', 'boredom', 'conditions']));
    expect(obj.type === 'mood' && obj.version === 1).toBe(true);
    expect(r.trigger === 'connect' && r.label === 'Neutral' && r.moodLabel === 'playful').toBe(true);
    expect(new Set(Object.keys(obj.felt as object))).toEqual(new Set(['p', 'a', 'd']));
  });

  test('turn triggers', () => {
    const rig = new Rig();
    rig.run(0.2);
    rig.engine.setAgentState('listening'); rig.run(0.1);
    rig.engine.setAgentState('thinking'); rig.run(0.1);
    expect(rig.reports[rig.reports.length - 1]?.trigger).toBe('endOfTurn');
    rig.engine.setAgentState('speaking'); rig.run(0.1);
    const n = rig.reports.length;
    rig.engine.setAgentState('followUp'); rig.run(0.1);
    expect(rig.reports.length === n + 1 && rig.reports[rig.reports.length - 1].trigger === 'replyEnded').toBe(true);
  });

  test('heartbeat every sixty seconds', () => {
    const rig = new Rig();
    rig.tickEngine = false;
    rig.run(59, 10);
    expect(rig.reports).toEqual([]);
    rig.run(1.5, 10);
    expect(rig.reports.length === 1 && rig.reports[0].trigger === 'heartbeat').toBe(true);
    rig.run(60, 10);
    expect(rig.reports.length).toBe(2);
  });

  test('label changes are rate limited', () => {
    const rig = new Rig();
    rig.run(0.2);
    const times: number[] = [];
    rig.layer.onMoodReport = () => { times.push(rig.layer.realTime); };
    for (let k = 0; k < 30; k++) {
      rig.layer.apply(toward(k % 2 === 0 ? pad(0.8, 0.9, 0.4) : pad(-0.6, -0.4, -0.4), 1));
      rig.run(0.3);
    }
    expect(times.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1 - 1e-6);
  });
});

describe('PersistenceAndSettingsTests', () => {
  test('mood round-trips decayed by elapsed time', () => {
    let now = 1_000_000;
    const store = new MemoryMoodStore();
    const rig = new Rig({ store, wallClock: () => now });
    rig.layer.setSlowMood(pad(0.3, 0.2, 0.1));
    rig.layer.saveMood();
    now += 600;
    const again = new Rig({ store, wallClock: () => now });
    expect(approx(again.layer.dynamics.mood.x, 0.3 * Math.exp(-1), 1e-3)).toBe(true);
    expect(approx(again.layer.dynamics.mood.y, 0.2 * Math.exp(-600 / 90), 1e-3)).toBe(true);
    expect(maxAbs(again.layer.dynamics.emotion)).toBe(0);
  });

  test('future or corrupt mood starts at baseline', () => {
    const now = 1_000_000;
    const future = new MemoryMoodStore(PersistedMood.make(pad(0.3, 0, 0), now + 3600));
    expect(P3.isZero(new Rig({ store: future, wallClock: () => now }).layer.dynamics.mood)).toBe(true);
    const corrupt = new MemoryMoodStore(PersistedMood.make(pad(NaN, 0, 0), now));
    expect(P3.isZero(new Rig({ store: corrupt, wallClock: () => now }).layer.dynamics.mood)).toBe(true);
    expect(PersistedMood.decode('garbage')).toBeNull();
  });

  test('settings decode tolerantly and validate', () => {
    const json = '{"dynamics": {"emotionDecaySeconds": 100, "moodGain": "x"}, "classifier": {"allowList": ["Happiness", "Fury"]}, "authority": {"idle": 2, "speaking": 0.2}, "bogus": 1}';
    const s = EmotionSettings.fromJSON(JSON.parse(json)).validated();
    expect(s.dynamics.emotionDecaySeconds).toBe(12);
    expect(s.dynamics.moodGain).toBe(0.06);
    expect(s.classifier.allowList).toEqual(['Happiness']);
    expect(s.authority.get('idle') === 1 && s.authority.get('speaking') === 0.2 && s.authority.get('thinking') === 0.55).toBe(true);
    const round = EmotionSettings.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(round.equals(s)).toBe(true);
    expect(EmotionSettings.fromJSON({}).equals(new EmotionSettings())).toBe(true);
  });
});

