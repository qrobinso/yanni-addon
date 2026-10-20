// Port of ConversationTurnTests/TurnAudioBufferTests.swift: the 10 s turn buffer and the Smart Turn window (§5.3).
import { describe, expect, test } from 'vitest';
import { TurnAudioBuffer, TurnAudioWindow } from '../../src/conversation/turn';

function append(b: TurnAudioBuffer, start: number, count: number): void {
  const a = new Float32Array(count);
  for (let i = 0; i < count; i++) a[i] = start + i;
  b.append(a);
}

describe('TurnAudioBuffer', () => {
  test('wraps around and keeps the newest', () => {
    const b = new TurnAudioBuffer(1000);
    append(b, 0, 700);
    append(b, 700, 700); // wraps
    expect(b.endIndex).toBe(1400);
    expect(b.startIndex).toBe(400);
    const w = new TurnAudioWindow();
    expect(b.copy(0, 1400, w)).toBe(1000); // clipped to what is held
    const s = w.samples;
    expect(s[s.length - 1]).toBe(1399);
    expect(s[s.length - 1000]).toBe(400);
    expect(s[s.length - 1001]).toBe(0); // zero padding before
    expect(w.validCount).toBe(1000);
  });

  test('window takes the last eight seconds zero-padded at the beginning', () => {
    const b = new TurnAudioBuffer();
    expect(b.capacity).toBe(160_000);
    append(b, 0, 150_000); // 9.4 s
    const w = new TurnAudioWindow();
    expect(w.count).toBe(128_000);
    expect(b.copy(0, 150_000, w)).toBe(128_000); // only the last 8 s
    expect(w.samples[0]).toBe(22_000);
    expect(w.samples[127_999]).toBe(149_999);
    // A short turn: right-aligned, zeros before.
    expect(b.copy(149_000, 150_000, w)).toBe(1000);
    expect(w.samples[126_999]).toBe(0);
    expect(w.samples[127_000]).toBe(149_000);
    expect(w.samples[127_999]).toBe(149_999);
    expect(w.samples.subarray(0, 127_000).every((x) => x === 0)).toBe(true);
  });

  test('discardAll hides older audio', () => {
    const b = new TurnAudioBuffer(1000);
    append(b, 0, 500);
    b.discardAll();
    append(b, 500, 100);
    expect(b.copy(0, 600, new TurnAudioWindow())).toBe(100);
  });

  test('no growth over many appends', () => {
    const b = new TurnAudioBuffer(4096);
    for (let i = 0; i < 10_000; i++) append(b, i * 333, 333);
    expect(b.capacity).toBe(4096);
    expect(b.endIndex).toBe(3_330_000);
    const w = new TurnAudioWindow();
    expect(b.copy(0, b.endIndex, w)).toBe(4096);
    expect(w.samples[w.count - 1]).toBe(Math.fround(3_329_999));
  });
});
