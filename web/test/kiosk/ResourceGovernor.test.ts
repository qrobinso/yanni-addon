// Port of YanniKioskTests/ResourceGovernorTests.swift (with NeverTheFaceTests).
import { describe, expect, test } from 'vitest';
import { makePersonTarget } from '../../src/engine/Commands';
import { FaceEngine } from '../../src/engine/FaceEngine';
import { FrameClock } from '../../src/render/FrameClock';
import { makeRenderStyle } from '../../src/render/RenderStyle';
import { DeviceDefaults } from '../../src/kiosk/DeviceDefaults';
import { browserProfile } from '../../src/kiosk/DeviceProfile';
import { KioskApply, type RenderScaleControl } from '../../src/kiosk/KioskApply';
import { makeGovernorInputs, ResourceGovernor as G, Thermal, type GovernorInputs } from '../../src/kiosk/ResourceGovernor';
import { iPadEnv } from './support';

const inputs = (thermal: Thermal = 0, o: Partial<GovernorInputs> = {}) => makeGovernorInputs({ thermal, ...o });

describe('ResourceGovernor', () => {
  test('level table: worst input wins', () => {
    const g = new G();
    expect(g.demanded(inputs(), 0).level).toBe(0);
    expect(g.demanded(inputs(Thermal.fair), 0).level).toBe(1);
    expect(g.demanded(inputs(0, { lowPowerMode: true }), 0).level).toBe(1);
    expect(g.demanded(inputs(0, { onBattery: true }), 0).level).toBe(1);
    expect(g.demanded(inputs(0, { frameDropRate: 0.05 }), 0).level).toBe(1);
    expect(g.demanded(inputs(Thermal.serious, { lowPowerMode: true, onBattery: true }), 0).level).toBe(2);
    expect(g.demanded(inputs(Thermal.critical), 0).level).toBe(4);
    const m = new G();
    m.noteMemoryWarning(10);
    expect(m.demanded(inputs(), 11).level).toBe(2);
    m.noteMemoryWarning(20);
    expect(m.demanded(inputs(), 21).level).toBe(3);    // repeated (≥ 2 in 60 s)
    expect(m.demanded(inputs(), 90).level).toBe(2);    // no longer repeated, still held
    expect(m.demanded(inputs(), 400).level).toBe(0);   // hold over
  });

  test('serious for ten minutes escalates', () => {
    const g = new G();
    g.update(inputs(Thermal.serious), 0);
    expect(g.level).toBe(2);
    g.update(inputs(Thermal.serious), 599);
    expect(g.level).toBe(2);
    g.update(inputs(Thermal.serious), 601);
    expect(g.level).toBe(3);
  });

  test('up immediately, down one level per five minutes', () => {
    const g = new G();
    expect(g.update(inputs(Thermal.critical), 0)).toBe(4);
    expect(g.update(inputs(), 1)).toBeNull();
    expect(g.update(inputs(), 299)).toBeNull();
    expect(g.level).toBe(4);
    expect(g.update(inputs(), 302)).toBe(3);
    expect(g.update(inputs(), 400)).toBeNull();
    expect(g.update(inputs(), 603)).toBe(2);
    expect(g.update(inputs(Thermal.critical), 700)).toBe(4);
    expect(g.update(inputs(), 701)).toBeNull();
    expect(g.level).toBe(4);
    let t = 702;
    for (let k = 0; k < 20; k++) { g.update(inputs(k % 2 === 0 ? Thermal.fair : Thermal.nominal), t); t += 10; }
    expect(g.level).toBe(4);
  });

  test('restored level steps down by the usual rule', () => {
    const g = G.restored(3, 0);
    expect(g.level).toBe(3);
    g.update(inputs(), 100);
    expect(g.level).toBe(3);
    g.update(inputs(), 301);
    expect(g.level).toBe(2);
  });

  test('budgets are cumulative', () => {
    const b = [0, 1, 2, 3, 4].map((l) => G.budget(l));
    expect(b[0].rateCeilingFPS === 120 && b[0].renderScale === 1 && !b[0].backgroundSuppressed && b[0].snapshotsAllowed).toBe(true);
    expect(b.map((x) => x.glowMotion)).toEqual([1, 1, 0.5, 0, 0]);
    expect(b[1].perceptionPressure === 1 && b[1].rateCeilingFPS === 60).toBe(true);
    expect(b[2].perceptionPressure === 2 && b[2].rateCeilingFPS === 60 && b[2].renderScale === 1).toBe(true);
    expect(b[3].renderScale === 0.8 && b[3].backgroundSuppressed && b[3].oledBrightnessScale === 0.85
      && b[3].idleDimSooner === 2 && b[3].snapshotsAllowed).toBe(true);
    expect(b[4].perceptionPressure === 3 && !b[4].snapshotsAllowed && b[4].renderScale === 0.8).toBe(true);
    for (const x of b) {
      expect(x.awakeTargetFPS === 60 && x.asleepTargetFPS === 30).toBe(true);
      expect(x.rateCeilingFPS).toBeGreaterThanOrEqual(60);
      expect(x.renderScale).toBeGreaterThanOrEqual(0.8);
    }
  });
});

/// "Never the face": at every level all face modifiers run and the eyes stay at the target frame rate.
describe('NeverTheFace', () => {
  const oledPro = browserProfile(iPadEnv(834, 1210), { maxFramesPerSecond: 120 });

  test.each([0, 1, 2, 3, 4])('eyes stay at target with someone in view (level %i)', (level) => {
    const engine = new FaceEngine();
    const clock = new FrameClock(engine);
    const control: RenderScaleControl = { renderScale: 1 };
    const budget = G.budget(level);
    KioskApply.apply(DeviceDefaults.for(oledPro), oledPro, budget, clock, control, engine);
    engine.setAgentState('idle');
    engine.setPeople([makePersonTarget(1, { x: 0.3, y: -0.1 })], 1);
    let t = 0;
    let previous: string | null = null;
    let changed = 0;
    for (let i = 0; i < 240; i++) {
      t += 1 / 60;
      engine.setPeople([makePersonTarget(1, { x: 0.3 * Math.sin(t), y: -0.1 })], 1);
      const f = clock.step(t);
      if (i > 30) expect(clock.policy.tier).toBeGreaterThanOrEqual(60);
      expect(f.isAsleep).toBe(false);
      const key = JSON.stringify(f.pose);
      if (previous !== null && previous !== key) changed += 1;
      previous = key;
    }
    expect(changed).toBeGreaterThanOrEqual(235);
    expect(engine.director.modifiers.every((m) => m.isEnabled)).toBe(true);
    expect(control.renderScale).toBe(budget.renderScale);
    expect(clock.rateCeiling).toBeGreaterThanOrEqual(60);
    expect(clock.rateCeiling).toBe(level >= 1 ? 60 : 120);
    const snap = clock.stats.snapshot();
    expect(snap.awake.delivered + snap.burst.delivered).toBeGreaterThanOrEqual(200);
  });

  test.each([0, 1, 2, 3, 4])('asleep stays at thirty (level %i)', (level) => {
    const engine = new FaceEngine();
    const clock = new FrameClock(engine);
    KioskApply.apply(DeviceDefaults.for(oledPro), oledPro, G.budget(level), clock, null, engine);
    engine.setAgentState('asleep');
    let t = 0;
    for (let i = 0; i < 120; i++) { t += 1 / 30; clock.step(t); }
    expect(clock.policy.tier).toBe(30);
    expect(engine.director.modifiers.every((m) => m.isEnabled)).toBe(true);
  });

  test('background fade uses its spring, not a snap', () => {
    const engine = new FaceEngine();
    const cfg = engine.moodBackground;
    cfg.mode = 'mood';
    engine.moodBackground = cfg;
    const clock = new FrameClock(engine);
    let t = 0;
    let f = clock.step(t);
    for (let i = 0; i < 600; i++) { t += 1 / 60; f = clock.step(t); }
    const before = f.backgroundPresence;
    expect(before).toBeGreaterThan(0.5);
    KioskApply.apply(DeviceDefaults.for(oledPro), oledPro, G.budget(3), clock, null, engine);
    t += 1 / 60;
    expect(before - clock.step(t).backgroundPresence).toBeLessThan(0.05);
    for (let i = 0; i < 600; i++) { t += 1 / 60; f = clock.step(t); }
    expect(f.backgroundPresence).toBeLessThan(0.05);
  });

  test('OLED brightness step-down is smoothed', () => {
    const engine = new FaceEngine();
    const clock = new FrameClock(engine);
    engine.setPeople([makePersonTarget(1, { x: 0, y: 0 })], 1);
    let t = 0;
    for (let i = 0; i < 300; i++) { t += 1 / 60; clock.step(t); }
    const base = engine.state.baseBrightness;
    KioskApply.apply(DeviceDefaults.for(oledPro), oledPro, G.budget(3), clock, null, engine);
    t += 1 / 60;
    clock.step(t);
    expect(Math.abs(engine.state.baseBrightness - base)).toBeLessThan(0.02);
    for (let i = 0; i < 900; i++) { t += 1 / 60; clock.step(t); }
    expect(Math.abs(engine.state.baseBrightness - base * 0.85)).toBeLessThan(0.02);
  });

  test('LCD ignores the OLED step-down', () => {
    const lcd = browserProfile(iPadEnv(820, 1180));
    const care = KioskApply.powerCare(DeviceDefaults.for(lcd), lcd, G.budget(3));
    expect(care.brightnessScale).toBe(1);
    expect(care.idleDimDelay).toBe(10);   // the dim still starts sooner
    expect(KioskApply.rateCeiling(DeviceDefaults.for(lcd), G.budget(0))).toBe(60);
  });

  test('style caps', () => {
    const d = DeviceDefaults.for(oledPro);
    const s = KioskApply.style(makeRenderStyle(), d);
    expect(s.maxLuminance).toBe(0.80);
    expect(s.backgroundAPLBudget).toBe(0.15);
    expect(KioskApply.style(makeRenderStyle(), d, 0.5).backgroundAPLBudget).toBe(0.30);
    const lcd = DeviceDefaults.for(browserProfile(iPadEnv(820, 1180)));
    expect(KioskApply.style(makeRenderStyle(), lcd)).toEqual(makeRenderStyle());
  });

  test('the glow and thinking-beat rates follow the level', () => {
    const engine = new FaceEngine();
    const clock = new FrameClock(engine);
    KioskApply.apply(DeviceDefaults.for(oledPro), oledPro, G.budget(2), clock, null, engine);
    expect(engine.listeningGlow.motion).toBe(0.5);
    const beats = engine.director.modifier('ThinkingBeats') as unknown as { rate: number };
    expect(beats.rate).toBe(0.6);
    expect(engine.state.backgroundSuppressed).toBe(false);
    KioskApply.apply(DeviceDefaults.for(oledPro), oledPro, G.budget(3), clock, null, engine);
    expect(engine.state.backgroundSuppressed).toBe(true);
  });
});
