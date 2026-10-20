// Controller-only parity for the life-* fixtures. The controller's outputs do depend on the face: waking → noticing /
// idle is AgentStateBehavior's auto-transition, tap wakes come from TouchReactions, the sleepy sink roll from EdgeAntics
// (and the engine RNG), the catch-yourself end from the catchSelf one-shot (its rate comes from the drowsy modulation). So this runs the engine-core stack
// (OneShotSampler + OneShotApply, deterministic whatever else is registered) and compares the controller's fields and
// agent state only up to the first frame where one of those modifiers changes them. The full comparison is the
// scenarios test, once every modifier is registered.
import { describe, expect, test } from 'vitest';
import { goldenNames, lifeFields, runGolden } from './harness';
import { curvePorted } from '../engine/ported';

const core = ['OneShotSampler', 'OneShotApply'];
const fields = ['f', 'agentState', ...lifeFields];

/// Frames compared per scenario, and what the face does at the cut-off.
const horizons: Record<string, { frames: number; why: string; needs?: Parameters<typeof curvePorted>[0] }> = {
  'life-sleep-wake': { frames: 2894, why: 'waking → noticing (AgentStateBehavior) at frame 2894' },
  'life-catch-self': { frames: 1278, why: 'the catchSelf playback rate (drowsy modulation) ends it at frame 1278', needs: 'catchSelf' },
  'life-bedtime': { frames: 2400, why: 'taps (TouchReactions) from frame 2400' },
  'life-force': { frames: 849, why: 'waking → idle (AgentStateBehavior) at frame 849' },
};

describe('golden life controller (core modifiers)', () => {
  test('every life fixture has a horizon', () => {
    expect(goldenNames().filter((n) => n.startsWith('life-')).sort()).toEqual(Object.keys(horizons).sort());
  });
  for (const [name, h] of Object.entries(horizons)) {
    const t = h.needs && !curvePorted(h.needs) ? test.skip : test;
    t(`${name} (frames 0..<${h.frames}: ${h.why})`, () => {
      const r = runGolden(name, { modifiers: core, fields, maxFrames: h.frames });
      expect(r.report).toBe('');
      expect(r.framesCompared).toBe(h.frames);
    });
  }
});
