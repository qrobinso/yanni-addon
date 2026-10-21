// Port of Tests/FacePerceptionTests/EngagementTests.swift: look-to-talk dwell, hysteresis, range, turn FIFO, release,
// re-engage, pinning, damping.
import { describe, expect, test } from 'vitest';
import { roundSwift } from '../../src/core/vec';
import { EngagementManager, makeEngagementInput } from '../../src/perception/Engagement';
import type { EngagementInput, EngagementOutput } from '../../src/perception/Engagement';
import { PerceptionEvent } from '../../src/perception/PerceptionTypes';

/// Drives the manager at 30 Hz. `looking(id, t)` returns lookingAtMe (null = detection dropout / not present).
class Rig {
  m = new EngagementManager();
  t = 0;
  events: [number, PerceptionEvent][] = [];
  distance = new Map<number, number>();
  eyes = true;
  outs = new Map<number, EngagementOutput>();

  run(seconds: number, looking: (id: number, t: number) => number | null, present: number[] = [1]): void {
    const dt = 1.0 / 30;
    const n = roundSwift(seconds / dt);
    for (let i = 0; i < n; i++) {
      this.t += dt;
      const inputs: EngagementInput[] = present.map((id) => {
        const l = looking(id, this.t);
        return makeEngagementInput({ id, lookingAtMe: l ?? 0, hasReading: l !== null, eyes: this.eyes,
          distance: this.distance.get(id) ?? 1, faceHeightPx: 120, headAngleDegrees: 10 });
      });
      const r = this.m.update(inputs, this.t, dt);
      for (const e of r.events) this.events.push([this.t, e]);
      this.outs = r.out;
    }
  }

  first(name: string): number | null { return this.events.find((e) => PerceptionEvent.name(e[1]) === name)?.[0] ?? null; }
  count(name: string): number { return this.events.filter((e) => PerceptionEvent.name(e[1]) === name).length; }
  engaged(): [number, number][] {
    return this.events.flatMap((e) => e[1].kind === 'engaged' ? [[e[0], e[1].id] as [number, number]] : []);
  }
  disengaged(id: number, reason: string): number | null {
    return this.events.find((e) => e[1].kind === 'disengaged' && e[1].id === id && e[1].reason === reason)?.[0] ?? null;
  }
}

/// lookingAtMe as the smoother would produce it (rise τ 0.12 s from 0 when looking starts at `from`).
function ramp(t: number, from: number, until = Infinity): number {
  if (t < from) return 0;
  if (t < until) return Math.fround(1 - Math.exp(-(t - from) / 0.12)) * 0.95;
  return 0.95 * Math.exp(-(t - until) / 0.25);
}

describe('EngagementTests', () => {
  test('briefGlanceNeverEngages', () => {
    const r = new Rig();
    r.run(5, (_, t) => ramp(t, 1, 1.6));
    expect(r.first('engaged')).toBeNull();
    const twice = new Rig();
    twice.run(6, (_, t) => t < 3 ? ramp(t, 1, 1.6) : ramp(t, 3.6, 4.2));
    expect(twice.first('engaged'), "two glances 2 s apart don't add up (decay)").toBeNull();
  });

  test('oneSecondEngagesHeadOnlyNeedsLonger', () => {
    const r = new Rig();
    r.run(4, (_, t) => ramp(t, 1));
    const e = r.first('engaged')!;
    expect(e - 1 > 1.0 && e - 1 < 1.25, `≈ 1 s of contact (${e - 1})`).toBe(true);

    const h = new Rig();
    h.eyes = false;
    h.run(4, (_, t) => ramp(t, 1));
    const eh = h.first('engaged')!;
    expect(eh - 1 > 1.4 && eh - 1 < 1.65, `≈ 1.4 s head-only (${eh - 1})`).toBe(true);
  });

  test("shortDropoutsDontReset", () => {
    const r = new Rig();
    // 0.15 s detection dropouts every 0.4 s while looking.
    r.run(4, (_, t) => {
      if (t < 1) return 0;
      return (t - 1) % 0.4 > 0.25 ? null : 0.9;
    });
    const e = r.first('engaged');
    expect(e).not.toBeNull();
    expect(e! - 1).toBeLessThan(1.8);
  });

  test('tooFarNeverEngages', () => {
    const r = new Rig();
    r.distance.set(1, 1.8);
    r.run(5, (_, t) => ramp(t, 1));
    expect(r.first('engaged')).toBeNull();
    expect(r.count('lookingAtMe'), 'looking-at-me milestones (0.5, 1, 2 s) still fire out of range').toBe(3);
  });

  test('milestones', () => {
    const r = new Rig();
    r.run(7, (_, t) => ramp(t, 1));
    const secs = r.events.flatMap((e) => e[1].kind === 'lookingAtMe' ? [e[1].seconds] : []);
    expect(secs).toEqual([0.5, 1, 2, 5]);
  });

  test('firstComeHoldsTheTurnSecondWaitsThenTakesIt', () => {
    const r = new Rig();
    r.distance = new Map([[1, 1], [2, 1.2]]);
    // 1 looks from 1 s; 2 from 1.5 s; 1 looks away at 5 s; 2 keeps looking.
    r.run(12, (id, t) => id === 1 ? ramp(t, 1, 5) : ramp(t, 1.5), [1, 2]);
    const engaged = r.engaged();
    expect(engaged[0]?.[1]).toBe(1);
    expect(r.count('wantsTurn'), 'once per turn').toBe(1);
    const release = r.disengaged(1, 'lookedAway');
    expect(release).not.toBeNull();
    expect(Math.abs(release! - 5 - 2.5), `released 2.5 s after looking away (${release})`).toBeLessThan(0.3);
    expect(engaged.length === 2 && engaged[1][1] === 2).toBe(true);
    expect(Math.abs(engaged[1][0] - release!), 'the waiter takes the turn at once, no new dwell').toBeLessThan(0.05);
  });

  test('waiterWhoStoppedLookingDoesNotTakeTheTurn', () => {
    const r = new Rig();
    r.distance = new Map([[1, 1], [2, 1.2]]);
    r.run(14, (id, t) => id === 1 ? ramp(t, 1, 5) : ramp(t, 1.5, 3), [1, 2]);
    expect(r.engaged().map((e) => e[1])).toEqual([1]);
  });

  test('tiesGoToMoreEyeContactThenNearer', () => {
    const r = new Rig();
    r.distance = new Map([[1, 1.4], [2, 0.9]]);
    r.run(3, (_, t) => ramp(t, 1), [1, 2]);
    expect(r.engaged()[0]?.[1], 'same moment, same contact: the nearer one').toBe(2);
  });

  test('releaseOutOfRangeAndGone', () => {
    const r = new Rig();
    r.run(3, (_, t) => ramp(t, 0.5));
    expect(r.m.engagedID).toBe(1);
    r.distance.set(1, 2.2);
    const t0 = r.t;
    r.run(3, () => 0.9);
    const rel = r.disengaged(1, 'outOfRange');
    expect(rel).not.toBeNull();
    expect(Math.abs(rel! - t0 - 2)).toBeLessThan(0.1);

    const g = new Rig();
    g.run(3, (_, t) => ramp(t, 0.5));
    const t1 = g.t;
    g.run(2, () => null, []);
    const gone = g.disengaged(1, 'left');
    expect(gone).not.toBeNull();
    expect(Math.abs(gone! - t1 - 0.5)).toBeLessThan(0.1);
  });

  test('reengageWithinFourSecondsIsQuick', () => {
    const r = new Rig();
    r.run(10, (_, t) => t < 4 ? ramp(t, 0.5) : (t < 7.5 ? 0.1 : 0.95));
    const engaged = r.engaged().map((e) => e[0]);
    expect(engaged.length).toBe(2);
    const released = r.first('disengaged')!;
    expect(released < 7.5 && 7.5 - released <= 4).toBe(true);
    expect(engaged[1] - 7.5, `only 0.5 s needed (${engaged[1] - 7.5})`).toBeLessThan(0.6);
  });

  test('pinHoldsThroughLookAwayUntilUnpinned', () => {
    const r = new Rig();
    r.run(3, (_, t) => ramp(t, 0.5));
    r.m.pinTurn(1);
    r.run(8, () => 0.0);
    expect(r.m.engagedID, 'pinned: a conversation keeps its turn').toBe(1);
    expect(r.first('disengaged')).toBeNull();
    r.m.unpinTurn();
    const t0 = r.t;
    r.run(4, () => 0.0);
    const rel = r.first('disengaged');
    expect(rel).not.toBeNull();
    expect(Math.abs(rel! - t0 - 2.5), 'release timers restart at unpin').toBeLessThan(0.1);
    // Pinning someone who doesn't hold the turn does nothing.
    r.m.pinTurn(42);
    expect(r.m.pinned).toBe(false);
  });

  test('gonePersonReleasesEvenWhenPinned', () => {
    const r = new Rig();
    r.run(3, (_, t) => ramp(t, 0.5));
    r.m.pinTurn(1);
    r.run(1, () => null, []);
    expect(r.m.engagedID).toBeNull();
  });

  test('falseEngagementDamping', () => {
    const r = new Rig();
    const engageOnce = (): number | null => {
      const start = r.t;
      let at: number | null = null;
      const before = r.count('engaged');
      r.run(3, (_, t) => ramp(t, start + 0.1));
      if (r.count('engaged') > before) at = r.engaged()[r.engaged().length - 1][0] - start - 0.1;
      for (const e of r.m.releaseTurn()) r.events.push([r.t, e]);
      r.run(5, () => 0);   // beyond the re-engage window
      return at;
    };
    const a = engageOnce();
    expect(a).not.toBeNull();
    r.m.noteEngagementOutcome(1, false);
    expect(engageOnce()).not.toBeNull();
    r.m.noteEngagementOutcome(1, false);
    expect(r.m.isDamped(1)).toBe(true);
    const start = r.t;
    r.run(4, (_, t) => ramp(t, start + 0.1));
    const damped = r.engaged()[r.engaged().length - 1][0] - start - 0.1;
    expect(damped > 1.9 && a! < 1.3, `dwell doubled after two engagements without speech (${a} → ${damped})`).toBe(true);
    expect(r.m.falseEngagementsPerHour).toBeGreaterThan(0);
    // Speech resets the count.
    r.m.noteEngagementOutcome(1, true);
    expect(r.m.noSpeech.get(1)).toBe(0);
  });
});
