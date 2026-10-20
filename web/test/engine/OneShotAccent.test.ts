// Port of Tests/FaceEngineTests/OneShotAccentTests.swift.
import { curvePorted, specPorted as specWorks } from './ported';
import { describe, expect, test } from 'vitest';
import { Canvas } from '../../src/model';
import {
  OneShotKind, OneShotLibrary, OneShotParams, isAnswer, isEdgeAntic, isIdleGame, isPupilShape,
} from '../../src/engine';

/// Swift `IdleGames.isPending`: every idle game is built in Swift, so this is always false.
// TODO(WP6): use IdleGames.isPending once the IdleGames modifier is ported.
const isPending = (_k: OneShotKind): boolean => false;

/// Kinds whose spec works (originals, answers, pupil shapes) and kinds whose curves are ported (the 18 originals).
const specPorted = OneShotKind.allCases.filter(specWorks);
const specUnported = OneShotKind.allCases.filter((k) => !specPorted.includes(k));
const sampled = specPorted.filter(curvePorted);
const unsampled = OneShotKind.allCases.filter((k) => !sampled.includes(k));

describe('OneShotAccentTests', () => {
  const accentTimesWithinDurationAndSorted = (kind: OneShotKind): void => {
    const spec = OneShotLibrary.spec(kind);
    expect(spec.accentTimes.length).toBeGreaterThan(0);
    for (const a of spec.accentTimes) expect(a >= 0 && a <= spec.duration).toBe(true);
    expect(spec.accentTimes).toEqual([...spec.accentTimes].sort((x, y) => x - y));
  };
  test.each(specPorted)('accentTimesWithinDurationAndSorted %s', accentTimesWithinDurationAndSorted);
  // needs WP6 (edge antic and idle game specs)
  test.skip.each(specUnported)('accentTimesWithinDurationAndSorted %s', accentTimesWithinDurationAndSorted);

  /// Each accent sits on a motion peak of the authored curves (a local extremum of some channel within ±20 ms; the
  /// pupil transformations' silhouette scale counts), or — for gaze-driven accents — on a gaze jump.
  const accentsSitOnMotionPeaks = (kind: OneShotKind): void => {
    const p = new OneShotParams();
    const step = 0.005;
    const channels = (t: number): number[] => {
      const o = OneShotLibrary.sample(kind, t, p);
      return [o.delta.face('centerY') * Canvas.yFactor, o.delta.face('centerX') * Canvas.xFactor, o.delta.face('angle'),
        o.faceScaleMul.y - 1, o.blink, o.lidClose, o.lidCoverage.x, o.lidCoverage.y, o.delta.eye('left', 'x'),
        o.stageOffset.x, o.stageOffset.y, o.eyeStageOffset.x, o.eyeStageOffset.y, o.eyeStageOffset.z,
        // Pupil transformations accent their silhouette: the pop's scale peak, the coin flip's sliver.
        o.pupilShapeScale.x, o.pupilShapeScale.y, o.pupilShapeScale.z, o.pupilShapeScale.w];
    };
    // A pending idle game's curve is still a rest placeholder (idle games design §7).
    for (const a of OneShotLibrary.spec(kind).accentTimes) {
      if (isPending(kind)) continue;
      let found = false;
      let t = Math.max(a - 0.02, step);
      while (t <= a + 0.02 && !found) {
        const l = channels(t - step), c = channels(t), r = channels(t + step);
        for (let i = 0; i < c.length; i++) {
          if (Math.abs(c[i]) > 0.02
            && ((c[i] >= l[i] && c[i] >= r[i] && (c[i] > l[i] || c[i] > r[i]))
              || (c[i] <= l[i] && c[i] <= r[i] && (c[i] < l[i] || c[i] < r[i])))) {
            found = true;
          }
        }
        t += step;
      }
      if (!found) {
        // Gaze jump within the last 60 ms.
        const before = a < 0.06 ? null : OneShotLibrary.sample(kind, a - 0.06, p).gaze;
        const at = OneShotLibrary.sample(kind, a + 0.005, p).gaze;
        const bp = before?.point, ap = at?.point;
        found = at !== null && !(bp !== undefined && ap !== undefined && bp.x === ap.x && bp.y === ap.y);
      }
      expect(found, `${kind} accent ${a} is not on a motion peak`).toBe(true);
    }
  };
  test.each(sampled)('accentsSitOnMotionPeaks %s', accentsSitOnMotionPeaks);
  // needs WP6 (answer, edge antic, pupil shape and idle game curves)
  test.skip.each(unsampled)('accentsSitOnMotionPeaks %s', accentsSitOnMotionPeaks);
});
