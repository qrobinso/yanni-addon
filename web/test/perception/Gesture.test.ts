// Port of FacePerceptionTests/GestureTests.swift: joint-rule gestures, including near-misses.
import { describe, expect, test } from 'vitest';
import { CameraGeometry } from '../../src/perception/CameraGeometry';
import { HandShape } from '../../src/perception/HandShapes';
import { PerceptionProcessor } from '../../src/perception/PerceptionProcessor';
import { PerceptionSettings } from '../../src/perception/PerceptionSettings';
import type { Chirality, GestureObservation, HandDetection, PerceptionTier } from '../../src/perception/PerceptionTypes';
import {
  HandModel, LookTarget, SyntheticGesture, SyntheticPerson, SyntheticScene, SyntheticScenes, type HandModelShape,
} from '../../src/perception/SyntheticScenes';

const scene = new SyntheticScene('hands', 1, []);

function hand(shape: HandModelShape, chirality: Chirality = 'right', rotation = 0, distance = 1.2): HandDetection {
  return HandModel.detection(shape, chirality, rotation, { x: 0.1, y: 0.3, z: distance }, (p) => scene.project(p));
}
const classify = (h: HandDetection): HandShape | null => HandShape.classify(h, undefined, scene.intrinsics.imageSize);

/// Plays a synthetic scene through the processor and returns the gestures.
function gestures(s: SyntheticScene, tier: PerceptionTier = 3): GestureObservation[] {
  const p = new PerceptionProcessor(undefined, new CameraGeometry(undefined, s.cameraOffset), tier);
  const out: GestureObservation[] = [];
  for (const f of s.recording().frames) out.push(...p.process(f).snapshot.gestures);
  return out;
}

const person = (distance: number, gesture: SyntheticGesture, start: number, end: number, hand: Chirality = 'right') =>
  new SyntheticPerson({ path: [[0, 0, distance]], looks: [[0, LookTarget.eyes]], gestures: [[start, end, gesture, hand]] });

describe('GestureTests', () => {
  test('handShapes', () => {
    const up = classify(hand('thumbsUp'))!;
    expect(up.thumbsUp && !up.openPalm && up.pointDirection === null).toBe(true);

    const side = classify(hand('thumbSideways'))!;
    expect(side.thumbsUp, 'a fist with the thumb sideways is not a thumbs up').toBe(false);

    const open = classify(hand('open'))!;
    expect(open.openPalm && open.palmFacing && !open.thumbsUp).toBe(true);

    const openLeft = classify(hand('open', 'left'))!;
    expect(openLeft.openPalm, 'left palm toward the camera').toBe(true);

    // The back of the hand (a right hand mirrored, labelled right) is not a palm toward Yanni.
    const back = hand('open', 'left');
    back.chirality = 'right';
    expect(classify(back)?.openPalm).toBe(false);

    const fist = classify(hand('fist'))!;
    expect(!fist.openPalm && !fist.thumbsUp && fist.pointDirection === null).toBe(true);

    const relaxed = classify(hand('relaxed'))!;
    expect(!relaxed.openPalm && relaxed.pointDirection === null, 'two fingers out is neither palm nor point').toBe(true);

    const point = classify(hand('point', 'left', -Math.PI / 2))!;
    const dir = point.pointDirection!;
    expect(dir.x, 'pointing to the viewer frame\'s left').toBeLessThan(-0.95);
  });

  test('missingJointsGiveNothing', () => {
    const h = hand('open');
    delete h.joints.indexTip;
    expect(classify(h)).toBeNull();
    const low = hand('open');
    low.joints.wrist!.c = 0.1;
    expect(classify(low)).toBeNull();
  });

  test('waveAtYanniIsDirected', () => {
    const waves = gestures(SyntheticScenes.waveAtYanni).filter((g) => g.kind.kind === 'wave');
    expect(waves.length).toBeGreaterThanOrEqual(1);
    expect(waves.every((g) => g.directedAtYanni)).toBe(true);
    expect(waves[0]?.confidence ?? 0, 'confident').toBeGreaterThanOrEqual(0.75);
    expect((waves[0]?.time ?? 9999) - 1000, 'within ≈ 1.5 s of starting').toBeLessThan(3.1);
  });

  test('waveWhileWalkingPastIsNotDirected', () => {
    const waves = gestures(SyntheticScenes.waveWalkingPast).filter((g) => g.kind.kind === 'wave');
    expect(waves.length).toBeGreaterThan(0);
    expect(waves.every((g) => !g.directedAtYanni)).toBe(true);
  });

  test('talkingWithHandsAndScratchingAreNotWaves', () => {
    expect(gestures(SyntheticScenes.talkingWithHands).filter((g) => g.kind.kind === 'wave')).toEqual([]);
    const scratch = new SyntheticScene('scratch', 5, [person(1.2, SyntheticGesture.scratch, 0.5, 4.5)]);
    expect(gestures(scratch).filter((g) => g.kind.kind === 'wave')).toEqual([]);
  });

  test('thumbsUpHeldFiresOnce', () => {
    const ups = gestures(SyntheticScenes.thumbsUp).filter((g) => g.kind.kind === 'thumbsUp');
    expect(ups.length).toBe(1);
    const u = ups[0];
    expect(u.directedAtYanni).toBe(true);
    expect(u.time - 1000, 'held ≥ 0.4 s').toBeGreaterThanOrEqual(1.5 + 0.4 - 0.07);
    const side = new SyntheticScene('thumb-sideways', 4, [person(1.2, SyntheticGesture.thumbSideways, 0.5, 3.5)]);
    expect(gestures(side).filter((g) => g.kind.kind === 'thumbsUp')).toEqual([]);
  });

  test('pointLeftGivesDirection', () => {
    const pts = gestures(SyntheticScenes.pointLeft).flatMap((g) => g.kind.kind === 'point' ? [g.kind.direction] : []);
    expect(pts.length).toBe(1);
    expect(pts[0]?.x ?? 0).toBeLessThan(-0.9);
  });

  test('openPalmHeldStill', () => {
    const s = new SyntheticScene('palm', 3, [person(1.2, SyntheticGesture.openPalm, 0.5, 2.5)]);
    const g = gestures(s).filter((x) => x.kind.kind === 'openPalm');
    expect(g.length).toBe(1);
    expect(g[0].time - 1000).toBeGreaterThanOrEqual(0.5 + 0.45);
  });

  test('handGesturesNeedToBeNear', () => {
    const far = new SyntheticScene('far-thumb', 4, [person(2.6, SyntheticGesture.thumbsUp, 0.5, 3.5)]);
    expect(gestures(far).filter((g) => g.kind.kind === 'thumbsUp'), 'thumbs up only within 2 m').toEqual([]);
  });

  test('reducedTierWavesOnlyWithinTwoMetres', () => {
    const s = new SyntheticScene('far-wave', 5, [person(2.6, SyntheticGesture.wave, 0.5, 4.5)]);
    expect(gestures(s, 3).filter((g) => g.kind.kind === 'wave').length, 'full tier: body-pose waves beyond 2 m').toBeGreaterThan(0);
    expect(gestures(s, 1).filter((g) => g.kind.kind === 'wave')).toEqual([]);
  });

  test('disabledGesturesDontFire', () => {
    const settings = new PerceptionSettings();
    settings.thumbsUpEnabled = false;
    const p = new PerceptionProcessor(settings, new CameraGeometry(undefined, { x: 0, y: -0.11 }));
    const out: GestureObservation[] = [];
    for (const f of SyntheticScenes.thumbsUp.recording().frames) out.push(...p.process(f).snapshot.gestures);
    expect(out.filter((g) => g.kind.kind === 'thumbsUp')).toEqual([]);
  });
});
