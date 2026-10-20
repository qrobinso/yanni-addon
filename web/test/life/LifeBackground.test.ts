// Port of Tests/FaceLifeTests/LifeBackgroundTests.swift: the mood background follows the real life cycle: black asleep,
// black all bedtime unless colour at bedtime (a night wake included), back when awake.
import { describe, expect } from 'vitest';
import { LifeSettings } from '../../src/life';
import { LifeRig, fullStackTest, makeDate } from './LifeRig';

const bedtime = (): LifeSettings => new LifeSettings({ bedtimeEnabled: true, bedtimeStart: 22 * 60, bedtimeEnd: 7 * 60 });

function rig(night: boolean, colourAtBedtime = false): LifeRig {
  const r = new LifeRig({ settings: night ? bedtime() : new LifeSettings(),
    date: night ? makeDate(2026, 10, 10, 23, 0) : makeDate(2026, 10, 10, 12, 0) });
  const c = r.engine.moodBackground;
  c.mode = 'mood';
  c.colourAtBedtime = colourAtBedtime;
  r.engine.moodBackground = c;
  return r;
}

describe('LifeBackgroundTests', () => {
  fullStackTest('daytimeIsPresentAndAsleepIsBlack', () => {
    const r = rig(false);
    r.run(2);
    expect(r.engine.state.output.backgroundPresence).toBeGreaterThan(0.99);
    expect(r.engine.state.output.backgroundStrength).toBeGreaterThan(0.75);
    r.fallAsleep();
    r.run(8);
    expect(r.engine.state.output.backgroundPresence).toBeLessThan(0.01);
  });

  fullStackTest('bedtimeFlagReachesTheEngineAndBlacksTheBackground', () => {
    const r = rig(true);
    expect(r.engine.state.isBedtime).toBe(true);
    r.run(6);
    expect(r.engine.state.output.backgroundPresence, 'black at bedtime by default, even awake').toBeLessThan(0.01);
  });

  fullStackTest('colourAtBedtimeCoversANightWake', () => {
    const r = rig(true, true);
    r.fallAsleep();
    r.run(8);
    expect(r.engine.state.output.backgroundPresence, 'asleep is always black').toBeLessThan(0.01);
    r.tap(); r.run(0.3); r.tap(); r.run(0.3); r.tap(); r.frame();
    expect(r.life.isNightAwake).toBe(true);
    r.run(3);
    expect(r.engine.state.output.backgroundPresence, 'a night wake shows the colour with colourAtBedtime').toBeGreaterThan(0.95);
  });

  fullStackTest('nightWakeStaysBlackWithoutColourAtBedtime', () => {
    const r = rig(true);
    r.fallAsleep();
    r.tap(); r.run(0.3); r.tap(); r.run(0.3); r.tap(); r.frame();
    r.run(3);
    expect(r.life.isNightAwake).toBe(true);
    expect(r.engine.state.output.backgroundPresence).toBeLessThan(0.01);
  });
});
