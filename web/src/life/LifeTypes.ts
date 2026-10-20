// Port of FaceLife/LifeTypes.swift (plus LifeCalendar, the port's stand-in for Foundation's Calendar).
import type { AgentState } from '../engine';

/// Where Yanni is in its daily life, derived from the observed agent state (never stored separately).
export type LifePhase = 'awake' | 'drowsy' | 'asleep' | 'halfAwake' | 'waking';

export const LifePhase = {
  allCases: ['awake', 'drowsy', 'asleep', 'halfAwake', 'waking'] as readonly LifePhase[],
  /// The phase an agent state belongs to: the sleep-related states map to themselves, everything else is awake.
  of(s: AgentState): LifePhase {
    switch (s) {
      case 'drowsy': return 'drowsy';
      case 'asleep': return 'asleep';
      case 'halfAwake': return 'halfAwake';
      case 'waking': return 'waking';
      default: return 'awake';
    }
  },
} as const;

/// What perception should do with the camera: full rate, or a low rate that only detects a person (asleep).
export type CameraMode = 'normal' | 'low';

/// Why the phase changed.
/// timer: an inactivity, drift-back or lead-in timer ran out. person: someone came into view, engaged, lingered or
/// left. tap: a tap woke (or stirred) Yanni. force: force sleep / force wake. bedtime: bedtime started. activity:
/// activity while drowsy (Yanni caught itself). takeover: sheepish / confused / has-a-message alone too long.
/// external: someone else changed the agent state. restore: a relaunch restored the saved phase (never activity).
export type LifeReason = 'timer' | 'person' | 'tap' | 'force' | 'bedtime' | 'activity' | 'takeover' | 'external' | 'restore';

/// A phase change as reported to `onPhaseChange`.
export interface LifePhaseChange {
  from: LifePhase;
  to: LifePhase;
  reason: LifeReason;
  /// The agent state right after the change.
  agentState: AgentState;
}

/// Activity from sources the face doesn't see itself. Resets the inactivity clock like a tap.
export type ActivityKind = 'speech' | 'motion' | 'voiceReply' | 'foreground' | 'other';

/// The next thing the life cycle will do on its own, for the panel's countdown.
export interface LifeCountdown {
  /// What happens ("drowsy", "asleep", "back to idle", "bedtime starts" …).
  label: string;
  /// Real seconds until it happens (time warp already applied); null while something holds it off.
  seconds: number | null;
}

/// Injected clock: monotonic seconds for timers and the wall-clock date for the bedtime schedule.
export interface LifeClock {
  monotonic: () => number;
  now: () => Date;
}

export const LifeClock = {
  /// Page uptime and the current date.
  get system(): LifeClock {
    return { monotonic: () => performance.now() / 1000, now: () => new Date() };
  },
} as const;

// MARK: - Calendar

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

const DAY = 86_400_000;

/// The pieces of Foundation's `Calendar` the life cycle uses, for one IANA time zone (Gregorian). Times are Unix ms.
/// port-note: Foundation's `Calendar.autoupdatingCurrent` follows time-zone changes by itself; here `current()` reads the
/// zone once, and the app re-assigns `calendar` (or calls `timeDidChange`) when it changes.
export class LifeCalendar {
  constructor(readonly timeZone: string) { formatter(timeZone); }

  /// The system's current zone.
  static current(): LifeCalendar { return new LifeCalendar(Intl.DateTimeFormat().resolvedOptions().timeZone); }

  // Offsets by UTC minute (zone transitions fall on whole minutes): the 1 Hz schedule checks and the tests' oracle hit
  // this instead of Intl. Cleared when it grows (it only fills while the calendar is asked about many minutes).
  private readonly offsets = new Map<number, number>();

  /// UTC offset (ms) at instant `t`.
  offset(t: number): number {
    const key = Math.floor(t / 60_000);
    let o = this.offsets.get(key);
    if (o === undefined) {
      const s = key * 60_000;
      const p: Record<string, number> = {};
      for (const x of formatter(this.timeZone).formatToParts(new Date(s))) if (x.type !== 'literal') p[x.type] = Number(x.value);
      o = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - s;
      if (this.offsets.size > 100_000) this.offsets.clear();
      this.offsets.set(key, o);
    }
    return o;
  }

  /// Local wall-clock fields at `t` (ms).
  parts(t: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
    const d = new Date(t + this.offset(t));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(),
      minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
  }

  /// Instants whose local wall time is `wall` (local fields written as if UTC, ms): one normally, two in a repeated
  /// hour (earlier first), none in a skipped one.
  private instants(wall: number): number[] {
    const out: number[] = [];
    for (const o of new Set([this.offset(wall - DAY), this.offset(wall + DAY)])) {
      const t = wall - o;
      if (this.offset(t) === o && !out.includes(t)) out.push(t);
    }
    return out.sort((a, b) => a - b);
  }

  /// First instant at or after `wall`'s local time: in a skipped hour, the transition (Foundation `.nextTime`).
  private resolve(wall: number): number[] {
    const ts = this.instants(wall);
    if (ts.length) return ts;
    const before = this.offset(wall - DAY), after = this.offset(wall + DAY);
    return [this.transitionBetween(wall - after, wall - before)];
  }

  /// `Calendar.date(from:)` for a local date and time (seconds may be fractional).
  date(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
    return new Date(this.resolve(Date.UTC(year, month - 1, day, hour, minute) + second * 1000)[0]);
  }

  /// `dateComponents([.hour, .minute], from:)`.
  hourMinute(d: Date): { hour: number; minute: number } {
    const p = this.parts(d.getTime());
    return { hour: p.hour, minute: p.minute };
  }

  /// `nextDate(after:matching: DateComponents(hour:minute:), matchingPolicy: .nextTime)`: the first instant strictly
  /// after `after` whose local time is hour:minute:00 (in a skipped hour, the end of the gap).
  nextDate(after: Date, hour: number, minute: number): Date | null {
    const start = after.getTime();
    const p = this.parts(start);
    for (let k = -1; k <= 3; k++) {
      const wall = Date.UTC(p.year, p.month - 1, p.day + k, hour, minute);
      const hit = this.resolve(wall).find((t) => t > start);
      if (hit !== undefined) return new Date(hit);
    }
    return null;
  }

  /// `timeZone.nextDaylightSavingTimeTransition(after:)` (looks up to two years ahead).
  nextDaylightSavingTimeTransition(after: Date): Date | null {
    const t0 = after.getTime();
    const o0 = this.offset(t0);
    for (let d = 1; d <= 731; d++) {
      if (this.offset(t0 + d * DAY) !== o0) return new Date(this.transitionBetween(t0 + (d - 1) * DAY, t0 + d * DAY));
    }
    return null;
  }

  /// The first minute in (lo, hi] whose offset differs from lo's.
  private transitionBetween(lo: number, hi: number): number {
    const o = this.offset(lo);
    let a = Math.floor(lo / 60_000), b = Math.ceil(hi / 60_000);
    while (b - a > 1) {
      const m = Math.floor((a + b) / 2);
      if (this.offset(m * 60_000) === o) a = m; else b = m;
    }
    return b * 60_000;
  }
}
