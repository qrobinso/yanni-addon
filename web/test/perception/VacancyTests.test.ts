// Port of Tests/FacePerceptionTests/VacancyTests.swift: the room-empty duty cycle (perception design §6.6).
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import {
  FrameGate, PerceptionProcessor, PressureLevel, StagePlan, VacancyScheduler, makeFrameDetections,
} from '../../src/perception';
import { body, face } from './TestSupport';

describe('VacancyTests', () => {
  test('schedulerCountsFromTheLastPresence', () => {
    const v = new VacancyScheduler();
    expect(v.isVacant(0), 'nothing seen yet: not vacant').toBe(false);
    v.note(false, 0);
    expect(v.isVacant(9.9)).toBe(false);
    expect(v.isVacant(10)).toBe(true);
    v.note(true, 12);
    expect(v.isVacant(12)).toBe(false);
    expect(v.isVacant(22)).toBe(true);
    v.after = VacancyScheduler.after(PressureLevel.fair);
    expect(v.isVacant(17)).toBe(true);
    expect(VacancyScheduler.after(PressureLevel.nominal) === 10 && VacancyScheduler.after(PressureLevel.serious) === 5).toBe(true);
  });

  test('vacancyPlanIsRectanglesAndMotionOnly', () => {
    const p = StagePlan.vacant;
    expect(p.analysisFPS).toBe(5);
    expect(p.rectanglesOnly, 'face rectangles still run').toBe(false);
    expect(p.landmarkFaces === 0 && !p.handPose && !p.bodyPose && p.wristROIs === 0).toBe(true);
    expect(p.motionEvery, 'motion still wakes it (and plays stimuli)').toBe(1);
  });

  test('processorGoesVacantAndBackAndHonoursPressure', () => {
    const proc = new PerceptionProcessor();
    let vacantAt: number | null = null;
    for (let i = 0; i < 15 * 12; i++) {
      const t = 1000 + i / 15;
      const out = proc.process(makeFrameDetections(t));
      if (out.snapshot.stats.vacant && vacantAt === null) vacantAt = t - 1000;
    }
    expect(vacantAt !== null && Math.abs(vacantAt - 10) < 0.1, `vacant 10 s after the last presence (${vacantAt})`).toBe(true);
    // A face (no body) ends it on the same frame.
    const out = proc.process(makeFrameDetections(1013, { faces: [face({ x: 0.5, y: 0.4 })] }));
    expect(out.snapshot.stats.vacant).toBe(false);
    // Under pressure, 5 s.
    proc.apply([{ kind: 'pressure', level: PressureLevel.fair }]);
    let t = 1013;
    let stillThere = true;
    while (t < 1030 && stillThere) {
      t += 1 / 15;
      stillThere = !proc.process(makeFrameDetections(t)).snapshot.stats.vacant;
    }
    // The tracked face coasts a little before the room counts as empty.
    expect(t - 1013, `vacant about 5 s after the face went (${t - 1013})`).toBeLessThan(7);
    // Asleep (low mode) is never reported as vacant.
    proc.apply([{ kind: 'lowMode', on: true }]);
    expect(proc.process(makeFrameDetections(t + 1)).snapshot.stats.vacant).toBe(false);
  });

  /// Simulates the camera pipeline (30 fps capture, 15 fps while vacant, the frame gate at the plan's rate) and
  /// returns the delay from someone stepping in to the face seeing them (the first snapshot with a person).
  function wakeLatency(appear: number): number {
    const proc = new PerceptionProcessor();
    const gate = new FrameGate();
    let t = 1000;
    const end = appear + 3;
    while (t < end) {
      const vacant = proc.vacancy.isVacant(t);
      const plan = vacant ? StagePlan.vacant : StagePlan.plan(proc.tier);
      const captureFPS = vacant ? VacancyScheduler.captureFPS : 30;
      if (gate.shouldAnalyse(t, plan.analysisFPS, false)) {
        const det = makeFrameDetections(t);
        if (t >= appear) {
          det.faces = [face({ x: 0.5, y: 0.35 })];
          det.bodies = [body({ x: 0.5, y: 0.45 })];
        }
        if (proc.process(det).snapshot.people.length > 0) return t - appear;
      }
      t += 1 / captureFPS;
    }
    return Infinity;
  }

  test('wakeLatencyStaysWithinAThirdOfASecondOfFullRate', () => {
    const rng = new SplitMix64(42);
    let worst = 0;
    for (let i = 0; i < 20; i++) {
      const offset = rng.unit() * 0.2;   // phase against the analysis cadence
      const full = wakeLatency(1003 + offset);      // within the delay: full rate
      const empty = wakeLatency(1030 + offset);     // 30 s alone: vacancy plan
      expect(full, `full-rate latency ${full}`).toBeLessThan(0.2);
      worst = Math.max(worst, empty - full);
    }
    expect(worst, `vacancy adds at most 0.3 s before the face sees someone (worst ${worst})`).toBeLessThanOrEqual(0.3);
  });
});
