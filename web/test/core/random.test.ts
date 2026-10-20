import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';

describe('SplitMix64', () => {
  test('matches the reference SplitMix64 sequence for seed 0', () => {
    const r = new SplitMix64(0);
    // Reference values (Vigna's splitmix64.c, seed 0).
    expect(r.next()).toBe(0xe220a8397b1dcdafn);
    expect(r.next()).toBe(0x6e789e6aa1b965f4n);
    expect(r.next()).toBe(0x06c45d188009454fn);
  });

  test('unit is in [0, 1) and 24-bit quantised', () => {
    const r = new SplitMix64(0x59414e4e49n);
    for (let i = 0; i < 1000; i++) {
      const u = r.unit();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      expect(Number.isInteger(u * 16777216)).toBe(true);
    }
  });
});
