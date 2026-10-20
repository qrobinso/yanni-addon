// Port of ConversationAudioTests/CaptureResamplerTests.swift.
import { describe, expect, test } from 'vitest';
import { CaptureResampler } from '../../src/conversation/audio/CaptureResampler';

/** Runs `input` through a fresh resampler in IO-sized chunks (10 ms) and returns the 16 kHz output. */
function resample(input: Float32Array, rate: number): Float32Array {
  const rs = CaptureResampler.make(rate)!;
  const out: number[] = [];
  const chunk = Math.floor(rate / 100);
  for (let i = 0; i < input.length; i += chunk) rs.process(input.subarray(i, i + chunk), (c) => out.push(...c));
  expect(rs.outputFrames).toBe(out.length);
  expect(rs.inputFrames).toBe(input.length);
  return Float32Array.from(out);
}

const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

/** Magnitude of the `f` Hz component (single-bin DFT). */
function tone(x: Float32Array, f: number, rate: number): number {
  let re = 0, im = 0;
  for (let k = 0; k < x.length; k++) {
    const a = (2 * Math.PI * f * k) / rate;
    re += x[k] * Math.cos(a);
    im -= x[k] * Math.sin(a);
  }
  return (2 * Math.hypot(re, im)) / x.length;
}

describe('CaptureResampler', () => {
  test.each([48000, 44100, 24000])('a tone keeps its frequency, level and timing at %d Hz', (rate) => {
    const amp = 0.5;
    const input = Float32Array.from({ length: rate * 2 }, (_, i) => amp * Math.sin((2 * Math.PI * 1000 * i) / rate));
    const out = resample(input, rate);
    // Length: everything but the filter's held-back look-ahead.
    const ideal = Math.floor((input.length * 16000) / rate);
    expect(out.length).toBeLessThanOrEqual(ideal);
    expect(out.length).toBeGreaterThanOrEqual(ideal - 64);
    const steady = out.subarray(1600, out.length - 160);
    expect(Math.abs(20 * Math.log10(rms(steady) / (amp / Math.SQRT2)))).toBeLessThan(0.1);
    expect(Math.abs(tone(steady, 1000, 16000) - amp)).toBeLessThan(0.01);
    expect(tone(steady, 1100, 16000)).toBeLessThan(0.005);
    // Timing: zero latency, the output lines up with the ideal 16 kHz tone at lag 0.
    let best = { lag: 0, err: Infinity };
    for (let lag = -7; lag <= 7; lag++) {
      let e = 0;
      for (let k = 1600; k < out.length - 160; k++) {
        const d = out[k] - amp * Math.sin((2 * Math.PI * 1000 * (k + lag)) / 16000);
        e += d * d;
      }
      if (e < best.err) best = { lag, err: e };
    }
    expect(best.lag).toBe(0);
  });

  test.each([48000, 44100])('a 100 Hz → 6 kHz sweep matches the ideal sweep at %d Hz', (rate) => {
    const seconds = 2, f0 = 100, f1 = 6000, k = (f1 - f0) / seconds;
    const sweep = (t: number): number => 0.5 * Math.sin(2 * Math.PI * (f0 * t + (k * t * t) / 2));
    const out = resample(Float32Array.from({ length: rate * seconds }, (_, i) => sweep(i / rate)), rate);
    let err = 0, ref = 0;
    for (let i = 320; i < out.length - 320; i++) {
      const r = sweep(i / 16000);
      err += (out[i] - r) ** 2;
      ref += r * r;
    }
    expect(10 * Math.log10(err / ref)).toBeLessThan(-40);
  });

  test('reset starts a fresh stream', () => {
    const rs = CaptureResampler.make(48000)!;
    rs.process(new Float32Array(4800).fill(0.5), () => {});
    expect(rs.outputFrames).toBeGreaterThan(0);
    rs.reset();
    expect([rs.outputFrames, rs.inputFrames]).toEqual([0, 0]);
    expect(CaptureResampler.make(1)).toBeNull();
  });
});
