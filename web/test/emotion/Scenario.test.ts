// Port of Tests/FaceEmotionTests/ScenarioTests.swift: the fake conversation source through the real layer and face.
import { describe, expect, test } from 'vitest';
import type { AgentState } from '../../src/engine';
import { ConversationSimulator, PersonalityPreset, type PAD3, type SimScenario } from '../../src/emotion';
import { Rig, hasModifiers, maxAbs } from './support';

interface Trace { labels: string[]; beats: string[]; cues: string[]; minFelt: PAD3; maxFelt: PAD3; states: AgentState[]; rig: Rig }

function play(s: SimScenario, seconds = 16): Trace {
  const rig = new Rig();
  rig.run(0.5);
  const sim = new ConversationSimulator(rig.layer);
  sim.start(s, rig.host);
  const tr: Trace = { labels: [], beats: [], cues: [], minFelt: { x: 1, y: 1, z: 1 }, maxFelt: { x: -1, y: -1, z: -1 },
    states: [], rig };
  rig.run(seconds, 60, (r) => {
    sim.tick(r.host);
    const l = r.layer.classifierState.labelName;
    if (l !== null && r.engine.state.emotionWeight > 0.05 && tr.labels[tr.labels.length - 1] !== l) tr.labels.push(l);
    const f = r.felt;
    tr.minFelt = { x: Math.min(tr.minFelt.x, f.x), y: Math.min(tr.minFelt.y, f.y), z: Math.min(tr.minFelt.z, f.z) };
    tr.maxFelt = { x: Math.max(tr.maxFelt.x, f.x), y: Math.max(tr.maxFelt.y, f.y), z: Math.max(tr.maxFelt.z, f.z) };
    const st = r.engine.state.agentState;
    if (tr.states[tr.states.length - 1] !== st) tr.states.push(st);
  });
  tr.beats = rig.layer.events.filter((e) => e.kind === 'beat').map((e) => e.text);
  tr.cues = rig.layer.events.filter((e) => e.kind === 'cue').map((e) => e.text);
  return tr;
}

const playful = new Set(['Happiness', 'Excitement', 'Amazement', 'Contentment', 'Curious']);
const arbiter = hasModifiers('PupilReactions');

describe('ScenarioTests', () => {
  test('joke', () => {
    const t = play('joke');
    expect(t.beats).toContain('laugh');
    expect(t.labels.some((l) => playful.has(l))).toBe(true);
    expect(t.maxFelt.x).toBeGreaterThan(0.4);
    expect(t.rig.layer.dynamics.mood.x).toBeGreaterThan(0.01);
    expect(t.rig.reports.some((r) => r.trigger === 'endOfTurn') && t.rig.reports.some((r) => r.trigger === 'replyEnded')).toBe(true);
  });

  test.skipIf(!arbiter)('compliment', () => {
    const t = play('compliment');
    expect(t.cues.some((c) => c.includes('affection') && c.includes('accepted'))).toBe(true);
    expect(t.beats).not.toContain('delightedSquint');
  });

  test('sad news', () => {
    const t = play('sadNews');
    expect(t.beats).toEqual([]);
    expect(t.cues.some((c) => c.includes('accepted'))).toBe(false);
    expect(t.labels.some((l) => ['Sadness', 'Concerned', 'Disappointment'].includes(l))).toBe(true);
    expect(t.labels.some((l) => playful.has(l))).toBe(false);
    expect(t.minFelt.x).toBeLessThan(0);
  });

  test('teasing', () => {
    expect(play('teasing').beats).toContain('mockOffense');
  });

  test('not for me', () => {
    const t = play('notForMe');
    expect(t.rig.gates).toEqual([{ kind: 'notForMe', turnId: 'sim-1' }]);
    expect(t.states).toContain('notForMe');
    expect(t.rig.layer.dynamics.mood.x).toBeLessThan(0);
  });

  test('garbled', () => {
    const t = play('garbled');
    expect(t.rig.gates.length).toBe(1);
    expect(t.states).toContain('confused');
  });

  test('barge-in', () => {
    const t = play('bargeIn');
    expect(t.states).toContain('interrupted');
    expect(t.cues.some((c) => c.includes('delight'))).toBe(false);
    expect(t.rig.layer.events.some((e) => e.kind === 'dropped' && e.text.includes('cancelled'))).toBe(true);
  });

  test('decision model down', () => {
    const t = play('decisionModelDown', 6);
    expect(t.rig.layer.isActive('decisionModelDown')).toBe(true);
    expect(t.minFelt.z).toBeLessThan(PersonalityPreset.baseline('playful').z - 0.05);
  });

  test('voice services down and reconnect', () => {
    const t = play('voiceServicesDown');
    expect(t.states).toContain('sheepish');
    expect(t.rig.layer.isActive('voiceServicesUnreachable')).toBe(false);
    expect(t.rig.reports.some((r) => r.trigger === 'connect')).toBe(true);
    expect(t.rig.layer.events.some((e) => e.text.startsWith('relief'))).toBe(true);
  });

  test('every scenario settles back near baseline', () => {
    for (const s of ConversationSimulator.scenarios) {
      const t = play(s, 40);
      expect(maxAbs(t.rig.layer.dynamics.emotion), s).toBeLessThan(0.02);
      expect(maxAbs(t.maxFelt) <= 1 && maxAbs(t.minFelt) <= 1).toBe(true);
    }
  }, 60_000);
});

