import { describe, expect, test, vi } from 'vitest';
import { OwnerAccess, type KeyValue } from '../../src/app/OwnerAccess';
import { FourFingerPress, TouchInput, type TouchGestureEvent } from '../../src/app/TouchInput';
import { TouchGestureRecognizer } from '../../src/engine/TouchGestures';

const memory = (): KeyValue & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

describe('OwnerAccess', () => {
  test('stores a salted hash, verifies, locks after five wrong tries', async () => {
    let t = 0;
    const store = memory();
    const a = new OwnerAccess(store, () => t);
    expect(a.isPINRequired).toBe(false);
    expect(await a.verify('0000')).toBe('ok');
    expect(await a.setPIN('12a4')).toBe(false);
    expect(await a.setPIN('1234')).toBe(true);
    expect([...store.m.values()].join()).not.toContain('1234');
    expect(await a.verify('1234')).toBe('ok');
    for (let i = 0; i < 4; i++) expect(await a.verify('9999')).toBe('wrong');
    expect(await a.verify('9999')).toEqual({ locked: 60 });
    t = 30;
    expect(await a.verify('1234')).toEqual({ locked: 30 });
    t = 61;
    expect(await a.verify('1234')).toBe('ok');
    a.clearPIN();
    expect(a.isPINRequired).toBe(false);
  });
});

describe('TouchInput', () => {
  const rig = () => {
    const got: TouchGestureEvent[] = [];
    const progress: (number | null)[] = [];
    let menus = 0;
    const input = new TouchInput(new TouchGestureRecognizer(), {
      onGesture: (e) => got.push(e), onCornerProgress: (p) => progress.push(p), onMenu: () => { menus += 1; },
    });
    return { input, got, progress, menus: () => menus };
  };

  test('a quick tap pokes, a still hold talks', () => {
    const r = rig();
    r.input.down(1, 100, 100, 0, 1000, 800);
    r.input.up(1, 102, 101, 0.1);
    expect(r.got).toEqual([{ kind: 'tap', at: { x: 102, y: 101 } }]);
    r.input.down(1, 100, 100, 1, 1000, 800);
    r.input.tick(1.3);
    r.input.tick(1.55);
    r.input.up(1, 100, 100, 2);
    expect(r.got.slice(1)).toEqual([{ kind: 'hold', at: { x: 100, y: 100 } }]);
  });

  test('a quick tap in the corner still pokes; holding it opens the menu without a poke', () => {
    const r = rig();
    r.input.down(1, 990, 790, 0, 1000, 800);
    r.input.tick(0.6); // the corner never becomes hold to talk
    r.input.up(1, 990, 790, 0.7);
    expect(r.got.map((e) => e.kind)).toEqual(['tap']);
    r.input.down(1, 990, 790, 1, 1000, 800);
    r.input.tick(1.9);
    expect(r.progress).toEqual([]); // nothing in the first second
    r.input.tick(2.75);
    expect(r.progress.at(-1)).toBeCloseTo(0.5);
    r.input.tick(3.5);
    expect(r.menus()).toBe(1);
    expect(r.progress.at(-1)).toBeNull();
    r.input.up(1, 990, 790, 3.6);
    expect(r.got).toHaveLength(1);
  });

  test('a second finger cancels the touch', () => {
    const r = rig();
    r.input.down(1, 100, 100, 0, 1000, 800);
    r.input.down(2, 300, 100, 0.05, 1000, 800);
    r.input.up(1, 100, 100, 0.1);
    r.input.up(2, 300, 100, 0.1);
    expect(r.got).toEqual([]);
  });

  test('normalises to gaze space around the centre, clamped', () => {
    expect(TouchInput.normalised({ x: 500, y: 400 }, 1000, 800)).toEqual({ x: 0, y: 0 });
    expect(TouchInput.normalised({ x: 0, y: 1200 }, 1000, 800)).toEqual({ x: -1, y: 1 });
  });
});

describe('FourFingerPress', () => {
  const rig = () => {
    const got: string[] = [];
    const p = new FourFingerPress(() => got.push('menu'), () => got.push('reset'));
    for (let i = 0; i < 4; i++) p.down(i, 100 * i, 100);
    return { p, got };
  };

  test('menu at 1.2 s, Reset at 10 s; finger movement within 40 px keeps it, and after the menu any movement does', () => {
    vi.useFakeTimers();
    try {
      const { p, got } = rig();
      p.move(0, 30, 120); // 36 px
      vi.advanceTimersByTime(1200);
      expect(got).toEqual(['menu']);
      p.move(1, 400, 400); // began: movement no longer matters
      vi.advanceTimersByTime(8800);
      expect(got).toEqual(['menu', 'reset']);
    } finally { vi.useRealTimers(); }
  });

  test('a finger moving more than 40 px before 1.2 s, or one lifting, ends the press', () => {
    vi.useFakeTimers();
    try {
      const a = rig();
      a.p.move(2, 241, 100);
      vi.advanceTimersByTime(10_000);
      expect(a.got).toEqual([]);
      const b = rig();
      b.p.lift(3);
      vi.advanceTimersByTime(10_000);
      expect(b.got).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
