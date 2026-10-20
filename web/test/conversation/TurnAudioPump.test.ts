// Port of the platform-neutral parts of ConversationAudioTests/TurnAudioPumpTests.swift (the ring and the resampler
// live in the worklet on the web) and the playout audibility marks.
import { describe, expect, test } from 'vitest';
import { PlayoutAudibility } from '../../src/conversation/audio/PlayoutAudibility';
import { TurnAudioPump, type Discontinuity } from '../../src/conversation/audio/TurnAudioPump';

function rig() {
  const ticks: (() => void)[] = [];
  const p = new TurnAudioPump(() => 7, { set: (fn) => { ticks.push(fn); return ticks.length; }, clear: () => { ticks.length = 0; } });
  const sink = { samples: 0, ends: [] as number[], gaps: [] as Discontinuity[] };
  p.onAudio = (c, end) => { sink.samples += c.length; sink.ends.push(end); };
  p.onDiscontinuity = (d) => sink.gaps.push(d);
  return { p, sink, ticks };
}

describe('TurnAudioPump', () => {
  test('a closed gate delivers nothing and reopening is a gap before any audio', () => {
    const { p, sink } = rig();
    p.push(new Float32Array(512), 1);
    expect(sink.samples).toBe(0);
    p.noteDiscontinuity('newGeneration');
    p.start();
    p.push(new Float32Array(512), 2);
    expect(sink.gaps).toEqual(['newGeneration']);
    expect(sink.samples).toBe(512);
    expect(p.stats.generations).toBe(1);
  });

  test('start and stop run the timer, idempotently', () => {
    const { p, ticks } = rig();
    p.start(); p.start();
    expect(ticks.length).toBe(1);
    ticks[0]();
    expect(p.stats.ticks).toBe(1);
    p.stop(); p.stop();
    expect(ticks.length).toBe(0);
  });
});

describe('PlayoutAudibility', () => {
  test('loud spans: 10 ms blocks at or above −40 dBFS, merged', () => {
    const rate = 1000;
    const x = new Float32Array(100);
    x.fill(0.1, 10, 40); // 30 ms loud
    x.fill(0.001, 40, 60); // quiet
    x.fill(0.1, 60, 70);
    expect(PlayoutAudibility.loudSpans(x, rate)).toEqual([[0.01, 0.04], [0.06, 0.07]]);
  });

  test('the newest loud instant reached by now, and a barge-in cut', () => {
    const a = new PlayoutAudibility();
    expect(a.lastLoudHostTime(5)).toBe(-Infinity);
    a.markPlayout(10, 12);
    a.markPlayout(13, 14);
    expect(a.lastLoudHostTime(9)).toBe(-Infinity);
    expect(a.lastLoudHostTime(11)).toBe(11);
    expect(a.lastLoudHostTime(12.5)).toBe(12);
    expect(a.lastLoudHostTime(20)).toBe(14);
    a.cutAfter(11.5);
    expect(a.lastLoudHostTime(20)).toBe(11.5);
  });
});
