// Port of Tests/FaceLifeTests/LifeScheduleCacheTests.swift: the cached 1 Hz schedule check must agree with the uncached
// computation at every step, and stay off the calendar in steady state.
import { describe, expect, test } from 'vitest';
import { LifeCalendar, LifeSettings } from '../../src/life';
import { LifeRig, makeDate, utcCalendar } from './LifeRig';

const bedtime = (start: number, end: number): LifeSettings => new LifeSettings({ bedtimeEnabled: true, bedtimeStart: start, bedtimeEnd: end });

/// The uncached implementation (the oracle): calendar minute in window, next start / end after `now`.
function reference(st: LifeSettings, cal: LifeCalendar, now: Date): { active: boolean; boundary: number | null } {
  if (!st.hasSchedule) return { active: false, boundary: null };
  const c = cal.hourMinute(now);
  const active = LifeSettings.isInWindow(c.hour * 60 + c.minute, st.bedtimeStart, st.bedtimeEnd);
  const next = (m: number): number | null => cal.nextDate(now, Math.floor(m / 60), m % 60)?.getTime() ?? null;
  const a = next(st.bedtimeStart), b = next(st.bedtimeEnd);
  return { active, boundary: a !== null && b !== null ? Math.min(a, b) : a ?? b };
}

/// One 1 Hz schedule step: both clocks advance by `dt`, then the controller runs a frame.
function step(rig: LifeRig, dt = 1): void {
  rig.clock.advance(dt);
  rig.life.afterFrame(rig.clock.mono);
}

function matches(rig: LifeRig, cal: LifeCalendar, label: string): boolean {
  const st = rig.life.settings;
  const ref = reference(st, cal, rig.clock.date);
  const ok = rig.life.isScheduledBedtime === ref.active
    && rig.life.isBedtime === (ref.active || st.manualBedtime)
    && (rig.life.nextBedtimeBoundary?.getTime() ?? null) === ref.boundary;
  if (!ok) {
    expect.fail(`${label} at ${rig.clock.date.toISOString()}: scheduled ${rig.life.isScheduledBedtime} vs ${ref.active}, boundary ${
      rig.life.nextBedtimeBoundary?.toISOString()} vs ${ref.boundary === null ? null : new Date(ref.boundary).toISOString()}`);
  }
  return ok;
}

/// Steps `seconds` at 1 Hz, comparing with the oracle after every step; returns the mismatch count.
function runCompared(rig: LifeRig, cal: LifeCalendar, seconds: number, label: string): number {
  let mismatches = 0;
  for (let i = 0; i < seconds; i++) {
    step(rig);
    if (!matches(rig, cal, label)) { mismatches += 1; if (mismatches > 3) break; }
  }
  return mismatches;
}

describe('LifeScheduleCacheTests', () => {
  test('ordinaryDayAcrossStartEndAndMidnight', () => {
    const cal = utcCalendar();
    const rig = new LifeRig({ settings: bedtime(22 * 60, 7 * 60), date: makeDate(2026, 10, 10, 12, 0), calendar: cal });
    expect(runCompared(rig, cal, 26 * 3600, 'UTC')).toBe(0);
    expect(rig.bedtimeCalls.map((c) => c[0])).toEqual([false, true, false]);
  });

  test('sameDayWindow', () => {
    const cal = utcCalendar('Europe/Paris');
    const rig = new LifeRig({ settings: bedtime(13 * 60 + 15, 14 * 60 + 45), date: makeDate(2026, 10, 10, 11, 0, 'Europe/Paris'), calendar: cal });
    expect(runCompared(rig, cal, 6 * 3600, 'Paris')).toBe(0);
  });

  /// Spring forward (America/New_York, 2026-03-08 02:00 → 03:00) and fall back (2026-11-01 02:00 → 01:00), with
  /// windows that start, end or sit inside the skipped / repeated hour.
  const dstWindows: [number, number][] = [[1320, 420], [150, 420], [1320, 90], [75, 105], [0, 120], [120, 180]];

  test.each(dstWindows)('daylightSavingDays %i–%i', (start, end) => {
    const cal = utcCalendar('America/New_York');
    for (const [y, mo, d] of [[2026, 3, 7], [2026, 10, 31]]) {
      const rig = new LifeRig({ settings: bedtime(start, end), date: makeDate(y, mo, d, 12, 0, 'America/New_York'), calendar: cal });
      expect(runCompared(rig, cal, 25 * 3600, `NY ${mo}/${d} ${start}-${end}`)).toBe(0);
    }
  });

  test('wallClockJumps', () => {
    const cal = utcCalendar();
    const rig = new LifeRig({ settings: bedtime(22 * 60, 7 * 60), date: makeDate(2026, 10, 10, 21, 50), calendar: cal });
    expect(runCompared(rig, cal, 20 * 60, 'before')).toBe(0);
    expect(rig.life.isBedtime).toBe(true);
    // Backwards (NTP correction / manual change, no notification): out of the window again at once.
    rig.clock.date = makeDate(2026, 10, 10, 20, 0);
    step(rig);
    expect(matches(rig, cal, 'after backward jump')).toBe(true);
    expect(rig.life.isBedtime).toBe(false);
    expect(runCompared(rig, cal, 3 * 3600, 'after backward jump')).toBe(0);
    // A small backwards step inside the tolerance changes nothing visible either.
    rig.clock.date = new Date(rig.clock.date.getTime() - 500);
    expect(runCompared(rig, cal, 60, 'small step')).toBe(0);
    // Forward across a boundary.
    rig.clock.date = makeDate(2026, 10, 11, 7, 30);
    step(rig);
    expect(matches(rig, cal, 'after forward jump')).toBe(true);
    expect(runCompared(rig, cal, 3600, 'after forward jump')).toBe(0);
  });

  test('timeZoneChangeIsPickedUpWhenForced', () => {
    const rig = new LifeRig({ settings: bedtime(22 * 60, 7 * 60), date: makeDate(2026, 10, 10, 20, 0), calendar: utcCalendar() });
    expect(rig.life.isBedtime).toBe(false);
    const cal = utcCalendar('Asia/Tokyo');           // 05:00 there
    rig.life.calendar = cal;
    expect(rig.life.isBedtime).toBe(true);
    expect(runCompared(rig, cal, 7200, 'Tokyo')).toBe(0);
  });

  /// A simulated day of 1 Hz checks asks the calendar only at the boundaries and the hourly safety net.
  test('steadyStateStaysOffTheCalendar', () => {
    const rig = new LifeRig({ settings: bedtime(22 * 60, 7 * 60), date: makeDate(2026, 10, 10, 12, 0) });
    const before = rig.life.scheduleRecomputeCount;
    for (let i = 0; i < 24 * 3600; i++) step(rig);
    const n = rig.life.scheduleRecomputeCount - before;
    // 2 boundaries + ≤ 24 hourly rechecks.
    expect(n).toBeLessThanOrEqual(26);
    expect(n).toBeGreaterThanOrEqual(2);

    // Between two checks nothing is recomputed.
    const c = rig.life.scheduleRecomputeCount;
    for (let i = 0; i < 600; i++) step(rig);
    expect(rig.life.scheduleRecomputeCount - c).toBeLessThanOrEqual(1);

    // No schedule: only the safety net.
    const quiet = new LifeRig({ settings: bedtime(22 * 60, 7 * 60).with({ bedtimeEnabled: false }) });
    const q0 = quiet.life.scheduleRecomputeCount;
    for (let i = 0; i < 24 * 3600; i++) step(quiet);
    expect(quiet.life.scheduleRecomputeCount - q0).toBeLessThanOrEqual(24);
  });

  test('forcedPathsStillRecompute', () => {
    const rig = new LifeRig({ settings: bedtime(22 * 60, 7 * 60), date: makeDate(2026, 10, 10, 12, 0) });
    const c = rig.life.scheduleRecomputeCount;
    rig.life.timeDidChange();
    expect(rig.life.scheduleRecomputeCount).toBe(c + 1);
    rig.life.settings = rig.life.settings.with({ bedtimeStart: 12 * 60 });
    expect(rig.life.isBedtime, 'settings change applies at once').toBe(true);
    expect(rig.life.scheduleRecomputeCount).toBe(c + 2);
  });
});

// Swift LifeAllocationTests counts heap allocations with libmalloc's logger hook; JS has no equivalent. The steady state
// staying off the calendar is covered above.
describe('LifeAllocationTests', () => {
  test.skip('afterFrameAllocatesNothingInSteadyState (no allocation counter in JS)', () => {});
});
