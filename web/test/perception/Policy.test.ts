// Port of Tests/FacePerceptionTests/PolicyTests.swift: motion map, tier policy, capture clock, settings.
import { describe, expect, test } from 'vitest';
import { CameraGeometry } from '../../src/perception/CameraGeometry';
import { CaptureClock } from '../../src/perception/CaptureClock';
import { MotionDetector, makeMotionParams } from '../../src/perception/Motion';
import { PerceptionSettings } from '../../src/perception/PerceptionSettings';
import { NRect, PerceptionTier, makeMotionGrid } from '../../src/perception/PerceptionTypes';
import type { MotionGrid, PerceptionEvent } from '../../src/perception/PerceptionTypes';
import {
  FrameGate, HardwareClass, LowModeScheduler, PressureLevel, StagePlan, TierPolicy,
} from '../../src/perception/TierPolicy';
import type { TierPolicyMeasurement } from '../../src/perception/TierPolicy';

const { full, standard, reduced, critical } = PerceptionTier;
const M = TierPolicy.measurement;

describe('MotionTests', () => {
  const geo = new CameraGeometry();
  const grid = (fill: (r: number, c: number) => number, exposure = false): MotionGrid => {
    const l: number[] = [];
    for (let r = 0; r < 24; r++) for (let c = 0; c < 32; c++) l.push(fill(r, c));
    return makeMotionGrid(32, 24, l, exposure);
  };
  const inBlob = (r: number, c: number): boolean => r >= 4 && r <= 8 && c >= 24 && c <= 28;

  test('blobBecomesAStimulus', () => {
    const m = new MotionDetector();
    const events: PerceptionEvent[] = [];
    for (let i = 0; i < 40; i++) {
      const moving = i >= 20 && i < 26;
      const g = grid((r, c) => moving && inBlob(r, c) ? (i % 2 === 0 ? 0.9 : 0.5) : 0.4);
      const e = m.update(g, i / 15, [], geo);
      if (e !== null) events.push(e);
    }
    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.kind).toBe('motion');
    if (e.kind === 'motion') {
      expect(e.at.x > 0.3 && e.at.y < -0.2, `top right (${e.at.x}, ${e.at.y})`).toBe(true);
      expect(e.strength).toBeGreaterThanOrEqual(0.2);
    }
  });

  test('peopleAreMaskedOut', () => {
    const m = new MotionDetector();
    let n = 0;
    const person = NRect.make(0.7, 0.1, 0.25, 0.3);
    for (let i = 0; i < 30; i++) {
      const g = grid((r, c) => inBlob(r, c) ? (i % 2 === 0 ? 0.9 : 0.5) : 0.4);
      if (m.update(g, i / 15, [person], geo) !== null) n += 1;
    }
    expect(n).toBe(0);
  });

  test('busyCellsAreLearnedAndIgnored', () => {
    const m = new MotionDetector();
    let late = 0;
    // A TV flickers constantly; after the long-term average learns it, it is ignored.
    for (let i = 0; i < 15 * 200; i++) {
      const g = grid((r, c) => r >= 14 && r <= 20 && c >= 2 && c <= 8 ? (i % 2 === 0 ? 0.3 : 0.6) : 0.4);
      const t = i / 15;
      if (m.update(g, t, [], geo) !== null && t > 150) late += 1;
    }
    expect(late).toBe(0);
    expect(Math.max(...m.baselineCells)).toBeGreaterThan(makeMotionParams().busyCell);
  });

  test('exposureChangeIsSuppressed', () => {
    const m = new MotionDetector();
    let n = 0;
    for (let i = 0; i < 20; i++) {
      // A global brightness step at frame 10 (auto exposure): every cell changes.
      const g = grid(() => i < 10 ? 0.4 : 0.55, i === 10);
      if (m.update(g, i / 15, [], geo) !== null) n += 1;
    }
    expect(n).toBe(0);
  });
});

describe('TierPolicyTests', () => {
  test('startingTierFromHardware', () => {
    expect(HardwareClass.startingTier('iPad16,3')).toBe(full);
    expect(HardwareClass.startingTier('iPad13,18')).toBe(standard);
    expect(HardwareClass.startingTier('iPad13,4')).toBe(full);
    expect(HardwareClass.startingTier('iPad15,7')).toBe(standard);
    expect(HardwareClass.startingTier('iPad8,1')).toBe(reduced);
    expect(HardwareClass.startingTier('arm64')).toBe(full);
  });

  test('stepsDownOnOverrunAndLateFrames', () => {
    const p = new TierPolicy(full);
    // Full tier: 33 ms interval, budget 20 ms.
    expect(p.evaluate(M(25), 5)).toEqual({ kind: 'change', to: standard, reason: 'p90 25 ms over budget' });
    expect(p.evaluate(M(10, { lateFraction: 0.2 }), 10)).toEqual({ kind: 'change', to: reduced, reason: '20% frames late' });
    expect(p.current).toBe(reduced);
  });

  test('displayDropsNeedAProbe', () => {
    const p = new TierPolicy(full);
    expect(p.evaluate(M(10, { displayDropRate: 0.05 }), 5)).toEqual({ kind: 'requestProbe' });
    // The renderer drops just as many frames with perception paused: renderer-bound, keep the tier.
    p.noteProbe(0.05, 6);
    expect(p.evaluate(M(10, { displayDropRate: 0.05 }), 10)).toEqual({ kind: 'keep' });
    expect(p.rendererBound).toBe(true);
    // Paused, the renderer is fine: perception costs the eyes frames → step down.
    p.noteProbe(0.0, 11);
    expect(p.evaluate(M(10, { displayDropRate: 0.05 }), 15)).toMatchObject({ kind: 'change', to: standard });
  });

  test('stepsUpAfterHeadroomNeverAboveCeiling', () => {
    const p = new TierPolicy(standard);
    p.evaluate(M(60), 0);
    expect(p.current).toBe(reduced);
    let t = 0;
    const changes: PerceptionTier[] = [];
    for (let i = 0; i < 40; i++) {
      t += 5;
      const d = p.evaluate(M(5), t);
      if (d.kind === 'change') changes.push(d.to);
    }
    expect(changes, 'back up after 60 s of headroom, never above the hardware tier').toEqual([standard]);
  });

  test('roomEmptyIntervalsAreNeverHeadroom', () => {
    const p = new TierPolicy(full);
    p.evaluate(M(25), 0);
    expect(p.current).toBe(standard);
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += 5;
      expect(p.evaluate(M(2, { vacant: true }), t)).toEqual({ kind: 'keep' });
    }
    expect(p.current, "the cheap vacancy plan doesn't step the tier back up").toBe(standard);
  });

  test('thermalCaps', () => {
    expect(TierPolicy.cap(PressureLevel.nominal, full)).toBe(full);
    expect(TierPolicy.cap(PressureLevel.fair, full)).toBe(standard);
    expect(TierPolicy.cap(PressureLevel.serious, full)).toBe(reduced);
    expect(TierPolicy.cap(PressureLevel.critical, full)).toBe(critical);
    const p = new TierPolicy(full);
    const m = (pressure: PressureLevel): TierPolicyMeasurement => M(5, { pressure });
    expect(p.evaluate(m(PressureLevel.serious), 5), 'serious → reduced').toMatchObject({ kind: 'change', to: reduced });
    expect(p.evaluate(m(PressureLevel.shutdown), 10).kind, 'shutdown stops').toBe('stopCamera');
    expect(p.evaluate(m(PressureLevel.nominal), 15), 'recovers').toMatchObject({ kind: 'change', to: full });
  });

  test('overrideWins', () => {
    const p = new TierPolicy(full, reduced);
    expect(p.current).toBe(reduced);
    expect(p.evaluate(M(1), 5)).toEqual({ kind: 'keep' });
  });

  test('lowModeBoost', () => {
    const s = new LowModeScheduler();
    expect(s.plan(0).analysisFPS).toBe(4);
    expect(s.plan(0).rectanglesOnly).toBe(true);
    s.noteCandidate(1);
    expect(s.plan(2).analysisFPS).toBe(10);
    expect(s.plan(4.1).analysisFPS).toBe(4);
  });

  test('frameGateDropsToRateAndWhileBusy', () => {
    const g = new FrameGate();
    let accepted = 0;
    for (let i = 0; i < 30; i++) if (g.shouldAnalyse(i / 30, 10, false)) accepted += 1;
    expect(accepted).toBe(10);
    expect(g.shouldAnalyse(5, 10, true)).toBe(false);
    expect(g.droppedBusy).toBe(1);
  });

  test('plansPerTier', () => {
    expect(StagePlan.plan(full).maxPeople).toBe(6);
    expect(StagePlan.plan(standard).maxPeople).toBe(4);
    expect(StagePlan.plan(reduced).bodyPose).toBe(false);
    expect(StagePlan.plan(critical).handPose).toBe(false);
  });
});

// port-note: the Swift tests drive CoreMedia clocks; the web clock is performance.now() plus a per-source offset.
describe('CaptureClockTests', () => {
  test('hostClockIsIdentity', () => {
    const now = CaptureClock.nowSeconds();
    expect(Math.abs(CaptureClock.hostSeconds(now)! - now)).toBeLessThan(1e-6);
    expect(CaptureClock.hostSeconds(null)).toBeNull();
    expect(CaptureClock.hostSeconds(NaN)).toBeNull();
  });

  test('timebaseWithOffsetConverts', () => {
    // The capture clock reads 100 s right now: a frame stamped 100.5 s happens 0.5 s after "now" on the host clock.
    const hostNow = CaptureClock.nowSeconds();
    const s = CaptureClock.hostSeconds(100.5, hostNow - 100)!;
    expect(Math.abs(s - (hostNow + 0.5))).toBeLessThan(0.01);
  });
});

describe('SettingsTests', () => {
  test('tolerantDecoding', () => {
    const json = '{"engageDwell": 1.3, "maxPeople": "lots", "headPoseFrame": "cameraRelative", "future": 1}';
    const s = PerceptionSettings.decode(JSON.parse(json));
    expect(s.engageDwell).toBe(1.3);
    expect(s.maxPeople).toBe(6);
    expect(s.headPoseFrame).toBe('cameraRelative');
    const round = PerceptionSettings.decode(JSON.parse(JSON.stringify(s)));
    expect(round.equals(s)).toBe(true);
  });

  test('validation', () => {
    const s = new PerceptionSettings({
      engageDwell: 99, eyeContactSigmaEyes: NaN, cameraOffsetOverride: { x: 2, y: -0.1 }, eyeContactExit: 0.9, headYawSign: -3,
    });
    const v = s.validated();
    expect(v.engageDwell).toBe(3);
    expect(v.eyeContactSigmaEyes).toBe(8);
    expect(v.cameraOffsetOverride).toEqual({ x: 0.3, y: -0.1 });
    expect(v.eyeContactExit).toBeLessThanOrEqual(v.eyeContactEnter);
    expect(v.headYawSign).toBe(-1);
    expect(v.eyeContactParams.bias).toEqual({ x: 0, y: 0 });
  });
});
