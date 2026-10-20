// Port of Tests/FaceEngineTests/OneShotIntensityTests.swift.
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import {
  FaceCommand, FaceEngine, OneShotKind, OneShotLibrary, OneShotRequest, type OneShotParams,
  isAnswer, isEdgeAntic, isIdleGame, isPupilShape, missingModifiers,
} from '../../src/engine';

/// Every kind whose intensity is an amplitude scale (not an edge antic, a pupil transformation, an answer or a game).
const ordinaryKinds: OneShotKind[] = OneShotKind.allCases.filter(
  (k) => !isEdgeAntic(k) && !isPupilShape(k) && !isAnswer(k) && !isIdleGame(k));

function params(r: OneShotRequest, seed = 21): OneShotParams {
  return OneShotLibrary.makeParams(r, new SplitMix64(seed), { x: 0.2, y: -0.1 });
}

/// `OneShotRequest.intensity` as an amplitude scale for ordinary one-shots and the nod mirror's `softVoice` flag.
describe('OneShotIntensity', () => {
  test.each(ordinaryKinds)('nilAndOneAreBitIdentical %s', (kind) => {
    const base = params(OneShotRequest.make(kind));
    expect(params(OneShotRequest.make(kind, { intensity: 1 }))).toEqual(base);
    expect(params(OneShotRequest.make(kind, { intensity: NaN }))).toEqual(base);
    expect(params(OneShotRequest.make(kind, { softVoice: true }))).toEqual(base);
  });

  test.each(ordinaryKinds)('intensityScalesTheAmplitude %s', (kind) => {
    const base = params(OneShotRequest.make(kind));
    const table: [number, number][] = [[0.6, 0.6], [0.3, 0.3], [1.2, 1.2], [0.1, 0.3], [2, 1.3]];
    for (const [i, expected] of table) {
      const p = params(OneShotRequest.make(kind, { intensity: i }));
      expect(Math.abs(p.amp - base.amp * expected), `${kind} at ${i}`).toBeLessThan(1e-6);
      p.amp = base.amp;
      expect(p, `only the amplitude changes (${kind})`).toEqual(base);
    }
  });

  const keepOwn = (k: OneShotKind): void => {
    expect(params(OneShotRequest.make(k, { intensity: 0.6 })).amp, k).toBe(params(OneShotRequest.make(k)).amp);
  };
  test('edgeAnticsAnswersAndShapesKeepTheirOwnIntensity (answers)', () => {
    for (const k of ['nodYes', 'shakeNoBig'] as OneShotKind[]) keepOwn(k);
  });
  test('edgeAnticsAnswersAndShapesKeepTheirOwnIntensity (edge antics, shapes)', () => {
    for (const k of ['pretendExit', 'sleepySink', 'starEyes', 'pingPong'] as OneShotKind[]) keepOwn(k);
  });

  test('sampledMotionScales', () => {
    const full = params(OneShotRequest.make('delightedSquint'));
    const big = params(OneShotRequest.make('delightedSquint', { intensity: 1.2 }));
    const d = OneShotLibrary.duration('delightedSquint', full);
    let maxFull = 0, maxBig = 0;
    for (let i = 1; i < 60; i++) {
      const t = d * i / 60;
      maxFull = Math.max(maxFull, Math.abs(OneShotLibrary.sample('delightedSquint', t, full).delta.face('centerY')));
      maxBig = Math.max(maxBig, Math.abs(OneShotLibrary.sample('delightedSquint', t, big).delta.face('centerY')));
    }
    expect(maxFull).toBeGreaterThan(0);
    expect(Math.abs(maxBig / maxFull - 1.2)).toBeLessThan(1e-3);
  });

  // needs the full default stack (lights up once WP6/WP7 register every modifier; nodYes answer curves)
  test.skipIf(missingModifiers().length > 0)('softVoiceReachesTheStartedOneShot', () => {
    const e = new FaceEngine({ seed: 4 });
    e.tick(1.0 / 60);
    e.send(FaceCommand.play(OneShotRequest.make('nodYes', { softVoice: true })));
    e.tick(1.0 / 60);
    expect(e.state.startedOneShots.find((s) => s.kind === 'nodYes')?.softVoice).toBe(true);
    for (let i = 0; i < 180; i++) e.tick(1.0 / 60);
    e.send(FaceCommand.playOneShot('laugh'));
    e.tick(1.0 / 60);
    expect(e.state.startedOneShots.find((s) => s.kind === 'laugh')?.softVoice).toBe(false);
  });
});
