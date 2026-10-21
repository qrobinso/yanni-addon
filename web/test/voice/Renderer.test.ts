// Port of Tests/FaceVoiceTests/RendererTests.swift.
// Scheduling, cancel, threading, performance and the WAV demo.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { VocalContour } from '../../src/model';
import {
  HostClock, Note, VoiceRenderer, makeEnvelope, makeModulation2, makeTimbre, type Phrase,
} from '../../src/voice';
import { Fx } from './RendererFixtures';

const fs = 48000.0;

const chirp = (id = 1, duration = 0.2): Phrase => Fx.phrase([Fx.sineNote({ start: 0, duration })], id);

function firstNonZero(x: Float32Array): number | null {
  const i = x.findIndex((v) => Math.abs(v) > 1e-9);
  return i < 0 ? null : i;
}

describe('RendererTests', () => {
  // port-note: Swift renders on a plain Thread to catch main-actor executor checks; JS has no such threads (the
  // browser renders in an AudioWorklet), so this keeps the render-loop intent on the test thread.
  test('rendersOffTheMainThread', () => {
    const r = Fx.renderer();
    r.enqueue(chirp(), Fx.host0);
    const buf = new Float32Array(512);
    let p = 0;
    for (let k = 0; k < 20; k++) {
      r.render(512, Fx.host(k * 512, 48000), buf);
      for (let i = 0; i < 512; i++) p = Math.max(p, Math.abs(buf[i]));
    }
    expect(p).toBeGreaterThan(0.05);
  });

  test('sampleAccurateStartFromHostTime', () => {
    for (const startSample of [1000, 1234, 4097]) {
      const r = Fx.renderer();
      r.enqueue(chirp(), Fx.host(startSample, fs));
      const x = Fx.render(r, 0.2);
      const first = firstNonZero(x)!;
      expect(first >= startSample && first <= startSample + 2).toBe(true);
      const started = r.lastStarted()!;
      expect(started.id).toBe(1);
      const err = Math.abs(started.hostTime - Fx.host(startSample, fs));
      expect(err).toBeLessThan(1.5 / fs);
    }
  });

  test('lateUpTo150msShiftsAndReportsActualStart', () => {
    const r = Fx.renderer();
    const bufferHost = Fx.host(4800, fs);
    const x = Fx.render(r, 0.3, { before: (n) => {
      if (n === 4864) r.enqueue(chirp(7), bufferHost - Fx.ticks(0.1));
    } });
    expect(firstNonZero(x)! >= 4864 && firstNonZero(x)! <= 4866).toBe(true);
    const s = r.lastStarted()!;
    expect(s.id).toBe(7);
    expect(s.hostTime).toBe(Fx.host(4864, fs));
  });

  test('lateBeyond150msIsDropped', () => {
    const r = Fx.renderer();
    const x = Fx.render(r, 0.3, { before: (n) => {
      if (n === 9728) r.enqueue(chirp(9), Fx.host(n, 48000) - Fx.ticks(0.2));
    } });
    expect(Fx.peak(x)).toBe(0);
    expect(r.lastStarted()).toBeNull();
  });

  test('noBurstAfterStoppedEngine', () => {
    // Queued while "stopped": host time jumps 2 s between buffers; queued and pending phrases must not play.
    const r = Fx.renderer();
    Fx.render(r, 0.1);
    const now = Fx.host(4864, fs);
    r.enqueue(chirp(1), now);
    r.enqueue(chirp(2), now + Fx.ticks(0.05));
    const afterStop = Fx.render(r, 0.4, { host0: Fx.host0 + Fx.ticks(2.1) });
    expect(Fx.peak(afterStop)).toBe(0);

    // A phrase already dequeued (pending) when the engine stops must also be dropped.
    const r2 = Fx.renderer();
    r2.enqueue(chirp(3), Fx.host0 + Fx.ticks(0.1));
    Fx.render(r2, 0.02);                                     // dequeued, pending
    const x = Fx.render(r2, 0.4, { host0: Fx.host0 + Fx.ticks(3) });
    expect(Fx.peak(x)).toBe(0);
    expect(r2.lastStarted()).toBeNull();
  });

  test('invalidHostTimeFallsBackToSampleTimeAnchor', () => {
    const r = Fx.renderer();
    const buf = new Float32Array(256);
    const out = new Float32Array(40 * 256);
    const start = 3000;
    for (let k = 0; k < 40; k++) {
      const n = k * 256;
      // Only the first buffer has a valid host time; later ones extrapolate from sample time.
      const host = k === 0 ? Fx.host(0, fs) : null;
      if (k === 2) r.enqueue(chirp(), Fx.host(start, fs));
      r.render(256, host, buf, n + 77_000);
      out.set(buf, n);
    }
    const first = firstNonZero(out)!;
    expect(first >= start && first <= start + 2).toBe(true);

    // No host time ever: anchors to the real clock.
    const r2 = Fx.renderer();
    r2.enqueue(chirp(), HostClock.now() + Fx.ticks(0.05));
    const out2 = new Float32Array(40 * 256);
    for (let k = 0; k < 40; k++) {
      r2.render(256, null, buf);
      out2.set(buf, k * 256);
    }
    const f2 = firstNonZero(out2)! / fs;
    expect(f2 > 0.03 && f2 < 0.06).toBe(true);
  });

  test('cancelFadesWithin30msAndLaterEnqueuePlays', () => {
    const r = Fx.renderer();
    r.enqueue(Fx.phrase([Fx.sineNote({ start: 0, duration: 1 })], 1), Fx.host0);
    r.enqueue(Fx.phrase([Fx.sineNote({ start: 0, duration: 0.3 })], 2), Fx.host0 + Fx.ticks(0.3));
    const cancelAt = 9728, restart = cancelAt + 4864;
    const x = Fx.render(r, 0.8, { before: (n) => {
      if (n === cancelAt) {
        r.cancelAll();
        // Enqueued right after the cancel: must still play.
        r.enqueue(Fx.phrase([Fx.sineNote({ start: 0, duration: 0.2 })], 3), Fx.host(restart, 48000));
      }
    } });
    expect(Fx.peak(x.subarray(cancelAt - 480, cancelAt))).toBeGreaterThan(0.1);
    expect(Fx.peak(x.subarray(cancelAt + Math.trunc(0.03 * fs), restart))).toBe(0);
    expect(Fx.peak(x.subarray(restart + 480, restart + 4800))).toBeGreaterThan(0.1);
    expect(r.lastStarted()!.id).toBe(3);
    expect(Fx.maxDelta(x)).toBeLessThan(1.3 * 2 * Math.PI * 660 / fs);
  });

  test('isSoundingTracksVoices', () => {
    const r = Fx.renderer();
    expect(r.isSounding).toBe(false);
    r.enqueue(chirp(1, 0.1), Fx.host0);
    Fx.render(r, 0.05);
    expect(r.isSounding).toBe(true);
    Fx.render(r, 0.3, { host0: Fx.host(2400, fs) });
    expect(r.isSounding).toBe(false);
  });

  test('setSampleRateRerendersInPlace', () => {
    const r = Fx.renderer({ fs: 48000 });
    r.setSampleRate(44100);
    expect(r.sampleRate).toBe(44100);
    r.enqueue(Fx.phrase([Fx.sineNote({ start: 0, duration: 0.5 })]), Fx.host0);
    const x = Fx.render(r, 0.5);
    expect(x.length).toBe(22050);
    const hz = Fx.autocorrelationPitch(x.subarray(8820, 17640), 44100);
    expect(Math.abs(1200 * Math.log2(hz / 660))).toBeLessThan(10);
  });

  test('performanceDensePhrases', () => {
    const r = Fx.renderer();
    // Default (full-feature) timbre: sine + FM, formants, breath noise, filter envelope; 3 overlapping voices.
    const dense = (i: number): Phrase => {
      const notes: Note[] = [];
      for (let k = 0; k < 8; k++) {
        const p0 = k % 5;
        const c = new VocalContour({ start: p0, end: p0 + 3, scoop: 1.2, wobbleDepth: 0.5 });
        notes.push(new Note({ start: k * 0.1, duration: 0.1, contour: c, gain: 0.8, slur: k % 2 === 1 }));
      }
      return Fx.phrase(notes, i);
    };
    const seconds = 10.0;
    const chunk = 256;
    const total = Math.trunc(seconds * fs);
    const buf = new Float32Array(chunk);
    let next = 0;
    let elapsed = 0;
    let n = 0;
    let maxVoices = 0;
    while (n < total) {
      const host = Fx.host(n, fs);
      // A new 0.8 s phrase every 0.3 s → ~3 voices sounding at once.
      while (next * 0.3 <= n / fs + 0.05) {
        r.enqueue(dense(next), Fx.host0 + Fx.ticks(next * 0.3));
        next += 1;
      }
      const t0 = performance.now();
      r.render(chunk, host, buf);
      elapsed += performance.now() - t0;
      let active = 0;
      for (let i = 0; i < VoiceRenderer.voiceCapacity; i++) if (r.debugVoiceStage(i) !== 'free') active += 1;
      maxVoices = Math.max(maxVoices, active);
      n += chunk;
    }
    const msPerSecond = elapsed / seconds;
    console.log(`PERF: ${msPerSecond.toFixed(3)} ms per second of audio (48 kHz, up to ${maxVoices} voices)`);
    expect(maxVoices).toBeGreaterThanOrEqual(3);
    // port-note: Swift asserts ≤ 2 ms only in optimised builds; here only when YANNI_PERF=1 (timing under a
    // parallel vitest run is too noisy to gate on).
    if (process.env.YANNI_PERF === '1') expect(msPerSecond).toBeLessThanOrEqual(2);
  });

  test('cancelDropsPendingAndQueuedPhrases', () => {
    const r = Fx.renderer();
    r.enqueue(chirp(1), Fx.host0 + Fx.ticks(0.2));
    r.enqueue(chirp(2), Fx.host0 + Fx.ticks(0.3));
    Fx.render(r, 0.01);                                      // both dequeued as pending
    r.cancelAll();
    const x = Fx.render(r, 0.6, { host0: Fx.host(480, fs) });
    expect(Fx.peak(x)).toBe(0);
    expect(r.lastStarted()).toBeNull();
  });

  test('fullVoiceTableStealsOldest', () => {
    const r = Fx.renderer();
    for (let i = 0; i < 4; i++) {                             // 4 overlapping phrases, table holds 3
      r.enqueue(Fx.phrase([Fx.sineNote({ start: 0, duration: 0.5 })], i + 1), Fx.host0 + Fx.ticks(0.05 * i));
    }
    const x = Fx.render(r, 0.9);
    expect(Fx.allFinite(x) && Fx.peak(x) < 1).toBe(true);
    expect(r.lastStarted()?.id).toBe(4);
    expect(Fx.peak(x.subarray(Math.trunc(0.85 * fs)))).toBeLessThan(1e-4);
  });

  test('writeDemoWAVs', () => {
    const dir = join(tmpdir(), 'yanni-voice-demo');
    mkdirSync(dir, { recursive: true });
    const paths: string[] = [];
    for (const [name, phrase] of DemoPhrases.all()) {
      const x = Fx.renderPhrase(phrase, { seconds: phrase.duration + 0.15, delay: 0.05 });
      expect(Fx.allFinite(x) && Fx.peak(x) <= 1 && Fx.peak(x) > 0.05).toBe(true);
      const path = join(dir, `${name}.wav`);
      Fx.writeWAV(x, fs, path);
      paths.push(path);
    }
    console.log('DEMO WAVs:\n' + paths.join('\n'));
  });
});

/// Hand-built reaction-like phrases for listening.
const DemoPhrases = {
  all(): [string, Phrase][] {
    return [['rising-chirp', DemoPhrases.risingChirp()], ['falling-sigh', DemoPhrases.fallingSigh()],
      ['trill', DemoPhrases.trill()], ['startle', DemoPhrases.startle()], ['bi-dup', DemoPhrases.biDup()]];
  },

  risingChirp(): Phrase {
    const t = makeTimbre({ vowelStart: 0.4, vowelEnd: 0.9 });
    return Fx.phrase([
      new Note({ start: 0, duration: 0.09, contour: new VocalContour({ start: 0, end: 1, scoop: 1.2 }), timbre: t }),
      new Note({ start: 0.13, duration: 0.3, contour: new VocalContour({ start: 1, end: 7, glideOnset: 0.35, scoop: 0.8 }),
        timbre: t, slur: true }),
    ]);
  },

  fallingSigh(): Phrase {
    const inhale = makeTimbre({ sine: 0, fm: 0, noiseDB: 0, noiseFreq: 1200, noiseBandPass: true, noiseBurst: 1 });
    const e = makeEnvelope({ attackTau: 0.06, release: 0.04 });
    const sigh = makeTimbre({ cutoff: 0.35, filterEnvOctaves: 0.5, noiseDB: -14, noiseFreq: 1200, noiseBandPass: true,
      vowelStart: 0, vowelEnd: 0.5, fmIndexPeak: 1.5 });
    const se = makeEnvelope({ attackTau: 0.04, sustain: 0.7, release: 0.12 });
    const m = makeModulation2({ vibratoRate: 5, vibratoDepth: 0.25 });
    return Fx.phrase([
      new Note({ start: 0, duration: 0.15, contour: VocalContour.flat(-3), timbre: inhale, envelope: e, gain: 0.4 }),
      new Note({ start: 0.2, duration: 0.6, contour: new VocalContour({ start: -3, end: -10, glideOnset: 0.1, glideEase: 0.8, scoop: 1.5 }),
        timbre: sigh, envelope: se, modulation: m, gain: 0.9 }),
    ], 1, 'sleepy');
  },

  trill(): Phrase {
    const t = makeTimbre({ vowelStart: 0.6, vowelEnd: 0.3 });
    const m = makeModulation2({ vibratoDepth: 0, tremoloDepth: 0.3, tremoloRate: 12.5 });
    const e = makeEnvelope({ attackTau: 0.015, release: 0.1 });
    return Fx.phrase([
      new Note({ start: 0, duration: 0.45, contour: new VocalContour({ start: 2, end: -5, trillDepth: 1.5, trillRate: 12.5 }),
        timbre: t, envelope: e, modulation: m, gain: 0.7 }),
    ], 1, 'embarrassed');
  },

  startle(): Phrase {
    const t = makeTimbre({ fmIndexPeak: 4, noiseBurst: 6, vowelStart: 1, vowelEnd: 0.8, cutoff: 0.8 });
    const e = makeEnvelope({ attackTau: 0.002, release: 0.05 });
    const tail = makeTimbre({ cutoff: 0.5, vowelStart: 0.7, vowelEnd: 0.4 });
    return Fx.phrase([
      new Note({ start: 0, duration: 0.12, contour: new VocalContour({ start: 9, end: 9, scoop: -1, scoopTau: 0.025 }),
        timbre: t, envelope: e, gain: 1, accent: true }),
      new Note({ start: 0.12, duration: 0.12, contour: new VocalContour({ start: 9, end: 5 }), timbre: tail, gain: 0.4, slur: true }),
    ], 1, 'startled');
  },

  biDup(): Phrase {
    return Fx.phrase([
      new Note({ start: 0, duration: 0.06, contour: new VocalContour({ start: 0, end: 0.5, scoop: 1 }) }),
      new Note({ start: 0.06, duration: 0.1, contour: new VocalContour({ start: 4, end: 4.5 }), slur: true }),
    ], 1, 'engaged');
  },
};
