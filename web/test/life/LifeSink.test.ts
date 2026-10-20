// Port of Tests/FaceLifeTests/LifeSinkTests.swift: the sleepy sink, requested while drowsy, asleep committed at its
// settle point (screen-edge antics design).
import { describe, expect } from 'vitest';
import { sleepySinkSettle } from '../../src/engine/EdgeAnticCurves';
import { EdgeGeometry } from '../../src/model';
import { LifeSettings } from '../../src/life';
import { LifeRig, fullStackTest, req } from './LifeRig';

function rig(o: { chance?: number; geometry?: EdgeGeometry | null; bedtime?: boolean } = {}): LifeRig {
  const r = new LifeRig({ settings: new LifeSettings({ minutesToDrowsy: 0.25, minutesToAsleep: 0.25, manualBedtime: o.bedtime ?? false }) });
  r.engine.setEdgeGeometry(o.geometry === undefined ? EdgeGeometry.reference : o.geometry);
  const st = r.engine.edgeAnticSettings;
  st.sleepySinkChance = o.chance ?? 1;
  r.engine.edgeAnticSettings = st;
  return r;
}

describe('LifeSinkTests', () => {
  /// Drowsy → sink (full rate, not the asleep tier) → asleep at the settle point → closed and dim, never reopening.
  fullStackTest('sinkThenAsleepAtSettlePoint', () => {
    const r = rig();
    r.runUntil(40, () => r.state === 'drowsy', 1 / 60);
    let sinkStart: number | null = null, asleepAt: number | null = null;
    let sawAsleepTierDuringSink = false;
    const lidAfterCommit: number[] = [];
    const reached = r.runUntil(60, () => {
      const s = r.engine.state;
      if (sinkStart === null && s.activeOneShots.includes('sleepySink')) {
        sinkStart = s.time;
        expect(r.state, 'the sink plays while still drowsy').toBe('drowsy');
      }
      if (s.activeOneShots.includes('sleepySink') && s.output.isAsleep) sawAsleepTierDuringSink = true;
      if (asleepAt === null && r.state === 'asleep') asleepAt = s.time;
      if (asleepAt !== null) lidAfterCommit.push(s.lidClose);
      return asleepAt !== null && s.time - asleepAt > 3;
    }, 1 / 60);
    expect(reached).not.toBeNull();
    const start: number = req(sinkStart as number | null), commit: number = req(asleepAt as number | null);
    expect(Math.abs((commit - start) - sleepySinkSettle), `asleep at the settle point: ${commit - start}`).toBeLessThan(0.1);
    expect(sawAsleepTierDuringSink).toBe(false);
    // Once asleep the lids only close further (no visible reopen as the sink lets go).
    let peak = 0, worstReopen = 0;
    for (const l of lidAfterCommit) { peak = Math.max(peak, l); worstReopen = Math.max(worstReopen, peak - l); }
    expect(worstReopen).toBeLessThan(0.08);
    expect(lidAfterCommit[lidAfterCommit.length - 1] ?? 0).toBeGreaterThan(0.8);
    expect(r.engine.state.output.isAsleep).toBe(true);
    expect(r.changes[r.changes.length - 1]?.reason).toBe('timer');
  });

  /// Activity during the sink: it is cancelled and Yanni catches itself.
  fullStackTest('activityDuringSinkCatches', () => {
    const r = rig();
    r.runUntil(40, () => r.state === 'drowsy', 1 / 60);
    r.runUntil(30, () => r.engine.state.activeOneShots.includes('sleepySink'), 1 / 60);
    expect(r.life.isSinkingToSleep).toBe(true);
    r.run(0.8, 1 / 60);
    r.tap();
    const back = r.runUntil(4, () => r.state === 'idle' || r.state === 'noticing' || r.state === 'waking', 1 / 60);
    expect(back).not.toBeNull();
    expect(r.engine.state.activeOneShots.includes('sleepySink')).toBe(false);
    expect(r.life.isSinkingToSleep).toBe(false);
  });

  fullStackTest('noSinkWithoutScreenAtBedtimeOrUnderForceSleep', () => {
    for (const [name, r] of [['headless', rig({ geometry: null })], ['chance 0', rig({ chance: 0 })], ['bedtime', rig({ bedtime: true })]] as const) {
      let sank = false;
      r.runUntil(120, () => {
        if (r.engine.state.activeOneShots.includes('sleepySink')) sank = true;
        return r.state === 'asleep';
      });
      expect(r.state, name).toBe('asleep');
      expect(sank, name).toBe(false);
    }
    const f = rig();
    let sank = false;
    f.life.forceSleep();
    f.runUntil(20, () => {
      if (f.engine.state.activeOneShots.includes('sleepySink')) sank = true;
      return f.state === 'asleep';
    });
    expect(f.state === 'asleep' && !sank).toBe(true);
  });

  fullStackTest('bedtimeReachesTheEngine', () => {
    const r = rig({ bedtime: true });
    expect(r.engine.state.isBedtime).toBe(true);
    r.life.forceWake();
    r.frame();
    expect(r.engine.state.isBedtime).toBe(false);
  });
});
