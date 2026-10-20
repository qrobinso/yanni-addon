// LifeCalendar (the port's stand-in for Foundation's Calendar): the DST answers Foundation gives.
import { expect, test } from 'vitest';
import { LifeCalendar } from '../../src/life';

const ny = new LifeCalendar('America/New_York');
const iso = (d: Date | null): string | undefined => d?.toISOString();

test('nextDate, date(from:) and DST transitions in New York', () => {
  // Spring forward 2026-03-08 02:00 EST → 03:00 EDT (07:00Z): a 02:30 match is the end of the gap (.nextTime).
  expect(iso(ny.nextDate(new Date('2026-03-08T06:00:00Z'), 2, 30))).toBe('2026-03-08T07:00:00.000Z');
  expect(iso(ny.nextDaylightSavingTimeTransition(new Date('2026-03-07T17:00:00Z')))).toBe('2026-03-08T07:00:00.000Z');
  // Fall back 2026-11-01 02:00 EDT → 01:00 EST (06:00Z): 01:30 happens twice, the first one is next.
  expect(iso(ny.nextDate(new Date('2026-11-01T04:00:00Z'), 1, 30))).toBe('2026-11-01T05:30:00.000Z');
  expect(iso(ny.nextDate(new Date('2026-11-01T05:30:00Z'), 1, 30))).toBe('2026-11-01T06:30:00.000Z');
  expect(iso(ny.nextDaylightSavingTimeTransition(new Date('2026-10-31T16:00:00Z')))).toBe('2026-11-01T06:00:00.000Z');
  expect(iso(ny.date(2026, 10, 10, 23, 0))).toBe('2026-10-11T03:00:00.000Z');
  expect(ny.hourMinute(new Date('2026-10-11T03:07:00Z'))).toEqual({ hour: 23, minute: 7 });
  expect(new LifeCalendar('UTC').nextDaylightSavingTimeTransition(new Date())).toBeNull();
});
