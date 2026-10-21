// Port of Tests/FaceEngineTests/PupilBehaviourTests.swift.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import {
  AgentState, Composer, FaceCommand, FaceEngine, FaceState, IdleBeats, Mood, OneShotApply, OneShotChannels,
  OneShotKind, OneShotLibrary, OneShotOutput, OneShotParams, OneShotSampler, Pupils, isModifierRegistered,
  makePersonTarget, missingModifiers,
} from '../../src/engine';
import { ExpressionLibrary, ParamLayout } from '../../src/model';
import { Brightness } from '../../src/engine/modifiers/Brightness';
import { LidsHarness } from './harness';
import { VocalRig } from './VocalRig';

const f = Math.fround;

/// Dilation, one-shot pupil accents, brightness dimming and whole-stack pupil safety.
describe('PupilBehaviour', () => {
  // MARK: Dilation (H4)

  function dilationRig(mood: Mood): { p: Pupils; h: LidsHarness } {
    const p = new Pupils();
    const h = new LidsHarness([p], 120);
    h.s.mood = mood;
    return { p, h };
  }

  test('dilationDirection', () => {
    const neutral = Pupils.target(Mood.make(0, 0, 0));
    expect(Math.abs(neutral - 1)).toBeLessThan(1e-6);
    const happy = Pupils.target(Mood.make(0.8, 0.4, 0.3));
    expect(happy > 1.15 && happy < 1.25, `${happy}`).toBe(true);
    const threat = Pupils.target(Mood.make(-0.5, 0.9, -0.7));
    expect(threat, `${threat}`).toBeLessThan(0.6);
    // Aroused but in control: no threat, a little interest.
    expect(Pupils.target(Mood.make(0, 0.9, 0.5))).toBeGreaterThan(1.05);
    expect(Number.isFinite(Pupils.target(Mood.make(NaN, Infinity, 0)))).toBe(true);
  });

  test('dilationFeedsPupilSizeMulAndComposer', () => {
    const { p, h } = dilationRig(Mood.make(0.9, 0.3, 0.4));
    h.run(3);
    expect(p.level).toBeGreaterThan(1.15);
    expect(Math.abs(h.s.pupilSizeMul.x - p.level)).toBeLessThan(1e-6);
    expect(h.s.output.pose.eye('left', 'size')).toBeGreaterThan(h.s.basePose.eye('left', 'size') * 1.15);
  });

  test('constrictsFastDilatesSlowly', () => {
    const halfTime = (to: Mood): number => {
      const { p, h } = dilationRig(Mood.make(0, 0, 0));
      h.run(1);
      h.s.mood = to;
      const goal = Pupils.target(to);
      let t = 0;
      while (Math.abs(p.level - 1) < Math.abs(goal - 1) * 0.5 && t < 5) { h.step(); t += h.dt; }
      return t;
    };
    const constrict = halfTime(Mood.make(-0.5, 0.9, -0.7));
    const dilate = halfTime(Mood.make(1, 0.5, 0.5));
    // ω 14 vs ω 4 (critically damped half-time ≈ 1.68/ω): ≈ 0.12 s vs 0.42 s.
    expect(constrict, `${constrict}`).toBeLessThan(0.16);
    expect(dilate, `${dilate}`).toBeGreaterThan(0.33);
    expect(constrict * 2.5).toBeLessThan(dilate);
  });

  test('dilationMatchesAt60And120Fps', () => {
    const a = new Pupils(), b = new Pupils();
    const ha = new LidsHarness([a], 60), hb = new LidsHarness([b], 120);
    const moods = [Mood.make(0.9, 0.3, 0.4), Mood.make(-0.5, 0.9, -0.7), Mood.playful];
    ha.s.mood = moods[0]; hb.s.mood = moods[0];
    for (let i = 0; i < 60 * 6; i++) {
      // The new mood is first seen on the frame at (i + 1)/60 s at both rates.
      hb.step();
      if (i % 120 === 0) { ha.s.mood = moods[(i / 120) % 3]; hb.s.mood = moods[(i / 120) % 3]; }
      ha.step(); hb.step();
      expect(Math.abs(a.level - b.level)).toBeLessThan(1e-4);
    }
  });

  // MARK: One-shot accents (H7)

  function samples(kind: OneShotKind, step = 0.005): { t: number; o: OneShotOutput }[] {
    const d = OneShotLibrary.spec(kind).duration;
    const out: { t: number; o: OneShotOutput }[] = [];
    // Swift `stride(from: Float(0), through: d, by: step)`: start + i × step in Float.
    for (let i = 0; f(i * f(step)) <= d; i++) {
      const t = f(i * f(step));
      out.push({ t, o: OneShotLibrary.sample(kind, t, new OneShotParams()) });
    }
    return out;
  }

  test('crossEyedConvergesInwardAndReturnsToZero', () => {
    const s = samples('crossEyed');
    let peak = 0, peakT = 0;
    for (const { t, o } of s) {
      const l = o.delta.eye('left', 'x'), r = o.delta.eye('right', 'x');
      expect(Math.abs(l + r), 'symmetric').toBeLessThan(1e-6);
      if (l > peak) { peak = l; peakT = t; }
    }
    // Inward (left +x, right −x) to ±0.75 with a ζ≈0.5 overshoot, peaking around 0.25 s.
    expect(peak > 0.8 && peak < 0.95, `peak ${peak}`).toBe(true);
    expect(Math.abs(peakT - 0.25), `peak at ${peakT}`).toBeLessThan(0.04);
    // Held with a wobble in the middle.
    const held = s.filter((x) => x.t > 0.35 && x.t < 0.55).map((x) => x.o.delta.eye('left', 'x'));
    expect(Math.max(...held) - Math.min(...held)).toBeGreaterThan(0.03);
    expect(held.every((v) => Math.abs(v - 0.75) < 0.12)).toBe(true);
    // Release overshoots outward a little, then exactly zero at the end.
    expect(Math.min(0, ...s.filter((x) => x.t > 0.65).map((x) => x.o.delta.eye('left', 'x')))).toBeLessThan(-0.02);
    const end = OneShotLibrary.sample('crossEyed', OneShotLibrary.spec('crossEyed').duration, new OneShotParams());
    for (const side of ParamLayout.Side.allCases) {
      for (const q of ParamLayout.Pupil.allCases) expect(end.delta.eye(side, q)).toBe(0);
    }
    expect(OneShotLibrary.spec('crossEyed').channels & OneShotChannels.pupils).not.toBe(0);
    expect(OneShotLibrary.spec('crossEyed').accentTimes).toEqual([0.25]);
  });

  test('crossEyedThroughTheEngineReturnsToRest', () => {
    const engine = new FaceEngine({ seed: 9 });
    for (let i = 0; i < 120; i++) engine.tick(1.0 / 120);
    engine.send(FaceCommand.playOneShot('crossEyed'));
    let maxInward = 0;
    for (let i = 0; i < 120; i++) {
      engine.tick(1.0 / 120);
      const p = engine.state.output.pose;
      maxInward = Math.max(maxInward, (p.eye('left', 'x') - p.eye('right', 'x')) / 2);
    }
    expect(maxInward, `${maxInward}`).toBeGreaterThan(0.6);
    expect(engine.state.oneShot.delta.eye('left', 'x')).toBe(0);
  });

  test('bigSurpriseShrinksPupilsToDots', () => {
    const s = samples('bigSurprise');
    const minMul = Math.min(1, ...s.map((x) => x.o.pupilSizeMul.x));
    const minT = s.find((x) => x.o.pupilSizeMul.x === minMul)?.t ?? 0;
    expect(minMul < 0.65 && minMul > 0.55, `${minMul}`).toBe(true);
    expect(Math.abs(minT - 0.19), `dots at the pop: ${minT}`).toBeLessThan(0.03);
    expect(OneShotLibrary.sample('bigSurprise', 1.2, new OneShotParams()).pupilSizeMul).toEqual({ x: 1, y: 1 });
  });

  test('delightedSquintDilates', () => {
    const maxMul = Math.max(1, ...samples('delightedSquint').map((x) => x.o.pupilSizeMul.x));
    expect(Math.abs(maxMul - 1.15), `${maxMul}`).toBeLessThan(0.01);
  });

  test('oneShotPupilSizeReachesTheFrame', () => {
    const h = new LidsHarness([new OneShotSampler(), new OneShotApply()], 120);
    h.s.commands.push(FaceCommand.playOneShot('bigSurprise'));
    let minMul = 1;
    h.run(1.4, (h) => { minMul = Math.min(minMul, h.s.pupilSizeMul.x); });
    expect(minMul).toBeLessThan(0.65);
    expect(h.s.pupilSizeMul).toEqual({ x: 1, y: 1 });
  });

  // needs WP6 (IdleBeats)
  test.skipIf(!isModifierRegistered('IdleBeats'))('idleBeatsCrossEyedOnlyInPlayfulMoods', { timeout: 30_000 }, () => {
    const beats = (mood: Mood): Set<OneShotKind> => {
      const seen = new Set<OneShotKind>();
      for (let seed = 1; seed <= 12; seed++) {
        const h = new LidsHarness([new IdleBeats()], 30, seed);
        h.s.mood = mood;
        h.run(400, (h) => {
          for (const k of h.s.oneShotRequests) seen.add(k);
          h.s.oneShotRequests.length = 0;
        });
      }
      return seen;
    };
    expect(beats(Mood.make(0.6, 0.5, 0.1)).has('crossEyed')).toBe(true);
    expect(beats(Mood.make(0.6, 0.1, 0.1)).has('crossEyed')).toBe(false);
    expect(beats(Mood.playful).has('crossEyed')).toBe(false);
  });

  // MARK: VocalSync

  test('startleShrinksPupilsWidenDoesNotDilate', () => {
    const rig = new VocalRig();
    rig.cue(0.05, { duration: 0.3, intensity: 0.9, kind: 'startle' });
    let minMul = 1, maxMul = 0;
    rig.run(0.6, () => { minMul = Math.min(minMul, rig.s.pupilSizeMul.x); maxMul = Math.max(maxMul, rig.s.pupilSizeMul.x); });
    expect(minMul < 0.88 && minMul > 0.8, `${minMul}`).toBe(true);
    expect(maxMul).toBeLessThanOrEqual(1.0001);
    rig.run(1);
    expect(Math.abs(rig.s.pupilSizeMul.x - 1)).toBeLessThan(1e-3);
    // Curious widens the eyes but leaves the pupils alone.
    const c = new VocalRig();
    c.cue(0.05, { duration: 0.3, kind: 'curious' });
    c.run(0.6, () => { expect(c.s.pupilSizeMul.x).toBe(1); });
  });

  // MARK: Brightness (H8)

  test('idleDimsAfterTwentyEmptySecondsAndRestores', () => {
    const b = new Brightness();
    const h = new LidsHarness([b], 60);
    h.s.agentState = 'idle';
    h.s.targetBrightness = 0.85;
    h.run(19.5);
    expect(Math.abs(b.level - 0.85), 'no dim before 20 s').toBeLessThan(1e-4);
    h.run(12);
    expect(Math.abs(b.level - 0.6), `${b.level}`).toBeLessThan(0.01);
    // Someone appears: restore smoothly.
    h.s.people = [makePersonTarget(1, { x: 0, y: 0 })];
    let prev = b.level, maxStep = 0;
    h.run(10, () => { maxStep = Math.max(maxStep, Math.abs(b.level - prev)); prev = b.level; });
    expect(Math.abs(b.level - 0.85)).toBeLessThan(0.01);
    expect(maxStep, `smooth restore ${maxStep}`).toBeLessThan(0.005);
    // Engaged (or anything but idle) never dims, even with nobody visible.
    const b2 = new Brightness();
    const h2 = new LidsHarness([b2], 60);
    h2.s.agentState = 'engaged';
    h2.s.targetBrightness = 0.85;
    h2.run(40);
    expect(Math.abs(b2.level - 0.85)).toBeLessThan(1e-4);
    // Leaving idle restores too.
    h.s.people = [];
    h.run(30);
    expect(b.level).toBeLessThan(0.62);
    h.s.agentState = 'noticing';
    h.run(10);
    expect(Math.abs(b.level - 0.85)).toBeLessThan(0.01);
  });

  // MARK: Whole stack

  // needs WP6 (full default stack)
  test.skipIf(missingModifiers().length > 0)('pupilsNeverNonFiniteAndWithinRanges', () => {
    const engine = new FaceEngine({ seed: 31 });
    const rng = new SplitMix64(5);
    let t = 0, next = 1;
    while (t < 90) {
      const dt = rng.uniform(0.006, 0.04);
      t += dt;
      if (t > next) {
        next = t + rng.uniform(0.4, 3);
        switch (Math.trunc(rng.unit() * 5)) {
          case 0: engine.setAgentState(AgentState.allCases[Math.trunc(rng.unit() * AgentState.allCases.length) % AgentState.allCases.length]); break;
          case 1: engine.send(FaceCommand.playOneShot(OneShotKind.allCases[Math.trunc(rng.unit() * OneShotKind.count) % OneShotKind.count])); break;
          case 2: engine.setMood(Mood.make(rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))); break;
          case 3: {
            const n = Math.trunc(rng.unit() * 3);
            const people = Array.from({ length: n }, (_, i) =>
              makePersonTarget(i, { x: rng.uniform(-1.3, 1.3), y: rng.uniform(-1, 1) }, rng.uniform(0.1, 4)));
            engine.setPeople(people, n > 0 ? 0 : null);
            break;
          }
          default: engine.setCameraOffset({ x: rng.uniform(-0.2, 0.2), y: rng.uniform(-0.2, 0.2) });
        }
      }
      const fr = engine.tick(dt);
      for (const side of ParamLayout.Side.allCases) {
        for (const q of ParamLayout.Pupil.allCases) {
          const v = fr.pose.eye(side, q);
          const r = ParamLayout.Pupil.range(q);
          expect(Number.isFinite(v)).toBe(true);
          expect(v >= r.lowerBound && v <= r.upperBound, `${side}.${q} = ${v}`).toBe(true);
        }
      }
      expect(engine.state.delta.hasNonFinite).toBe(false);
      if (fr.pose.hasNonFinite) return;
    }
  });

  // needs WP6 (full default stack)
  test.skipIf(missingModifiers().length > 0)('pupilsNeverStill', () => {
    const engine = new FaceEngine({ seed: 13 });
    for (let i = 0; i < 120; i++) engine.tick(1.0 / 60);
    let prev = engine.tick(1.0 / 60).pose.copy();
    let still = 0;
    for (let i = 0; i < 600; i++) {
      const p = engine.tick(1.0 / 60).pose.copy();
      if (p.eye('left', 'x') === prev.eye('left', 'x') && p.eye('left', 'y') === prev.eye('left', 'y')) still += 1;
      if (p.eye('right', 'x') === prev.eye('right', 'x') && p.eye('right', 'y') === prev.eye('right', 'y')) still += 1;
      prev = p;
    }
    expect(still).toBe(0);
  });

  test('pupilSaccadeRequestsHighFrameRate', () => {
    const s = new FaceState(ExpressionLibrary.bundled(), 1);
    s.dt = 1.0 / 60;
    s.time = 10;
    Composer.compose(s);
    expect(s.output.wantsHighFrameRate).toBe(false);
    // A pupil jump of 0.2 normalised in one frame ≈ 0.8 canvas units / (1/60 s) = 48 units/s > 30.
    s.delta.setEye('left', 'x', 0.2);
    Composer.compose(s);
    expect(s.output.wantsHighFrameRate).toBe(true);
  });
});
