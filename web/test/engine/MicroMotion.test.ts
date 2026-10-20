// Port of Tests/FaceEngineTests/MicroMotionTests.swift.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import type { V2 } from '../../src/core/vec';
import { FaceCommand, GazeLoopNoise, makeGazeOverride, makePersonTarget, type GazeIntent, type PersonTarget } from '../../src/engine';
import { ParamLayout, Units } from '../../src/model';
import { GazeRig, eq, len2, sub } from './GazeRig';

/// Lanes the three gaze modifiers write.
const gazeLanes: number[] = [
  ParamLayout.index('centerX'), ParamLayout.index('centerY'), ParamLayout.index('angle'),
  ParamLayout.index('left', 'centerX'), ParamLayout.index('left', 'centerY'),
  ParamLayout.index('right', 'centerX'), ParamLayout.index('right', 'centerY'),
  ParamLayout.index('left', 'x'), ParamLayout.index('left', 'y'),
  ParamLayout.index('right', 'x'), ParamLayout.index('right', 'y'),
];

const copy = (v: V2): V2 => ({ x: v.x, y: v.y });
const allFinite = (a: ArrayLike<number>): boolean => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

describe('MicroMotion', () => {
  test('neverStillWhileHolding', () => {
    const rig = new GazeRig({ seed: 40 });
    rig.intent = { kind: 'rest', at: { x: 0, y: 0.3 } };
    rig.run(1);
    let prev = rig.s.delta.raw.slice();
    let frozen = 0;
    rig.run(10, (r) => {
      let moved = false;
      for (const i of gazeLanes) if (Math.abs(r.s.delta.raw[i] - prev[i]) > 1e-6) moved = true;
      if (!moved) frozen += 1;
      prev = r.s.delta.raw.slice();
    });
    expect(frozen).toBe(0);
  });

  test('driftIsSubtleAndBounded', () => {
    // MicroMotion alone, fixation held still by the attention stack being disabled.
    const rig = new GazeRig({ seed: 41 });
    rig.attention.isEnabled = false;
    rig.tracking.isEnabled = false;
    let maxHead = 0, maxPupil = 0, maxShape = 0, maxOwn = 0;
    rig.run(60, (r) => {
      const d = r.s.delta;
      maxHead = Math.max(maxHead, Math.abs(Units.canvasX(d.face('centerX'))), Math.abs(Units.canvasY(d.face('centerY'))));
      maxPupil = Math.max(maxPupil, Math.abs(d.eye('left', 'x')), Math.abs(d.eye('left', 'y')));
      maxShape = Math.max(maxShape, Math.abs(d.eye('left', 'centerX')), Math.abs(d.eye('left', 'centerY')));
      // Per-eye (non-conjugate) part: half the left/right difference.
      maxOwn = Math.max(maxOwn, Math.abs(d.eye('left', 'x') - d.eye('right', 'x')) / 2,
        Math.abs(d.eye('left', 'y') - d.eye('right', 'y')) / 2);
    });
    expect(maxHead > 0.05 && maxHead < 0.6).toBe(true);
    // Fixational drift + micro-saccades live on the pupils (normalised): ±0.04 shared, ≤0.08 hops.
    expect(maxPupil > 0.01 && maxPupil < 0.14, `${maxPupil}`).toBe(true);
    expect(maxOwn > 0.001 && maxOwn <= 0.0101, `per-eye drift ${maxOwn}`).toBe(true);
    expect(maxShape).toBe(0);
  });

  test('microSaccadesOccurAndAreSmallAndQuick', () => {
    const rig = new GazeRig({ seed: 42 });
    rig.attention.isEnabled = false;
    rig.tracking.isEnabled = false;
    let events = 0, prevTarget: V2 = { x: 0, y: 0 };
    let maxOffset = 0;
    rig.run(30, (r) => {
      const t = copy(r.micro.debugMicroTarget);
      if (!eq(t, prevTarget)) events += 1;
      prevTarget = t;
      maxOffset = Math.max(maxOffset, len2(r.micro.debugMicroValue));
    });
    // Every 0.6–2 s → about 15–50 in 30 s.
    expect(events >= 15 && events <= 50, `${events}`).toBe(true);
    expect(maxOffset).toBeLessThanOrEqual(0.08 * 1.15);
    // Quick: the hop is ~90 % done within 50 ms.
    const r2 = new GazeRig({ seed: 43 });
    r2.attention.isEnabled = false;
    r2.tracking.isEnabled = false;
    let last = copy(r2.micro.debugMicroTarget);
    let checked = false;
    for (let i = 0; i < 120 * 10 && !checked; i++) {
      r2.step(1 / 120);
      const t = copy(r2.micro.debugMicroTarget);
      if (!eq(t, last)) {
        const from = copy(r2.micro.debugMicroValue);
        for (let j = 0; j < 6; j++) r2.step(1 / 120);
        const done = len2(sub(r2.micro.debugMicroValue, from)) / Math.max(len2(sub(t, from)), 1e-6);
        expect(done, `${done}`).toBeGreaterThan(0.85);
        checked = true;
      }
      last = t;
    }
    expect(checked).toBe(true);
  });

  test('microSaccadesDeferredDuringBigSaccades', () => {
    const rig = new GazeRig({ seed: 44 });
    let prev = copy(rig.micro.debugMicroTarget);
    let flips = 1;
    rig.run(20, (r) => {
      flips = -flips;
      // Keep the stack in constant big saccades.
      r.override = makeGazeOverride({ x: 0.9 * flips, y: 0 }, 'saccade');
      const t = copy(r.micro.debugMicroTarget);
      expect(eq(t, prev) || !r.s.isSaccading).toBe(true);
      prev = t;
    });
  });

  test('loopNoiseIsContinuousAcrossWrap', () => {
    const n = new GazeLoopNoise(7, 2, GazeLoopNoise.period - 2);
    let prev = n.sample();
    for (let i = 0; i < 120 * 4; i++) {
      n.advance(1 / 120);
      const v = n.sample();
      expect(Math.abs(v - prev)).toBeLessThan(0.08);
      prev = v;
    }
    expect(n.phase).toBeLessThan(GazeLoopNoise.period);
  });

  // MARK: Whole gaze stack

  test('soakNoNaNWithRandomDt', () => {
    const rig = new GazeRig({ seed: 50 });
    const rng = new SplitMix64(77);
    const intents: GazeIntent[] = [{ kind: 'idle' }, { kind: 'track' }, { kind: 'thinking' }, { kind: 'rest', at: { x: 0, y: 0.5 } },
      { kind: 'lookAway' }, { kind: 'track' }];
    let t = 0, nextEvent = 0;
    while (t < 60) {
      const dt = rng.uniform(0.008, 0.034);
      t += dt;
      if (t > nextEvent) {
        nextEvent = t + rng.uniform(0.3, 3);
        switch (Math.trunc(rng.unit() * 7)) {
          case 0: rig.intent = intents[Math.trunc(rng.unit() * intents.length) % intents.length]; break;
          case 1: rig.send(FaceCommand.glance({ x: rng.uniform(-1.5, 1.5), y: rng.uniform(-1.5, 1.5) }, rng.uniform(-1, 2))); break;
          case 2: rig.send(FaceCommand.stimulus({ x: rng.uniform(-1, 1), y: rng.uniform(-1, 1) }, rng.uniform(-0.5, 1.5))); break;
          case 3: rig.send(FaceCommand.restGaze({ x: rng.uniform(-1, 1), y: rng.uniform(-1, 1) })); break;
          case 4: rig.override = rig.override === null ? makeGazeOverride({ x: rng.uniform(-1, 1), y: 0.3 }, 'smooth') : null; break;
          case 5: {
            const n = Math.trunc(rng.unit() * 4);
            const people: PersonTarget[] = [];
            for (let i = 0; i < n; i++) {
              people.push(makePersonTarget(i, { x: rng.uniform(-1.2, 1.2), y: rng.uniform(-1, 1) }, rng.uniform(0, 4), rng.unit()));
            }
            rig.setPeople(people, n > 0 && rng.chance(0.7) ? Math.trunc(rng.unit() * n) : null);
            break;
          }
          default:
            rig.s.modulation.glanceRate = rng.uniform(0, 3);
            rig.s.modulation.bounciness = rng.uniform(0, 1);
            rig.s.modulation.speed = rng.uniform(0.5, 1.5);
        }
      }
      rig.step(dt);
      expect(rig.s.delta.hasNonFinite).toBe(false);
      expect(Number.isFinite(rig.s.eyeGaze.x) && Number.isFinite(rig.s.eyeGaze.y)).toBe(true);
      expect(Number.isFinite(rig.s.eyeScaleMul.x) && Number.isFinite(rig.s.lidCoverage.x)).toBe(true);
      if (rig.s.delta.hasNonFinite) break;
    }
  });

  test('nanInputsAreIgnored', () => {
    const rig = new GazeRig({ seed: 51 });
    rig.intent = { kind: 'track' };
    rig.setPeople([makePersonTarget(1, { x: NaN, y: 0.2 }, NaN, NaN)], 1);
    rig.send(FaceCommand.glance({ x: Infinity, y: 0 }, NaN));
    rig.send(FaceCommand.stimulus({ x: NaN, y: NaN }, NaN));
    rig.run(3, (r) => { expect(r.s.delta.hasNonFinite).toBe(false); });
  });

  /// Runs a scripted scenario and samples on the 60 fps grid.
  function scenario(fps: number, start: number, seconds = 24): { gaze: V2; delta: Float64Array | number[] }[] {
    const rig = new GazeRig({ seed: 1234, startTime: start });
    const per = Math.trunc(fps / 60);
    const out: { gaze: V2; delta: Float64Array | number[] }[] = [];
    const frames = Math.trunc(seconds * fps);
    const t0 = rig.s.time;
    const sent = new Set<number>();
    // Swift's dt is a Float: Float(1/fps) adds exactly onto a Double clock even at 1e6 s, so both rates hit identical times.
    const dt = Math.fround(1 / fps);
    const at = (sec: number, id: number, body: () => void): void => {
      if (rig.s.time - t0 >= sec - 1e-6 && !sent.has(id)) { sent.add(id); body(); }
    };
    for (let i = 0; i < frames; i++) {
      // Commands are queued for the frame whose time first reaches the scripted second.
      const next = rig.s.time + dt;
      const saved = rig.s.time;
      rig.s.time = next;
      at(5, 1, () => rig.send(FaceCommand.glance({ x: -0.7, y: 0.2 }, 0.5)));
      at(9, 2, () => rig.send(FaceCommand.stimulus({ x: 0.6, y: -0.4 }, 0.9)));
      at(13, 3, () => { rig.intent = { kind: 'thinking' }; });
      at(17, 4, () => { rig.intent = { kind: 'rest', at: { x: 0.1, y: 0.5 } }; });
      at(20, 5, () => { rig.override = makeGazeOverride({ x: 0.8, y: 0 }, 'saccade'); });
      at(21, 6, () => { rig.override = null; rig.intent = { kind: 'idle' }; });
      rig.s.time = saved;
      rig.step(dt);
      if ((i + 1) % per === 0) out.push({ gaze: copy(rig.s.eyeGaze), delta: rig.s.delta.raw.slice() });
    }
    return out;
  }

  function compare60vs120(start: number): void {
    const a = scenario(60, start), b = scenario(120, start);
    expect(a.length).toBe(b.length);
    let maxGaze = 0;
    const maxLane = new Array<number>(ParamLayout.count).fill(0);
    for (let k = 0; k < Math.min(a.length, b.length); k++) {
      const x = a[k], y = b[k];
      maxGaze = Math.max(maxGaze, len2(sub(x.gaze, y.gaze)));
      for (const i of gazeLanes) maxLane[i] = Math.max(maxLane[i], Math.abs(x.delta[i] - y.delta[i]));
    }
    // Tolerance: 1e-3 of each parameter's soft range (positions ±200 → 0.4, angle ±90 → 0.18).
    for (const i of gazeLanes) {
      const r = ParamLayout.ranges[i];
      expect(maxLane[i], `${ParamLayout.names[i]} diff ${maxLane[i]}`).toBeLessThan(1e-3 * (r.upperBound - r.lowerBound));
    }
    expect(maxGaze, `gaze diff ${maxGaze}`).toBeLessThan(2e-3);
  }

  test('equivalence60vs120', () => { compare60vs120(0); });

  test('equivalence60vs120AtLongUptime', () => { compare60vs120(1_000_000); });

  test('worksFromMillionSeconds', () => {
    const rig = new GazeRig({ seed: 60, startTime: 1_000_000 });
    let moves = 0, last = copy(rig.s.gazeTarget.point);
    let prev = rig.s.delta.raw.slice();
    let frozen = 0;
    rig.run(30, (r) => {
      if (len2(sub(r.s.gazeTarget.point, last)) > 0.01) moves += 1;
      last = copy(r.s.gazeTarget.point);
      let moved = false;
      for (const i of gazeLanes) if (Math.abs(r.s.delta.raw[i] - prev[i]) > 1e-6) moved = true;
      if (!moved) frozen += 1;
      prev = r.s.delta.raw.slice();
      expect(allFinite(r.s.delta.raw)).toBe(true);
    });
    expect(moves).toBeGreaterThan(10);
    expect(frozen).toBe(0);
  });
});
