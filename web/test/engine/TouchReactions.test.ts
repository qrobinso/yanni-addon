// Port of Tests/FaceEngineTests/TouchReactionsTests.swift.
import { describe, expect, test } from 'vitest';
import { opening } from './harness';
import { SplitMix64 } from '../../src/core/random';
import type { V3 } from '../../src/core/vec';
import { ExpressionLibrary, type FaceFrame } from '../../src/model';
import {
  AgentStateBehavior, Director, ExpressionTransition, FaceAffect, FaceCommand, FaceEngine, FaceState, MoodPalette, Phase,
  type AgentState, type Modifier, type OneShotKind,
} from '../../src/engine';
import { MoodColor } from '../../src/engine/modifiers/MoodColor';
import { TouchReactions } from '../../src/engine/modifiers/TouchReactions';

/// Records every one-shot request made so far this frame without consuming it (register right before the sampler).
class RequestTap implements Modifier {
  readonly name = 'RequestTap';
  readonly phase = Phase.behaviour;
  isEnabled = true;
  log: { time: number; kind: OneShotKind }[] = [];
  update(s: FaceState): void {
    for (const k of s.oneShotRequests) this.log.push({ time: s.time, kind: k });
  }
}

const touch = (e: FaceEngine): TouchReactions => e.director.modifier('TouchReactions') as TouchReactions;

function run(e: FaceEngine, seconds: number, dt = 1.0 / 60.0, each: (f: FaceFrame) => void = () => {}): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) each(e.tick(dt));
}

const meanOpening = (f: FaceFrame): number => (opening(f.pose, 'left') + opening(f.pose, 'right')) / 2;

/// Default stack with a request recorder spliced in before the sampler.
function engineWithLog(seed = 3): [FaceEngine, RequestTap] {
  const tap = new RequestTap();
  const mods = FaceEngine.makeDefaultModifiers();
  const i = mods.findIndex((m) => m.name === 'OneShotSampler');
  mods.splice(i, 0, tap);
  return [new FaceEngine({ seed, modifiers: mods }), tap];
}

const reactionKinds = new Set<OneShotKind>(['perkUp', 'delightedSquint', 'curiousTilt', 'doubleTake', 'sideEye',
  'mockOffense', 'lookAway', 'bigSurprise']);

const simdDistance = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('TouchReactions', () => {
  // MARK: Waking

  test('startledWakeOpensFastAndLooksAtTheTap', () => {
    const e = new FaceEngine({ seed: 5 });
    e.setAgentState('asleep');
    run(e, 5);
    const closed = meanOpening(e.state.output);
    expect(closed, `asleep eyes are thin lines (${closed})`).toBeLessThan(0.06);

    touch(e).forceStartle = true;
    e.send(FaceCommand.tap({ x: 0.7, y: 0 }));
    e.tick(1.0 / 60.0);
    expect(e.state.startedOneShots.some((o) => o.kind === 'bigSurprise')).toBe(true);
    expect(e.state.agentState).toBe('noticing');

    let maxGazeX = -1;
    run(e, 0.3, undefined, () => { maxGazeX = Math.max(maxGazeX, e.state.eyeGaze.x); });
    const at300 = meanOpening(e.state.output);
    run(e, 2.5);
    const settled = meanOpening(e.state.output);
    expect(at300, `open within ~0.3 s: ${at300} vs settled ${settled}`).toBeGreaterThan(0.75 * settled);
    expect(maxGazeX, `looked toward the tap (${maxGazeX})`).toBeGreaterThan(0.15);
    expect(e.state.output.brightness).toBeGreaterThan(0.6);
  });

  test('gentleWakeGoesThroughWaking', () => {
    const e = new FaceEngine({ seed: 5 });
    e.setAgentState('asleep');
    run(e, 3);
    touch(e).forceStartle = false;
    e.send(FaceCommand.tap({ x: -0.3, y: 0.2 }));
    e.tick(1.0 / 60.0);
    expect(e.state.agentState).toBe('waking');
    let wakeStarted = false;
    run(e, 0.1, undefined, () => { if (e.state.startedOneShots.some((o) => o.kind === 'wake')) wakeStarted = true; });
    expect(wakeStarted).toBe(true);
    // Slower than a startle: still mostly closed at 0.3 s.
    run(e, 0.2);
    expect(meanOpening(e.state.output)).toBeLessThan(0.25);
  });

  test.each([['asleep', 0.6], ['drowsy', 0.35], ['halfAwake', 0.2]] as [AgentState, number][])(
    'startleProbabilityMatches (%s, %d)', (state, p) => {
      const library = ExpressionLibrary.bundled();
      const n = 600;
      let startled = 0;
      for (let seed = 0; seed < n; seed++) {
        const d = new Director([new AgentStateBehavior(), new TouchReactions()]);
        const s = new FaceState(library, BigInt(seed) * 7919n + 11n);
        s.agentState = state;
        s.dt = 1 / 60;
        s.time = 1 / 60; s.frame = 1;
        d.run(s);
        s.commands = [FaceCommand.tap({ x: 0, y: 0 })];
        s.time += 1 / 60; s.frame += 1;
        d.run(s);
        if (s.agentState === 'noticing') startled += 1; else expect(s.agentState).toBe('waking');
      }
      const rate = startled / n;
      expect(Math.abs(rate - p), `${state}: ${rate} vs ${p}`).toBeLessThan(0.07);
    });

  test('tapWakesCanBeDisabled', () => {
    const e = new FaceEngine({ seed: 5 });
    e.setAgentState('asleep');
    run(e, 1);
    touch(e).tapWakesEnabled = false;
    e.send(FaceCommand.tap({ x: 0, y: 0 }));
    run(e, 1);
    expect(e.state.agentState).toBe('asleep');
  });

  // MARK: Awake flinch

  test('idleTapFlinchesBlinksAndGlances', () => {
    const e = new FaceEngine({ seed: 8 });
    run(e, 1.5);
    e.send(FaceCommand.tap({ x: -0.8, y: 0.1 }));
    let maxBlink = 0, minScaleY = 2, minGazeX = 1;
    run(e, 0.6, undefined, () => {
      maxBlink = Math.max(maxBlink, e.state.blink);
      minScaleY = Math.min(minScaleY, e.state.faceScaleMul.y);
      minGazeX = Math.min(minGazeX, e.state.eyeGaze.x);
    });
    expect(maxBlink, `flinch blink (${maxBlink})`).toBeGreaterThan(0.8);
    expect(minScaleY, `recoil dip (${minScaleY})`).toBeLessThan(0.975);
    expect(minGazeX, `glanced toward the tap (${minGazeX})`).toBeLessThan(-0.2);
    expect(touch(e).annoyance).toBeGreaterThan(0.8);
  });

  test('recoilSpringsBackWithoutSnapping', () => {
    const d = new Director([new TouchReactions()]);
    const s = new FaceState(ExpressionLibrary.bundled(), 1);
    let prev = 1;
    let maxStep = 0, minY = 1, maxY = 1;
    for (let f = 0; f < 120; f++) {
      s.dt = 1 / 120; s.time += 1 / 120; s.frame += 1;
      s.commands = f === 10 ? [FaceCommand.tap({ x: 0.5, y: 0 })] : [];
      d.run(s);
      const y = s.faceScaleMul.y;
      maxStep = Math.max(maxStep, Math.abs(y - prev)); prev = y;
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    expect(Math.abs(minY - 0.96), `dip ≈ 0.96 (${minY})`).toBeLessThan(0.006);
    expect(maxY > 1.001 && maxY < 1.015, `small overshoot (${maxY})`).toBe(true);
    // A flinch starts with a velocity kick (≈ 1.5 /s), never a positional jump: ≤ kick·dt per 120 fps frame.
    expect(maxStep, `no snap (${maxStep})`).toBeLessThan(0.015);
    expect(Math.abs(prev - 1), 'settled').toBeLessThan(1e-3);
  });

  // MARK: Escalation

  test('repeatedTapsEscalateToSulkThenForgive', () => {
    const [e, log] = engineWithLog();
    const tr = touch(e);
    run(e, 1.5);
    const tiers: number[] = [];
    const tier = (k: OneShotKind | null): number => {
      switch (k) {
        case 'perkUp': case 'delightedSquint': case 'curiousTilt': return 0;
        case 'doubleTake': case 'sideEye': return 1;
        case 'mockOffense': return 2;
        case 'lookAway': return 3;
        default: return -1;
      }
    };
    let tapIndex = 0;
    while (!tr.isSulking && tapIndex < 12) {
      e.send(FaceCommand.tap({ x: 0.4, y: -0.2 }));
      e.tick(1.0 / 60.0);
      tiers.push(tier(tr.lastReaction));
      run(e, 0.5);
      tapIndex += 1;
    }
    expect(tr.isSulking, `sulked after ${tapIndex} taps: ${tiers}`).toBe(true);
    expect(tiers[0], 'first tap is friendly').toBe(0);
    expect(tiers.includes(1), `hey… tier reached: ${tiers}`).toBe(true);
    expect(log.log.some((x) => x.kind === 'mockOffense'), 'hmph').toBe(true);
    expect(log.log.some((x) => x.kind === 'lookAway'), 'sulk look-away').toBe(true);
    expect(tiers.every((t, i) => i === 0 || tiers[i - 1] <= t), `never de-escalates while tapping: ${tiers}`).toBe(true);
    expect(e.state.reactionOverlayWeight).toBeGreaterThan(0.5);

    // Taps during the sulk are ignored: no new reactions, A held.
    const a = tr.annoyance;
    const before = log.log.length;
    for (let i = 0; i < 3; i++) {
      e.send(FaceCommand.tap({ x: 0.4, y: -0.2 }));
      run(e, 0.5);
    }
    expect(log.log.length, 'ignored').toBe(before);
    expect(tr.annoyance).toBe(a);

    // Forgives with a side-eye, A back to 2.
    let forgaveAt: number | undefined;
    run(e, 2.5, undefined, () => { if (forgaveAt === undefined && !tr.isSulking) forgaveAt = e.state.time; });
    expect(forgaveAt).toBeDefined();
    expect(log.log[log.log.length - 1]?.kind).toBe('sideEye');
    expect(tr.annoyance).toBeLessThanOrEqual(TouchReactions.forgivenAnnoyance + 1e-4);
    expect(e.state.gazeIntent.kind, 'gaze intent restored').not.toBe('lookAway');
  });

  test('annoyanceDecaysSoQuietTimeResetsToFriendly', () => {
    const e = new FaceEngine({ seed: 4 });
    const tr = touch(e);
    run(e, 1);
    for (let i = 0; i < 4; i++) {
      e.send(FaceCommand.tap({ x: 0.2, y: 0 }));
      run(e, 0.4);
    }
    expect(tr.annoyance).toBeGreaterThan(3);
    run(e, 10);
    expect(tr.annoyance).toBeLessThan(0.5);
    e.send(FaceCommand.tap({ x: 0.2, y: 0 }));
    e.tick(1.0 / 60.0);
    expect((['perkUp', 'delightedSquint', 'curiousTilt'] as (OneShotKind | null)[]).includes(tr.lastReaction)).toBe(true);
  });

  test('decayIsExponentialWithTau', () => {
    const d = new Director([new TouchReactions()]);
    const s = new FaceState(ExpressionLibrary.bundled(), 1);
    const tr = d.modifiers[0] as TouchReactions;
    s.dt = 1 / 60; s.time = 1 / 60; s.frame = 1;
    s.commands = [FaceCommand.tap({ x: 0, y: 0 })];
    d.run(s);
    s.commands = [];
    for (let i = 0; i < 240; i++) { s.time += 1 / 60; s.frame += 1; d.run(s); }
    expect(Math.abs(tr.annoyance - Math.exp(-4 / TouchReactions.annoyanceTau))).toBeLessThan(1e-3);
  });

  test('neverTheSameReactionTwiceInARow', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const [e, log] = engineWithLog(seed);
      const rng = new SplitMix64(seed + 100);
      // IdleBeats picks its own beats (it only avoids repeating itself); test TouchReactions' guarantee.
      const ib = e.director.modifier('IdleBeats');
      if (ib) ib.isEnabled = false;
      run(e, 1);
      for (let i = 0; i < 60; i++) {
        e.send(FaceCommand.tap(rng.inEllipse(1, 1)));
        run(e, rng.uniform(0.15, 2.5));
      }
      const kinds = log.log.map((x) => x.kind).filter((k) => reactionKinds.has(k));
      expect(kinds.length).toBeGreaterThan(10);
      for (let i = 1; i < kinds.length; i++) {
        expect(kinds[i - 1], `seed ${seed}: ${kinds[i]} twice in a row in ${log.log.map((x) => `${x.time}:${x.kind}`)}`)
          .not.toBe(kinds[i]);
      }
    }
  });

  test('conversationTapsOnlyFlinchButAccumulate', () => {
    const [e, log] = engineWithLog();
    e.setAgentState('thinking');
    run(e, 1);
    const before = log.log.length;
    for (let i = 0; i < 6; i++) {
      e.send(FaceCommand.tap({ x: 0.5, y: 0 }));
      run(e, 0.3);
    }
    expect(log.log.length, 'no reaction one-shots during thinking').toBe(before);
    expect(touch(e).annoyance).toBeGreaterThan(3);
    expect(touch(e).isSulking).toBe(false);
    expect(e.state.agentState).toBe('thinking');
  });

  test('notForMeTapsOnlyFlinch', () => {
    const e = new FaceEngine({ seed: 2 });
    e.setAgentState('sheepish');
    run(e, 1);
    e.send(FaceCommand.tap({ x: 0.5, y: 0 }));
    e.tick(1.0 / 60.0);
    expect(touch(e).annoyance).toBe(0);
    expect(touch(e).lastReaction).toBeNull();
  });

  // MARK: Overlay

  test('overlayWeightRisesAndFallsSmoothly', () => {
    const e = new FaceEngine({ seed: 6 });
    run(e, 1);
    let prev = 0, maxStep = 0, peak = 0;
    for (let i = 0; i < 5; i++) {
      e.send(FaceCommand.tap({ x: 0.3, y: 0 }));
      run(e, 0.45, undefined, () => {
        const w = e.state.reactionOverlayWeight;
        maxStep = Math.max(maxStep, Math.abs(w - prev)); prev = w; peak = Math.max(peak, w);
      });
    }
    run(e, 20, undefined, () => {
      const w = e.state.reactionOverlayWeight;
      maxStep = Math.max(maxStep, Math.abs(w - prev)); prev = w;
    });
    expect(peak, `annoyed overlay (${peak})`).toBeGreaterThan(0.6);
    expect(maxStep, `no jumps at 60 fps (${maxStep})`).toBeLessThan(0.06);
    expect(prev, `fades back out (${prev})`).toBeLessThan(0.02);
    const et = e.director.modifier('ExpressionTransition') as ExpressionTransition;
    expect(et.overlayRecomputeCount, 'overlay resolved only on mix changes').toBeLessThanOrEqual(6);
  });

  test('overlayAndAnnoyanceMatchAt60And120fps', () => {
    function simulate(fps: number): [number, number][] {
      const d = new Director([new AgentStateBehavior(), new TouchReactions()]);
      const tr = d.modifiers[1] as TouchReactions;
      const s = new FaceState(ExpressionLibrary.bundled(), 9);
      const dt = Math.fround(1 / fps); // Swift: 1 / Float(fps)
      const samples: [number, number][] = [];
      const tapFrames60 = [30, 60, 84, 102, 120, 135, 150];
      for (let f = 0; f < 10 * fps; f++) {
        s.dt = dt; s.time += dt; s.frame += 1;
        s.commands.length = 0;
        const k = fps / 60;
        if ((f + 1) % k === 0 && tapFrames60.includes((f + 1) / k - 1)) s.commands.push(FaceCommand.tap({ x: 0.2, y: 0 }));
        d.run(s);
        if (f % (fps / 10) === fps / 10 - 1) samples.push([tr.annoyance, s.reactionOverlayWeight]);
      }
      return samples;
    }
    const a = simulate(60), b = simulate(120);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      expect(Math.abs(a[i][0] - b[i][0])).toBeLessThan(1e-3);
      // Taps act at frame ends (exact); the sulk's end is detected on the first frame past its time, so
      // the two rates may start easing the weight down up to one 60 fps frame apart.
      expect(Math.abs(a[i][1] - b[i][1])).toBeLessThan(0.04);
    }
  });

  test('annoyanceWarmsTheAffectTowardAngry', () => {
    const e = new FaceEngine({ seed: 6 });
    run(e, 1);
    const calm = FaceAffect.effectivePAD(e.state);
    for (let i = 0; i < 5; i++) {
      e.send(FaceCommand.tap({ x: 0.3, y: 0 }));
      run(e, 0.4);
    }
    const annoyed = FaceAffect.effectivePAD(e.state);
    expect(annoyed.x, `less pleasant: ${JSON.stringify(calm)} → ${JSON.stringify(annoyed)}`).toBeLessThan(calm.x - 0.2);
    expect(annoyed.z, 'more dominant').toBeGreaterThan(calm.z + 0.1);
    const mc = e.director.modifier('MoodColor') as MoodColor;
    expect(simdDistance(mc.effectivePAD(e.state), annoyed), 'MoodColor and FaceAffect agree').toBeLessThan(1e-5);
    const angry = MoodPalette.standard.anchors.find((x) => x.name === 'angry')!.pad;
    expect(simdDistance(annoyed, angry)).toBeLessThan(simdDistance(calm, angry) - 0.3);
  });

  // MARK: Robustness

  test('nonFiniteAndExtremeTapsStayFinite', () => {
    const e = new FaceEngine({ seed: 1 });
    const points = [{ x: NaN, y: 0 }, { x: Infinity, y: -Infinity }, { x: 40, y: -40 }, { x: 0, y: 0 }];
    for (const st of ['idle', 'asleep', 'thinking', 'waking', 'drowsy'] as AgentState[]) {
      e.setAgentState(st);
      for (const p of points) {
        e.send(FaceCommand.tap(p));
        for (let i = 0; i < 20; i++) {
          const f = e.tick(1.0 / 60.0);
          expect(f.pose.hasNonFinite).toBe(false);
          expect(Number.isFinite(e.state.reactionOverlayWeight)).toBe(true);
        }
      }
    }
    expect(Number.isFinite(touch(e).annoyance)).toBe(true);
  });
});
