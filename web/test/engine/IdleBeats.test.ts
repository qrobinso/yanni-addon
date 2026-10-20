// Port of Tests/FaceEngineTests/IdleBeatsTests.swift.
import { describe, expect, test } from 'vitest';
import { AgentState, IdleBeats, Mood, type Modifier, type OneShotKind } from '../../src/engine';
import { ASTOneShotProbe, ASTRecorder, ASTRig } from './ASTRig';

const beatKinds = new Set<OneShotKind>(['curiousTilt', 'doubleTake', 'delightedSquint', 'sideEye']);

function simulate(o: { seed: number; mood?: Mood; state?: AgentState; seconds: number; beats?: IdleBeats;
  probe?: ASTOneShotProbe }): { time: number; kind: OneShotKind }[] {
  const rec = new ASTRecorder();
  const mods: Modifier[] = [];
  if (o.probe) mods.push(o.probe);
  mods.push(o.beats ?? new IdleBeats(), rec);
  const rig = new ASTRig(mods, o.seed);
  rig.state.mood = o.mood ?? Mood.playful;
  rig.state.agentState = o.state ?? 'idle';
  rig.run(o.seconds, 1 / 20);
  return rec.requests;
}

const pairs = <T>(a: T[]): [T, T][] => a.slice(1).map((b, i) => [a[i], b]);

describe('IdleBeatsTests', () => {
  test.each([1, 2, 3])('spacingAndNoRepeats(seed: %i)', (seed) => {
    const beats = simulate({ seed, seconds: 2 * 3600 });
    expect(beats.length > 80 && beats.length < 250, `≈ one per 45–60 s, got ${beats.length}`).toBe(true);
    for (const [a, b] of pairs(beats)) {
      expect(b.time - a.time).toBeGreaterThanOrEqual(20 - 1e-6);
      expect(a.kind, 'never the same beat twice in a row').not.toBe(b.kind);
    }
    expect(beats.every((b) => beatKinds.has(b.kind))).toBe(true);
    // Median spacing near 45 s.
    const gaps = pairs(beats).map(([a, b]) => b.time - a.time).sort((x, y) => x - y);
    expect(Math.abs(gaps[Math.floor(gaps.length / 2)] - 45)).toBeLessThan(10);
  });

  test('firstBeatWaitsToSettle', () => {
    const beats = simulate({ seed: 4, seconds: 600 });
    expect(beats[0]?.time ?? 0).toBeGreaterThanOrEqual(6);
  });

  test('moodGating', () => {
    const neutralMood: Mood = { pleasure: 0, arousal: 0, dominance: -0.2 };
    const a = simulate({ seed: 5, mood: neutralMood, seconds: 3600 });
    expect(a.some((b) => b.kind === 'delightedSquint' || b.kind === 'sideEye')).toBe(false);

    const happy: Mood = { pleasure: 0.7, arousal: 0.3, dominance: 0.5 };
    const b = simulate({ seed: 5, mood: happy, seconds: 3600 });
    expect(b.some((x) => x.kind === 'delightedSquint')).toBe(true);
    expect(b.some((x) => x.kind === 'sideEye')).toBe(false);

    const smug: Mood = { pleasure: 0.1, arousal: 0, dominance: 0.6 };
    const c = simulate({ seed: 6, mood: smug, seconds: 3 * 3600 });
    const side = c.filter((x) => x.kind === 'sideEye').length;
    expect(side > 0 && side * 4 < c.length, 'side-eye is rare').toBe(true);
  });

  test.each([...AgentState.allCases])('onlyInIdleAndNoticing(%s)', (st) => {
    const beats = simulate({ seed: 7, state: st, seconds: 600 });
    if (st === 'idle' || st === 'noticing') {
      expect(beats.length).toBeGreaterThan(0);
    } else {
      expect(beats, st).toEqual([]);
    }
  });

  test('disabledProducesNothing', () => {
    const rec = new ASTRecorder();
    const ib = new IdleBeats();
    ib.isEnabled = false;
    const rig = new ASTRig([ib, rec]);
    rig.run(600, 1 / 20);
    expect(rec.requests).toEqual([]);
  });

  test('defersWhileAnotherOneShotPlays', () => {
    const probe = new ASTOneShotProbe();
    probe.active = ['laugh'];
    const beats = simulate({ seed: 8, seconds: 600, probe });
    expect(beats).toEqual([]);
  });

  test('reentryRespectsSpacing', () => {
    const rec = new ASTRecorder();
    const rig = new ASTRig([new IdleBeats(), rec], 9);
    // Bounce between idle and listening; beats must stay ≥ 20 s apart and only fire while idle.
    for (let i = 0; i < 400; i++) {
      rig.state.agentState = i % 3 === 0 ? 'listening' : 'idle';
      const st = rig.state.agentState;
      const before = rec.requests.length;
      rig.run(7, 1 / 20);
      if (st === 'listening') expect(rec.requests.length).toBe(before);
    }
    for (const [a, b] of pairs(rec.requests)) expect(b.time - a.time).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(rec.requests.length).toBeGreaterThan(0);
  });
});
