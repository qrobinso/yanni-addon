// Port of Tests/FacePerceptionTests/HarnessTests.swift: the evaluator over synthetic recordings and its maths, and
// the tuner.
import { describe, expect, test } from 'vitest';
import {
  EvaluationReport, FeatureRecordingHeader, FeatureRecordingSession, GestureKind, GestureScore, PerceptionEvaluator,
  PerceptionSettings, StageTimings, SyntheticScenes, TuningAxis, makeFrameDetections, makeGestureObservation,
  makeSessionLabel, makeSessionLabels, makeTrackedPerson,
  type EvaluationRun, type EvaluationTimed, type FeatureFrame,
} from '../../src/perception';

describe('HarnessTests', () => {
  // MARK: Evaluator

  test('evaluatorScoresSyntheticSessions', () => {
    const wave = SyntheticScenes.waveAtYanni.session();
    const r = PerceptionEvaluator.evaluate([wave])[0];
    expect(r.platform).toBe('synthetic');
    expect(r.gestures.wave?.truePositives === 1 && r.gestures.wave?.falseNegatives === 0).toBe(true);
    expect(r.lookingWindows).toBe(1);
    const tte = r.medianTimeToEngage ?? 99;
    expect(tte >= 0.8 && tte <= 1.5, `engages after about the dwell: ${tte}`).toBe(true);

    // Waving while walking past, not looking: the wave label is missed (it is not aimed at Yanni) and nothing
    // reacts in a "none" session.
    const past = SyntheticScenes.waveWalkingPast.session('none');
    const rp = PerceptionEvaluator.evaluate([past])[0];
    expect(rp.falseReactions).toBe(0);
    expect(rp.noneHours > 0 && rp.falseReactionsPerHour === 0).toBe(true);
    expect(rp.rateClaimable, 'synthetic data is never evidence for a rate').toBe(false);

    // A glance train never engages: no false engagements in an eye-contact session.
    const glance = SyntheticScenes.glanceOnly.session('eyeContact');
    const rg = PerceptionEvaluator.evaluate([glance])[0];
    expect(rg.falseEngagements).toBe(0);
  });

  test('platformsAreNeverPooled', () => {
    const a = SyntheticScenes.thumbsUp.session();
    a.header.platform = 'iPad';
    const b = SyntheticScenes.thumbsUp.session();
    b.header.platform = 'Mac preview';
    const reports = PerceptionEvaluator.evaluate([a, b]);
    expect(reports.map((r) => r.platform)).toEqual(['Mac preview', 'iPad']);
    expect(reports.every((r) => r.sessions === 1)).toBe(true);
  });

  test('scoringMathsOnAToySequence', () => {
    // Two people cross; the tracker's IDs are given directly.
    const h = new FeatureRecordingHeader('toy', 'none', [], new Date(), 0);
    const frames: FeatureFrame[] = Array.from({ length: 3600 }, (_, i) => ({
      detections: makeFrameDetections(i), people: [], primaryID: null, engagedID: null, stages: new StageTimings(), tier: 3,
    }));
    const labels = makeSessionLabels([
      makeSessionLabel(10, 14, 'thumbsUp'), makeSessionLabel(20, 24, 'thumbsUp'),
      makeSessionLabel(30, 34, 'wave'), makeSessionLabel(100, 110, 'crossing', { people: 2 }),
      makeSessionLabel(200, 202, 'looking', { distance: 1 }),
    ]);
    const session = new FeatureRecordingSession(h, frames, [], labels);
    const g = (k: GestureKind, t: number, played: boolean): EvaluationTimed => ({
      t, event: { kind: 'gesture', gesture: makeGestureObservation({ kind: k, personID: 1, hand: 'right', confidence: 0.9,
        directedAtYanni: true, at: { x: 0, y: 0 }, distance: 1, time: t }) },
      reaction: played ? 'x → y' : null,
    });
    const events: EvaluationTimed[] = [
      g(GestureKind.thumbsUp, 11, true), g(GestureKind.thumbsUp, 12, true),     // TP, then a duplicate (FP)
      g(GestureKind.wave, 21, true),                                            // inside thumbsUp's window: confusion
      g(GestureKind.openPalm, 500, false),                                      // FP, no reaction
      { t: 200.6, event: { kind: 'engaged', id: 1 }, reaction: null },          // 0.6 s after the look started
      { t: 900, event: { kind: 'engaged', id: 2 }, reaction: null },            // outside any look: false
    ];
    const people: EvaluationRun['frames'] = frames.map((f) => ({ t: f.detections.time, people: [], engaged: null }));
    for (let t = 100; t <= 110; t++) {
      people[t].people = [makeTrackedPerson(1), makeTrackedPerson(t < 105 ? 2 : 3)];   // one ID switch
      people[t].engaged = t < 105 ? 1 : 3;                                              // one engaged swap
    }
    const r = new EvaluationReport('toy');
    PerceptionEvaluator.score({ session, events, frames: people }, r, new PerceptionSettings());
    const thumbs = new GestureScore();
    thumbs.truePositives = 1; thumbs.falsePositives = 1; thumbs.falseNegatives = 1;
    expect(r.gestures.thumbsUp.equals(thumbs)).toBe(true);
    expect(r.gestures.wave?.falseNegatives === 1 && r.gestures.wave?.falsePositives === 1).toBe(true);
    expect(r.confusion.thumbsUp?.wave).toBe(1);
    expect(r.gestures.openPalm?.falsePositives).toBe(1);
    expect(r.falseReactions, "the duplicate thumbs up and the wave played; the palm didn't").toBe(2);
    expect(Math.abs((r.falseReactionsPerHour ?? 0) - 2 / (3599 / 3600))).toBeLessThan(0.01);
    expect(r.timeToEngage.length === 1 && Math.abs(r.timeToEngage[0] - 0.6) < 1e-9 && r.engageRecall === 1).toBe(true);
    expect(r.falseEngagements).toBe(1);
    expect(r.crossings === 1 && r.idSwitches === 1 && r.engagedSwaps === 1).toBe(true);
  });

  test('tunerSearchesEveryCombinationAndPrefersFeasible', () => {
    const s = [SyntheticScenes.sitAndLook.session('eyeContact'), SyntheticScenes.glanceOnly.session('eyeContact')];
    const axes: TuningAxis[] = [{ name: 'engageDwell', values: [0.6, 1.0], apply: (x, v) => { x.engageDwell = v; } }, TuningAxis.eyeContactEnter];
    const results = PerceptionEvaluator.tune(s, axes, undefined, 0.5);
    expect(results).toHaveLength(2 * TuningAxis.eyeContactEnter.values.length);
    const firstInfeasible = results.findIndex((x) => !x.feasible);
    const leadingFeasible = results.slice(0, firstInfeasible < 0 ? results.length : firstInfeasible).every((x) => x.feasible);
    expect(leadingFeasible).toBe(true);
    expect(results[0]?.medianTimeToEngage).not.toBeNull();
  });
});
