// The Pupil reactions section's cue simulator: the cue it builds and the arbiter's accept / reject reason it shows.
import { describe, expect, test } from 'vitest';
import { TuningModel, simulatedCue } from '../../src/preview/TuningModel';
import { makeContext } from './support';

const fields = { cueKind: 'delight' as const, cueConfidence: 0.9, cueSource: 'debug' as const, cueDirected: true, cueValence: 0.4,
  cueKey: '', cueAge: 0 };

describe('simulatedCue', () => {
  test('carries the fields; age 0 is now', () => {
    const c = simulatedCue(fields, 100);
    expect(c).toMatchObject({ kind: 'delight', confidence: 0.9, source: 'debug', directedAtYanni: true, valence: 0.4, hostTime: null, key: '' });
  });

  test('an age back-dates it on the display-link clock (none known yet: now)', () => {
    expect(simulatedCue({ ...fields, cueAge: 2 }, 100).hostTime).toBe(98);
    expect(simulatedCue({ ...fields, cueAge: 2 }, null).hostTime).toBeNull();
  });
});

describe('cue simulator through the arbiter', () => {
  function rig() {
    const ctx = makeContext();
    const m = new TuningModel(ctx);
    ctx.step(30);
    return { ctx, m, send: () => { m.sendCue(); ctx.step(2); return m.pupilReadouts(); } };
  }

  test('a confident delight is accepted (✓) and shows stars', () => {
    const { ctx, send } = rig();
    const r = send();
    expect(r.accepted).toBe(true);
    expect(r.last).toMatch(/starEyes ✓/);
    ctx.step(20);
    expect(ctx.engine.state.activeOneShots).toContain('starEyes');
  });

  test('rejections name their reason', () => {
    const low = rig();
    low.m.cueConfidence = 0.2;
    expect(low.send()).toMatchObject({ accepted: false, last: expect.stringMatching(/✗ lowConfidence/) });

    const aimed = rig();
    aimed.m.cueKind = 'affection';
    aimed.m.cueDirected = false;
    expect(aimed.send().last).toMatch(/✗ notDirected/);

    const stale = rig();
    stale.m.cueAge = 3;
    expect(stale.send().last).toMatch(/✗ stale/);

    const cooled = rig();
    expect(cooled.send().accepted).toBe(true);
    cooled.ctx.step(240);
    cooled.m.cueKind = 'curiosity';
    expect(cooled.send().last).toMatch(/✗ (globalCooldown|busy)/);
  });

  test('mark somber blocks playful cues and shows the window', () => {
    const { m, send } = rig();
    m.markSomber();
    const r = send();
    expect(r.last).toMatch(/✗ somber/);
    expect(r.somber).toMatch(/s left/);
  });

  test('read-outs: next allowed per transformation after an accepted cue', () => {
    const { send } = rig();
    const r = send();
    expect(r.next).toMatch(/^Stars \d+ s · Hearts \d+ s/);
    expect(Number(/Stars (\d+) s/.exec(r.next)![1])).toBeGreaterThan(0);
  });
});
