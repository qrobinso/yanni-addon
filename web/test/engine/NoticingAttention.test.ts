// Port of Tests/FaceEngineTests/NoticingAttentionTests.swift.
import { describe, expect, test } from 'vitest';
import {
  FaceCommand, FaceEngine, Mood, NoticingAttention, ThinkingBeats, gazeLength, makePersonTarget, missingModifiers,
  type AgentState, type PersonTarget,
} from '../../src/engine';
import { NoticingBeat, type NoticingParams } from '../../src/engine/modifiers/NoticingAttention';
import { NoticingBeatCurves } from '../../src/engine/modifiers/NoticingBeatCurves';
import { BeatPose } from '../../src/engine/modifiers/ThinkingBeatCurves';
import type { V2 } from '../../src/core/vec';

// needs the full default stack (every modifier ported)
const fullStack = missingModifiers().length === 0;

const where_: V2 = { x: 0.25, y: 0.05 };
const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });

function person(o: { id?: number; at?: V2; distance?: number; facing?: number } = {}): PersonTarget {
  return makePersonTarget(o.id ?? 1, o.at ?? where_, o.distance ?? 1.4, 0.5, o.facing ?? 0);
}

const na = (e: FaceEngine): NoticingAttention => e.director.modifier('NoticingAttention') as NoticingAttention;

function engine(seed: number, o: { mood?: Mood; reduceMotion?: boolean; bedtime?: boolean } = {}): FaceEngine {
  const e = new FaceEngine({ seed });
  e.setMood(o.mood ?? Mood.playful);
  const p = e.pupilReactionSettings;
  p.reduceMotion = o.reduceMotion ?? false;
  e.pupilReactionSettings = p;
  e.setBedtime(o.bedtime ?? false);
  for (let i = 0; i < 30; i++) e.tick(1 / 60);
  e.setPeople([person()], 1, null);
  e.setAgentState('noticing');
  return e;
}

function run(e: FaceEngine, seconds: number, each: (e: FaceEngine) => void = () => {}): void {
  const n = Math.trunc(seconds * 60);
  for (let i = 0; i < n; i++) { e.tick(1 / 60); each(e); }
}

/// Runs until distracted (at most `limit` s); returns the seconds it took.
function untilDistracted(e: FaceEngine, limit = 30): number | null {
  const a = na(e);
  for (let i = 0; i < Math.trunc(limit * 60); i++) {
    e.tick(1 / 60);
    if (a.interest === 'distracted') return (i + 1) / 60;
  }
  return null;
}

/// Beats in start order over `seconds`.
function beats(e: FaceEngine, seconds: number): NoticingBeat[] {
  const out: NoticingBeat[] = [];
  let was: NoticingBeat | null = null;
  run(e, seconds, (e) => {
    const c = na(e).current;
    if (c !== null && c !== was) out.push(c);
    was = c;
  });
  return out;
}

/// Noticing attention (noticing attention design): interest decay, varied distraction beats, check-ins, the snap backs
/// (facing within a frame or two, a gesture, an approach, a newcomer, a tap), the Reduce Motion / calm / governor sets,
/// and letting go when noticing ends. Deterministic: seeded engines.
describe('NoticingAttention', () => {
  test.skipIf(!fullStack).each([1, 2, 3, 4, 5, 6, 7, 8])('interestDecaysAfterThePatience(seed: %i)', (seed) => {
    const e = engine(seed);
    e.tick(1 / 60);
    expect(na(e).interest, 'noticing someone starts by watching them').toBe('watching');
    const t = untilDistracted(e);
    const k = NoticingAttention.patienceScale(Mood.playful);
    const lo = Math.fround(NoticingAttention.patience[0] * k), hi = Math.fround(NoticingAttention.patience[1] * k);
    expect(t).not.toBeNull();
    if (t !== null) expect(t >= lo - 0.05 && t <= hi + 0.1, `bored after ${t} s (${lo}…${hi})`).toBe(true);
  });

  test.skipIf(!fullStack)('grumpyMoodsGetBoredSoonerThanPlayfulOnes', () => {
    let grumpy = 0, playful = 0;
    for (let seed = 1; seed <= 10; seed++) {
      grumpy += untilDistracted(engine(seed, { mood: Mood.make(-0.6, 0.2, 0.3) })) ?? 30;
      playful += untilDistracted(engine(seed, { mood: Mood.make(0.7, 0.6, 0.2) })) ?? 30;
    }
    expect(grumpy < playful, `grumpy ${grumpy} vs playful ${playful}`).toBe(true);
  });

  test.skipIf(!fullStack).each([1, 2, 3, 4, 5, 6])('distractionBeatsVaryWithNoImmediateRepeats(seed: %i)', (seed) => {
    const recs = beats(engine(seed), 90);
    expect(recs.length, `${recs}`).toBeGreaterThanOrEqual(6);
    expect(new Set(recs).size, `variety: ${recs}`).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < recs.length; i++) expect(recs[i - 1] !== recs[i], `no immediate repeat: ${recs[i]}`).toBe(true);
    expect(recs.includes('sleepyDrift'), 'not tired: no sleepy drift').toBe(false);
  });

  test.skipIf(!fullStack)('everyAwakeBeatIsReachedAcrossSeeds', () => {
    const seen = new Set<NoticingBeat>();
    for (let seed = 1; seed <= 10; seed++) for (const b of beats(engine(seed), 60)) seen.add(b);
    const want = NoticingBeat.allCases.filter((b) => b !== 'sleepyDrift');
    expect([...seen].sort()).toEqual([...want].sort());
  });

  test.skipIf(!fullStack).each([1, 2, 3, 4])('checkInsLookBackAtThePerson(seed: %i)', (seed) => {
    const e = engine(seed);
    untilDistracted(e);
    const a = na(e);
    let checkIns = 0, wasChecking = false, onPerson = 0, checkFrames = 0, ownFrames = 0;
    run(e, 40, (e) => {
      const checking = a.interest === 'checkIn';
      if (checking && !wasChecking) checkIns += 1;
      wasChecking = checking;
      if (checking && e.state.oneShot.gaze === null && !e.state.gazeInterrupted) {
        checkFrames += 1;
        if (gazeLength(sub(e.state.gazeTarget.point, where_)) < 0.15 && e.state.gazeTarget.contact) onPerson += 1;
      }
      if (a.interest === 'distracted' && a.ownsGaze) ownFrames += 1;
    });
    expect(checkIns, `${checkIns} check-ins in 40 s`).toBeGreaterThanOrEqual(3);
    expect(onPerson, `check-ins look at the person (${onPerson}/${checkFrames})`)
      .toBeGreaterThan(Math.trunc(checkFrames * 9 / 10));
    expect(ownFrames, `distracted most of the time (${ownFrames} frames)`).toBeGreaterThan(40 * 60 / 3);
  });

  test.skipIf(!fullStack).each([1, 2, 3, 4, 5])('facingSnapsBackWithinTwoFrames(seed: %i)', (seed) => {
    const e = engine(seed);
    untilDistracted(e);
    run(e, 1.3);
    const a = na(e);
    const snaps = a.snapCount;
    e.setPeople([person({ facing: 0.8 })], 1, null);
    e.tick(1 / 60);
    e.tick(1 / 60);
    expect(a.interest).toBe('watching');
    expect(a.lastSnap === 'facing' && a.snapCount === snaps + 1).toBe(true);
    expect(a.ownsGaze).toBe(false);
    if (e.state.oneShot.gaze === null && !e.state.gazeInterrupted) {
      expect(gazeLength(sub(e.state.gazeTarget.point, where_)), `target ${JSON.stringify(e.state.gazeTarget.point)}`)
        .toBeLessThan(0.15);
      expect(e.state.gazeTarget.contact).toBe(true);
    }
    // The eyes arrive quickly (a saccade, not a slow drift).
    run(e, 0.3);
    expect(gazeLength(sub(e.state.eyeGaze, where_)), `eyes at ${JSON.stringify(e.state.eyeGaze)}`).toBeLessThan(0.15);
    // While they keep facing Yanni it keeps watching: no boredom, no look-aways.
    let owned = 0;
    run(e, 40, () => { if (a.interest !== 'watching' || a.ownsGaze) owned += 1; });
    expect(owned).toBe(0);
  });

  test.skipIf(!fullStack)('lookingAtMeAloneAlsoSnapsBack', () => {
    const e = engine(3);
    untilDistracted(e);
    e.setPeople([makePersonTarget(1, where_, 1.4, 0.5, 0, 0.5)], 1, null);
    e.tick(1 / 60);
    expect(na(e).interest).toBe('watching');
    expect(na(e).lastSnap).toBe('facing');
  });

  test.skipIf(!fullStack)('aGestureSnapsBack', () => {
    const e = engine(4);
    untilDistracted(e);
    e.send(FaceCommand.attend(1));
    e.tick(1 / 60);
    expect(na(e).interest).toBe('watching');
    expect(na(e).lastSnap).toBe('gesture');
  });

  test.skipIf(!fullStack)('aTapSnapsBack', () => {
    const e = engine(5);
    untilDistracted(e);
    e.send(FaceCommand.tap({ x: 0.5, y: 0.5 }));
    e.tick(1 / 60);
    expect(na(e).lastSnap).toBe('tap');
  });

  test.skipIf(!fullStack)('comingCloserSnapsBack', () => {
    // Quickly: 1.8 m → 1.0 m in a second.
    const e = engine(6);
    e.setPeople([person({ distance: 1.8 })], 1, null);
    untilDistracted(e);
    for (let i = 0; i < 60; i++) {
      if (i % 4 === 0) e.setPeople([person({ distance: Math.fround(1.8 - Math.fround(0.8 * i / 60)) })], 1, null);
      e.tick(1 / 60);
      if (na(e).interest === 'watching') break;
    }
    expect(na(e).lastSnap).toBe('approach');
    // Slowly but much closer: 2.2 m → 1.6 m over 6 s.
    const f = engine(7);
    f.setPeople([person({ distance: 2.2 })], 1, null);
    untilDistracted(f);
    for (let i = 0; i < 360; i++) {
      if (i % 4 === 0) f.setPeople([person({ distance: Math.fround(2.2 - Math.fround(0.6 * i / 360)) })], 1, null);
      f.tick(1 / 60);
      if (na(f).lastSnap !== null) break;
    }
    expect(na(f).lastSnap).toBe('approach');
  });

  test.skipIf(!fullStack)('aNewcomerSnapsBack', () => {
    const e = engine(8);
    untilDistracted(e);
    e.setPeople([person(), person({ id: 2, at: { x: -0.5, y: 0.1 } })], 1, null);
    e.tick(1 / 60);
    expect(na(e).interest).toBe('watching');
    expect(na(e).lastSnap).toBe('newcomer');
  });

  test.skipIf(!fullStack)('reduceMotionKeepsTheGentleBeatsAndGlides', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const e = engine(seed, { reduceMotion: true });
      let saccades = 0;
      const recs: NoticingBeat[] = [];
      let was: NoticingBeat | null = null;
      run(e, 70, (e) => {
        const a = na(e);
        if (a.ownsGaze && e.state.gazeTarget.mode === 'saccade') saccades += 1;
        if (a.current !== null && a.current !== was) recs.push(a.current);
        was = a.current;
      });
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.every(NoticingBeat.isGentle), `${recs}`).toBe(true);
      expect(saccades, 'no darting under Reduce Motion').toBe(0);
    }
  });

  test.skipIf(!fullStack)('bedtimeAndTiredMoodsAreCalmAndTiredOnesDrift', () => {
    const tired = Mood.make(0.1, -0.6, 0);
    let drift = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const a = beats(engine(seed, { bedtime: true }), 60);
      const b = beats(engine(seed, { mood: tired }), 60);
      expect([...a, ...b].every(NoticingBeat.isCalm), `${[...a, ...b]}`).toBe(true);
      drift += b.filter((x) => x === 'sleepyDrift').length;
    }
    expect(drift, 'tired moods drift sleepily').toBeGreaterThan(0);
  });

  test.skipIf(!fullStack)('theGovernorDropsTheFlourishes', () => {
    let full = 0, thin = 0;
    for (let seed = 1; seed <= 6; seed++) {
      full += beats(engine(seed), 60).length;
      const e = engine(seed);
      na(e).rate = ThinkingBeats.governorRate(3);
      const b = beats(e, 60);
      expect(b.some(NoticingBeat.isFunny), `${b}`).toBe(false);
      thin += b.length;
    }
    expect(thin < full, `${thin} vs ${full}`).toBe(true);
  });

  test.skipIf(!fullStack).each<AgentState>(['engaged', 'listening', 'drowsy'])('leavingNoticingLetsGoAtOnce(%s)', (to) => {
    for (const beat of NoticingBeat.allCases) {
      const e = engine(11);
      e.tick(1 / 60);
      na(e).play(beat);
      run(e, 0.5);
      const a = na(e);
      expect(a.current).toBe(beat);
      e.setAgentState(to);
      run(e, NoticingAttention.releaseDuration + 0.05);
      expect(a.current === null && a.interest === 'inactive' && !a.ownsGaze, `${beat} let go`).toBe(true);
      expect(a.lastOutput.delta.raw.every((v) => v === 0)).toBe(true);
      expect(a.lastOutput.lidCoverage).toEqual({ x: 0, y: 0, z: 0, w: 0 });
      expect(a.lastOutput.blink).toBe(0);
    }
  });

  test.skipIf(!fullStack)('neverMovesTheGazeOverAOneShot', () => {
    const e = engine(12);
    untilDistracted(e);
    e.send(FaceCommand.playOneShot('lookAway'));
    let clash = 0, owned = 0;
    run(e, 2, (e) => {
      if (e.state.oneShot.gaze !== null) { owned += 1; if (na(e).ownsGaze) clash += 1; }
    });
    expect(owned).toBeGreaterThan(0);
    expect(clash).toBe(0);
  });

  test('beatCurvesStartAndEndAtRest', () => {
    const p: NoticingParams = { side: 1, amp: 1, v: { x: 0.3, y: 0.6, z: 0.2, w: 0.9 } };
    const fly: V2[] = Array.from({ length: 8 }, () => ({ x: 0.1, y: 0.1 }));
    for (const b of NoticingBeat.allCases) {
      for (const t of [0, Math.fround(NoticingBeat.duration(b) - 1e-4)]) {
        const pose = new BeatPose();
        NoticingBeatCurves.sample(b, t, p, { x: 0.4, y: -0.1 }, fly, pose);
        const o = pose.o;
        expect(Math.abs(o.delta.face('angle')) < 0.05 && Math.abs(o.delta.face('centerY')) < 0.02, `${b} pose at ${t}`)
          .toBe(true);
        const lc = o.lidCoverage;
        expect(Math.max(lc.x, lc.y, lc.z, lc.w) < 0.02 && o.blink < 0.02, `${b} lids at ${t}`).toBe(true);
        expect(Math.abs(o.pupilSizeMul.x - 1), `${b} pupils at ${t}`).toBeLessThan(0.02);
      }
    }
  });
});
