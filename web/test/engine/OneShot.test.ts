// Port of Tests/FaceEngineTests/OneShotTests.swift.
import { curvePorted, specPorted as specWorks } from './ported';
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import { Canvas, EdgeGeometry, ExpressionLibrary, ParamLayout, Units } from '../../src/model';
import {
  Director, FaceCommand, FaceState, OneShotApply, OneShotKind, OneShotLibrary, OneShotOutput, OneShotParams,
  OneShotSampler, isAnswer, isEdgeAntic, isIdleGame, isPupilShape, type AgentState,
} from '../../src/engine';

// MARK: - Harness

/// Runs only the one-shot modifiers (other modifiers are out of scope here).
class OneShotRig {
  readonly sampler = new OneShotSampler();
  readonly director: Director;
  s: FaceState;

  constructor(seed = 1) {
    this.director = new Director([this.sampler, new OneShotApply()]);
    this.s = new FaceState(ExpressionLibrary.bundled(), seed);
    this.s.edgeGeometry = EdgeGeometry.reference; // a screen, so the screen-edge antics play
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

const lanes = (v: ArrayLike<number> | object): number[] =>
  ('length' in v ? Array.from(v as ArrayLike<number>) : Object.values(v as Record<string, number>));
const maxAbs = (v: ArrayLike<number> | object): number => lanes(v).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const sub = (a: object, b: object): number[] => { const bl = lanes(b); return lanes(a).map((x, i) => x - bl[i]); };
const minus1 = (v: object): number[] => lanes(v).map((x) => x - 1);

/// Per-frame change between two outputs, in canvas units / degrees / fractions. Blink is excluded.
class OneShotJump {
  translate = 0; angle = 0; scale = 0; lids = 0; lidClose = 0; brightness = 0;

  constructor(a: OneShotOutput, b: OneShotOutput) {
    const d = b.delta.sub(a.delta);
    this.translate = Math.max(Math.abs(d.face('centerX')) * Canvas.xFactor, Math.abs(d.face('centerY')) * Canvas.yFactor);
    this.angle = Math.abs(d.face('angle'));
    this.scale = maxAbs(sub(b.faceScaleMul, a.faceScaleMul));
    for (const side of ParamLayout.Side.allCases) {
      this.translate = Math.max(this.translate, Math.abs(d.eye(side, 'centerX')) * Canvas.xFactor,
        Math.abs(d.eye(side, 'centerY')) * Canvas.yFactor);
      this.angle = Math.max(this.angle, Math.abs(d.eye(side, 'upperLidAngle')), Math.abs(d.eye(side, 'lowerLidAngle')));
      this.scale = Math.max(this.scale, Math.abs(d.eye(side, 'scaleX')), Math.abs(d.eye(side, 'scaleY')));
    }
    this.lids = maxAbs(sub(b.lidCoverage, a.lidCoverage));
    this.lidClose = Math.abs(b.lidClose - a.lidClose);
    this.brightness = Math.abs(b.brightnessMul - a.brightnessMul);
  }

  /// Bounds per 1/120 s frame: 84 canvas/s, 180°/s, 6/s scale, 12/s lid coverage, 14/s lid close.
  static readonly translateMax = 0.7; static readonly angleMax = 1.5; static readonly scaleMax = 0.05;
  static readonly lidsMax = 0.1; static readonly lidCloseMax = 0.12; static readonly brightnessMax = 0.02;

  get ok(): boolean {
    const J = OneShotJump;
    return this.translate <= J.translateMax && this.angle <= J.angleMax && this.scale <= J.scaleMax
      && this.lids <= J.lidsMax && this.lidClose <= J.lidCloseMax && this.brightness <= J.brightnessMax;
  }

  toString(): string { return JSON.stringify({ ...this }); }
}

const isIdentity = (o: OneShotOutput, tol = 1e-6): boolean =>
  maxAbs(o.stageOffset) <= tol && maxAbs(o.eyeStageOffset) <= tol && maxAbs(minus1(o.eyeScaleMul)) <= tol
  && maxAbs(o.delta.raw) <= tol && maxAbs(minus1(o.faceScaleMul)) <= tol && maxAbs(o.lidCoverage) <= tol
  && o.blink <= tol && o.lidClose <= tol && Math.abs(o.brightnessMul - 1) <= tol;

const isFinite = (o: OneShotOutput): boolean =>
  !o.delta.hasNonFinite && Number.isFinite(o.faceScaleMul.x) && Number.isFinite(o.faceScaleMul.y)
  && lanes(o.lidCoverage).every(Number.isFinite) && Number.isFinite(o.blink) && Number.isFinite(o.lidClose)
  && Number.isFinite(o.brightnessMul);

/// Swift `IdleGames.isPending`: every idle game is built in Swift, so this is always false.
// TODO(WP6): use IdleGames.isPending once the IdleGames modifier is ported.
const isPending = (_k: OneShotKind): boolean => false;

const dt120 = 1 / 120;

/// Kinds whose curves are ported (the 18 originals so far); the rest need WP6 (answers, pupil shapes, edge antics,
/// games) and light up as their curve files land.
const ported = OneShotKind.allCases.filter(curvePorted);
const unported = OneShotKind.allCases.filter((k) => !ported.includes(k));
/// Kinds whose spec works (originals, answers, pupil shapes so far).
const specPorted = OneShotKind.allCases.filter(specWorks);
const allPorted = unported.length === 0;

// MARK: - Library curves

describe('OneShotLibraryTests', () => {
  // needs WP6 (OneShotLibrary.specs builds the edge antic and idle game specs)
  test.skipIf(!allPorted)('specTableCoversEveryKindInOrder', () => {
    expect(OneShotLibrary.specs.length).toBe(OneShotKind.allCases.length);
    for (const k of OneShotKind.allCases) {
      expect(OneShotLibrary.spec(k).kind).toBe(k);
      expect(OneShotLibrary.spec(k).duration).toBeGreaterThan(0);
    }
  });

  test('specTableCoversEveryKindInOrder (ported specs)', () => {
    for (const k of specPorted) {
      expect(OneShotLibrary.spec(k).kind).toBe(k);
      expect(OneShotLibrary.spec(k).duration).toBeGreaterThan(0);
    }
  });

  const startsAndEndsAtExactlyZero = (kind: OneShotKind): void => {
    const rng = new SplitMix64(99);
    for (let n = 0; n < 5; n++) {
      const p = OneShotLibrary.makeParams(kind, rng, { x: 0.1, y: -0.05 });
      const d = OneShotLibrary.duration(kind, p);
      expect(isIdentity(OneShotLibrary.sample(kind, 0, p), 0)).toBe(true);
      expect(isIdentity(OneShotLibrary.sample(kind, d, p), 0)).toBe(true);
      expect(OneShotLibrary.sample(kind, d, p).gaze).toBeNull();
      // Something actually happens mid-way.
      let peak = 0;
      for (let i = 1; i < 50; i++) {
        const o = OneShotLibrary.sample(kind, d * i / 50, p);
        peak = Math.max(peak, maxAbs(o.delta.raw), maxAbs(o.lidCoverage), o.lidClose, o.blink,
          maxAbs(minus1(o.faceScaleMul)), o.gaze === null ? 0 : 1);
      }
      // A pending idle game's curve is still a rest placeholder (idle games design §7).
      expect(peak > 0.05 || isPending(kind), `${kind} does nothing`).toBe(true);
    }
  };
  test.each(ported)('startsAndEndsAtExactlyZero %s', startsAndEndsAtExactlyZero);
  // needs WP6 (answer, edge antic, pupil shape and idle game curves)
  test.skip.each(unported)('startsAndEndsAtExactlyZero %s', startsAndEndsAtExactlyZero);

  const curvesAreContinuousAt120fps = (kind: OneShotKind): void => {
    const rng = new SplitMix64(5);
    for (let n = 0; n < 4; n++) {
      const p = OneShotLibrary.makeParams(kind, rng, { x: 0, y: 0 });
      p.amp = 1.1; p.timeMul = 0.94; // worst case: biggest and fastest
      const d = OneShotLibrary.duration(kind, p);
      let prev = OneShotLibrary.sample(kind, 0, p);
      let t = 0;
      while (t < d + 0.02) {
        t += dt120; // nominal speed; mood speed scales these velocity bounds proportionally
        const o = OneShotLibrary.sample(kind, t, p);
        const j = new OneShotJump(prev, o);
        expect(j.ok, `${kind} jump at t=${t}: ${j}`).toBe(true);
        prev = o;
      }
    }
  };
  test.each(ported)('curvesAreContinuousAt120fps %s', curvesAreContinuousAt120fps);
  // needs WP6 (answer, edge antic, pupil shape and idle game curves)
  test.skip.each(unported)('curvesAreContinuousAt120fps %s', curvesAreContinuousAt120fps);

  test('repeatsVary', () => {
    const rng = new SplitMix64(3);
    const a = OneShotLibrary.makeParams('laugh', rng, { x: 0, y: 0 });
    const b = OneShotLibrary.makeParams('laugh', rng, { x: 0, y: 0 });
    expect(a).not.toEqual(b);
    const oa = OneShotLibrary.sample('laugh', 0.2, a), ob = OneShotLibrary.sample('laugh', 0.2, b);
    expect(oa.delta.equals(ob.delta)).toBe(false);
  });

  test('laughBouncesUpAndSquints', () => {
    const p = new OneShotParams(); p.amp = 1;
    const peak = OneShotLibrary.sample('laugh', 0.21, p);
    expect(Units.canvasY(peak.delta.face('centerY'))).toBeLessThan(-2.0); // up is negative
    expect(peak.lidCoverage.y > 0.25 && peak.lidCoverage.w > 0.25).toBe(true);
    const antic = OneShotLibrary.sample('laugh', 0.08, p);
    expect(antic.delta.face('centerY')).toBeGreaterThan(0); // anticipation dip goes the other way
  });

  test('perkUpPopsAndOpensLids', () => {
    const p = new OneShotParams();
    const o = OneShotLibrary.sample('perkUp', 0.16, p);
    expect(o.faceScaleMul.y).toBeGreaterThan(1.06);
    expect(o.lidCoverage.x).toBeLessThan(0);
    expect(OneShotLibrary.sample('perkUp', 0.08, p).faceScaleMul.y).toBeLessThan(1); // dip first
  });

  test('stretchPreservesVolume', () => {
    const o = OneShotLibrary.sample('stretch', 0.6, new OneShotParams());
    expect(o.faceScaleMul.y).toBeGreaterThan(1.12);
    expect(Math.abs(o.faceScaleMul.x * Math.sqrt(o.faceScaleMul.y) - 1)).toBeLessThan(1e-4);
  });

  test('lookAwayTargetIsSideAndDown', () => {
    const rng = new SplitMix64(11);
    for (let n = 0; n < 20; n++) {
      const p = OneShotLibrary.makeParams('lookAway', rng, { x: 0, y: 0 });
      const g = OneShotLibrary.sample('lookAway', 0, p).gaze;
      expect(g !== null && Math.abs(g.point.x) >= 0.5 && g.point.y > 0.2).toBe(true);
    }
  });

  test('doubleTakeReturnsToOrigin', () => {
    const rng = new SplitMix64(2);
    const origin = { x: 0.5, y: 0.1 };
    const p = OneShotLibrary.makeParams('doubleTake', rng, origin);
    const away = OneShotLibrary.sample('doubleTake', 0.2, p).gaze!.point;
    expect(away.x).toBeLessThan(origin.x); // glances toward the side with more room
    expect(OneShotLibrary.sample('doubleTake', 0.8, p).gaze!.point).toEqual(origin);
    expect(OneShotLibrary.sample('doubleTake', 1.3, p).gaze).toBeNull();
  });
});

// MARK: - Sampler / Apply

describe('OneShotSamplerTests', () => {
  const runsToCompletionContinuouslyAndReportsOnce = (kind: OneShotKind): void => {
    const rig = new OneShotRig(7);
    rig.request(kind);
    let prev = new OneShotOutput();
    let completions = 0;
    let frames = 0;
    let sawActive = false;
    while (frames < 900) {
      rig.step(dt120);
      frames += 1;
      const o = rig.s.oneShot;
      expect(isFinite(o)).toBe(true);
      const j = new OneShotJump(prev, o);
      expect(j.ok, `${kind} frame ${frames}: ${j}`).toBe(true);
      prev = o;
      if (rig.s.activeOneShots.includes(kind)) sawActive = true;
      completions += rig.s.completedOneShots.filter((k) => k === kind).length;
      if (completions > 0 && frames > 400 && !rig.sampler.isSpringReleasing) break;
    }
    expect(sawActive).toBe(true);
    expect(completions).toBe(1);
    expect(isIdentity(rig.s.oneShot)).toBe(true);
    expect(rig.s.oneShot.gaze === null && !rig.s.oneShot.ownsClosure).toBe(true);
    expect(rig.s.activeOneShots).toEqual([]);
    expect(rig.sampler.activeSlotCount).toBe(0);
  };
  test.each(ported)('runsToCompletionContinuouslyAndReportsOnce %s', runsToCompletionContinuouslyAndReportsOnce);
  // needs WP6 (answer, edge antic, pupil shape and idle game curves)
  test.skip.each(unported)('runsToCompletionContinuouslyAndReportsOnce %s', runsToCompletionContinuouslyAndReportsOnce);

  test('applyFoldsIntoAccumulators', () => {
    const s = new FaceState(ExpressionLibrary.bundled(), 0);
    s.delta.setFace('centerY', 2);
    s.faceScaleMul = { x: 1.1, y: 1.0 };
    s.blink = 0.3; s.lidClose = 0.5; s.brightness = 0.8;
    s.lidCoverage = { x: 0.1, y: 0, z: 0, w: 0 };
    s.oneShot.delta.setFace('centerY', 3);
    s.oneShot.faceScaleMul = { x: 2, y: 0.5 };
    s.oneShot.lidCoverage = { x: 0.2, y: 0.3, z: 0, w: -0.1 };
    s.oneShot.blink = 0.6; s.oneShot.lidClose = 0.2; s.oneShot.brightnessMul = 0.5;
    new OneShotApply().update(s);
    expect(s.delta.face('centerY')).toBe(5);
    expect(s.faceScaleMul).toEqual({ x: 2.2, y: 0.5 });
    expect(Math.abs(s.lidCoverage.x - 0.3) < 1e-6 && s.lidCoverage.y === 0.3 && s.lidCoverage.w === -0.1).toBe(true);
    expect(s.blink === 0.6 && s.lidClose === 0.5 && s.brightness === 0.4).toBe(true);
  });

  test('lookAwayOverridesGazeOnFirstFrame', () => {
    const rig = new OneShotRig();
    rig.s.commands.push(FaceCommand.playOneShot('lookAway'));
    rig.step(dt120);
    expect(rig.s.oneShot.gaze).not.toBeNull();
    expect(rig.s.oneShot.gaze?.mode).toBe('saccade');
    expect(rig.s.activeOneShots).toEqual(['lookAway']);
  });

  test('commandsAreNotConsumed', () => {
    const rig = new OneShotRig();
    rig.s.commands.push(FaceCommand.playOneShot('laugh'));
    rig.s.commands.push(FaceCommand.blink);
    rig.s.dt = dt120; rig.s.time += dt120;
    rig.director.run(rig.s);
    expect(rig.s.commands).toEqual([FaceCommand.playOneShot('laugh'), FaceCommand.blink]);
    expect(rig.s.oneShotRequests).toEqual([]);
  });

  test('channelConflictFadesOldOneWithoutJump', () => {
    const rig = new OneShotRig(4);
    rig.request('laugh');
    let prev = new OneShotOutput();
    let laughCompletions = 0;
    for (let frame = 1; frame <= 240; frame++) {
      if (frame === 48) { // 0.4 s: laugh is mid-bounce
        expect(maxAbs(rig.s.oneShot.delta.raw)).toBeGreaterThan(1);
        rig.request('perkUp'); // shares translate/scale/lids
      }
      rig.step(dt120);
      const j = new OneShotJump(prev, rig.s.oneShot);
      expect(j.ok, `frame ${frame}: ${j}`).toBe(true);
      prev = rig.s.oneShot;
      laughCompletions += rig.s.completedOneShots.filter((k) => k === 'laugh').length;
      if (frame === 50) expect(new Set(rig.s.activeOneShots)).toEqual(new Set(['laugh', 'perkUp']));
      if (frame === 48 + 16) expect(rig.s.activeOneShots).toEqual(['perkUp']); // faded within ~120 ms
    }
    expect(laughCompletions).toBe(1); // a conflict-cancelled one-shot still reports (auto-transitions rely on it)
  });

  test('nonConflictingOneShotsOverlap', () => {
    const rig = new OneShotRig();
    rig.request('lookAway'); // gaze, lids
    rig.request('sorryBlink'); // closure, scale, translate
    for (let i = 0; i < 12; i++) rig.step(dt120);
    expect(new Set(rig.s.activeOneShots)).toEqual(new Set(['lookAway', 'sorryBlink']));
    expect(rig.s.oneShot.gaze).not.toBeNull();
  });

  test('retriggerRestartsWithoutJump', () => {
    const rig = new OneShotRig(8);
    rig.request('laugh');
    let prev = new OneShotOutput();
    let completions = 0;
    let activeAt150 = false;
    for (let frame = 1; frame <= 300; frame++) {
      if (frame === 84) rig.request('laugh'); // 0.7 s, past the 0.5 s cooldown
      rig.step(dt120);
      const j = new OneShotJump(prev, rig.s.oneShot);
      expect(j.ok, `frame ${frame}: ${j}`).toBe(true);
      prev = rig.s.oneShot;
      completions += rig.s.completedOneShots.filter((k) => k === 'laugh').length;
      if (frame === 150) activeAt150 = rig.s.activeOneShots.includes('laugh'); // 1.25 s: first instance would be over
    }
    expect(activeAt150).toBe(true);
    expect(completions).toBe(1);
  });

  test('cooldownBlocksRapidRetrigger', () => {
    const rig = new OneShotRig();
    rig.request('laugh');
    for (let i = 0; i < 12; i++) rig.step(dt120);
    rig.request('laugh');
    rig.s.commands.push(FaceCommand.playOneShot('laugh'));
    rig.step(dt120);
    expect(rig.sampler.activeSlotCount).toBe(1);
    for (let i = 0; i < 60; i++) rig.step(dt120); // now ≈0.6 s since the trigger
    rig.request('laugh');
    rig.step(dt120);
    expect(rig.sampler.activeSlotCount).toBe(2); // old one crossfading out, new one starting
  });

  test('duplicateRequestsInOneFrameTriggerOnce', () => {
    const rig = new OneShotRig();
    rig.request('perkUp');
    rig.s.commands.push(FaceCommand.playOneShot('perkUp'));
    rig.step(dt120);
    expect(rig.sampler.activeSlotCount).toBe(1);
  });

  test('stateScopedReleasedOnStateChange', () => {
    const rig = new OneShotRig();
    rig.request('lookAway');
    for (let i = 0; i < 36; i++) rig.step(dt120);
    expect(rig.s.oneShot.gaze).not.toBeNull();
    let prev = rig.s.oneShot;
    rig.setState('engaged');
    let completions = 0;
    for (let frame = 1; frame <= 30; frame++) {
      rig.step(dt120);
      expect(rig.s.oneShot.gaze).toBeNull(); // fading slots never steer gaze
      expect(new OneShotJump(prev, rig.s.oneShot).ok).toBe(true);
      prev = rig.s.oneShot;
      completions += rig.s.completedOneShots.length;
      if (frame === 16) expect(rig.s.activeOneShots).toEqual([]);
    }
    expect(completions).toBe(0);
    expect(isIdentity(rig.s.oneShot)).toBe(true);
  });

  test('nonScopedSurvivesStateChange', () => {
    const rig = new OneShotRig();
    rig.request('dance');
    for (let i = 0; i < 30; i++) rig.step(dt120);
    rig.setState('speaking');
    for (let i = 0; i < 30; i++) rig.step(dt120);
    expect(rig.s.activeOneShots).toEqual(['dance']);
  });

  test('entryOneShotOnStateChangeFrameSurvives', () => {
    const rig = new OneShotRig();
    rig.request('curiousTilt');
    for (let i = 0; i < 30; i++) rig.step(dt120);
    rig.setState('interrupted');
    rig.request('sorryBlink');
    for (let i = 0; i < 20; i++) rig.step(dt120);
    expect(rig.s.activeOneShots).toEqual(['sorryBlink']);
  });

  test.each(['sorryBlink', 'nodOff', 'wake', 'yawn'] as OneShotKind[])('closureOwners %s', (kind) => {
    const rig = new OneShotRig();
    rig.request(kind);
    rig.step(dt120);
    expect(rig.s.oneShot.ownsClosure).toBe(true);
    for (let i = 0; i < 20; i++) rig.step(dt120);
    expect(rig.s.oneShot.ownsClosure).toBe(true);
  });

  test('laughDoesNotOwnClosure', () => {
    const rig = new OneShotRig();
    rig.request('laugh');
    for (let i = 0; i < 20; i++) rig.step(dt120);
    expect(rig.s.oneShot.ownsClosure).toBe(false);
  });

  test('sorryBlinkBlinksTwiceAndResetsBlinkSchedule', () => {
    const rig = new OneShotRig();
    rig.request('sorryBlink');
    let starts = 0;
    let last = rig.s.lastBlinkTime;
    let peak = 0;
    for (let i = 0; i < 70; i++) {
      rig.step(dt120);
      if (rig.s.lastBlinkTime !== last) { starts += 1; last = rig.s.lastBlinkTime; }
      peak = Math.max(peak, rig.s.blink);
    }
    expect(starts).toBe(2);
    expect(peak).toBeGreaterThan(0.95);
  });

  test('nodOffDroopsThenSnapsOpen', () => {
    const rig = new OneShotRig();
    rig.request('nodOff');
    let peak = 0, peakTime = 0;
    let after = 1;
    for (let i = 0; i < 330; i++) {
      rig.step(dt120);
      if (rig.s.lidClose > peak) { peak = rig.s.lidClose; peakTime = rig.s.time; }
      if (rig.s.time > 2.15 && rig.s.time < 2.2) after = rig.s.lidClose;
    }
    expect(peak > 0.7 && peak < 0.9).toBe(true);
    expect(peakTime).toBeGreaterThan(1.5);
    expect(after).toBeLessThan(0.05);
  });

  test('wakeStartsFromCurrentOpening', () => {
    const rig = new OneShotRig();
    rig.request('wake');
    rig.step(dt120);
    expect(rig.s.lidClose).toBeLessThan(0.1); // eased in, never a pop to closed
    let peak = 0;
    for (let i = 0; i < 240; i++) { rig.step(dt120); peak = Math.max(peak, rig.s.lidClose); }
    expect(peak > 0.5 && peak < 1).toBe(true);
  });

  const framesToComplete = (kind: OneShotKind, speed: number, seed: number): number => {
    const rig = new OneShotRig(seed);
    rig.s.modulation.speed = speed;
    rig.request(kind);
    for (let frame = 1; frame <= 2000; frame++) {
      rig.step(dt120);
      if (rig.s.completedOneShots.includes(kind)) return frame;
    }
    return -1;
  };

  test('speedScalesDuration', () => {
    const normal = framesToComplete('dance', 1, 21);
    const fast = framesToComplete('dance', 1.5, 21);
    const slow = framesToComplete('dance', 0.6, 21);
    expect(Math.abs(normal / fast - 1.5)).toBeLessThan(0.03);
    expect(Math.abs(slow / normal - 1 / 0.6)).toBeLessThan(0.03);
    // Clamped to 0.5…1.6.
    expect(framesToComplete('dance', 5, 21)).toBe(framesToComplete('dance', 1.6, 21));
  });

  /// Scripted sequence with conflicts, overlaps, a state release and a retrigger.
  const runScript = (fps: number): OneShotOutput[] => {
    const rig = new OneShotRig(1234);
    const dt = 1 / fps;
    const perSixty = fps / 60;
    const out: OneShotOutput[] = [];
    for (let frame = 0; frame < 60 * 5 * perSixty; frame++) {
      if (frame % perSixty === 0) {
        switch (frame / perSixty) { // 60 fps frame index
          case 0: rig.request('laugh'); break;
          case 30: rig.s.commands.push(FaceCommand.playOneShot('lookAway')); break;
          case 54: rig.request('confusedShake'); break; // conflicts with laugh (translate, lids)
          case 75: rig.setState('thinking'); break; // releases lookAway
          case 90: rig.request('nodOff'); break;
          case 180: rig.request('bigSurprise'); break;
          case 230: rig.request('bigSurprise'); break; // retrigger
          default: break;
        }
      }
      rig.step(dt);
      if ((frame + 1) % perSixty === 0) out.push(rig.s.oneShot);
    }
    return out;
  };

  test('sixtyAndOneTwentyFpsMatch', () => {
    const a = runScript(60), b = runScript(120);
    expect(a.length).toBe(b.length);
    let worst = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      const d = y.delta.sub(x.delta);
      let e = Math.max(Math.abs(d.face('centerX')) * Canvas.xFactor, Math.abs(d.face('centerY')) * Canvas.yFactor,
        Math.abs(d.face('angle')) * 0.1);
      e = Math.max(e, maxAbs(sub(x.faceScaleMul, y.faceScaleMul)), maxAbs(sub(x.lidCoverage, y.lidCoverage)),
        Math.abs(x.lidClose - y.lidClose), Math.abs(x.blink - y.blink), Math.abs(x.brightnessMul - y.brightnessMul));
      worst = Math.max(worst, e);
      expect(x.gaze).toEqual(y.gaze);
      expect(x.ownsClosure).toBe(y.ownsClosure);
    }
    expect(worst, `worst 60/120 difference ${worst}`).toBeLessThan(1e-3);
  });

  // needs WP6 (requests every kind: edge antic and idle game specs and curves)
  test.skipIf(!allPorted)('capacityOverflowAllKindsAtOnce', () => {
    const rig = new OneShotRig(77);
    for (const k of OneShotKind.allCases) rig.request(k);
    let prev = new OneShotOutput();
    for (let frame = 1; frame <= 960; frame++) { // 8 s: the longest idle game plays out
      rig.step(dt120);
      expect(rig.sampler.activeSlotCount).toBeLessThanOrEqual(OneShotSampler.capacity);
      expect(isFinite(rig.s.oneShot)).toBe(true);
      expect(new OneShotJump(prev, rig.s.oneShot).ok, `frame ${frame}`).toBe(true);
      prev = rig.s.oneShot;
    }
    expect(rig.sampler.activeSlotCount).toBe(0);
    expect(isIdentity(rig.s.oneShot)).toBe(true);
  });

  test('overflowMidAnimationEvictsWithoutJump', () => {
    const rig = new OneShotRig(31);
    rig.request('laugh');
    for (let i = 0; i < 26; i++) rig.step(dt120); // laugh near its first peak, full weight
    expect(maxAbs(rig.s.oneShot.delta.raw)).toBeGreaterThan(2);
    let prev = rig.s.oneShot;
    // Seven lid-sharing requests in one frame: the slots fill, then the weakest fading one is evicted.
    for (const k of ['perkUp', 'confusedShake', 'delightedSquint', 'stretch', 'bigSurprise', 'dance',
      'mockOffense'] as OneShotKind[]) {
      rig.request(k);
    }
    for (let frame = 1; frame <= 400; frame++) {
      rig.step(dt120);
      expect(rig.sampler.activeSlotCount).toBeLessThanOrEqual(OneShotSampler.capacity);
      const j = new OneShotJump(prev, rig.s.oneShot);
      expect(j.ok, `frame ${frame}: ${j}`).toBe(true);
      prev = rig.s.oneShot;
      if (frame === 20) expect(rig.s.activeOneShots).toEqual(['mockOffense']); // last request wins the channels
    }
  });

  test('lowPriorityDisjointOneShotDoesNotDisturbHighPriority', () => {
    const rig = new OneShotRig();
    rig.request('wake'); // priority 9
    rig.step(dt120);
    rig.request('sideEye'); // priority 2, disjoint channels → coexists
    rig.step(dt120);
    expect(new Set(rig.s.activeOneShots)).toEqual(new Set(['wake', 'sideEye']));
    const wakeBefore = rig.s.oneShot.lidClose;
    rig.step(dt120);
    expect(rig.s.oneShot.lidClose).toBeGreaterThanOrEqual(wakeBefore); // wake keeps playing
  });
});
