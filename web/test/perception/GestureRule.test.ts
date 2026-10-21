// Port of FacePerceptionTests/GestureRuleTests.swift: the curated gestures' rules and their near-misses, through the
// real processor (perception upgrade design §6.2).
import { describe, expect, test } from 'vitest';
import { CameraGeometry } from '../../src/perception/CameraGeometry';
import { HandShape } from '../../src/perception/HandShapes';
import { PerceptionProcessor } from '../../src/perception/PerceptionProcessor';
import type { GestureObservation } from '../../src/perception/PerceptionTypes';
import { HandModel, SyntheticScene, SyntheticScenes, type HandModelShape } from '../../src/perception/SyntheticScenes';

function gestures(s: SyntheticScene, fps: number | null = null): GestureObservation[] {
  if (fps !== null) s.fps = fps; // the scene getters hand out a fresh scene per read
  const p = new PerceptionProcessor(undefined, new CameraGeometry(undefined, s.cameraOffset), 3);
  const out: GestureObservation[] = [];
  for (const f of s.recording().frames) out.push(...p.process(f).snapshot.gestures);
  return out;
}

const directed = (s: SyntheticScene, fps: number | null = null): string[] =>
  gestures(s, fps).filter((g) => g.directedAtYanni).map((g) => g.kind.kind);

describe('GestureRuleTests', () => {
  test.each([
    ['clap', () => SyntheticScenes.clapAtYanni], ['armsUp', () => SyntheticScenes.armsUpAtYanni],
    ['nod', () => SyntheticScenes.nodding], ['dancing', () => SyntheticScenes.dancing],
    ['peekaboo', () => SyntheticScenes.peekaboo], ['heartHands', () => SyntheticScenes.heartHandsAtOneMetre],
    ['thumbsDown', () => SyntheticScenes.thumbsDown], ['peace', () => SyntheticScenes.peace],
    ['highFive', () => SyntheticScenes.highFiveApproach], ['byeWave', () => SyntheticScenes.byeWaveLeaving],
    ['point', () => SyntheticScenes.farPoint],
  ] as [string, () => SyntheticScene][])('eachGestureFiresDirected %s', (name, scene) => {
    const s = scene();
    const got = directed(s);
    expect(got[0], `${s.name}: ${got}`).toBe(name);
  });

  test.each([
    ['applauding the TV', () => SyntheticScenes.applaudingTV], ['a stretch', () => SyntheticScenes.stretching],
    ['small talking nods', () => SyntheticScenes.smallNods], ['nodding while walking', () => SyntheticScenes.nodWhileWalking],
    ['walking with swinging arms', () => SyntheticScenes.walkingArms], ['covering a yawn', () => SyntheticScenes.yawnCover],
    ['a hidden face without a look first', () => SyntheticScenes.peekabooWithoutLook], ['a fist', () => SyntheticScenes.fistHeld],
    ['talking with hands', () => SyntheticScenes.talkingWithHands], ['the busy none scene', () => SyntheticScenes.busyNone],
  ] as [string, () => SyntheticScene][])('nearMissesNeverFireDirected: %s', (what, scene) => {
    const got = directed(scene());
    expect(got, `${what}: ${got}`).toEqual([]);
  });

  test('applaudingTheTVIsAClapButNotAimed', () => {
    const g = gestures(SyntheticScenes.applaudingTV);
    expect(g.some((x) => x.kind.kind === 'clap' && !x.directedAtYanni)).toBe(true);
  });

  test('walkingIsNeverDancingOrClapping', () => {
    const g = gestures(SyntheticScenes.walkingArms);
    expect(g.some((x) => x.kind.kind === 'dancing' || x.kind.kind === 'clap')).toBe(false);
    expect(gestures(SyntheticScenes.nodWhileWalking).some((x) => x.kind.kind === 'nod')).toBe(false);
  });

  /// Time-based K-of-N: the same shapes fire once, after their hold, at 10, 15 and 30 fps.
  test.each([10, 15, 30])('frameRateIndependent %d fps', (fps) => {
    const cases: [() => SyntheticScene, string, number][] = [
      [() => SyntheticScenes.thumbsUp, 'thumbsUp', 1.5], [() => SyntheticScenes.peace, 'peace', 1.5],
      [() => SyntheticScenes.heartHandsAtOneMetre, 'heartHands', 1.0], [() => SyntheticScenes.clapAtYanni, 'clap', 1.5],
    ];
    for (const [scene, name, start] of cases) {
      // Body pose runs on every other frame: at 10 fps (5 Hz) the stream has no body readings (no tier does that).
      if (fps < 15 && name === 'clap') continue;
      const g = gestures(scene(), fps).filter((x) => x.kind.kind === name);
      expect(g.length, `${name} at ${fps} fps`).toBe(1);
      const t = g[0]?.time;
      if (t !== undefined) {
        expect(t - 1000, `${name} at ${fps}`).toBeGreaterThanOrEqual(start + 0.35);
        expect(t - 1000, `${name} at ${fps}`).toBeLessThanOrEqual(start + 1.3);
      }
    }
  });

  test('dancingReportsStartedAndEnded', () => {
    const g = gestures(SyntheticScenes.dancing).filter((x) => x.kind.kind === 'dancing');
    expect(g.map((x) => x.phase)).toEqual(['started', 'ended']);
    expect(g[0]?.directedAtYanni, 'facing ≥ 0.3 for 4 s').toBe(true);
  });

  test('peekabooFiresAtTheReveal', () => {
    const g = gestures(SyntheticScenes.peekaboo).find((x) => x.kind.kind === 'peekaboo');
    const t = (g?.time ?? 0) - 1000;
    expect(t, 'at the reveal').toBeGreaterThanOrEqual(1.5 + 1.7);
    expect(t, 'at the reveal').toBeLessThanOrEqual(1.5 + 2.1);
  });

  test('farPointGivesTheArmsDirection', () => {
    const k = gestures(SyntheticScenes.farPoint).find((x) => x.kind.kind === 'point')?.kind;
    expect(k?.kind, 'no point').toBe('point');
    if (k?.kind === 'point') expect(k.direction.x).toBeLessThan(-0.9);
  });

  test('handShapesThumbsDownAndPeace', () => {
    const scene = new SyntheticScene('hands', 1, []);
    const hand = (shape: HandModelShape, rotation = 0): HandShape | null =>
      HandShape.classify(HandModel.detection(shape, 'right', rotation, { x: 0.1, y: 0.3, z: 1.2 }, (p) => scene.project(p)),
        undefined, scene.intrinsics.imageSize);
    const down = hand('thumbsUp', Math.PI);
    expect(down?.thumbsDown === true && down?.thumbsUp === false, 'orientation kept: up ≠ down').toBe(true);
    expect(hand('peace')?.peace).toBe(true);
    expect(hand('relaxed')?.peace, 'two fingers together is not a V').toBe(false);
    expect(hand('fist')?.fist).toBe(true);
    expect(hand('open')?.peace).toBe(false);
  });
});
