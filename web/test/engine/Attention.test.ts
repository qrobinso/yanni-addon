// Port of Tests/FaceEngineTests/AttentionTests.swift.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import type { V2 } from '../../src/core/vec';
import { FaceCommand, makeGazeOverride, makePersonTarget } from '../../src/engine';
import { GazeRig, eq, len2, sub } from './GazeRig';

const P = (id: number, x: number, y: number, salience = 0.5) => makePersonTarget(id, { x, y }, 1.5, salience);

describe('Attention', () => {
  // MARK: Idle

  test('idleFixationProcess', () => {
    const rig = new GazeRig({ seed: 11 });
    let changes = 0, glances = 0, drifts = 0;
    let last = { ...rig.s.gazeTarget.point };
    let lastChangeT = 0, t = 0;
    const intervals: number[] = [];
    let outOfBounds = 0;
    rig.run(120, (r) => {
      t += 1.0 / 120;
      const g = r.s.gazeTarget;
      if (!(Math.abs(g.point.x) <= 0.91 && Math.abs(g.point.y) <= 0.51)) outOfBounds++;
      if (g.mode === 'saccade' && len2(sub(g.point, last)) > 0.01) {
        changes++;
        if (len2(sub(g.point, last)) > 0.3) glances++;
        intervals.push(t - lastChangeT);
        lastChangeT = t;
      }
      if (g.mode === 'smooth' && len2(g.velocity) > 0.01 && len2(sub(g.point, last)) > 0) drifts++;
      last = { ...g.point };
    });
    expect(outOfBounds).toBe(0);
    // ~1.2 s median fixation → roughly 60–120 moves in two minutes.
    expect(changes > 50 && changes < 140, `${changes}`).toBe(true);
    expect(glances, `${glances}`).toBeGreaterThan(5);
    expect(drifts, 'expected occasional slow drifts').toBeGreaterThan(0);
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median > 0.6 && median < 2.0, `median ${median}`).toBe(true);
    // Not a loop: consecutive intervals (quantised to 1/60 s) rarely coincide.
    let same = 0;
    for (let i = 1; i < intervals.length; i++) if (Math.abs(intervals[i] - intervals[i - 1]) < 1e-6) same++;
    expect(same * 10 < intervals.length, `${same} repeats`).toBe(true);
  });

  test('glanceRateScalesFixations', () => {
    const moves = (rate: number): number => {
      const rig = new GazeRig({ seed: 4, micro: false });
      let n = 0;
      let last = { ...rig.s.gazeTarget.point };
      rig.run(60, (r) => {
        r.s.modulation.glanceRate = rate;
        if (len2(sub(r.s.gazeTarget.point, last)) > 0.01 && r.s.gazeTarget.mode === 'saccade') n++;
        last = { ...r.s.gazeTarget.point };
      });
      return n;
    };
    expect(moves(2)).toBeGreaterThan(moves(0.5) * 2);
  });

  test('thinkingLooksUpAndAside', () => {
    const rig = new GazeRig({ seed: 2 });
    rig.intent = { kind: 'thinking' };
    rig.run(1);
    const sides = new Set<number>();
    let bad = 0;
    rig.run(40, (r) => {
      const p = r.s.gazeTarget.point;
      if (!(p.y < -0.25) || !(Math.abs(p.x) > 0.25)) bad++;
      sides.add(p.x > 0 ? 1 : -1);
    });
    expect(bad).toBe(0);
    expect(rig.s.eyeGaze.y).toBeLessThan(-0.2);
    expect(sides.size, 'occasionally switches side').toBe(2);
  });

  test('restHoldsWithTinyDrift', () => {
    const rig = new GazeRig({ seed: 3 });
    const p: V2 = { x: 0.1, y: 0.6 };
    rig.intent = { kind: 'rest', at: p };
    rig.run(1);
    let moved = false, bad = 0;
    const first = { ...rig.s.gazeTarget.point };
    rig.run(20, (r) => {
      if (!(len2(sub(r.s.gazeTarget.point, p)) < 0.06)) bad++;
      if (len2(sub(r.s.gazeTarget.point, first)) > 0.005) moved = true;
    });
    expect(bad).toBe(0);
    expect(moved).toBe(true);
    expect(len2(sub(rig.s.eyeGaze, p))).toBeLessThan(0.08);
  });

  test('lookAwayAvoidsPrimary', () => {
    for (const [px, sign] of [[0.6, -1], [-0.6, 1]]) {
      const rig = new GazeRig({ seed: 5 });
      rig.setPeople([P(7, px, 0)], 7);
      rig.intent = { kind: 'track' };
      rig.run(1);
      rig.intent = { kind: 'lookAway' };
      rig.run(0.5);
      let bad = 0;
      rig.run(5, (r) => {
        if (!(r.s.gazeTarget.point.x * sign > 0.4)) bad++;
        if (!(r.s.gazeTarget.point.y > 0.15)) bad++;
      });
      expect(bad, `px ${px}`).toBe(0);
    }
  });

  test('restGazeCommandHoldsUntilSomeoneAppears', () => {
    const rig = new GazeRig({ seed: 6 });
    rig.run(2);
    const exit: V2 = { x: -0.85, y: 0.1 };
    rig.send(FaceCommand.restGaze(exit));
    rig.run(0.1);
    let bad = 0;
    rig.run(8, (r) => { if (!(len2(sub(r.s.gazeTarget.point, exit)) < 0.06)) bad++; });
    expect(bad).toBe(0);
    rig.setPeople([P(1, 0.5, 0)], null);
    rig.run(1.5);
    expect(len2(sub(rig.s.gazeTarget.point, exit))).toBeGreaterThan(0.3);
  });

  // MARK: Priority

  test('overrideWinsQuickly', () => {
    const rig = new GazeRig({ seed: 8 });
    rig.run(0.3);
    const before = { ...rig.s.eyeGaze };
    const target: V2 = { x: before.x > 0 ? -0.8 : 0.8, y: 0.2 };
    rig.override = makeGazeOverride(target, 'saccade');
    rig.send(FaceCommand.glance({ x: -target.x, y: -0.3 }, 1)); // lower priority than the override
    rig.run(0.2);
    expect(len2(sub(rig.s.eyeGaze, before))).toBeGreaterThanOrEqual(0.5);
    expect(rig.s.gazeTarget.point).toEqual(target);
  });

  test('overridePausesIdleScheduling', () => {
    const rig = new GazeRig({ seed: 9 });
    rig.run(1);
    const p: V2 = { x: 0.4, y: -0.2 };
    rig.override = makeGazeOverride(p, 'saccade');
    let bad = 0;
    rig.run(5, (r) => { if (!eq(r.s.gazeTarget.point, p)) bad++; });
    expect(bad).toBe(0);
    rig.override = null;
    rig.step(1 / 120);
    const back = { ...rig.s.gazeTarget.point };
    // Returns to its own fixation and holds briefly before choosing a new one.
    rig.run(0.3, (r) => { if (!eq(r.s.gazeTarget.point, back)) bad++; });
    expect(bad).toBe(0);
  });

  test('glanceThenReturn', () => {
    const rig = new GazeRig({ seed: 12 });
    rig.intent = { kind: 'rest', at: { x: 0.2, y: 0.1 } };
    rig.run(2);
    const home = { ...rig.s.gazeTarget.point };
    const g: V2 = { x: -0.8, y: -0.1 };
    rig.send(FaceCommand.glance(g, 0.5));
    rig.run(0.1);
    expect(rig.s.gazeTarget.point).toEqual(g);
    rig.run(0.3);
    expect(len2(sub(rig.s.eyeGaze, g))).toBeLessThan(0.05);
    rig.run(0.3);
    expect(len2(sub(rig.s.gazeTarget.point, home))).toBeLessThan(0.06);
    rig.run(0.5);
    expect(len2(sub(rig.s.eyeGaze, rig.s.gazeTarget.point))).toBeLessThan(0.05);
  });

  test('glanceWithoutDurationUsesNaturalLength', () => {
    const rig = new GazeRig({ seed: 13 });
    rig.intent = { kind: 'rest', at: { x: 0, y: 0 } };
    rig.run(1);
    rig.send(FaceCommand.glance({ x: 0.7, y: 0 }, 0));
    let held = 0;
    rig.run(1.5, (r) => { if (eq(r.s.gazeTarget.point, { x: 0.7, y: 0 })) held += 1.0 / 120; });
    expect(held >= 0.39 && held <= 0.72, `${held}`).toBe(true);
  });

  test('stimulusLessLikelyWhileResting', () => {
    let reacted = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rig = new GazeRig({ seed, micro: false });
      rig.intent = { kind: 'rest', at: { x: 0, y: 0.2 } };
      rig.run(1);
      const p: V2 = { x: 0.75, y: -0.3 };
      rig.send(FaceCommand.stimulus(p, 1));
      rig.run(0.05);
      if (eq(rig.s.gazeTarget.point, p)) reacted++;
    }
    expect(reacted > 3 && reacted < 25, `${reacted}`).toBe(true);
  });

  test('strongStimulusInIdleAlwaysReactsAndDecays', () => {
    const lingers: number[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      const rig = new GazeRig({ seed });
      rig.run(1);
      const p: V2 = { x: -0.7, y: 0.4 };
      rig.send(FaceCommand.stimulus(p, 1));
      let linger = 0;
      rig.run(3, (r) => { if (eq(r.s.gazeTarget.point, p)) linger += 1.0 / 120; });
      expect(linger).toBeGreaterThan(0.5);
      expect(eq(rig.s.gazeTarget.point, p)).toBe(false); // lost interest
      lingers.push(linger);
    }
    expect(new Set(lingers.map((l) => Math.trunc(l * 100))).size, 'linger has jitter').toBeGreaterThan(3);
  });

  test('weakStimuliReactLessAndShorter', () => {
    const stats = (strength: number): { reacted: number; linger: number } => {
      let reacted = 0, total = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const rig = new GazeRig({ seed, micro: false });
        rig.run(0.2);
        const p: V2 = { x: 0.6, y: -0.4 };
        rig.send(FaceCommand.stimulus(p, strength));
        let l = 0;
        rig.run(2.5, (r) => { if (eq(r.s.gazeTarget.point, p)) l += 1.0 / 120; });
        if (l > 0) { reacted++; total += l; }
      }
      return { reacted, linger: reacted > 0 ? total / reacted : 0 };
    };
    const weak = stats(0.1), strong = stats(1);
    expect(strong.reacted).toBe(60);
    expect(weak.reacted).toBeLessThan(40);
    expect(weak.linger).toBeLessThan(strong.linger * 0.7);
  });

  // MARK: People

  test('peopleHoppingUsesOnlyPresentPeople', () => {
    const rig = new GazeRig({ seed: 21 });
    const a = P(1, -0.6, 0.0, 0.8);
    const b = P(2, 0.6, 0.1, 0.5);
    const c = P(3, 0.0, 0.85, 1.0); // outside the glance ellipse
    rig.setPeople([a, b, c], null);
    const visits = [0, 0, 0];
    rig.run(40, (r) => {
      [a, b, c].forEach((p, i) => { if (len2(sub(r.s.gazeTarget.point, p.position)) < 0.12) visits[i]++; });
    });
    expect(visits.filter((v) => v > 120).length, `visits ${visits}`).toBe(3);
    // Remove c: never looked at again.
    rig.setPeople([a, b], null);
    rig.run(0.5);
    let bad = 0;
    rig.run(40, (r) => { if (!(len2(sub(r.s.gazeTarget.point, c.position)) > 0.2)) bad++; });
    expect(bad).toBe(0);
  });

  test('salienceWeightsHops', () => {
    const rig = new GazeRig({ seed: 22, micro: false });
    const a = P(1, -0.6, 0.0, 1.0);
    const b = P(2, 0.6, 0.0, 0.0);
    const c = P(3, 0.0, 0.3, 1.0);
    rig.setPeople([a, b, c], null);
    const time = [0, 0, 0];
    rig.run(120, (r) => {
      [a, b, c].forEach((p, i) => { if (len2(sub(r.s.gazeTarget.point, p.position)) < 0.12) time[i]++; });
    });
    expect(time[0] > time[1] && time[2] > time[1], `${time}`).toBe(true);
  });

  // MARK: Track

  test('trackFollowsPrimary', () => {
    const rig = new GazeRig({ seed: 30 });
    rig.intent = { kind: 'track' };
    rig.setPeople([P(1, -0.7, 0), P(2, 0.5, 0.1)], 2);
    rig.run(1.5);
    expect(len2(sub(rig.s.eyeGaze, { x: 0.5, y: 0.1 }))).toBeLessThan(0.07);
    // Not a dead stare: the target keeps making small micro-fixations.
    const pts = new Set<number>();
    rig.run(5, (r) => { pts.add(Math.trunc(r.s.gazeTarget.point.x * 1000)); });
    expect(pts.size).toBeGreaterThan(2);
    let bad = 0;
    rig.run(5, (r) => { if (!(len2(sub(r.s.gazeTarget.point, { x: 0.5, y: 0.1 })) < 0.06)) bad++; });
    expect(bad).toBe(0);
  });

  test('trackWithoutPeopleFallsBackToIdle', () => {
    const rig = new GazeRig({ seed: 31 });
    rig.intent = { kind: 'track' };
    rig.setPeople([], 3);
    let moves = 0;
    let last = { ...rig.s.gazeTarget.point };
    rig.run(20, (r) => {
      if (len2(sub(r.s.gazeTarget.point, last)) > 0.01 && r.s.gazeTarget.mode === 'saccade') moves++;
      last = { ...r.s.gazeTarget.point };
    });
    expect(moves).toBeGreaterThan(6);
  });

  test('trackHysteresisNoSaccadeLoop', () => {
    // Person moves at 1 unit/s; perception updates at 20 Hz with ±0.01 jitter.
    const rig = new GazeRig({ seed: 32 });
    rig.intent = { kind: 'track' };
    let x = -0.8;
    rig.setPeople([P(1, x, 0)], 1);
    rig.run(1.5);
    let saccadeStarts = 0;
    let prevMode = rig.s.gazeTarget.mode;
    let wasSaccading = rig.s.isSaccading;
    let flips = 0;
    let t = 0, nextSample = 0;
    const rng = new SplitMix64(99);
    let maxErr = 0;
    rig.run(1.6, (r) => {
      t += 1.0 / 120;
      x = -0.8 + t;
      if (t >= nextSample) {
        nextSample += 0.05;
        const jx = rng.uniform(-0.01, 0.01), jy = rng.uniform(-0.01, 0.01);
        r.setPeople([P(1, x + jx, jy)], 1);
      }
      if (r.s.isSaccading && !wasSaccading) saccadeStarts++;
      wasSaccading = r.s.isSaccading;
      if (r.s.gazeTarget.mode !== prevMode) flips++;
      prevMode = r.s.gazeTarget.mode;
      if (t > 0.5) maxErr = Math.max(maxErr, Math.abs(r.s.eyeGaze.x - x));
    });
    expect(saccadeStarts, `saccades: ${saccadeStarts}`).toBeLessThanOrEqual(2);
    expect(flips, `mode flips: ${flips}`).toBeLessThanOrEqual(4);
    expect(maxErr, `pursuit lag ${maxErr}`).toBeLessThan(0.25);
  });

  test('trackJumpTriggersOneSaccade', () => {
    const rig = new GazeRig({ seed: 33 });
    rig.intent = { kind: 'track' };
    rig.setPeople([P(1, -0.5, 0)], 1);
    rig.run(1.5);
    rig.setPeople([P(1, 0.5, 0)], 1);
    let saccadeFrames = 0;
    rig.run(1.0, (r) => { if (r.s.gazeTarget.mode === 'saccade') saccadeFrames++; });
    expect(saccadeFrames).toBeGreaterThan(0);
    expect(len2(sub(rig.s.eyeGaze, { x: 0.5, y: 0 }))).toBeLessThan(0.07);
  });
});
