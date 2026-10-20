// Port of ConversationAudioTests/MicLevelMeterTests.swift (the allocation suite has no JS equivalent).
import { describe, expect, test } from 'vitest';
import { MicLevelMeter } from '../../src/conversation/audio/MicLevelMeter';
import { TurnAudioPump } from '../../src/conversation/audio/TurnAudioPump';
import { SplitMix64 } from '../../src/core/random';

/** Seeded white noise at `db` dBFS RMS (uniform samples: RMS = amplitude / √3). */
function noise(n: number, db: number, rng: SplitMix64): Float32Array {
  const a = 10 ** (db / 20) * Math.sqrt(3);
  return Float32Array.from({ length: n }, () => rng.uniform(-a, a));
}
const meanSquare = (x: Float32Array): number => x.reduce((s, v) => s + v * v, 0) / Math.max(x.length, 1);

/** Feeds 10 ms blocks (160 samples at 16 kHz) of `signal(i)` and returns the level after each block. */
function run(m: MicLevelMeter, blocks: number, signal: (i: number) => Float32Array): number[] {
  return Array.from({ length: blocks }, (_, i) => { m.update(meanSquare(signal(i)), 0.01); return m.level; });
}

describe('MicLevelMeter', () => {
  test('quiet room noise never moves it', () => {
    const rng = new SplitMix64(1);
    const levels = run(new MicLevelMeter(), 1000, () => noise(160, -64, rng));
    expect(Math.max(...levels)).toBe(0);
  });

  test('louder room noise is learned and gated out', () => {
    const rng = new SplitMix64(2);
    const m = new MicLevelMeter();
    const levels = run(m, 1000, () => noise(160, -50, rng)); // a fan at -50 dBFS
    expect(Math.max(...levels.slice(-400))).toBeLessThan(0.03);
    expect(m.noiseDB).toBeGreaterThan(-53);
    expect(m.noiseDB).toBeLessThan(-47);
  });

  test('speech rises fast and releases slower', () => {
    const rng = new SplitMix64(3);
    const m = new MicLevelMeter();
    run(m, 300, () => noise(160, -62, rng));
    const up = run(m, 30, () => noise(160, -28, rng));
    const target = MicLevelMeter.perceptual(-28, MicLevelMeter.floorDB);
    expect(up[2]).toBeGreaterThan(0.55 * target); // 30 ms attack
    expect(up[2]).toBeLessThan(0.8 * target);
    expect(Math.abs(up[up.length - 1] - target)).toBeLessThan(0.05);
    const down = run(m, 60, () => noise(160, -62, rng));
    expect(down[19]).toBeGreaterThan(0.3 * target); // 200 ms release
    expect(down[19]).toBeLessThan(0.45 * target);
    expect(down[down.length - 1]).toBeLessThan(0.06);
    expect(m.db).toBeLessThan(-50);
  });

  test('continuous speech is never learned as noise', () => {
    const rng = new SplitMix64(4);
    const m = new MicLevelMeter();
    // Syllables (150 ms at -30 dBFS) with short gaps (100 ms at -60) for 10 s.
    const levels = run(m, 1000, (i) => noise(160, i % 25 < 15 ? -30 : -60, rng));
    expect(m.noiseDB).toBeLessThanOrEqual(MicLevelMeter.noiseCeilingDB);
    expect(Math.max(...levels.slice(975, 990))).toBeGreaterThan(0.6);
  });

  test('bounded and safe on garbage', () => {
    const m = new MicLevelMeter();
    for (const ms of [NaN, Infinity, -1, 4, 0]) m.update(ms, 0.01);
    m.update(1, NaN);
    m.update(1, -1);
    expect(m.level >= 0 && m.level <= 1 && Number.isFinite(m.db) && Number.isFinite(m.noiseDB)).toBe(true);
    m.reset();
    expect({ ...m }).toEqual({ ...new MicLevelMeter() });
  });

  test('the pump publishes the level and zeroes it when stopped', () => {
    const timers = { set: () => 1, clear: () => {} };
    const p = new TurnAudioPump(() => 0, timers);
    p.start();
    expect(p.inputLevel).toBe(0);
    p.tick();
    for (let i = 0; i < 50; i++) { // 0.5 s of a -23 dBFS sine, 10 ms per tick
      p.push(Float32Array.from({ length: 160 }, (_, k) => 0.1 * Math.sin((2 * Math.PI * 300 * (i * 160 + k)) / 16000)), i * 0.01);
      p.tick();
    }
    expect(p.inputLevel).toBeGreaterThan(0.8);
    expect(Math.abs((p.inputLevelDB ?? 0) + 23)).toBeLessThan(2);
    for (let i = 0; i < 60; i++) p.tick(); // no audio for a while: it decays
    expect(p.inputLevel).toBeLessThan(0.1);
    p.stop();
    expect(p.inputLevel).toBe(0);
    expect(p.inputLevelDB).toBeNull();
  });
});
