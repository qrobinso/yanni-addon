// Port of Tests/FaceEngineTests/EdgeAnticTests.swift.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import type { V2 } from '../../src/core/vec';
import {
  AgentState, Composer, EdgeAnticContext, EdgeAnticSettings, FaceCommand, FaceState, OneShotChannels, OneShotKindSet,
  OneShotLibrary, OneShotOutput, makeOneShotCancel, makePersonTarget, type OneShotKind,
} from '../../src/engine';
import { edgeStageSpeedLimit } from '../../src/engine/EdgeAnticCurves';
import { Canvas, EdgeGeometry, ExpressionLibrary, FaceFrame, ParamLayout, type Side } from '../../src/model';
import { EdgeRig, EdgeSamplerRig, EdgeTriggerRig, allEdgeAntics, screenAntics } from './EdgeRigs';

const length = (v: V2): number => Math.sqrt(v.x * v.x + v.y * v.y);
const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
const ctx = (o: ConstructorParameters<typeof EdgeAnticContext>[0] = {}): EdgeAnticContext =>
  new EdgeAnticContext({ geometry: EdgeGeometry.reference, ...o });
const zero = { x: 0, y: 0 };
const isZero2 = (v: V2): boolean => v.x === 0 && v.y === 0;
const isZero4 = (v: { x: number; y: number; z: number; w: number }): boolean => v.x === 0 && v.y === 0 && v.z === 0 && v.w === 0;
const LONG = 600_000;

// MARK: - Library and staging

describe('EdgeAnticLibraryTests', () => {
  /// Pupils lead, then the eye shapes, then the whole face (measured onset of each layer).
  test.each(allEdgeAntics)('stagingOnsetOrder(%s)', (kind) => {
    for (const side of [1, -1]) {
      const rng = new SplitMix64(9);
      const p = OneShotLibrary.makeParams(kind, rng, zero, ctx({ sideHint: side }));
      let pupil: number | null = null, eye: number | null = null, face: number | null = null;
      let t = Math.fround(0.001);
      while (t < 1.5 && (pupil === null || eye === null || face === null)) {
        const o = OneShotLibrary.sample(kind, Math.fround(t * p.timeMul), p);
        const pupilMove = o.gaze !== null || Math.abs(o.delta.eye('left', 'x')) > 0.005 || Math.abs(o.delta.eye('left', 'y')) > 0.005;
        if (pupil === null && pupilMove) pupil = t;
        const e = o.eyeStageOffset;
        if (eye === null && Math.max(Math.abs(e.x), Math.abs(e.y), Math.abs(e.z), Math.abs(e.w)) > 0.01) eye = t;
        if (face === null && Math.max(Math.abs(o.stageOffset.x), Math.abs(o.stageOffset.y)) > 0.01) face = t;
        t = Math.fround(t + 0.001);
      }
      expect(pupil !== null && eye !== null && face !== null).toBe(true);
      expect(pupil! < eye! && eye! < face!, `${kind}: pupils ${pupil}, eyes ${eye}, face ${face}`).toBe(true);
    }
  });

  /// Authored stage motion stays under the stage speed bound, with bounded acceleration.
  test.each(allEdgeAntics)('stageContinuityBound(%s)', (kind) => {
    const rng = new SplitMix64(3);
    for (let i = 0; i < 6; i++) {
      const st = new EdgeAnticSettings();
      st.timingScale = EdgeAnticSettings.timingScaleRange[0]; // fastest
      st.intensity = 2;
      const p = OneShotLibrary.makeParams(kind, rng, zero, ctx({ settings: st }));
      // Played at the fastest allowed speed.
      const speed = OneShotLibrary.spec(kind).speedRange?.[1] ?? 1;
      const dt = Math.fround(1.0 / 120);
      const d = OneShotLibrary.duration(kind, p);
      let prev: V2[] = [], prevV: V2[] = [];
      let t = 0, maxV = 0, maxA = 0;
      while (t <= d) {
        const o = OneShotLibrary.sample(kind, t, p);
        const e = o.eyeStageOffset;
        const cur = [{ x: o.stageOffset.x + e.x, y: o.stageOffset.y + e.y }, { x: o.stageOffset.x + e.z, y: o.stageOffset.y + e.w }];
        if (prev.length) {
          const v = cur.map((c, j) => ({ x: (c.x - prev[j].x) / dt, y: (c.y - prev[j].y) / dt })); // per engine dt
          maxV = Math.max(maxV, length(v[0]), length(v[1]));
          if (prevV.length) {
            maxA = Math.max(maxA, length(sub(v[0], prevV[0])) / dt, length(sub(v[1], prevV[1])) / dt);
          }
          prevV = v;
        }
        prev = cur;
        t = Math.fround(t + Math.fround(dt * speed));
      }
      expect(maxV, `${kind} stage speed ${maxV}`).toBeLessThanOrEqual(edgeStageSpeedLimit);
      expect(maxA, `${kind} stage acceleration ${maxA}`).toBeLessThanOrEqual(12000);
    }
  });

  test('accumulateIncludesEyeScale', () => {
    const src = new OneShotOutput();
    src.eyeScaleMul = { x: 1.2, y: 0.8, z: 1, w: 1.1 };
    src.stageOffset = { x: 10, y: -4 };
    src.eyeStageOffset = { x: 1, y: 2, z: 3, w: 4 };
    const o = new OneShotOutput();
    OneShotLibrary.accumulate(src, 0.5, o);
    expect(Math.abs(o.eyeScaleMul.x - 1.1) < 1e-6 && Math.abs(o.eyeScaleMul.y - 0.9) < 1e-6 && Math.abs(o.eyeScaleMul.w - 1.05) < 1e-6).toBe(true);
    expect(o.stageOffset.x === 5 && o.stageOffset.y === -2).toBe(true);
    expect(o.eyeStageOffset).toEqual({ x: 0.5, y: 1, z: 1.5, w: 2 });
  });

  test('specsAreSpringReleasedAndScoped', () => {
    for (const k of screenAntics) {
      const s = OneShotLibrary.spec(k);
      expect(s.releaseStyle).toBe('spring');
      expect(!s.releases('noticing') && !s.releases('idle') && s.releases('listening')).toBe(true);
      expect(s.cooldown, 'cooldown covers the antic').toBeGreaterThanOrEqual(s.duration);
      expect(s.priority >= 3 && s.priority <= 4).toBe(true);
    }
    const sink = OneShotLibrary.spec('sleepySink');
    expect(sink.releaseStyle === 'spring' && !sink.releases('asleep') && sink.releases('waking')).toBe(true);
    // port-note: Swift also checks MemoryLayout<OneShotChannels.RawValue>.size == 2; here, every channel fits 16 bits.
    expect(OneShotChannels.translate).toBe(1);
    expect(OneShotChannels.pupilShape).toBeLessThan(1 << 16);
  });

  /// Partial travel follows `travel`; hidden targets don't.
  test('travelNeverScalesHiddenTargets', () => {
    const a = new EdgeAnticSettings(), b = new EdgeAnticSettings();
    a.travel = 0.6; b.travel = 1.4;
    const pa = OneShotLibrary.makeParams('shyPeek', new SplitMix64(2), zero, ctx({ settings: a, sideHint: 1 }));
    const pb = OneShotLibrary.makeParams('shyPeek', new SplitMix64(2), zero, ctx({ settings: b, sideHint: 1 }));
    expect(pa.edge.hide).toBe(pb.edge.hide);
    expect(pa.edge.near, 'a bigger travel peeks further onto the screen').toBeGreaterThan(pb.edge.near);
    const la = OneShotLibrary.makeParams('curiousLean', new SplitMix64(2), zero, ctx({ settings: a }));
    const lb = OneShotLibrary.makeParams('curiousLean', new SplitMix64(2), zero, ctx({ settings: b }));
    expect(la.edge.near).toBeLessThan(lb.edge.near);
  });
});

// MARK: - Settings

describe('EdgeAnticSettingsTests', () => {
  test('validatedClampsAndRejectsNonFinite', () => {
    const s = new EdgeAnticSettings();
    s.frequency = 100; s.travel = -1; s.intensity = NaN; s.timingScale = 9; s.maxHiddenSeconds = 0.1;
    s.shyPeek.weight = 10; s.popUp.cooldown = 1; s.greetingChance = 2; s.sleepySinkChance = Infinity;
    const v = s.validated();
    expect(v.frequency === 4 && v.travel === 0.5 && v.intensity === 1 && v.timingScale === 1.4 && v.maxHiddenSeconds === 0.8).toBe(true);
    expect(v.shyPeek.weight === 3 && v.popUp.cooldown === 10 && v.greetingChance === 1 && v.sleepySinkChance === 0.5).toBe(true);
  });

  test('tolerantDecoding', () => {
    const json = '{"frequency": 2, "travel": "lots", "shyPeek": {"enabled": false}, "unknown": 1, "maxHiddenSeconds": 99}';
    const s = EdgeAnticSettings.fromJSON(JSON.parse(json));
    expect(s.frequency === 2 && s.travel === 1 && !s.shyPeek.enabled && s.shyPeek.weight === 1 && s.maxHiddenSeconds === 2).toBe(true);
    const empty = EdgeAnticSettings.fromJSON({});
    expect(empty.equals(new EdgeAnticSettings())).toBe(true);
    const custom = new EdgeAnticSettings();
    custom.intensity = 1.7; custom.pretendExit.enabled = false; custom.quietAtBedtime = false;
    const round = EdgeAnticSettings.fromJSON(JSON.parse(JSON.stringify(custom)));
    expect(round.equals(custom)).toBe(true);
  });
});

// MARK: - Behaviour on a screen

/// Ends the antic at `cancelAt` with `interrupt`; checks the swoop home is velocity-continuous, visible within
/// 0.6 s and at rest within 1 s.
function checkInterrupt(kind: OneShotKind, cancelAt: number, label: string, interrupt: (rig: EdgeRig) => void): void {
  const rig = new EdgeRig();
  rig.play(kind);
  rig.run(cancelAt);
  interrupt(rig);
  let t = 0;
  let prev = rig.frame;
  rig.run(1.2, undefined, (f) => {
    t += 1.0 / 120;
    for (const s of ParamLayout.Side.allCases) {
      // Per-frame stage step at 120 fps: under the release spring's speed (no teleport).
      expect(length(sub(FaceFrame.stage(f, s), FaceFrame.stage(prev, s))), `${label}: jump at ${t}`).toBeLessThan(6);
    }
    if (Math.abs(t - 0.6) < 0.5 / 120) {
      expect(rig.visible('left', f) > 0.5 && rig.visible('right', f) > 0.5, `${label}: not back at 0.6 s`).toBe(true);
    }
    prev = f;
  });
  expect(rig.screenAnticActive, `${label}: still playing`).toBe(false);
  expect(length(rig.frame.stageOffset) < 0.3 && rig.visible('left') > 0.95 && rig.visible('right') > 0.95,
    `${label}: not home after 1.2 s`).toBe(true);
}

describe('EdgeAnticBehaviourTests', () => {
  /// Without screen geometry nothing ever leaves the screen: no screen-edge antic starts, stage stays zero.
  test('headlessNeverPlaysScreenAntics', () => {
    const rig = new EdgeRig({ geometry: null, automatic: true });
    const games = rig.engine.idleGameSettings;
    games.enabled = false; // the idle games play on the reference screen when none is known (idle games design §3)
    rig.engine.idleGameSettings = games;
    let started = 0;
    const countStarted = (): void => {
      started += rig.engine.state.startedOneShots.filter((s) => OneShotKindSet.screenEdgeAntics.contains(s.kind)).length;
    };
    for (const k of screenAntics) rig.engine.send(FaceCommand.playOneShot(k));
    let stageZero = true;
    rig.run(20 * 60, 1.0 / 20, (f) => {
      countStarted();
      if (!isZero2(f.stageOffset) || !isZero4(f.eyeStageOffset)) stageZero = false;
    });
    expect(stageZero).toBe(true);
    rig.engine.setAgentState('noticing');
    rig.run(10 * 60, 1.0 / 20, countStarted);
    expect(started).toBe(0);
    expect(rig.engine.rollSleepySink()).toBe(false);
  }, LONG);

  /// The eye nearer the screen centre peeks back first, at least 0.25 s before the other.
  test.each([1, -1])('shyPeekInnerEyeReturnsFirst(side: %d)', (side) => {
    const rig = new EdgeRig();
    rig.play('shyPeek', side);
    const inner: Side = side > 0 ? 'left' : 'right';
    const outer: Side = side > 0 ? 'right' : 'left';
    let wasHidden = false;
    let innerBack: number | null = null, outerBack: number | null = null;
    let t = 0;
    rig.run(6, undefined, (f) => {
      t += 1.0 / 120;
      if (rig.bothHidden(f)) wasHidden = true;
      if (!wasHidden) return;
      if (innerBack === null && rig.visible(inner, f) > 0.3) innerBack = t;
      if (outerBack === null && rig.visible(outer, f) > 0.3) outerBack = t;
    });
    expect(wasHidden).toBe(true);
    expect(innerBack !== null && outerBack !== null).toBe(true);
    expect(outerBack! - innerBack!, `inner back at ${innerBack}, outer at ${outerBack}`).toBeGreaterThanOrEqual(0.25);
    expect(rig.visible('left') > 0.99 && rig.visible('right') > 0.99).toBe(true);
  });

  /// The trailing eye lingers on screen while the leading eye leaves; the face is never fully hidden, and the
  /// pupils stay within contact range.
  test.each([1, -1])('pretendExitTrailingEyeLingers(side: %d)', (side) => {
    const rig = new EdgeRig();
    rig.play('pretendExit', side);
    const trailing: Side = side > 0 ? 'left' : 'right';
    const leading: Side = side > 0 ? 'right' : 'left';
    let leadingGone = false, minTrailing = 1, everBothHidden = false;
    rig.run(5.5, undefined, (f) => {
      if (rig.visible(leading, f) <= 0) leadingGone = true;
      minTrailing = Math.min(minTrailing, rig.visible(trailing, f));
      if (rig.bothHidden(f)) everBothHidden = true;
    });
    expect(everBothHidden).toBe(false);
    expect(leadingGone).toBe(true);
    expect(minTrailing >= 0.3 && minTrailing < 0.75, `trailing eye lingers half clipped: ${minTrailing}`).toBe(true);
    // Pupil bias (library) stays within ±0.25.
    const p = OneShotLibrary.makeParams('pretendExit', new SplitMix64(4), zero, ctx({ sideHint: side }));
    let t = 0;
    while (t < OneShotLibrary.duration('pretendExit', p)) {
      const o = OneShotLibrary.sample('pretendExit', t, p);
      expect(Math.abs(o.delta.eye('left', 'x')) <= 0.25 + 1e-4 && Math.abs(o.delta.eye('right', 'x')) <= 0.25 + 1e-4).toBe(true);
      t = Math.fround(t + 0.01);
    }
  });

  test('popUpOvershootsAboveRestThenSettles', () => {
    const rig = new EdgeRig();
    rig.play('popUp');
    let deepest = 0, overshoot = 0, minVisible = 1;
    let reachedBottom = false;
    rig.run(4, undefined, (f) => {
      deepest = Math.max(deepest, f.stageOffset.y);
      if (f.stageOffset.y > 0.9 * deepest && deepest > 10) reachedBottom = true;
      if (reachedBottom) overshoot = Math.min(overshoot, f.stageOffset.y);
      minVisible = Math.min(minVisible, rig.visible('left', f), rig.visible('right', f));
    });
    expect(deepest).toBeGreaterThan(20);
    expect(overshoot < -1.5 && overshoot > -6, `overshoot above rest ≈ 3 canvas units: ${overshoot}`).toBe(true);
    expect(minVisible > 0.1 && minVisible < 0.4, `only the tops of the eyes show: ${minVisible}`).toBe(true);
    expect(Math.abs(rig.frame.stageOffset.y)).toBeLessThan(0.05);
  });

  test('curiousLeanClipsTheNearEyePartly', () => {
    for (const side of [1, -1]) {
      const rig = new EdgeRig();
      rig.play('curiousLean', side);
      const near: Side = side > 0 ? 'right' : 'left';
      let minNear = 1;
      rig.run(4.5, undefined, (f) => { minNear = Math.min(minNear, rig.visible(near, f)); });
      expect(minNear > 0.5 && minNear < 0.75, `near eye 25–50 % clipped by its box: ${minNear}`).toBe(true);
    }
  });

  /// A full-stack run of each antic: the eye order never swaps and every antic ends exactly at rest.
  test.each(allEdgeAntics)('eyeOrderAndEndAtRest(%s)', (kind) => {
    const g = EdgeGeometry.reference;
    for (const side of [1, -1]) {
      const rig = new EdgeRig({ state: kind === 'sleepySink' ? 'drowsy' : 'idle' });
      rig.engine.playEdgeAntic(kind, side);
      let played = false;
      let minGap = Infinity;
      rig.run(OneShotLibrary.spec(kind).duration * 1.3 + 1, undefined, (f) => {
        if (rig.engine.state.activeOneShots.includes(kind)) played = true;
        const l = g.leftEyeCenter.x + EdgeGeometry.eyeOffset('left', f).x;
        const r = g.rightEyeCenter.x + EdgeGeometry.eyeOffset('right', f).x;
        minGap = Math.min(minGap, r - l);
      });
      expect(minGap, `${kind} eyes too close / swapped: ${minGap}`).toBeGreaterThanOrEqual(Canvas.eyeWidth * 1.18);
      expect(played).toBe(true);
      expect(isZero2(rig.frame.stageOffset) && isZero4(rig.frame.eyeStageOffset)).toBe(true);
    }
  });

  /// The sleepy sink drifts and bounces fully on screen.
  test('sleepySinkStaysVisible', () => {
    for (const g of [EdgeGeometry.reference, new EdgeGeometry({ visibleHalfExtent: { x: 54, y: 82 }, leftEyeCenter: { x: -21, y: -2 },
      rightEyeCenter: { x: 21, y: 2 }, leftEyeHalfSize: { x: 24.7, y: 28.2 }, rightEyeHalfSize: { x: 22.4, y: 25.7 } })]) {
      const rig = new EdgeRig({ geometry: g, state: 'drowsy' });
      rig.engine.playEdgeAntic('sleepySink');
      let deepest = 0, minVis = 1;
      rig.run(4.5, undefined, (f) => {
        deepest = Math.max(deepest, f.stageOffset.y);
        minVis = Math.min(minVis, rig.visible('left', f), rig.visible('right', f));
      });
      expect(minVis).toBeGreaterThan(0.999);
      expect(deepest).toBeGreaterThan(2);
    }
  });

  // MARK: Cancellation

  /// Engagement mid-hide: smooth cancel to an attentive, visible pose.
  test('engagementDuringHiddenShyPeek', () => {
    checkInterrupt('shyPeek', 1.1, 'engage', (rig) => {
      expect(rig.bothHidden()).toBe(true);
      rig.engine.setPeople([makePersonTarget(1, { x: 0.3, y: 0 })], 1, 1);
      rig.engine.setAgentState('listening');
    });
  });

  test('tapDuringHiddenShyPeek', () => {
    checkInterrupt('shyPeek', 1.1, 'tap', (rig) => {
      expect(rig.bothHidden()).toBe(true);
      rig.engine.send(FaceCommand.tap({ x: 0.2, y: 0 }));
    });
  });

  /// A voice reaction one-shot (paired with a chirp) shares channels: it spring-releases the antic.
  test('voiceReactionDuringHiddenShyPeek', () => {
    checkInterrupt('shyPeek', 1.1, 'voice', (rig) => { rig.engine.send(FaceCommand.playOneShotAt('perkUp', 0)); });
  });

  test('wakeDuringHiddenShyPeek', () => {
    checkInterrupt('shyPeek', 1.1, 'wake', (rig) => { rig.engine.send(FaceCommand.playOneShot('wake')); });
  });

  test('rotationDuringHiddenShyPeek', () => {
    const rig = new EdgeRig();
    rig.play('shyPeek');
    rig.run(1.1);
    expect(rig.bothHidden()).toBe(true);
    // Portrait: a narrower, taller screen.
    const portrait = new EdgeGeometry({ visibleHalfExtent: { x: 54, y: 77.3 }, leftEyeCenter: { x: -21.13, y: -2.22 },
      rightEyeCenter: { x: 21.13, y: 2.22 }, leftEyeHalfSize: { x: 24.69, y: 28.23 }, rightEyeHalfSize: { x: 22.45, y: 25.67 } });
    rig.engine.setEdgeGeometry(portrait);
    rig.geometry = portrait;
    rig.run(1.0);
    expect(rig.screenAnticActive).toBe(false);
    expect(rig.visible('left') > 0.95 && rig.visible('right') > 0.95).toBe(true);
  });

  /// Eviction of a spring slot (a full slot table) also swoops home.
  test('evictionSpringReturns', () => {
    const rig = new EdgeSamplerRig();
    rig.play('shyPeek');
    for (let i = 0; i < 132; i++) rig.step(1.0 / 120);
    const before = rig.stage('left');
    expect(before.x).toBeGreaterThan(60);
    rig.sampler.evictForTesting('shyPeek', rig.s);
    let prev = before;
    let t = 0;
    while (t < 1.6) {
      rig.step(1.0 / 120);
      t = Math.fround(t + Math.fround(1.0 / 120));
      expect(length(sub(rig.stage('left'), prev))).toBeLessThan(6);
      prev = rig.stage('left');
    }
    expect(length(rig.stage('left')) < 0.05 && !rig.sampler.isSpringReleasing).toBe(true);
  });

  /// At every 50 ms of every screen antic, a cancel hands over position and velocity: the stage velocity is
  /// continuous across the release (bounded acceleration), the face is visible within 0.6 s and at rest after
  /// 1 s; and the swoop home is the same at 60 and 120 fps.
  test.each(screenAntics)('springReleaseSweep(%s)', (kind) => {
    const duration = OneShotLibrary.spec(kind).duration;
    const g = EdgeGeometry.reference;
    let cancelAt = 0.05;
    while (cancelAt < duration) {
      const curves: V2[][] = [];
      for (const fps of [60, 120]) {
        const rig = new EdgeSamplerRig({ seed: 11 });
        rig.s.modulation.speed = 1;
        rig.play(kind, 1);
        const dt = Math.fround(1 / fps);
        const pre = Math.round(cancelAt * fps);
        let x0: V2 = zero, x1: V2 = zero;
        for (let i = 0; i < pre; i++) { x0 = x1; rig.step(dt); x1 = rig.stage('left'); }
        rig.s.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.screenEdgeAntics));
        rig.step(dt);
        const x2 = rig.stage('left');
        const dv = length(sub({ x: (x2.x - x1.x) / dt, y: (x2.y - x1.y) / dt }, { x: (x1.x - x0.x) / dt, y: (x1.y - x0.y) / dt }));
        expect(dv, `${kind} at ${cancelAt} (${fps} fps): Δv ${dv}`).toBeLessThanOrEqual(12000 * dt + 4);
        const curve: V2[] = [];
        const step = fps / 60;
        for (let i = 2; i <= Math.trunc(fps * 12 / 10); i++) { // frame 1 was the cancel frame
          rig.step(dt);
          // Common 60 Hz sample times from 2/60 s after the cancel frame's start.
          if (i % step === 0 && Math.trunc(i / step) >= 2) curve.push(rig.stage('left'));
          const t = Math.fround(i * dt);
          if (Math.abs(t - 0.6) < dt / 2) {
            const v = g.visibleFraction('left', rig.stage('left'));
            const w = g.visibleFraction('right', rig.stage('right'));
            expect(v > 0.5 && w > 0.5, `${kind} at ${cancelAt}: not visible at 0.6 s`).toBe(true);
          }
          if (Math.abs(t - 1.0) < dt / 2) {
            expect(length(rig.stage('left')) < 1 && length(rig.stage('right')) < 1, `${kind} at ${cancelAt}: not home after 1 s`).toBe(true);
          }
        }
        curves.push(curve);
      }
      const n = Math.min(curves[0].length, curves[1].length);
      let worst = 0;
      for (let i = 0; i < n; i++) worst = Math.max(worst, length(sub(curves[0][i], curves[1][i])));
      expect(worst, `${kind} at ${cancelAt}: 60/120 fps differ by ${worst}`).toBeLessThan(0.75);
      cancelAt += 0.05;
    }
  }, LONG);

  // MARK: Watchdog

  /// A hide longer than the limit: the playhead jumps to the return keyframe and the face comes back.
  test('watchdogBringsTheFaceBack', () => {
    const rig = new EdgeRig();
    rig.edge.watchdogLimitOverride = 0.2;
    rig.play('shyPeek');
    let hiddenSince: number | null = null, backAt: number | null = null;
    let t = 0;
    rig.run(5, undefined, (f) => {
      t += 1.0 / 120;
      if (rig.bothHidden(f)) { if (hiddenSince === null) hiddenSince = t; } else if (hiddenSince !== null && backAt === null) backAt = t;
    });
    expect(hiddenSince !== null && backAt !== null).toBe(true);
    expect(backAt! - hiddenSince!).toBeLessThanOrEqual(0.2 + 0.6);
    expect(rig.edge.watchdogSeeks === 1 && rig.edge.watchdogReleases === 0).toBe(true);
  });

  /// If jumping ahead can't bring the face back, the antic is spring-released.
  test('watchdogFallsBackToSpringRelease', () => {
    // A screen so small that the eyes are never on it.
    const tiny = new EdgeGeometry({ visibleHalfExtent: { x: 2, y: 2 }, leftEyeCenter: { x: -30, y: 0 }, rightEyeCenter: { x: 30, y: 0 },
      leftEyeHalfSize: { x: 10, y: 10 }, rightEyeHalfSize: { x: 10, y: 10 } });
    const rig = new EdgeRig({ geometry: tiny });
    rig.edge.watchdogLimitOverride = 0.1;
    rig.play('curiousLean');
    rig.run(0.9);
    expect(rig.edge.watchdogSeeks === 1 && rig.edge.watchdogReleases === 1).toBe(true);
    expect(rig.engine.state.activeOneShots.includes('curiousLean')).toBe(false);
  });

  // MARK: Composer

  test('composerBoundsStageAndGoesFast', () => {
    const rig = new EdgeRig();
    rig.play('shyPeek');
    let fast = false;
    let maxStage = 0;
    rig.run(1.0, undefined, (f) => {
      if (f.wantsHighFrameRate && length(f.stageOffset) > 5) fast = true;
      maxStage = Math.max(maxStage, Math.abs(f.stageOffset.x));
    });
    expect(fast, 'stage motion takes the 120 fps path').toBe(true);
    const g = EdgeGeometry.reference;
    expect(maxStage).toBeLessThanOrEqual(g.visibleHalfExtent.x + g.pairHalfWidth + Composer.stageMargin);
    const s = new FaceState(ExpressionLibrary.bundled(), 1);
    s.stageOffset = { x: NaN, y: 1e6 };
    s.edgeGeometry = g;
    Composer.compose(s);
    expect(s.output.stageOffset.x === 0 && s.output.stageOffset.y === g.visibleHalfExtent.y + g.pairHalfHeight + Composer.stageMargin).toBe(true);
  });
});

// MARK: - Triggers

describe('EdgeAnticTriggerTests', () => {
  test.each([1, 2, 3])('spacingCooldownsAndNoRepeats(seed: %d)', (seed) => {
    const t = new EdgeTriggerRig({ seed });
    t.run(3 * 3600);
    const a = t.antics;
    expect(a.length > 40 && a.length < 160, `antics in 3 h: ${a.length}`).toBe(true);
    for (let i = 1; i < a.length; i++) {
      const x = a[i - 1], y = a[i];
      expect(x.kind, 'never the same antic twice in a row').not.toBe(y.kind);
      expect(y.time - x.time).toBeGreaterThanOrEqual(25 - 1e-6);
    }
    const st = new EdgeAnticSettings();
    for (const k of screenAntics) {
      const times = a.filter((e) => e.kind === k).map((e) => e.time);
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1], `${k} cooldown`).toBeGreaterThanOrEqual(st.antic(k)!.cooldown - 1e-6);
    }
    // Antics and idle beats keep 25 s apart both ways.
    for (const x of a) {
      for (const b of t.beatsFired) expect(Math.abs(b.time - x.time), `antic ${x.kind}@${x.time} vs beat ${b.kind}@${b.time}`).toBeGreaterThanOrEqual(25 - 0.06);
    }
    expect(t.beatsFired.length).toBeGreaterThan(0);
  }, LONG);

  test('frequencyScalesHowOften', () => {
    const fast = new EdgeAnticSettings();
    fast.frequency = 2;
    const a = new EdgeTriggerRig({ seed: 5, withBeats: false });
    a.run(2 * 3600);
    const b = new EdgeTriggerRig({ seed: 5, withBeats: false, settings: fast });
    b.run(2 * 3600);
    expect(b.antics.length, `${a.antics.length} → ${b.antics.length}`).toBeGreaterThan(1.4 * a.antics.length);
  }, LONG);

  test.each(AgentState.allCases)('onlyIdleAndNoticing(%s)', (state) => {
    const t = new EdgeTriggerRig({ seed: 7, withBeats: false });
    t.rig.setAgentState(state);
    t.run(15 * 60);
    if (state === 'idle' || state === 'noticing') expect(t.antics.length).toBeGreaterThan(0);
    else expect(t.antics.length, state).toBe(0);
  }, LONG);

  test('noneAtBedtimeSulkingEngagedOrDisabled', () => {
    const cases: [string, (s: FaceState) => void][] = [
      ['bedtime', (s) => { s.isBedtime = true; }],
      ['sulking', (s) => { s.isSulking = true; }],
      ['engaged', (s) => { s.people = [makePersonTarget(1, zero)]; s.primaryPersonID = 1; s.engagedPersonID = 1; }],
      ['disabled', (s) => { s.edgeSettings.enabled = false; }],
      ['no geometry', (s) => { s.edgeGeometry = null; }],
    ];
    for (const [name, setup] of cases) {
      const t = new EdgeTriggerRig({ seed: 8, withBeats: false });
      t.run(15 * 60, undefined, setup);
      expect(t.antics.length, name).toBe(0);
    }
  }, LONG);

  test('greetingChanceHoldsOverSeeds', () => {
    let greeted = 0;
    const trials = 160;
    for (let seed = 0; seed < trials; seed++) {
      const t = new EdgeTriggerRig({ seed: 1000 + seed, withBeats: false });
      t.rig.state.edgeSettings.frequency = 0.25; // keep regular antics out of the way
      t.run(61);
      const before = t.antics.length;
      t.run(3, undefined, (s) => { s.people = [makePersonTarget(1, { x: 0.4, y: 0 })]; s.primaryPersonID = 1; });
      if (t.antics.slice(before).some((e) => e.kind === 'popUp')) greeted += 1;
    }
    const rate = greeted / trials;
    expect(Math.abs(rate - 0.35), `greeting rate ${rate}`).toBeLessThan(0.12);
  }, LONG);

  test('postConversationChanceHoldsOverSeeds', () => {
    let played = 0;
    const trials = 160;
    for (let seed = 0; seed < trials; seed++) {
      const t = new EdgeTriggerRig({ seed: 2000 + seed, withBeats: false });
      t.rig.state.edgeSettings.frequency = 0.25;
      t.rig.setAgentState('speaking');
      t.run(2);
      t.rig.setAgentState('idle');
      const before = t.antics.length;
      t.run(11);
      const after = t.antics.slice(before);
      if (after.some((e) => e.kind === 'curiousLean' || e.kind === 'pretendExit')) played += 1;
      expect(after.some((e) => e.kind === 'shyPeek' || e.kind === 'popUp')).toBe(false);
    }
    const rate = played / trials;
    expect(Math.abs(rate - 0.3), `post-conversation rate ${rate}`).toBeLessThan(0.12);
  }, LONG);

  test('waitsForOtherOneShots', () => {
    const t = new EdgeTriggerRig({ seed: 9, withBeats: true });
    t.run(2 * 3600, undefined, (s) => {
      if (Math.round(s.time * 20) % 300 === 7) s.oneShotRequests.push('dance');
    });
    expect(t.antics.length).toBeGreaterThan(10);
    expect(t.startedOverOthers, 'an antic started on top of another one-shot').toBe(0);
  }, LONG);
});
