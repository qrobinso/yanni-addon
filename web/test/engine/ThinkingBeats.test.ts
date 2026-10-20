// Port of Tests/FaceEngineTests/ThinkingBeatsTests.swift.
import { describe, expect, test } from 'vitest';
import {
  FaceEngine, Mood, ThinkingBeats, makePersonTarget, missingModifiers, type AgentState,
} from '../../src/engine';
import { ThinkingBeat, type ThinkingBeatParams } from '../../src/engine/modifiers/ThinkingBeats';
import { BeatPose, ThinkingBeatCurves } from '../../src/engine/modifiers/ThinkingBeatCurves';
import { Units, type Side } from '../../src/model';

// needs the full default stack (every modifier ported)
const fullStack = missingModifiers().length === 0;

interface Rec { beat: ThinkingBeat; after: number }

const tbOf = (e: FaceEngine): ThinkingBeats => e.director.modifier('ThinkingBeats') as ThinkingBeats;

function engine(seed: number, o: { mood?: Mood; reduceMotion?: boolean; bedtime?: boolean } = {}): FaceEngine {
  const e = new FaceEngine({ seed });
  e.setMood(o.mood ?? Mood.playful);
  const p = e.pupilReactionSettings;
  p.reduceMotion = o.reduceMotion ?? false;
  e.pupilReactionSettings = p;
  e.setBedtime(o.bedtime ?? false);
  for (let i = 0; i < 60; i++) e.tick(1 / 60);
  return e;
}

/// Thinks for `seconds`, recording each beat as it starts.
function think(e: FaceEngine, seconds: number, each: (e: FaceEngine) => void = () => {}): Rec[] {
  e.setAgentState('thinking');
  const out: Rec[] = [];
  let lastStart = -1;
  const tb = tbOf(e);
  for (let i = 0; i < Math.trunc(seconds * 60); i++) {
    e.tick(1 / 60);
    if (tb.current !== null && tb.currentStartedAfter !== lastStart) {
      lastStart = tb.currentStartedAfter;
      out.push({ beat: tb.current, after: tb.currentStartedAfter });
    }
    each(e);
  }
  return out;
}

const beatsOf = (r: Rec[]): ThinkingBeat[] => r.map((x) => x.beat);
const vmax = (...v: number[]): number => Math.max(...v.map(Math.abs));

/// Thinking beats (thinking beats design): escalation, no repeats, the Reduce Motion / calm sets, the "aha!" perk,
/// stopping on a state change, amplitude bounds and curves that start and end at rest. Deterministic: seeded engines.
describe('ThinkingBeats', () => {
  test.skipIf(!fullStack).each([1, 2, 3, 4, 5, 6, 7, 8])('escalatesWithTimeAndNeverRepeats(seed: %i)', (seed) => {
    const recs = think(engine(seed), 14);
    expect(recs.length, `a busy wait: ${recs.length} beats`).toBeGreaterThanOrEqual(5);
    const first = recs[0];
    expect(first.after >= 0.15 && first.after <= 0.45, `the first beat comes quickly (${first.after})`).toBe(true);
    for (const r of recs) {
      const band = ThinkingBeats.band(r.after);
      expect(ThinkingBeat.belongs(r.beat, band) || ThinkingBeat.isGentle(r.beat), `${r.beat} at ${r.after} s is in band ${band}`)
        .toBe(true);
    }
    for (let i = 1; i < recs.length; i++) expect(recs[i - 1].beat !== recs[i].beat, `no immediate repeat: ${recs[i].beat}`).toBe(true);
    expect(recs.filter((r) => r.beat === 'question').length, 'the question mark at most once').toBeLessThanOrEqual(1);
    // The long wait settles into the "still working" loop: scan and peek, a few seconds apart.
    const late = recs.filter((r) => r.after >= 6);
    expect(late.every((r) => r.beat === 'scan' || r.beat === 'peek')).toBe(true);
  });

  test.skipIf(!fullStack)('everyBandIsReachedAcrossSeeds', () => {
    const seen = new Set<ThinkingBeat>();
    for (let seed = 1; seed <= 24; seed++) for (const r of think(engine(seed), 8)) seen.add(r.beat);
    expect([...seen].sort()).toEqual([...ThinkingBeat.allCases].sort());
  });

  test.skipIf(!fullStack)('reduceMotionKeepsOnlyTheGentleBeats', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const recs = think(engine(seed, { reduceMotion: true }), 12);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.every((r) => r.beat === 'ponder' || r.beat === 'slowBlink'), `${beatsOf(recs)}`).toBe(true);
      for (let i = 1; i < recs.length; i++) expect(recs[i - 1].beat).not.toBe(recs[i].beat);
    }
  });

  test.skipIf(!fullStack)('bedtimeAndSleepyMoodsAreCalm', () => {
    const sleepy = Mood.make(0.1, -0.6, 0);
    let calmCount = 0, livelyCount = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const a = think(engine(seed, { bedtime: true }), 10);
      const b = think(engine(seed, { mood: sleepy }), 10);
      expect([...a, ...b].every((r) => ThinkingBeat.isCalm(r.beat)), `${beatsOf([...a, ...b])}`).toBe(true);
      calmCount += b.length;
      livelyCount += think(engine(seed, { mood: Mood.make(0.6, 0.6, 0.2) }), 10).length;
    }
    expect(calmCount < livelyCount, `sleepy moods have fewer beats (${calmCount} vs ${livelyCount})`).toBe(true);
  });

  test.skipIf(!fullStack)('theGovernorThinsThemOut', () => {
    let full = 0, thin = 0;
    for (let seed = 1; seed <= 6; seed++) {
      full += think(engine(seed), 12).length;
      const e = engine(seed);
      tbOf(e).rate = ThinkingBeats.governorRate(3);
      thin += think(e, 12).length;
    }
    expect(thin < full, `${thin} vs ${full}`).toBe(true);
  });

  test.skipIf(!fullStack)('ahaPerkWhenTheReplyArrives', () => {
    const e = engine(9);
    think(e, 1.5);
    e.setAgentState('speaking');
    let perked = false;
    for (let i = 0; i < 6; i++) { e.tick(1 / 60); perked = perked || e.state.activeOneShots.includes('perkUp'); }
    expect(perked, 'thinking → speaking plays the aha perk').toBe(true);

    const f = engine(9);
    think(f, 1.5);
    f.setAgentState('listening'); // barge-in: no aha
    let other = false;
    for (let i = 0; i < 6; i++) { f.tick(1 / 60); other = other || f.state.activeOneShots.includes('perkUp'); }
    expect(other).toBe(false);
  });

  test.skipIf(!fullStack).each<AgentState>(['listening', 'speaking', 'sheepish'])('stopsOnAStateChangeWithNoLeftoverPose(%s)', (to) => {
    for (const beat of ThinkingBeat.allCases) {
      if (beat === 'question') continue;
      const e = engine(11);
      e.setAgentState('thinking');
      e.tick(1 / 60);
      tbOf(e).play(beat);
      for (let i = 0; i < 30; i++) e.tick(1 / 60);
      const tb = tbOf(e);
      expect(tb.current).toBe(beat);
      e.setAgentState(to);
      for (let i = 0; i < Math.trunc(Math.fround(ThinkingBeats.releaseDuration) * 60) + 2; i++) e.tick(1 / 60);
      expect(tb.current, `${beat} let go`).toBeNull();
      const o = tb.lastOutput;
      const nothingLeft = o.delta.raw.every((v) => v === 0) && vmax(o.lidCoverage.x, o.lidCoverage.y, o.lidCoverage.z, o.lidCoverage.w) === 0
        && o.blink === 0 && o.browDelta.raw.every((v) => v === 0) && tb.lastGazeOffset.x === 0 && tb.lastGazeOffset.y === 0;
      expect(nothingLeft, `${beat}: nothing left`).toBe(true);
      for (let i = 0; i < 300; i++) { e.tick(1 / 60); expect(tb.current).toBeNull(); }
    }
  });

  test.skipIf(!fullStack)('theQuestionMarkSwitchesBackOnBargeIn', () => {
    const e = engine(12);
    e.setAgentState('thinking');
    e.tick(1 / 60);
    tbOf(e).play('question');
    for (let i = 0; i < 20; i++) e.tick(1 / 60);
    expect(e.state.activeOneShots.includes('questionEyes')).toBe(true);
    e.setAgentState('listening');
    for (let i = 0; i < 60; i++) e.tick(1 / 60);
    expect(e.state.activeOneShots.includes('questionEyes'), 'switched back well before its hold ended').toBe(false);
  });

  test.skipIf(!fullStack)('amplitudesStayBounded', () => {
    const sides: Side[] = ['left', 'right'];
    for (let seed = 1; seed <= 10; seed++) {
      const e = engine(seed, { mood: Mood.make(1, 1, 1) });
      e.setPeople([makePersonTarget(1, { x: 0.9, y: 0.6 })], 1);
      let bad: string | null = null;
      think(e, 10, (e) => {
        if (bad !== null) return;
        const o = tbOf(e).lastOutput;
        const lc = [o.lidCoverage.x, o.lidCoverage.y, o.lidCoverage.z, o.lidCoverage.w];
        const es = [o.eyeScaleMul.x, o.eyeScaleMul.y, o.eyeScaleMul.z, o.eyeScaleMul.w];
        const fs = [o.faceScaleMul.x, o.faceScaleMul.y];
        const ps = [o.pupilSizeMul.x, o.pupilSizeMul.y];
        const br = Array.from(o.browDelta.raw);
        const g = e.state.gazeTarget.point;
        const checks: [boolean, string][] = [
          [Math.abs(o.delta.face('angle')) <= 4, 'angle'],
          [Math.abs(Units.canvasY(o.delta.face('centerY'))) <= 2, 'face centerY'],
          ...sides.flatMap((side): [boolean, string][] => [
            [Math.abs(Units.canvasY(o.delta.eye(side, 'centerY'))) <= 3.5, `${side} centerY`],
            [Math.abs(o.delta.eye(side, 'x')) <= 0.75, `${side} pupil x`],
          ]),
          [Math.min(...lc) >= -0.45 && Math.max(...lc) <= 0.45, 'lidCoverage'],
          [Math.min(...br) >= -0.12 && Math.max(...br) <= 0.3, 'browDelta'],
          [Math.min(...fs) >= 0.95 && Math.max(...fs) <= 1.1, 'faceScaleMul'],
          [Math.min(...es) >= 0.88 && Math.max(...es) <= 1, 'eyeScaleMul'],
          [Math.min(...ps) >= 0.9 && Math.max(...ps) <= 1.2, 'pupilSizeMul'],
          [o.blink >= 0 && o.blink <= 1, 'blink'],
          [Math.abs(g.x) <= 1 && Math.abs(g.y) <= 1, 'gaze contained'],
        ];
        for (const [ok, what] of checks) if (!ok) { bad = `seed ${seed} t ${e.state.time}: ${what}`; break; }
      });
      expect(bad).toBeNull();
    }
  });

  test('curvesStartAndEndAtRest', () => {
    for (const beat of ThinkingBeat.allCases) {
      for (const side of [-1, 1]) {
        const p: ThinkingBeatParams = { side, amp: 1, gazeAmp: 1, tempo: 1, smile: 0 };
        for (const t of [0, Math.fround(ThinkingBeat.duration(beat))]) {
          const pose = new BeatPose();
          ThinkingBeatCurves.sample(beat, t, p, { x: Math.fround(0.55 * side), y: -0.7 }, { x: 0, y: 0 }, pose);
          const o = pose.o;
          const rest = vmax(...o.delta.raw) < 1e-3
            && vmax(o.lidCoverage.x, o.lidCoverage.y, o.lidCoverage.z, o.lidCoverage.w) < 1e-3
            && vmax(...o.browDelta.raw) < 1e-3 && o.blink < 1e-3 && vmax(pose.gaze.x, pose.gaze.y) < 1e-3
            && vmax(o.faceScaleMul.x - 1, o.faceScaleMul.y - 1) < 1e-3
            && vmax(o.eyeScaleMul.x - 1, o.eyeScaleMul.y - 1, o.eyeScaleMul.z - 1, o.eyeScaleMul.w - 1) < 1e-3
            && vmax(o.pupilSizeMul.x - 1, o.pupilSizeMul.y - 1) < 1e-3;
          expect(rest, `${beat} at ${t} s (side ${side}) is at rest`).toBe(true);
        }
      }
    }
  });
});
