// Port of Tests/FaceVoiceTests/RendererFixturesTests.swift (shared helpers, no tests; `Fx` in Swift).
// port-note: host times are seconds, so `ticks(x)` is `x`. Renders return Float32Array like the Swift [Float].
import { writeFileSync } from 'node:fs';
import { VocalContour } from '../../src/model';
import {
  Note, Phrase, VoiceFingerprint, VoiceRenderer, makeEnvelope, makeModulation2, makeTimbre,
  type Envelope, type Modulation2, type Timbre, type VoiceReaction,
} from '../../src/voice';

/// Arbitrary synthetic host-clock origin for offline renders (seconds).
const host0 = 50;

export const Fx = {
  host0,

  ticks(seconds: number): number { return seconds; },

  /// Host time of sample `n` from `host0` at rate `fs`.
  host(n: number, fs: number, h0: number = host0): number { return h0 + n / fs; },

  /// Renders `seconds` in `chunk`-sized buffers with exact host times from `host0`. `before(sampleIndex)` runs before
  /// each buffer (enqueue/cancel/mute at buffer boundaries).
  render(r: VoiceRenderer, seconds: number, opts: { chunk?: number; host0?: number; before?: (n: number) => void } = {}): Float32Array {
    const chunk = opts.chunk ?? 256;
    const h0 = opts.host0 ?? host0;
    const fs = r.sampleRate;
    const total = Math.round(seconds * fs);
    const out = new Float32Array(total);
    const buf = new Float32Array(chunk);
    let n = 0;
    while (n < total) {
      const m = Math.min(chunk, total - n);
      opts.before?.(n);
      r.render(m, Fx.host(n, fs, h0), buf);
      out.set(buf.subarray(0, m), n);
      n += m;
    }
    return out;
  },

  /// Pure sine tone, filter wide open, no formants, no noise: easy to analyse.
  sineTimbre(): Timbre {
    return makeTimbre({
      sine: 1, square: 0, fm: 0, cutoff: 1, filterEnvOctaves: 0, resonance: 0, noiseDB: -200, noiseBurst: 1,
      formantAmount: 0,
    });
  },

  flatEnvelope(o: { attack?: number; release?: number } = {}): Envelope {
    return makeEnvelope({ attackTau: o.attack ?? 0.005, sustain: 1, decayFraction: 0.4, release: o.release ?? 0.06 });
  },

  noVibrato(): Modulation2 { return makeModulation2({ vibratoDepth: 0 }); },

  sineNote(o: { start: number; duration: number; pitch?: number; contour?: VocalContour; envelope?: Envelope;
    slur?: boolean; gain?: number }): Note {
    return new Note({
      start: o.start, duration: o.duration, contour: o.contour ?? VocalContour.flat(o.pitch ?? 0),
      timbre: Fx.sineTimbre(), envelope: o.envelope ?? Fx.flatEnvelope(), modulation: Fx.noVibrato(),
      gain: o.gain ?? 1, slur: o.slur ?? false,
    });
  },

  phrase(notes: Note[], id = 1, reaction: VoiceReaction = 'emote'): Phrase {
    const p = new Phrase();
    for (const n of notes) p.notes.push(n);
    p.id = id;
    p.reaction = reaction;
    return p;
  },

  renderer(o: { fs?: number; base?: number; maxHz?: number; loudness?: number } = {}): VoiceRenderer {
    const r = new VoiceRenderer(o.fs ?? 48000);
    const fp = VoiceFingerprint.default;
    fp.basePitchHz = o.base ?? 660; fp.maxPitchHz = o.maxHz ?? 1600; fp.loudness = o.loudness ?? 0.7;
    r.setFingerprint(fp);
    return r;
  },

  /// Renders one phrase starting at `delay` seconds after `host0`.
  renderPhrase(p: Phrase, o: { fs?: number; base?: number; maxHz?: number; seconds: number; delay?: number;
    stretch?: number; loudness?: number }): Float32Array {
    const r = Fx.renderer(o);
    r.enqueue(p, host0 + Fx.ticks(o.delay ?? 0.01), o.stretch ?? 1);
    return Fx.render(r, o.seconds);
  },

  // MARK: Analysis

  peak(x: ArrayLike<number>): number {
    let m = 0;
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
    return m;
  },
  rms(x: ArrayLike<number>): number {
    if (x.length === 0) return 0;
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / x.length);
  },
  maxDelta(x: ArrayLike<number>): number {
    let m = 0;
    let prev = x.length > 0 ? x[0] : 0;
    for (let i = 0; i < x.length; i++) { m = Math.max(m, Math.abs(x[i] - prev)); prev = x[i]; }
    return m;
  },
  allFinite(x: ArrayLike<number>): boolean {
    for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
    return true;
  },
  dB(x: number): number { return 20 * Math.log10(Math.max(x, 1e-12)); },

  /// Amplitude envelope of a steady sine with an integer `period` divisible by 4 (quadrature estimate).
  quadratureEnvelope(x: Float32Array, period: number): Float32Array {
    const q = Math.trunc(period / 4);
    const e = new Float32Array(x.length);
    for (let i = q; i < x.length; i++) e[i] = Math.sqrt(x[i] * x[i] + x[i - q] * x[i - q]);
    return e;
  },

  /// Fundamental (Hz) by normalised autocorrelation with parabolic peak interpolation.
  autocorrelationPitch(a: ArrayLike<number>, fs: number, minHz = 80, maxHz = 4000): number {
    const minLag = Math.trunc(fs / maxHz), maxLag = Math.trunc(fs / minHz);
    const n = a.length - maxLag - 1;
    const r = (lag: number): number => {
      let s = 0;
      for (let i = 0; i < n; i++) s += a[i] * a[i + lag];
      return s;
    };
    const vals = new Array<number>(maxLag + 2).fill(0);
    for (let lag = minLag; lag <= maxLag + 1; lag++) vals[lag] = r(lag);
    const r0 = r(0);
    // First lag where the correlation is a local max above 0.8·r0 (avoids octave errors).
    let best = minLag;
    for (let lag = minLag + 1; lag <= maxLag; lag++) {
      if (vals[lag] > 0.8 * r0 && vals[lag] >= vals[lag - 1] && vals[lag] >= vals[lag + 1]) { best = lag; break; }
    }
    const y0 = vals[best - 1], y1 = vals[best], y2 = vals[best + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    return fs / (best + shift);
  },

  /// Frequency from positive-going zero crossings (for glide direction).
  zeroCrossingHz(x: ArrayLike<number>, fs: number): number {
    const crossings: number[] = [];
    let prev = x.length > 0 ? x[0] : 0;
    for (let i = 0; i < x.length; i++) {
      if (prev <= 0 && x[i] > 0) crossings.push(i);
      prev = x[i];
    }
    if (crossings.length <= 2) return 0;
    return (crossings.length - 1) * fs / (crossings[crossings.length - 1] - crossings[0]);
  },

  /// Power at `hz` (Goertzel).
  goertzel(x: ArrayLike<number>, hz: number, fs: number): number {
    const w = 2 * Math.PI * hz / fs;
    const c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) {
      const s0 = x[i] + c * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return s1 * s1 + s2 * s2 - c * s1 * s2;
  },

  // MARK: WAV

  /// Writes 16-bit PCM mono WAV.
  writeWAV(x: ArrayLike<number>, fs: number, path: string): void {
    const d = Buffer.alloc(44 + x.length * 2);
    const bytes = x.length * 2;
    d.write('RIFF', 0); d.writeUInt32LE(36 + bytes, 4); d.write('WAVE', 8);
    d.write('fmt ', 12); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20); d.writeUInt16LE(1, 22);
    d.writeUInt32LE(fs, 24); d.writeUInt32LE(fs * 2, 28); d.writeUInt16LE(2, 32); d.writeUInt16LE(16, 34);
    d.write('data', 36); d.writeUInt32LE(bytes, 40);
    for (let i = 0; i < x.length; i++) d.writeInt16LE(Math.trunc(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + 2 * i);
    writeFileSync(path, d);
  },
};
