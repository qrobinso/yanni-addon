// Port of Tests/FaceEngineTests/IdleGamesTests.swift.
import { describe, expect, test } from 'vitest';
import { EdgeGeometry, PupilShape, type FaceFrame } from '../../src/model';
import {
  AgentState, EdgeAntics, FaceCommand, FaceEngine, IdleGames, Mood, NoticingAttention, OneShotKind, OneShotKindSet,
  isIdleGame, makePersonTarget,
} from '../../src/engine';
import { HideAndSeek } from '../../src/engine/IdleGameCurves+HideAndSeek';
import { ASTRecorder, ASTRig } from './ASTRig';

const allGames = OneShotKindSet.idleGames;
const builtGames = OneShotKind.allCases.filter((k) => IdleGames.built.contains(k));

type Req = { time: number; kind: OneShotKind };
const pairs = <T>(a: T[]): [T, T][] => a.slice(1).map((b, i) => [a[i], b]);

/// Schedules games on the AST rig (requests recorded and consumed, so nothing ever plays and blocks).
function simulate(o: { seed: number; state: AgentState; mood?: Mood; seconds: number; playable?: OneShotKindSet;
  reduceMotion?: boolean; watching?: boolean }): Req[] {
  const games = new IdleGames();
  games.playable = o.playable ?? IdleGames.built;
  const rec = new ASTRecorder();
  const rig = new ASTRig([games, rec], o.seed);
  rig.state.mood = o.mood ?? Mood.playful;
  rig.state.agentState = o.state;
  rig.state.pupilSettings.reduceMotion = o.reduceMotion ?? false;
  rig.state.noticingWatching = o.watching ?? false;
  rig.run(o.seconds, 1 / 20);
  return rec.requests;
}

// MARK: Full engine

function engine(state: AgentState = 'idle', seed = 3): FaceEngine {
  const e = new FaceEngine({ seed });
  e.setEdgeGeometry(EdgeGeometry.reference);
  const st = e.idleGameSettings;
  st.enabled = false;
  e.idleGameSettings = st;
  const edge = e.edgeAnticSettings;
  edge.enabled = false;
  e.edgeAnticSettings = edge;
  e.setAgentState(state);
  for (let i = 0; i < 30; i++) e.tick(1.0 / 60);
  return e;
}

function atRest(f: FaceFrame): boolean {
  const o = f.eyeStageOffset, s = f.pupilShapeScale;
  return Math.max(o.x, o.y, o.z, o.w, -o.x, -o.y, -o.z, -o.w) < 1 && s.x === 1 && s.y === 1 && s.z === 1 && s.w === 1
    && Math.abs(f.pose.eye('left', 'scaleX') - f.pose.eye('right', 'scaleX')) < 0.15;
}

const na = (e: FaceEngine): NoticingAttention => e.director.modifier('NoticingAttention') as NoticingAttention;

describe('IdleGamesTests', () => {
  // MARK: Schedule

  test.each([1, 2, 3])('twoHoursNoticing(seed: %i)', (seed) => {
    const g = simulate({ seed, state: 'noticing', seconds: 2 * 3600, playable: allGames });
    expect(g.length > 50 && g.length < 110, `≈ one per 90 s, got ${g.length}`).toBe(true);
    for (const [a, b] of pairs(g)) {
      expect(b.time - a.time).toBeGreaterThanOrEqual(EdgeAntics.idleActivitySpacing - 1e-6);
      expect(a.kind, 'never the same game twice in a row').not.toBe(b.kind);
    }
    expect(g.every((x) => IdleGames.noticingPool.includes(x.kind)), 'the noticing pool only').toBe(true);
    const gaps = pairs(g).map(([a, b]) => b.time - a.time).sort((x, y) => x - y);
    const median = gaps[Math.floor(gaps.length / 2)];
    expect(Math.abs(median - 90), `median ${median}`).toBeLessThan(20);
    expect(g[0]?.time ?? 0, 'settles first').toBeGreaterThanOrEqual(IdleGames.settle[0]);
  });

  test('twoHoursIdleUsesTheCalmPoolLessOften', () => {
    const g = simulate({ seed: 4, state: 'idle', seconds: 2 * 3600, playable: allGames });
    expect(g.length > 25 && g.length < 60, `≈ one per 180 s, got ${g.length}`).toBe(true);
    expect(g.every((x) => IdleGames.idlePool.includes(x.kind))).toBe(true);
    for (const [a, b] of pairs(g)) expect(a.kind).not.toBe(b.kind);
  });

  /// Only built games are scheduled, each from its state's pool.
  test('onlyBuiltGamesPlay', () => {
    const n = simulate({ seed: 5, state: 'noticing', seconds: 3600 });
    expect(n.length > 0 && n.every((x) => IdleGames.built.contains(x.kind) && IdleGames.noticingPool.includes(x.kind))).toBe(true);
    const i = simulate({ seed: 5, state: 'idle', seconds: 3600 });
    expect(i.length > 0 && i.every((x) => IdleGames.built.contains(x.kind) && IdleGames.idlePool.includes(x.kind))).toBe(true);
  });

  test('moodGates', () => {
    const low: Mood = { pleasure: -0.4, arousal: 0, dominance: 0 };
    expect(simulate({ seed: 6, state: 'noticing', mood: low, seconds: 1800, playable: allGames })).toEqual([]);
    const tired: Mood = { pleasure: 0.2, arousal: -0.5, dominance: 0 };
    expect(simulate({ seed: 6, state: 'idle', mood: tired, seconds: 1800, playable: allGames })).toEqual([]);
    const calm: Mood = { pleasure: 0.1, arousal: 0, dominance: 0 };
    expect(simulate({ seed: 7, state: 'noticing', mood: calm, seconds: 2 * 3600, playable: allGames }).some((x) => x.kind === 'danceBreak')).toBe(false);
    expect(simulate({ seed: 7, state: 'idle', mood: calm, seconds: 2 * 3600, playable: allGames }).some((x) => x.kind === 'hulaHoop')).toBe(false);
    const happy: Mood = { pleasure: 0.6, arousal: 0.4, dominance: 0 };
    expect(simulate({ seed: 7, state: 'noticing', mood: happy, seconds: 2 * 3600, playable: allGames }).some((x) => x.kind === 'danceBreak')).toBe(true);
    expect(simulate({ seed: 7, state: 'idle', mood: happy, seconds: 2 * 3600, playable: allGames }).some((x) => x.kind === 'hulaHoop')).toBe(true);
  });

  test.each([...AgentState.allCases])('onlyInIdleAndNoticing(%s)', (st) => {
    const g = simulate({ seed: 8, state: st, seconds: 1200, playable: allGames });
    expect(g.length === 0, st).toBe(!(st === 'idle' || st === 'noticing'));
  });

  /// Reduce Motion keeps only the staring contest and catch the fly; the noticing pool has neither.
  test('reduceMotion', () => {
    expect(IdleGames.reduceMotionGames.contains('catchTheFly')).toBe(true);
    const all = simulate({ seed: 9, state: 'idle', seconds: 2 * 3600, playable: allGames, reduceMotion: true });
    expect(all.length > 0 && all.every((x) => IdleGames.reduceMotionGames.contains(x.kind))).toBe(true);
    const built = simulate({ seed: 9, state: 'idle', seconds: 2 * 3600, reduceMotion: true });
    expect(built.some((x) => x.kind === 'staringContest') && built.some((x) => x.kind === 'catchTheFly')).toBe(true);
    expect(built.every((x) => IdleGames.reduceMotionGames.contains(x.kind))).toBe(true);
    expect(simulate({ seed: 9, state: 'noticing', seconds: 3600, reduceMotion: true })).toEqual([]);
  });

  /// While noticing, a game waits until Yanni stops watching the person.
  test('waitsWhileWatching', () => {
    expect(simulate({ seed: 10, state: 'noticing', seconds: 1800, watching: true })).toEqual([]);
  });

  test('keepsClearOfBeatsAndAntics', () => {
    const games = new IdleGames();
    const rec = new ASTRecorder();
    const rig = new ASTRig([games, rec], 11);
    rig.state.agentState = 'noticing';
    let last = -100;
    rig.run(1800, 1 / 20, (r) => {
      // An idle beat every 20 s.
      if (r.state.time - last >= 20) { last = r.state.time; r.state.lastIdleBeatTime = r.state.time; }
    });
    expect(rec.requests, 'a beat every 20 s leaves no 25 s gap').toEqual([]);
  });

  // MARK: Full engine

  /// Engagement, a tap, bedtime or leaving idle mid-game: cancelled, and back at rest within 1 s.
  test.each(builtGames)('interruptionsReturnToRestWithinOneSecond(%s)', (kind) => {
    const cuts: [string, (e: FaceEngine) => void][] = [
      ['engage', (e) => e.setPeople([makePersonTarget(1, { x: 0.1, y: 0 })], 1, 1)],
      ['tap', (e) => e.send(FaceCommand.tap({ x: 0.2, y: 0 }))],
      ['listening', (e) => e.setAgentState('listening')],
      ['rotation', (e) => e.setEdgeGeometry(new EdgeGeometry({
        visibleHalfExtent: { x: 39.29, y: 56.25 }, leftEyeCenter: { x: -21.134, y: -2.221 },
        rightEyeCenter: { x: 21.134, y: 2.221 }, leftEyeHalfSize: { x: 24.669, y: 28.212 },
        rightEyeHalfSize: { x: 22.431, y: 25.652 },
      }))],
    ];
    for (const [name, cut] of cuts) {
      for (const at of [0.6, 1.5, 3.0, 4.2]) {
        const e = engine();
        e.playIdleGame(kind, 1);
        for (let i = 0; i < Math.trunc(at * 60); i++) e.tick(1.0 / 60);
        expect(e.state.activeOneShots.includes(kind), `${kind} playing at ${at}`).toBe(true);
        cut(e);
        for (let i = 0; i < 60; i++) e.tick(1.0 / 60);
        expect(e.state.activeOneShots.includes(kind), `${kind} ${name} at ${at} cancelled`).toBe(false);
        expect(atRest(e.state.output), `${kind} ${name} at ${at}: ${JSON.stringify(e.state.output.eyeStageOffset)}`).toBe(true);
      }
    }
  }, 60_000);

  /// Someone noticed mid-game facing Yanni (NoticingAttention's snap back): cancelled at once, eyes back.
  test('facingSnapBackCancels', () => {
    const e = engine('noticing');
    e.setPeople([makePersonTarget(1, { x: 0.3, y: 0 }, 1.5, 0.5, 0)], 1, null);
    for (let i = 0; i < 60; i++) e.tick(1.0 / 60);
    e.playIdleGame('pingPong');
    for (let i = 0; i < 120; i++) e.tick(1.0 / 60);
    expect(e.state.activeOneShots.includes('pingPong')).toBe(true);
    e.setPeople([makePersonTarget(1, { x: 0.3, y: 0 }, 1.5, 0.5, 0.9)], 1, null);
    for (let i = 0; i < 3; i++) e.tick(1.0 / 60);
    expect(e.state.activeOneShots.includes('pingPong'), 'cancelled within 3 frames').toBe(false);
    for (let i = 0; i < 60; i++) e.tick(1.0 / 60);
    expect(atRest(e.state.output)).toBe(true);
  });

  /// While a game plays the noticing beats wait (no beat, no check-in over it).
  test('noNoticingBeatDuringAGame', () => {
    const e = engine('noticing');
    e.setPeople([makePersonTarget(1, { x: 0.3, y: 0 }, 1.5, 0.5, 0)], 1, null);
    const n = na(e);
    for (let i = 0; i < 60 * 30 && n.interest !== 'distracted'; i++) e.tick(1.0 / 60);
    expect(n.interest).toBe('distracted');
    for (let i = 0; i < 60 * 6 && n.current !== null; i++) e.tick(1.0 / 60);
    e.playIdleGame('basketball');
    const checkIns = n.checkInCount;
    for (let i = 0; i < 60 * 5; i++) {
      e.tick(1.0 / 60);
      if (e.state.activeOneShots.includes('basketball')) expect(n.current).toBeNull();
    }
    expect(n.checkInCount).toBe(checkIns);
  });

  /// Hide-and-seek ends on the person in frame with exclamation pupils, and on a shrug (no pupil shape) alone.
  test('hideAndSeekFindsThePersonInFrame', () => {
    for (const present of [true, false]) {
      const e = engine(present ? 'noticing' : 'idle');
      if (present) {
        e.setPeople([makePersonTarget(1, { x: 0.5, y: 0.1 }, 1.5, 0.5, 0)], 1, null);
        for (let i = 0; i < 120; i++) e.tick(1.0 / 60); // past the newcomer snap-back
      }
      e.playIdleGame('hideAndSeek', 1);
      let exclaim = false, lookedAt = false;
      for (let i = 0; i < Math.trunc(HideAndSeek.duration * 60); i++) {
        const f = e.tick(1.0 / 60);
        if (f.pupilShape.x === PupilShape.exclaim && f.pupilMorph.x > 0) exclaim = true;
        const p = e.state.gazeTarget.point;
        if (e.state.activeOneShots.includes('hideAndSeek') && Math.abs(p.x - 0.5) < 0.02 && Math.abs(p.y - 0.1) < 0.02) lookedAt = true;
      }
      expect(exclaim, `exclaim, present ${present}`).toBe(present);
      expect(lookedAt, `looked at, present ${present}`).toBe(present);
    }
  });

  /// Both eyes are never off screen at once, on either side.
  test.each(builtGames)('neverHidden(%s)', (kind) => {
    const g = EdgeGeometry.reference;
    for (const side of [1, -1]) {
      const e = engine();
      e.playIdleGame(kind, side);
      let hidden = 0;
      for (let i = 0; i < 60 * 8; i++) {
        const f = e.tick(1.0 / 60);
        if (g.visibleFractionIn('left', f) <= 0 && g.visibleFractionIn('right', f) <= 0) hidden += 1;
      }
      expect(hidden / 60 <= e.edgeAnticSettings.maxHiddenSeconds && hidden === 0, `${kind} ${side}`).toBe(true);
    }
  });

  /// The scheduler, end to end: a playful Yanni noticing someone (bored of them) plays games and keeps them apart.
  test('playsWhileNoticingEndToEnd', () => {
    const e = new FaceEngine({ seed: 12 });
    e.setEdgeGeometry(EdgeGeometry.reference);
    e.setAgentState('noticing');
    e.setPeople([makePersonTarget(1, { x: 0.3, y: 0 }, 1.5, 0.5, 0)], 1, null);
    const starts: number[] = [];
    for (let i = 0; i < 60 * 900; i++) {
      e.tick(1.0 / 60);
      for (const s of e.state.startedOneShots) if (isIdleGame(s.kind)) starts.push(s.engineTime);
    }
    expect(starts.length, `${starts.length} games in 15 min`).toBeGreaterThanOrEqual(3);
    for (const [a, b] of pairs(starts)) expect(b - a).toBeGreaterThanOrEqual(EdgeAntics.idleActivitySpacing);
  }, 60_000);
});
