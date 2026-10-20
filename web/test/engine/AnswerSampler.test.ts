// Port of Tests/FaceEngineTests/AnswerSamplerTests.swift.
import { describe, expect, test } from 'vitest';
import { Canvas, EdgeGeometry, ExpressionLibrary, ParamLayout, Units, BrowLayout, BrowPose } from '../../src/model';
import {
  Director, FaceCommand, FaceEngine, FaceState, OneShotApply, OneShotKindSet, OneShotOutput, OneShotSampler,
  makeOneShotCancel, type AgentState, type OneShotKind,
} from '../../src/engine';

// MARK: - Harness (copied from OneShot.test.ts, which doesn't export it)

/// Runs only the one-shot modifiers.
class OneShotRig {
  readonly director = new Director([new OneShotSampler(), new OneShotApply()]);
  s: FaceState;

  constructor(seed = 1) {
    this.s = new FaceState(ExpressionLibrary.bundled(), seed);
    this.s.edgeGeometry = EdgeGeometry.reference;
  }

  step(dt: number): void {
    const s = this.s;
    s.dt = dt;
    s.time += dt;
    s.frame += 1;
    this.director.run(s);
    s.commands.length = 0;
    s.agentStateChanged = false;
  }

  request(k: OneShotKind): void { this.s.oneShotRequests.push(k); }

  setState(a: AgentState): void {
    const s = this.s;
    s.previousAgentState = s.agentState;
    s.agentState = a;
    s.agentStateEnteredAt = s.time;
    s.agentStateChanged = true;
  }
}

const lanes = (v: object): number[] => Object.values(v as Record<string, number>);
const maxAbsDiff = (a: object, b: object): number => { const bl = lanes(b); return lanes(a).reduce((m, x, i) => Math.max(m, Math.abs(x - bl[i])), 0); };

/// Per-frame change between two outputs is within the 1/120 s bounds (OneShot.test.ts's OneShotJump).
function jumpOK(a: OneShotOutput, b: OneShotOutput): boolean {
  const d = b.delta.sub(a.delta);
  let translate = Math.max(Math.abs(d.face('centerX')) * Canvas.xFactor, Math.abs(d.face('centerY')) * Canvas.yFactor);
  let angle = Math.abs(d.face('angle'));
  let scale = maxAbsDiff(b.faceScaleMul, a.faceScaleMul);
  for (const side of ParamLayout.Side.allCases) {
    translate = Math.max(translate, Math.abs(d.eye(side, 'centerX')) * Canvas.xFactor, Math.abs(d.eye(side, 'centerY')) * Canvas.yFactor);
    angle = Math.max(angle, Math.abs(d.eye(side, 'upperLidAngle')), Math.abs(d.eye(side, 'lowerLidAngle')));
    scale = Math.max(scale, Math.abs(d.eye(side, 'scaleX')), Math.abs(d.eye(side, 'scaleY')));
  }
  return translate <= 0.7 && angle <= 1.5 && scale <= 0.05 && maxAbsDiff(b.lidCoverage, a.lidCoverage) <= 0.1
    && Math.abs(b.lidClose - a.lidClose) <= 0.12 && Math.abs(b.brightnessMul - a.brightnessMul) <= 0.02;
}

const answers: OneShotKind[] = ['nodYes', 'nodYesBig', 'shakeNo', 'shakeNoBig'];

const travel = (o: OneShotOutput): number =>
  Math.max(Math.abs(Units.canvasX(o.delta.face('centerX'))), Math.abs(Units.canvasY(o.delta.face('centerY'))));

/// The answers through the sampler: gating, Reduce Motion, interruption and frame-rate independence.
describe('AnswerSamplerTests', () => {
  test.each(answers)('playsThroughAndEndsAtRest(%s)', (kind) => {
    const rig = new OneShotRig(3);
    rig.setState('speaking');
    rig.step(1.0 / 120);
    rig.request(kind);
    let prev = new OneShotOutput(), peak = 0, done = false;
    for (let i = 0; i < 200; i++) {
      rig.step(1.0 / 120);
      const o = rig.s.oneShot;
      expect(jumpOK(prev, o), `${kind} jumped`).toBe(true);
      peak = Math.max(peak, travel(o));
      prev = o.copy();
      if (rig.s.completedOneShots.includes(kind)) done = true;
    }
    expect(done && peak > 2 && rig.s.activeOneShots.length === 0).toBe(true);
    expect(travel(rig.s.oneShot)).toBeLessThan(1e-5);
  });

  test.each(answers)('droppedWhileSleepy(%s)', (kind) => {
    for (const state of OneShotSampler.answerBlockedStates) {
      const rig = new OneShotRig();
      rig.setState(state);
      rig.step(1.0 / 60);
      rig.request(kind);
      rig.step(1.0 / 60);
      expect(rig.s.activeOneShots.length === 0 && rig.s.startedOneShots.length === 0, `${kind} in ${state}`).toBe(true);
    }
  });

  test('bedtimePlaysTheGentleAnswer', () => {
    for (const [kind, gentle] of [['nodYesBig', 'nodYes'], ['shakeNoBig', 'shakeNo'], ['shakeNo', 'shakeNo']] as const) {
      const rig = new OneShotRig();
      rig.s.isBedtime = true;
      rig.request(kind);
      rig.step(1.0 / 60);
      expect(rig.s.activeOneShots, kind).toEqual([gentle]);
      expect(rig.s.startedOneShots[0]?.kind).toBe(gentle);
    }
  });

  test.each(answers)('systemReduceMotionShrinksTheMove(%s)', (kind) => {
    const peak = (reduce: boolean): number => {
      const rig = new OneShotRig(9);
      rig.s.pupilSettings.reduceMotion = reduce;
      rig.request(kind);
      let m = 0;
      for (let i = 0; i < 160; i++) { rig.step(1.0 / 120); m = Math.max(m, travel(rig.s.oneShot)); }
      return m;
    };
    const full = peak(false), small = peak(true);
    expect(small < 0.45 * full && small > 0.3 * full, `${kind}: ${small} vs ${full}`).toBe(true);
  });

  /// Interrupted by a conflicting one-shot or a cancel, an answer lets go smoothly and leaves nothing behind.
  test.each(answers)('interruptibleWithoutJumps(%s)', (kind) => {
    for (let interrupt = 0; interrupt < 2; interrupt++) {
      const rig = new OneShotRig(5);
      rig.request(kind);
      let prev = new OneShotOutput();
      for (let f = 0; f < 180; f++) {
        if (f === 36) {
          if (interrupt === 0) rig.request('laugh');
          else rig.s.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.answers));
        }
        rig.step(1.0 / 120);
        expect(jumpOK(prev, rig.s.oneShot), `${kind} interrupt ${interrupt} frame ${f}`).toBe(true);
        prev = rig.s.oneShot.copy();
        if (f === 36 + 20) expect(rig.s.activeOneShots.includes(kind), `${kind} still playing`).toBe(false);
      }
      expect(rig.s.completedOneShots.includes(kind)).toBe(false);
      if (interrupt === 1) {
        expect(travel(rig.s.oneShot) < 1e-5 && rig.s.oneShot.browDelta.equals(BrowPose.zero)).toBe(true);
      }
    }
  });

  test.each(answers)('sixtyAndOneTwentyFpsMatch(%s)', (kind) => {
    const run = (fps: number): OneShotOutput[] => {
      const rig = new OneShotRig(11);
      rig.request(kind);
      const out: OneShotOutput[] = [];
      const per = fps / 30;
      for (let f = 0; f < 40 * per; f++) {
        rig.step(Math.fround(1 / fps));
        if ((f + 1) % per === 0) out.push(rig.s.oneShot.copy());
      }
      return out;
    };
    const a = run(60), b = run(120);
    a.forEach((x, i) => {
      const y = b[i];
      const d = x.delta.sub(y.delta).raw;
      let m = 0;
      for (const v of d) m = Math.max(m, Math.abs(v));
      expect(m, `${kind} differs by ${m}`).toBeLessThan(1e-3);
      expect(Math.abs(x.lidCoverage.x - y.lidCoverage.x) < 1e-3
        && Math.abs(x.browDelta.lane('left', 'y') - y.browDelta.lane('left', 'y')) < 1e-4).toBe(true);
    });
  });

  /// Brows off: `browIntensity` 0 leaves the answers' faces moving and the brows still.
  test('browsOffStillAnswers', () => {
    const e = new FaceEngine({ seed: 4 });
    e.browIntensity = 0;
    e.setAgentState('speaking');
    for (let i = 0; i < 60; i++) e.tick(1.0 / 60);
    const rest = e.tick(1.0 / 60).brows.copy();
    e.send(FaceCommand.playOneShot('shakeNoBig'));
    let moved = 0, browMove = 0;
    for (let i = 0; i < 70; i++) {
      const f = e.tick(1.0 / 60);
      moved = Math.max(moved, Math.abs(f.pose.face('centerX') - 0));
      for (const j of BrowLayout.usedIndices) browMove = Math.max(browMove, Math.abs(f.brows.get(j) - rest.get(j)));
    }
    expect(moved).toBeGreaterThan(0.5);
    expect(browMove, `brows moved ${browMove}`).toBeLessThan(1e-3);
  });
});
