// Port of Tests/FaceEngineTests/BrowEngineTests.swift.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import { Blink } from '../../src/engine/modifiers/Blink';
import { Brows } from '../../src/engine/modifiers/Brows';
import {
  AgentStateBehavior, Composer, Director, ExpressionTransition, FaceCommand, FaceEngine, FaceState, OneShotApply,
  OneShotKind, OneShotKindSet, OneShotLibrary, OneShotSampler, Phase, makeOneShotCancel,
  type AgentState, type Modifier,
} from '../../src/engine';
import { BrowLayout, BrowPose, ExpressionLibrary, ExpressionMix, mixEntry } from '../../src/model';

const lib = ExpressionLibrary.bundled();

/// Swift ASTRig (AgentStateTests.swift): a director over a bare state, uncomposed.
class ASTRig {
  readonly director: Director;
  state: FaceState;
  constructor(modifiers: Modifier[], seed = 1) {
    this.director = new Director(modifiers);
    this.state = new FaceState(ExpressionLibrary.bundled(), seed);
  }
  setAgentState(a: AgentState): void {
    if (a === this.state.agentState) return;
    this.state.previousAgentState = this.state.agentState;
    this.state.agentState = a;
    this.state.agentStateEnteredAt = this.state.time;
    this.state.agentStateChanged = true;
  }
  tick(dt = 1 / 60): void {
    this.state.dt = dt;
    this.state.time += dt;
    this.state.frame += 1;
    this.director.run(this.state);
    this.state.agentStateChanged = false;
    this.state.commands.length = 0;
  }
  run(seconds: number, each: (r: ASTRig) => void = () => {}, dt = 1 / 60): void {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) { this.tick(dt); each(this); }
  }
}

function rig(mods: Modifier[]): ASTRig {
  const r = new ASTRig(mods);
  r.tick();
  Composer.compose(r.state);
  return r;
}

/// Swings the face stage up and down (as an edge antic would).
class StageSwing implements Modifier {
  readonly name = 'StageSwing';
  readonly phase = Phase.behaviour;
  isEnabled = true;
  update(s: FaceState): void { s.stageOffset.y = 30 * Math.sin(s.time * 6); }
}

/// A shared generator for library sampling in tests.
const SplitMixHolder = { rng: new SplitMix64(42) };

function browTrajectory(fps: number): BrowPose[] {
  const r = rig([new ExpressionTransition()]);
  r.state.modulation.bounciness = 0.4;
  const per = fps / 60;
  const out: BrowPose[] = [];
  for (let frame = 1; frame <= fps * 2; frame++) {
    const prior = frame - 1;
    if (prior % per === 0) {
      switch (prior / per) {
        case 10: r.state.targetMix = ExpressionMix.single('Happiness'); break;
        case 50: r.state.targetMix = ExpressionMix.single('MockAnnoyed'); break;
        case 52: r.state.targetMix = ExpressionMix.single('Concerned'); break;
        default: break;
      }
    }
    r.tick(1 / fps);
    if (frame % per === 0) out.push(r.state.browBase.copy());
  }
  return out;
}

describe('BrowEngine', () => {
  // MARK: Expression springs, lead and follow

  test('browsSpringToTheExpressionWithBoundedOvershoot', () => {
    const et = new ExpressionTransition();
    const r = rig([et]);
    const n = lib.neutralBrows.lane('left', 'y'), target = lib.brows('Happiness').lane('left', 'y');
    r.state.targetMix = ExpressionMix.single('Happiness');
    let peak = -1;
    r.run(2, (r) => { peak = Math.max(peak, r.state.browBase.lane('left', 'y')); });
    expect(Math.abs(r.state.browBase.lane('left', 'y') - target), 'converges').toBeLessThan(1e-3);
    const travel = target - n;
    expect(peak, 'a subtle overshoot').toBeGreaterThan(target + 0.02 * travel);
    expect(peak, 'bounded overshoot').toBeLessThan(target + 0.25 * travel);
    expect(Math.abs(et.currentBrowTarget.lane('left', 'y') - target)).toBeLessThan(1e-5);
  });

  test('browsLeadWhenTheEyeShapeIsHeldBack', () => {
    const et = new ExpressionTransition();
    et.leadChance = 1;
    const r = rig([et]);
    r.state.targetMix = ExpressionMix.single('Surprise');
    r.run(0.04, undefined, 1 / 120);
    expect(et.lastChangeLedByBrows).toBe(true);
    expect(Math.abs(r.state.browBase.lane('left', 'curvature') - lib.neutralBrows.lane('left', 'curvature')),
      'brows already moving').toBeGreaterThan(0.01);
    expect(Math.abs(r.state.basePose.eye('left', 'scaleX') - 1), 'eye shape held back').toBeLessThan(1e-6);
    expect(Math.abs(r.state.basePose.eye('left', 'size') - lib.neutral.eye('left', 'size')), 'pupils start at once')
      .toBeGreaterThan(1e-3);
    r.run(0.2, undefined, 1 / 120);
    expect(r.state.basePose.eye('left', 'scaleX'), 'the eyes catch up').toBeGreaterThan(1.02);
  });

  test('browsFollowByDefault', () => {
    const et = new ExpressionTransition();
    et.leadChance = 0;
    const r = rig([et]);
    r.state.targetMix = ExpressionMix.single('Surprise');
    r.run(0.03, undefined, 1 / 120);
    expect(et.lastChangeLedByBrows).toBe(false);
    expect(r.state.basePose.eye('left', 'scaleX'), 'eye shape leads').toBeGreaterThan(1.003);
    expect(Math.abs(r.state.browBase.lane('left', 'curvature') - lib.neutralBrows.lane('left', 'curvature')),
      'brows wait').toBeLessThan(1e-6);
    r.run(0.1, undefined, 1 / 120);
    expect(Math.abs(r.state.browBase.lane('left', 'curvature') - lib.neutralBrows.lane('left', 'curvature')),
      'then follow').toBeGreaterThan(0.01);
  });

  /// A blend slider dragged continuously: the held lanes track the drag instead of sticking to the pre-drag target.
  test('blendDragKeepsTheLidsTracking', () => {
    const et = new ExpressionTransition();
    et.leadChance = 0;
    const r = rig([et]);
    let t = 0;
    let lidAtHalf = 0;
    r.run(1, (rig) => {
      t += 1 / 60;
      const w = Math.min(t, 1);
      rig.state.expressionOverride = new ExpressionMix([mixEntry('Neutral', 1 - w), mixEntry('Happiness', w)]);
      if (Math.abs(t - 0.5) < 0.009) lidAtHalf = rig.state.basePose.eye('left', 'lowerLidY');
    });
    // Target lower lid at w = 0.5 is 0.2; within ~100 ms of the drag the lid must be well on its way.
    const atFourTenths = 0.4 * lib.get('Happiness')!.pose.eye('left', 'lowerLidY');
    expect(lidAtHalf, `lid ${lidAtHalf} lags the drag by more than ~100 ms`).toBeGreaterThan(0.35 * atFourTenths);
  });

  test('browIntensityScalesAmplitudeOnly', () => {
    const et = new ExpressionTransition();
    const r = rig([et]);
    r.state.browIntensity = 0;
    r.state.targetMix = ExpressionMix.single('Surprise');
    r.run(1.5);
    for (const i of BrowLayout.usedIndices) expect(Math.abs(r.state.browBase.get(i) - lib.neutralBrows.get(i))).toBeLessThan(1e-4);
    r.state.browIntensity = 0.5;
    r.run(2);
    const half = ExpressionMix.single('Surprise', 0.5).brows(lib);
    expect(Math.abs(r.state.browBase.lane('left', 'curvature') - half.lane('left', 'curvature'))).toBeLessThan(1e-3);
  });

  test('browsAreFrameRateIndependent', () => {
    const a = browTrajectory(60), b = browTrajectory(120);
    let worst = 0;
    for (let k = 0; k < Math.min(a.length, b.length); k++) {
      for (const i of BrowLayout.usedIndices) {
        const range = BrowLayout.Lane.range(BrowLayout.Lane.allCases[i % 16]);
        worst = Math.max(worst, Math.abs(a[k].get(i) - b[k].get(i)) / (range.upperBound - range.lowerBound));
      }
    }
    expect(worst, `worst ${worst}`).toBeLessThan(1e-3);
  });

  // MARK: Blinks, follow-through, relaxation

  /// Blinks never move the brows: closure is excluded from the brows' anchor and lanes.
  test('blinksNeverMoveTheBrows', () => {
    const r = rig([new ExpressionTransition(), new Blink(), new Brows()]);
    r.run(1, (r) => Composer.compose(r.state));
    const beforeBrows = r.state.output.brows.copy();
    const beforeOffset = { ...r.state.output.browOffset };
    let blinked = false;
    for (let k = 0; k < 6; k++) {
      r.state.commands.push(FaceCommand.blink);
      r.run(0.5, (rig) => {
        Composer.compose(rig.state);
        if (rig.state.output.closureScale.y < 0.9) blinked = true;
        expect(rig.state.output.brows.equals(beforeBrows), `blink ${k} moved the brows`).toBe(true);
        expect(rig.state.output.browOffset).toEqual(beforeOffset);
      });
    }
    expect(blinked).toBe(true);
  });

  test('followThroughFromFaceMotion', () => {
    const r = rig([new ExpressionTransition(), new OneShotSampler(), new OneShotApply(), new Brows()]);
    r.state.oneShotRequests.push('laugh');
    let peak = 0;
    r.run(1.2, (rig) => {
      Composer.compose(rig.state);
      peak = Math.max(peak, Math.abs(rig.state.output.browOffset.y), Math.abs(rig.state.output.browOffset.w));
    });
    expect(peak, `brows trail the laugh's hops (${peak})`).toBeGreaterThan(0.4);
    expect(peak).toBeLessThanOrEqual(Brows.maxFollow.y + 0.01);
    r.run(1.5, (r) => Composer.compose(r.state));
    expect(Math.abs(r.state.output.browOffset.y), 'and settle').toBeLessThan(0.05);
  });

  test('followThroughFromStageOffsets', () => {
    const r = rig([new StageSwing(), new ExpressionTransition(), new Brows()]);
    let peak = 0;
    r.run(1, (rig) => {
      Composer.compose(rig.state);
      peak = Math.max(peak, Math.abs(rig.state.output.browOffset.y));
    });
    expect(peak, `stage motion swings the brows (${peak})`).toBeGreaterThan(1);
  });

  test('drowsyRelaxesTheBrows', () => {
    const e = new FaceEngine({ seed: 3 });
    e.setAgentState('idle');
    for (let i = 0; i < 120; i++) e.tick(1 / 60);
    const awake = e.state.output.brows.copy();
    e.setAgentState('drowsy');
    for (let i = 0; i < 300; i++) e.tick(1 / 60);
    const drowsy = e.state.output.brows.copy();
    const brows = e.director.modifier('Brows') as Brows;
    expect(brows.relaxation).toBeGreaterThan(0.7);
    expect(drowsy.lane('left', 'outer')).toBeLessThan(awake.lane('left', 'outer') - 0.02);
    expect(e.state.output.browPresence < 0.95 && e.state.output.browPresence > 0.8).toBe(true);
  });

  // MARK: Presence

  test('presenceFadesForSleepAndReturnsWithTheEyes', () => {
    const e = new FaceEngine({ seed: 5 });
    e.setAgentState('drowsy');
    for (let i = 0; i < 120; i++) e.tick(1 / 60);
    e.setAgentState('asleep');
    let minDuringFall = 1;
    for (let i = 0; i < 60 * 5; i++) { e.tick(1 / 60); minDuringFall = Math.min(minDuringFall, e.state.output.browPresence); }
    expect(e.state.output.browPresence, 'gone when asleep').toBeLessThan(0.02);
    // Half awake: partial; waking: grows back with the opening lids.
    e.setAgentState('halfAwake');
    for (let i = 0; i < 60 * 3; i++) e.tick(1 / 60);
    expect(Math.abs(e.state.output.browPresence - 0.6)).toBeLessThan(0.08);
    e.setAgentState('waking');
    const samples: number[] = [];
    for (let i = 0; i < 60 * 3; i++) { e.tick(1 / 60); samples.push(e.state.output.browPresence); }
    expect(samples[6], 'held back while the lids are still heavy').toBeLessThan(0.6);
    expect(samples[samples.length - 1]).toBeGreaterThan(0.95);
  });

  /// A stir tap while asleep flutters the lids only; the brows stay gone.
  test('stirDoesNotBringTheBrowsBack', () => {
    const r = rig([new AgentStateBehavior()]);
    r.setAgentState('asleep');
    r.run(6, (r) => Composer.compose(r.state));
    expect(r.state.browPresence).toBeLessThan(0.02);
    r.state.lidStirAt = r.state.time;
    r.run(0.5, (rig) => {
      Composer.compose(rig.state);
      expect(rig.state.browPresence).toBeLessThan(0.02);
    });
  });

  test('nodOffDoesNotFadeTheBrows', () => {
    const e = new FaceEngine({ seed: 9 });
    e.setAgentState('drowsy');
    for (let i = 0; i < 120; i++) e.tick(1 / 60);
    e.send(FaceCommand.playOneShot('nodOff'));
    let low = 1;
    for (let i = 0; i < 60 * 3; i++) { e.tick(1 / 60); low = Math.min(low, e.state.output.browPresence); }
    expect(low).toBeGreaterThan(0.85);
  });

  /// The fade is geometric: presence moves smoothly (no per-frame jumps).
  test('presenceIsSmooth', () => {
    const e = new FaceEngine({ seed: 2 });
    e.setAgentState('asleep');
    let last = e.tick(1 / 60).browPresence;
    for (let i = 0; i < 300; i++) {
      const p = e.tick(1 / 60).browPresence;
      expect(Math.abs(p - last)).toBeLessThan(0.06);
      last = p;
    }
  });

  // MARK: One-shots

  test('oneShotBrowTracksStartAndEndAtZero', () => {
    for (const kind of OneShotKind.allCases) {
      const p = OneShotLibrary.makeParams(kind, SplitMixHolder.rng, { x: 0, y: 0 });
      const d = OneShotLibrary.duration(kind, p);
      const a = OneShotLibrary.sample(kind, 0, p).browDelta;
      const b = OneShotLibrary.sample(kind, d, p).browDelta;
      for (const i of BrowLayout.usedIndices) {
        expect(Math.abs(a.get(i)) < 1e-5 && Math.abs(b.get(i)) < 1e-5, `${kind} lane ${i}`).toBe(true);
      }
    }
    // And the expressive ones do move the brows.
    for (const kind of ['laugh', 'bigSurprise', 'mockOffense', 'curiousTilt', 'confusedShake', 'doubleTake', 'sideEye'] as const) {
      const p = OneShotLibrary.makeParams(kind, SplitMixHolder.rng, { x: 0, y: 0 });
      let peak = 0;
      for (let k = 1; k < 50; k++) {
        const s = OneShotLibrary.sample(kind, OneShotLibrary.duration(kind, p) * k / 50, p).browDelta;
        for (const i of BrowLayout.usedIndices) peak = Math.max(peak, Math.abs(s.get(i)));
      }
      expect(peak, `${kind} has no brow acting`).toBeGreaterThan(0.04);
    }
  });

  /// An interrupted one-shot's brows fade out with the rest (release capture), never snap.
  test('releaseFadesTheBrowTrack', () => {
    const r = rig([new OneShotSampler()]);
    r.state.oneShotRequests.push('mockOffense');
    r.run(0.8);
    const held = r.state.oneShot.browDelta.lane('left', 'rotation');
    expect(held).toBeLessThan(-5);
    r.state.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.of(['mockOffense'])));
    let last = held;
    r.run(0.3, (rig) => {
      const v = rig.state.oneShot.browDelta.lane('left', 'rotation');
      expect(Math.abs(v - last), `brows snapped ${last} → ${v}`).toBeLessThan(3.5);
      last = v;
    });
    expect(Math.abs(last)).toBeLessThan(1e-4);
  });

  test('browTracksAreSummedAndScaledByIntensity', () => {
    const r = rig([new OneShotSampler(), new OneShotApply()]);
    r.state.browIntensity = 0.5;
    r.state.oneShotRequests.push('curiousTilt');
    r.state.oneShotRequests.push('laugh');
    r.run(0.5);
    const o = r.state.oneShot.browDelta;
    for (const i of BrowLayout.usedIndices) expect(Math.abs(r.state.browDelta.get(i) - 0.5 * o.get(i))).toBeLessThan(1e-5);
  });

  test('touchAnnoyanceUsesMockAnnoyed', () => {
    const e = new FaceEngine({ seed: 4 });
    for (let k = 0; k < 10; k++) {
      e.send(FaceCommand.tap({ x: 0, y: 0 }));
      for (let i = 0; i < 12; i++) e.tick(1 / 60);
    }
    const names = e.state.reactionOverlay?.entries.map((x) => x.name) ?? [];
    expect(names).toContain('MockAnnoyed');
    expect(names).not.toContain('Annoyance');
  });

  // MARK: Composer

  test('composerClampsAndKeepsInnerEndsApart', () => {
    const s = new FaceState(lib, 1);
    s.browBase = lib.neutralBrows.copy();
    s.browDelta.setLane('left', 'x', -0.25);
    s.browDelta.setLane('left', 'width', 0.4);
    s.browDelta.setLane('right', 'rotation', 999);
    const b = Composer.composedBrows(s);
    expect(-b.lane('left', 'x') + Composer.innerReachPerWidth * (b.lane('left', 'width') - 1))
      .toBeLessThanOrEqual(Composer.maxInnerReach + 1e-5);
    expect(b.lane('right', 'rotation')).toBe(BrowLayout.Lane.range('rotation').upperBound);
    s.browDelta.setLane('left', 'y', NaN);
    expect(Composer.composedBrows(s).equals(lib.neutralBrows.clamped())).toBe(true);
    s.browPresence = Infinity;
    s.browOffset = { x: NaN, y: 100, z: 0, w: 0 };
    Composer.compose(s);
    expect(s.output.browPresence).toBe(1);
    expect(s.output.browOffset).toEqual({ x: 0, y: Composer.maxBrowOffset, z: 0, w: 0 });
  });

  /// Idle for a long stretch: brows never jitter (per-frame change bounded) and never freeze the engine.
  test('idleBrowsNeverJitter', () => {
    const e = new FaceEngine({ seed: 11 });
    e.setAgentState('idle');
    let last = e.tick(1 / 60);
    let lastLY = last.brows.lane('left', 'y'), lastRY = last.brows.lane('right', 'y'), lastOY = last.browOffset.y;
    let worstY = 0, worstOffset = 0;
    for (let i = 0; i < 60 * 30; i++) {
      const f = e.tick(1 / 60);
      worstY = Math.max(worstY, Math.abs(f.brows.lane('left', 'y') - lastLY), Math.abs(f.brows.lane('right', 'y') - lastRY));
      worstOffset = Math.max(worstOffset, Math.abs(f.browOffset.y - lastOY));
      last = f;
      lastLY = last.brows.lane('left', 'y'); lastRY = last.brows.lane('right', 'y'); lastOY = last.browOffset.y;
    }
    expect(worstY, `brow y jumped ${worstY} in a frame`).toBeLessThan(0.03);
    expect(worstOffset, `follow-through jumped ${worstOffset} canvas units in a frame`).toBeLessThan(0.6);
  });
});
