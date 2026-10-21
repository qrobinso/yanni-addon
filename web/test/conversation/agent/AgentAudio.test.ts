// Self-checks for the web AsrAudioTap and PlayoutQueue (no Swift test target covers them).
import { describe, expect, test } from 'vitest';
import { audibleHostTime } from '../../../src/conversation/core/Ports';
import { AsrAudioTap } from '../../../src/conversation/audio/AsrAudioTap';
import { PlayoutQueue, type PlayoutOutput } from '../../../src/conversation/audio/PlayoutQueue';

describe('AsrAudioTap', () => {
  test('ring indices, wrap-around and discontinuities', () => {
    const tap = new AsrAudioTap(0.01); // 160 samples
    expect(tap.readableRange()).toBeNull();
    tap.write(new Float32Array(100).fill(0.5), 10);
    expect(tap.readableRange()).toEqual({ lower: 0, upper: 100 });
    expect(tap.sampleIndex(10 - 0.001)).toBe(84);
    tap.write(new Float32Array(100).fill(-2), 10.1);
    expect(tap.readableRange()).toEqual({ lower: 40, upper: 200 });
    const r = tap.read(0, 1000);
    expect(r.start).toBe(40);
    expect(r.samples.length).toBe(160);
    expect(r.samples[0]).toBe(16384); // round(0.5 × 32767)
    expect(r.samples[159]).toBe(-32767); // clipped
    tap.noteDiscontinuity();
    expect(tap.readableRange()).toBeNull();
    tap.write(new Float32Array(10), 11);
    expect(tap.readableRange()).toEqual({ lower: 200, upper: 210 });
  });
});

describe('PlayoutQueue', () => {
  test('reply start, frames played and flush', async () => {
    let now = 100;
    let end = 100.02;
    const flushed: number[] = [];
    const out: PlayoutOutput = {
      context: { sampleRate: 48000 },
      playPcm: (s, rate) => { const start = end; end += s.length / rate; return { start, end }; },
      flushPlayout: () => flushed.push(now),
    };
    const q = new PlayoutQueue(out, () => now);
    q.armReplyStart(7);
    expect(await q.enqueue(new Float32Array(4800))).toBe(true);
    expect(await q.enqueue(new Float32Array(4800))).toBe(true);
    expect(q.playoutSnapshot().replyStart).toBeNull(); // not audible yet
    now = 100.07;
    const s = q.playoutSnapshot();
    expect(s.replyStart).toEqual({ epoch: 7, frame: 0, hostTime: 100.02 });
    expect(s.framesPlayed).toBe(2400);
    expect(audibleHostTime(s, 4800)).toBeCloseTo(100.12, 6);
    q.flush();
    expect(flushed.length).toBe(1);
    expect(await q.enqueue(new Float32Array(10))).toBe(false); // refused until the next reply is armed
    now = 101;
    expect(q.playoutSnapshot().framesPlayed).toBe(2400); // the dropped audio never plays
    q.armReplyStart(8);
    expect(await q.enqueue(new Float32Array(10))).toBe(true);
  });
});
