// Port of Tests/FacePerceptionTests/CounterTests.swift.
import { describe, expect, test } from 'vitest';
import { CollectPreset, ScriptedSessionRunner } from '../../src/perception/CollectScript';
import { StageTimingWindow, StageTimings, PerceptionTimingMonitor } from '../../src/perception/HarnessTiming';
import { PerceptionCounters, ReflexDecision } from '../../src/perception/PerceptionCounters';
import { GestureKind, makeGestureObservation } from '../../src/perception/PerceptionTypes';
import type { PerceptionEvent } from '../../src/perception/PerceptionTypes';
import { StagePlan } from '../../src/perception/TierPolicy';

const gesture = (k: GestureKind, person = 1): PerceptionEvent => ({
  kind: 'gesture', gesture: makeGestureObservation({ kind: k, personID: person, hand: 'right', confidence: 0.9,
    directedAtYanni: true, at: { x: 0, y: 0 }, distance: 1.2, time: 0 }),
});

describe('CounterTests', () => {
  test('reflexDecisionParsing', () => {
    expect(ReflexDecision.parse('gesture.wave', 'wave → perkUp (dance cooling down)')).toEqual(ReflexDecision.played('wave', 'perkUp'));
    expect(ReflexDecision.parse('gesture.thumbsUp', 'thumbsUp → success cue')).toEqual(ReflexDecision.played('thumbsUp', 'success cue'));
    expect(ReflexDecision.parse('gesture.wave', 'wave: person cooldown')).toEqual(ReflexDecision.rejected('wave', 'person cooldown'));
    expect(ReflexDecision.parse('gesture.point', 'stale')).toEqual(ReflexDecision.rejected('point', 'stale'));
    expect(ReflexDecision.parse('engaged', 'x → y')).toBeNull();
    expect(ReflexDecision.parse('gesture.wave', null)).toBeNull();
  });

  test('countsReactionsRejectionsAndFalsePositives', () => {
    const c = new PerceptionCounters();
    c.tick(0);
    c.note(gesture(GestureKind.wave), 'wave → dance', 1);
    c.note(gesture(GestureKind.wave), 'wave: cooldown', 2);
    c.note(gesture(GestureKind.thumbsUp), 'thumbsUp → success cue', 3);
    expect(c.lifetime.gestureEvents).toEqual({ wave: 2, thumbsUp: 1 });
    expect(c.lifetime.reactionsByGesture).toEqual({ wave: 1, thumbsUp: 1 });
    expect(c.lifetime.reactionsByBeat).toEqual({ dance: 1, 'success cue': 1 });
    expect(c.lifetime.rejectionsByReason).toEqual({ cooldown: 1 });
    const last = c.reportWrongReaction();
    expect(last).toEqual({ gesture: 'thumbsUp', beat: 'success cue', at: 3 });
    c.noneSessionActive = true;
    c.note(gesture(GestureKind.openPalm), 'openPalm → perkUp', 4);
    expect(c.lifetime.gestureFalsePositives, 'the button plus a reaction during a none session').toBe(2);
    for (let t = 1; t <= 1800; t += 1) c.tick(t);
    expect(Math.abs(c.lifetime.perHour(c.lifetime.reactions) - 3 * 2), '3 reactions in half an hour = 6 / h').toBeLessThan(0.01);
    expect(c.hour.equals(c.lifetime)).toBe(true);
    c.take('hour');
    expect(c.hour.reactions === 0 && c.lifetime.reactions === 3).toBe(true);
  });

  test('engagementOutcomesAndIDSwitchProxies', () => {
    const c = new PerceptionCounters();
    c.note({ kind: 'engaged', id: 1 }, null, 10);
    c.noteEngagementOutcome(false);
    c.noteEngagementOutcome(true);
    expect(c.lifetime.engagements === 1 && c.lifetime.falseEngagements === 1 && c.lifetime.engagementsWithSpeech === 1).toBe(true);
    c.note({ kind: 'disengaged', id: 1, reason: 'left' }, null, 20);
    c.note({ kind: 'engaged', id: 2 }, null, 20.5);
    expect(c.lifetime.engagedHandOvers).toBe(1);
    c.note({ kind: 'personOutOfView', id: 3, lastPosition: { x: 0, y: 0 }, distance: 2, exitEdge: null }, null, 30);
    c.noteVisible([1, 3]);
    c.noteVisible([3]);
    expect(c.lifetime.reentries).toBe(1);
    c.noteHeap(30, 3);
    expect(c.lifetime.heapBlocksPerFrame).toBe(10);
  });

  test('scriptedSessionRunnerLabelsTheGoWindows', () => {
    const prompts = CollectPreset.prompts('handShapes', ['P1', 'P2'], 1.5);
    expect(prompts.length === 2 * 10 && prompts[0].person === 'P1' && prompts[0].distance === 1.5).toBe(true);
    const r = new ScriptedSessionRunner(prompts.slice(0, 2), 100);
    expect(r.phase(100)).toEqual({ kind: 'countdown', prompt: prompts[0], secondsLeft: 3 });
    expect(r.phase(102.5)).toEqual({ kind: 'countdown', prompt: prompts[0], secondsLeft: 1 });
    expect(r.phase(103)).toEqual({ kind: 'go', prompt: prompts[0], secondsLeft: 4 });
    expect(r.phase(107.5)).toEqual({ kind: 'rest', next: prompts[1] });
    expect(r.labels.length).toBe(1);
    expect(r.labels[0]).toMatchObject({ start: 103, end: 107, label: 'thumbsUp', person: 'P1', distance: 1.5, people: 1 });
    r.skip(108);                                                        // skip the second prompt
    expect(r.phase(200)).toEqual({ kind: 'done' });
    expect(r.labels.length).toBe(1);
    const tracking = CollectPreset.prompts('tracking', ['P1', 'P2', 'P3'], null);
    expect(tracking.every((p) => p.people === 3 && p.person === null && p.label === 'crossing')).toBe(true);
    expect(CollectPreset.prompts('hardNegatives', ['P1'], 2).every((p) => p.label.startsWith('none:'))).toBe(true);
  });

  test('liveTimingWindow', () => {
    const w = new StageTimingWindow(5, 16);
    for (let i = 0; i < 10; i++) {
      const t = new StageTimings();
      t.rects = i + 1;
      t.hands = i % 2 === 0 ? 4 : 0;
      w.add(t, i);
    }
    const s = w.summary(9);
    expect(s.stages[0].count, 'frames 4…9 are inside the 5 s window').toBe(6);
    expect(s.stages[0].p50 === 7 && s.stages[0].p90 === 10 && s.stages[0].p99 === 10).toBe(true);
    expect(s.stages[2].count, "a stage that didn't run is left out").toBe(3);
    expect(Math.abs(s.fps - 6.0 / 5)).toBeLessThan(1e-9);
    for (let i = 10; i < 40; i++) w.add(new StageTimings(), i);
    expect(w.summary(39).stages[0].count, 'the ring forgets old frames').toBe(0);
    expect(PerceptionTimingMonitor.median([StageTimings.fromValues([1, 0, 0, 0, 0, 0]), StageTimings.fromValues([3, 0, 0, 0, 0, 0]),
      StageTimings.fromValues([2, 0, 0, 0, 0, 0])]).rects).toBe(2);
    expect(StagePlan.summary(StagePlan.plan(1)).includes('primary only')).toBe(true);

    // The soak log's hourly p90s come from 0.25 ms bins and start again after each take.
    const m = new PerceptionTimingMonitor();
    for (let i = 1; i <= 100; i++) { const t = new StageTimings(); t.rects = i / 10; m.note(t, i); }
    const p90 = m.takeP90s();
    expect(p90[0], 'the 90th of 0.1…10 ms lands in the 9.0–9.25 bin').toBe(9.25);
    expect(p90[2], 'hands never ran').toBeNull();
    expect(m.takeP90s()[0]).toBeNull();
  });
});
