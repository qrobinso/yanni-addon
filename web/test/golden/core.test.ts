// Engine-core parity gate: the golden `rest-core` scenario (OneShotSampler + OneShotApply only, nothing playing).
import { expect, test } from 'vitest';
import { compareFrame, compareUntilDivergence, loadGolden, runGolden } from './harness';

test('rest-core matches the Swift engine frame for frame', () => {
  const r = runGolden('rest-core');
  expect(r.report).toBe('');
  expect(r.ok).toBe(true);
  expect(r.framesCompared).toBe(300);
});

test('compareUntilDivergence reports a clean run', () => {
  const d = compareUntilDivergence('rest-core', { maxFrames: 30 });
  expect(d.result.ok).toBe(true);
  expect(d.fields.every((f) => f.first === null)).toBe(true);
});

test('the harness reports a perturbed lane with its layout name and the recent inputs', () => {
  const g = loadGolden('rest-core');
  const saved = g.frames[7].pose;
  try {
    g.frames[7].pose = (saved as number[]).map((v, i) => (i === 18 ? v + 0.01 : v));
    const r = runGolden('rest-core');
    expect(r.ok).toBe(false);
    expect(r.framesCompared).toBe(8);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]).toMatchObject({ frame: 7, field: 'pose', index: 18, lane: 'left.upper_lid.y' });
    expect(r.report).toContain('first divergence at frame 7');
  } finally {
    g.frames[7].pose = saved;
  }
});

test('oneShots compare as sets; exact fields compare exactly', () => {
  const e = { f: 0, oneShots: ['laugh', 'dance'], isAsleep: false, pupilShape: [0, 0], brightness: 1 };
  expect(compareFrame(e, { ...e, oneShots: ['dance', 'laugh'] }, Object.keys(e))).toEqual([]);
  expect(compareFrame(e, { ...e, oneShots: ['dance'] }, Object.keys(e))).toHaveLength(1);
  expect(compareFrame(e, { ...e, isAsleep: true }, Object.keys(e))).toHaveLength(1);
  expect(compareFrame(e, { ...e, brightness: 1.0009 }, Object.keys(e))).toEqual([]);
  expect(compareFrame(e, { ...e, brightness: 1.002 }, Object.keys(e))).toHaveLength(1);
});
