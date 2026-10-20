// Port of Tests/FaceEngineTests/TouchGestureTests.swift.
import { describe, expect, test } from 'vitest';
import type { V2 } from '../../src/core/vec';
import { TouchGestureRecognizer as R, type TouchGestureEvent as Event } from '../../src/engine';

const P = (x: number, y: number): V2 => ({ x, y });
const tap = (at: V2): Event => ({ kind: 'tap', at });
const hold = (at: V2): Event => ({ kind: 'hold', at });

/// Feeds a touch: samples every `dt` from `points(t)` for `duration`, ticking at the same rate; returns every event.
function touch(r: R, duration: number, points: (t: number) => V2, dt = 1.0 / 60, excluded = false): Event[] {
  const events: Event[] = [];
  r.begin(points(0), 0, excluded);
  let t = dt;
  while (t < duration) {
    const m = r.move(points(t), t);
    if (m) events.push(m);
    const k = r.tick(t);
    if (k) events.push(k);
    t += dt;
  }
  const e = r.end(points(duration), duration);
  if (e) events.push(e);
  return events;
}

const isScratch = (e: Event | null): boolean => e?.kind === 'scratch';

/// The touch classifier: tap vs hold vs scratch vs drag, fed timestamped samples (no UI).
describe('TouchGesture', () => {
  test('quickStillTouchIsATap', () => {
    const r = new R();
    const e = touch(r, 0.15, () => P(100, 100));
    expect(e).toEqual([tap(P(100, 100))]);
    expect(r.isTracking).toBe(false);
  });

  test('jitterWithinTheSlopStillTaps', () => {
    const r = new R();
    const e = touch(r, 0.2, (t) => P(100 + 3 * Math.sin(t * 40), 100));
    expect(e.length).toBe(1);
    expect(e[0]?.kind, `expected a tap, got ${JSON.stringify(e)}`).toBe('tap');
  });

  test('stillForHalfASecondHoldsOnceAndNeverTaps', () => {
    const r = new R();
    const e = touch(r, 1.5, () => P(50, 60));
    expect(e, 'one hold, no tap on release').toEqual([hold(P(50, 60))]);
  });

  test('holdFiresOnTime', () => {
    const r = new R();
    r.begin(P(0, 0), 10);
    expect(r.tick(10.49)).toBeNull();
    expect(r.tick(10.5)).toEqual(hold(P(0, 0)));
    expect(r.tick(11)).toBeNull();
  });

  test('releaseJustAfterTheHoldTimeBetweenTicksIsAHold', () => {
    const r = new R();
    r.begin(P(0, 0), 0);
    expect(r.end(P(1, 0), 0.52)).toEqual(hold(P(0, 0)));
  });

  test('aDragDoesNothing', () => {
    const r = new R();
    const e = touch(r, 1.2, (t) => P(100 + 200 * t, 100));
    expect(e, `a drag neither taps, holds nor scratches: ${JSON.stringify(e)}`).toEqual([]);
  });

  test('oneThereAndBackIsNotAScratch', () => {
    const r = new R();
    const e = touch(r, 0.6, (t) => P(100 + 40 * Math.sin(t * Math.PI / 0.6), 100));
    expect(e.some(isScratch)).toBe(false);
  });

  test('rubbingBackAndForthScratchesAndKeepsGoing', () => {
    const r = new R();
    // 3 Hz rub (6 reversals a second), 30 pt wide, for 2 s.
    const e = touch(r, 2, (t) => P(200 + 15 * Math.sin(2 * Math.PI * 3 * t), 300));
    const strokes = e.filter(isScratch);
    expect(strokes.length, `a stroke per reversal (${strokes.length})`).toBeGreaterThanOrEqual(9);
    const s0 = strokes[0];
    expect(s0).toBeDefined();
    if (s0?.kind !== 'scratch') return;
    expect(s0.began).toBe(true);
    expect(s0.intensity >= 0.35 && s0.intensity <= 1).toBe(true);
    const began = strokes.filter((x) => x.kind === 'scratch' && x.began);
    expect(began.length).toBe(1);
    expect(e.some((x) => x.kind === 'hold'), 'a scratch never becomes a hold').toBe(false);
    expect(e.some((x) => x.kind === 'tap')).toBe(false);
    // The first stroke comes after two reversals: within ~0.4 s of starting a 3 Hz rub.
    const r2 = new R();
    let firstAt: number | undefined;
    r2.begin(P(200, 300), 0);
    let t = 1.0 / 60;
    while (t < 1 && firstAt === undefined) {
      if (isScratch(r2.move(P(200 + 15 * Math.sin(2 * Math.PI * 3 * t), 300), t))) firstAt = t;
      r2.tick(t);
      t += 1.0 / 60;
    }
    expect(firstAt).toBeDefined();
    expect(firstAt!).toBeLessThan(0.45);
  });

  test('verticalAndDiagonalRubsScratchToo', () => {
    for (const dir of [P(0, 1), P(0.7, 0.7)]) {
      const r = new R();
      const e = touch(r, 1, (t) => {
        const k = 15 * Math.sin(2 * Math.PI * 3 * t);
        return P(200 + dir.x * k, 200 + dir.y * k);
      });
      const n = e.filter(isScratch).length;
      expect(n >= 3 && n <= 6, `${JSON.stringify(dir)}: diagonal turns count once (${n})`).toBe(true);
    }
  });

  test('fasterRubIsMoreIntense', () => {
    function peak(hz: number): number {
      const r = new R();
      const e = touch(r, 1.5, (t) => P(200 + 15 * Math.sin(2 * Math.PI * hz * t), 200));
      const is = e.flatMap((x) => (x.kind === 'scratch' ? [x.intensity] : []));
      return is.length ? Math.max(...is) : 0;
    }
    expect(peak(4)).toBeGreaterThan(peak(1.5));
  });

  test('scratchEndsAfterAPauseAndCanStartAgain', () => {
    const r = new R();
    r.begin(P(0, 0), 0);
    let t = 0.0;
    let began = 0;
    const rub = (d: number): void => {
      const t0 = t;
      while (t < t0 + d) {
        t += 1.0 / 60;
        const ev = r.move(P(15 * Math.sin(2 * Math.PI * 3 * (t - t0)), 0), t);
        if (ev?.kind === 'scratch' && ev.began) began += 1;
        r.tick(t);
      }
    };
    rub(1);
    expect(r.isScratching).toBe(true);
    while (t < 2) { t += 1.0 / 60; r.tick(t); } // finger rests
    expect(r.isScratching).toBe(false);
    rub(1);
    expect(began).toBe(2);
    expect(r.end(P(0, 0), t + 0.01)).toBeNull();
  });

  test('rubbingInsideTheSlopIsNotAHold', () => {
    const r = new R();
    // 5 pt rub: never leaves the slop, but the path is far from still.
    const e = touch(r, 1, (t) => P(100 + 5 * Math.sin(2 * Math.PI * 4 * t), 100));
    expect(e.some((x) => x.kind === 'hold')).toBe(false);
  });

  test('excludedCornerOnlyTaps', () => {
    const r = new R();
    expect(touch(r, 1.5, () => P(10, 10), undefined, true),
      "a corner press never holds; its release taps (the corner menu's own hold cancels it)").toEqual([tap(P(10, 10))]);
    expect(touch(r, 2, (t) => P(10 + 15 * Math.sin(2 * Math.PI * 3 * t), 10), undefined, true)).toEqual([]);
  });

  test('cancelEndsTheTouchSilently', () => {
    const r = new R();
    r.begin(P(0, 0), 0);
    r.cancel();
    expect(r.isTracking).toBe(false);
    expect(r.tick(1)).toBeNull();
    expect(r.end(P(0, 0), 1)).toBeNull();
  });
});
