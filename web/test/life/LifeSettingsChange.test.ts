// Port of Tests/FaceLifeTests/LifeSettingsChangeTests.swift: `onSettingsChange` tells the settings hub when the
// controller changed its own settings (force wake clearing the manual bedtime switch), after the command has finished,
// and never for assignments from outside.
import { describe, expect, test } from 'vitest';
import type { AgentState } from '../../src/engine';
import { LifeSettings } from '../../src/life';
import { LifeRig, fullStackTest } from './LifeRig';

describe('LifeSettingsChangeTests', () => {
  test('forceWakeWithManualBedtimeFiresOnceAfterTheCommandCompleted', () => {
    const rig = new LifeRig();
    rig.life.settings = rig.life.settings.with({ manualBedtime: true });
    rig.fallAsleep();
    expect(rig.state).toBe('asleep');
    expect(rig.life.isBedtime).toBe(true);

    const calls: LifeSettings[] = [];
    let stateInside: AgentState | undefined, bedtimeInside: boolean | undefined;
    let controllerSettingsInside: LifeSettings | undefined, forceSleepInside: boolean | undefined;
    rig.life.onSettingsChange = (n) => {
      calls.push(n);
      controllerSettingsInside = rig.life.settings;
      stateInside = rig.engine.state.agentState;
      bedtimeInside = rig.life.isBedtime;
      forceSleepInside = rig.life.isForceSleepActive;
    };
    rig.life.forceWake();

    expect(calls.length).toBe(1);
    expect(calls[0]?.manualBedtime).toBe(false);
    // Inside the callback the command had already finished: settings cleared, schedule re-evaluated, waking.
    expect(controllerSettingsInside?.manualBedtime).toBe(false);
    expect(controllerSettingsInside?.equals(calls[0])).toBe(true);
    expect(stateInside).toBe('waking');
    expect(bedtimeInside).toBe(false);
    expect(forceSleepInside).toBe(false);

    // Nothing more fires while it wakes up.
    rig.run(3);
    expect(calls.length).toBe(1);
  });

  fullStackTest('forceWakeWithManualBedtimeOffDoesNotFire', () => {
    const rig = new LifeRig();
    let calls = 0;
    rig.life.onSettingsChange = () => { calls += 1; };
    rig.life.forceSleep();
    rig.run(1);
    rig.life.forceWake();
    rig.run(1);
    expect(calls).toBe(0);
    expect(rig.life.settings.manualBedtime).toBe(false);
  });

  test('forceWakeInsideAScheduledWindowSuspendsWithoutFiring', () => {
    const rig = new LifeRig({ settings: new LifeSettings({ bedtimeEnabled: true, bedtimeStart: 11 * 60, bedtimeEnd: 13 * 60 }) });
    expect(rig.life.isScheduledBedtime).toBe(true);
    let calls = 0;
    rig.life.onSettingsChange = () => { calls += 1; };
    rig.life.forceWake();
    expect(rig.life.scheduleSuspended).toBe(true);
    expect(calls).toBe(0);
  });

  test('assigningSettingsFromOutsideNeverFires', () => {
    const rig = new LifeRig();
    let calls = 0;
    rig.life.onSettingsChange = () => { calls += 1; };

    const s = rig.life.settings;
    s.manualBedtime = true;
    rig.life.settings = s;
    rig.run(1);
    s.manualBedtime = false;
    s.tapsToWake = 5;
    s.minutesToDrowsy = 10;
    rig.life.settings = s;
    // Out-of-range values are corrected by the controller itself: still not a controller-originated change.
    s.tapsToWake = 99;
    rig.life.settings = s;
    rig.run(1);

    expect(rig.life.settings.tapsToWake).toBe(LifeSettings.tapsRange[1]);
    expect(calls).toBe(0);
  });
});
