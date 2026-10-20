// Port of Tests/FaceLifeTests/LifeBedtimeTests.swift: bedtime schedule, night wakes, force sleep / force wake.
import { describe, expect, test } from 'vitest';
import { LifePhase, LifeSettings } from '../../src/life';
import { LifeRig, fullStackTest, makeDate, req, utcCalendar } from './LifeRig';

const bedtime = (start = 22 * 60, end = 7 * 60): LifeSettings => new LifeSettings({ bedtimeEnabled: true, bedtimeStart: start, bedtimeEnd: end });
const last = <T>(a: T[]): T | undefined => a[a.length - 1];

describe('LifeBedtimeTests', () => {
  // MARK: Schedule

  test('windowAcrossMidnight', () => {
    const w = (m: number): boolean => LifeSettings.isInWindow(m, 22 * 60, 7 * 60);
    expect(w(21 * 60 + 59)).toBe(false);
    expect(w(22 * 60)).toBe(true);
    expect(w(23 * 60 + 30)).toBe(true);
    expect(w(3 * 60)).toBe(true);
    expect(w(6 * 60 + 59)).toBe(true);
    expect(w(7 * 60)).toBe(false);
    expect(w(12 * 60)).toBe(false);
    expect(LifeSettings.isInWindow(13 * 60, 12 * 60, 14 * 60)).toBe(true);
    expect(LifeSettings.isInWindow(5, 600, 600), 'start == end is no window').toBe(false);
  });

  test('scheduleFollowsTheWallClock', () => {
    const rig = new LifeRig({ settings: bedtime(), date: makeDate(2026, 10, 10, 21, 59) });
    expect(rig.life.isBedtime).toBe(false);
    rig.run(61);
    expect(rig.life.isBedtime, '22:00 starts bedtime').toBe(true);
    rig.clock.date = makeDate(2026, 10, 11, 6, 59);
    rig.run(1.5);
    expect(rig.life.isBedtime).toBe(true);
    rig.clock.date = makeDate(2026, 10, 11, 7, 0);
    rig.run(1.5);
    expect(rig.life.isBedtime, '07:00 ends it').toBe(false);
    expect(rig.bedtimeCalls.map((c) => c[0])).toEqual([false, true, false]);
  });

  test('startEqualsEndAndDisabledMeanNoSchedule', () => {
    const same = new LifeRig({ settings: bedtime(600, 600), date: makeDate(2026, 10, 10, 10, 30) });
    expect(same.life.isBedtime).toBe(false);
    expect(same.life.nextBedtimeBoundary).toBeNull();
    const rig = new LifeRig({ settings: bedtime().with({ bedtimeEnabled: false }), date: makeDate(2026, 10, 10, 23, 0) });
    expect(rig.life.isBedtime).toBe(false);
  });

  test('manualSwitch', () => {
    const rig = new LifeRig();
    rig.life.settings = rig.life.settings.with({ manualBedtime: true });
    expect(rig.life.isBedtime).toBe(true);
    rig.life.settings = rig.life.settings.with({ manualBedtime: false });
    expect(rig.life.isBedtime).toBe(false);
  });

  test('daylightSavingDays', () => {
    const ny = utcCalendar('America/New_York');
    // Spring forward (2026-03-08): 02:00–03:00 doesn't exist; a 02:30 start is caught at 03:00.
    const spring = new LifeRig({ settings: bedtime(2 * 60 + 30, 7 * 60), date: makeDate(2026, 3, 8, 1, 59, 'America/New_York'), calendar: ny });
    expect(spring.life.isBedtime).toBe(false);
    spring.run(62);
    expect(spring.life.isBedtime, '01:59 + 1 min = 03:00 EDT, inside the window').toBe(true);
    // Fall back (2026-11-01): 01:00–02:00 repeats; a 01:30 end ends bedtime at the first 01:30 and the repeated hour
    // stays outside.
    const fall = new LifeRig({ settings: bedtime(22 * 60, 60 + 30), date: makeDate(2026, 11, 1, 1, 0, 'America/New_York'), calendar: ny });
    expect(fall.life.isBedtime).toBe(true);
    fall.clock.date = new Date(fall.clock.date.getTime() + 31 * 60 * 1000);
    fall.run(1.5);
    expect(fall.life.isBedtime).toBe(false);
    expect(fall.life.nextBedtimeBoundary).not.toBeNull();
  });

  test('timeZoneChangeReevaluates', () => {
    // 14:00 UTC is 23:00 in Tokyo.
    const rig = new LifeRig({ settings: bedtime(), date: makeDate(2026, 10, 10, 14, 0) });
    expect(rig.life.isBedtime).toBe(false);
    rig.life.calendar = utcCalendar('Asia/Tokyo');
    expect(rig.life.isBedtime).toBe(true);
    rig.life.calendar = utcCalendar();
    expect(rig.life.isBedtime).toBe(false);
    rig.life.timeDidChange();
    expect(rig.life.isBedtime).toBe(false);
  });

  // MARK: Entering bedtime

  test('enteringBedtimeYawnsAndSleepsWithin30s', () => {
    const rig = new LifeRig({ settings: bedtime(), date: makeDate(2026, 10, 10, 21, 59, 'UTC', 59.5) });
    rig.person(true);                                // presence doesn't hold it awake at bedtime
    rig.run(0.5);
    req(rig.runUntil(3, () => rig.life.isBedtime));
    let yawned = false;
    const t = req(rig.runUntil(40, () => {
      if (rig.engine.state.startedOneShots.some((s) => s.kind === 'yawn')) yawned = true;
      return rig.state === 'asleep';
    }));
    expect(Math.abs(t - 30), `drowsy → asleep over ≈ 30 s (${t})`).toBeLessThan(1.5);
    expect(yawned).toBe(true);
    expect(rig.changes.some((c) => c.to === 'drowsy' && c.reason === 'bedtime')).toBe(true);
    // The voice heard about bedtime before drowsy was written (so the yawn is silent).
    const call = req(rig.bedtimeCalls.find((c) => c[0]));
    expect(call[1]).not.toBe('drowsy');
  });

  test('passerByAtBedtimeDoesNotHalfWake', () => {
    const rig = new LifeRig({ settings: bedtime(), date: makeDate(2026, 10, 10, 23, 0) });
    rig.fallAsleep();
    rig.person(true, { facing: true });
    rig.run(10);
    expect(rig.state).toBe('asleep');
  });

  test('wakeOnMotionAtBedtimeHalfWakesAndWakes', () => {
    const rig = new LifeRig({ settings: bedtime().with({ wakeOnMotionAtBedtime: true }), date: makeDate(2026, 10, 10, 23, 0) });
    rig.fallAsleep();
    rig.person(true);
    req(rig.runUntil(2, () => rig.state === 'halfAwake'));
    rig.run(9);
    expect(rig.state, 'no linger wake at bedtime').toBe('halfAwake');
    rig.person(true, { engaged: true });
    req(rig.runUntil(1, () => rig.state === 'waking'));
    expect(rig.life.isNightAwake).toBe(true);
    expect(rig.life.isBedtime).toBe(true);
  });

  // MARK: Taps at bedtime

  fullStackTest('onlyNTapsWithin4sWake', () => {
    const rig = new LifeRig({ settings: bedtime(), date: makeDate(2026, 10, 10, 23, 0) });
    rig.fallAsleep();
    expect(rig.touch.tapsToWake).toBe(3);
    rig.tap(); rig.run(1);
    expect(rig.state, 'first tap: a lid flutter').toBe('asleep');
    rig.tap(); rig.run(1);
    expect(rig.state, 'second tap: a brief half-awake').toBe('halfAwake');
    rig.run(6);
    expect(rig.state, 'sinks back').toBe('asleep');
    // Spaced taps (> 4 s apart) never add up.
    for (let i = 0; i < 4; i++) { rig.tap(); rig.run(4.5); }
    expect(LifePhase.of(rig.state) === 'asleep' || rig.state === 'halfAwake').toBe(true);
    rig.run(6);
    // Three within 4 s wake.
    rig.tap(); rig.run(0.5); rig.tap(); rig.run(0.5); rig.tap(); rig.frame();
    expect(rig.state === 'noticing' || rig.state === 'waking').toBe(true);
    expect(last(rig.changes)?.reason).toBe('tap');
  });

  fullStackTest('nightWakeKeepsBedtimeAndDriftsBack', () => {
    const rig = new LifeRig({ settings: bedtime(), date: makeDate(2026, 10, 10, 23, 0) });
    rig.fallAsleep();
    rig.tap(); rig.run(0.3); rig.tap(); rig.run(0.3); rig.tap(); rig.frame();
    expect(LifePhase.of(rig.state) === 'awake' || rig.state === 'waking').toBe(true);
    expect(rig.life.isBedtime, 'a night wake is not a force wake').toBe(true);
    expect(rig.life.isNightAwake).toBe(true);
    expect(last(rig.bedtimeCalls)?.[0]).toBe(true);
    rig.person(true);                                // someone stays around without engaging
    rig.run(20);
    expect(LifePhase.of(rig.state), 'awake for bedtimeAwakeMinutes').toBe('awake');
    rig.life.timeWarp = 60;
    const t = req(rig.runUntil(40, () => rig.state === 'drowsy'));
    expect(t, 'drifts back after 1 minute (warped) despite presence').toBeLessThan(2);
    req(rig.runUntil(35, () => rig.state === 'asleep'));
  });

  // MARK: Force

  fullStackTest('forceSleepHoldsWithAPersonPresent', () => {
    const rig = new LifeRig({ settings: new LifeSettings({ wakeOnMotionAtBedtime: true }) });
    rig.person(true, { engaged: true });
    rig.run(2);
    rig.life.forceSleep();
    expect(rig.state).toBe('drowsy');
    expect(last(rig.changes)?.reason).toBe('force');
    const t = req(rig.runUntil(8, () => rig.state === 'asleep'));
    expect(t).toBeLessThan(5);
    rig.run(60);
    expect(rig.state, "people don't undo a force sleep").toBe('asleep');
    expect(rig.touch.tapsToWake).toBe(3);
    rig.life.forceWake();
    expect(rig.state).toBe('waking');
    req(rig.runUntil(6, () => rig.state === 'noticing'));
    expect(rig.life.isForceSleepActive).toBe(false);
  });

  fullStackTest('forceSleepEndsOnTapWake', () => {
    const rig = new LifeRig();
    rig.life.forceSleep();
    req(rig.runUntil(8, () => rig.state === 'asleep'));
    rig.tap(); rig.run(0.3); rig.tap(); rig.run(0.3); rig.tap(); rig.frame();
    expect(rig.life.isForceSleepActive).toBe(false);
    expect(LifePhase.of(rig.state) === 'awake' || rig.state === 'waking').toBe(true);
  });

  test('forceSleepHoldEnds', () => {
    const rig = new LifeRig();
    rig.life.forceSleep(20);
    req(rig.runUntil(8, () => rig.state === 'asleep'));
    rig.run(20);
    expect(rig.life.isForceSleepActive).toBe(false);
    rig.person(true);
    req(rig.runUntil(2, () => rig.state === 'halfAwake'));
  });

  test('forceWakeSuspendsOnlyTheCurrentWindow', () => {
    const rig = new LifeRig({ settings: bedtime(), date: makeDate(2026, 10, 10, 23, 0) });
    rig.fallAsleep();
    rig.life.forceWake();
    expect(rig.life.isBedtime).toBe(false);
    expect(rig.life.scheduleSuspended).toBe(true);
    expect(rig.state).toBe('waking');
    rig.clock.date = makeDate(2026, 10, 11, 3, 0);
    rig.run(1.5);
    expect(rig.life.isBedtime, 'suspended until the window ends').toBe(false);
    rig.clock.date = makeDate(2026, 10, 11, 7, 1);
    rig.run(1.5);
    expect(rig.life.scheduleSuspended).toBe(false);
    rig.clock.date = makeDate(2026, 10, 11, 22, 0);
    rig.run(1.5);
    expect(rig.life.isBedtime, "next night's bedtime is back").toBe(true);
  });

  test('forceWakeOutsideTheWindowDoesNotAffectTonight', () => {
    const rig = new LifeRig({ settings: bedtime(), date: makeDate(2026, 10, 10, 20, 0) });
    rig.life.forceWake();
    expect(rig.life.scheduleSuspended).toBe(false);
    rig.clock.date = makeDate(2026, 10, 10, 22, 0);
    rig.run(1.5);
    expect(rig.life.isBedtime).toBe(true);
  });

  test('forceWakeClearsTheManualSwitch', () => {
    const rig = new LifeRig();
    rig.life.settings = rig.life.settings.with({ manualBedtime: true });
    rig.fallAsleep();
    rig.life.forceWake();
    expect(rig.life.settings.manualBedtime).toBe(false);
    expect(rig.life.isBedtime).toBe(false);
  });

  fullStackTest('tapPermissionOnlyWhileAsleepAtBedtime', () => {
    const rig = new LifeRig({ settings: bedtime(), date: makeDate(2026, 10, 10, 22, 0) });
    rig.run(2);
    expect(rig.state).toBe('drowsy');
    expect(rig.touch.tapsToWake, 'not during the lead-in').toBe(1);
    req(rig.runUntil(35, () => rig.state === 'asleep'));
    expect(rig.touch.tapsToWake).toBe(3);
  });
});
