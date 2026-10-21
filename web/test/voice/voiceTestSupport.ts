// Shared helpers for the generator / mapping / reaction / novelty / babble tests (Swift GeneratorTests.swift's and
// BabbleTests.swift's free helpers), plus the few `Fx` render helpers (RendererFixturesTests.swift) the demo tests use.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PhraseGenerator, VoiceAffect, VoiceFingerprint, VoiceRenderer, makeBabbleRequest,
  type BabblePlan, type Note, type Phrase, type VoiceReaction,
} from '../../src/voice';

// MARK: Generator helpers

export const noteList = (p: Phrase): Note[] => [...p.notes];
export const tonal = (n: Note): boolean => n.timbre.sine + n.timbre.square + n.timbre.fm > 0;
export const tonalNotes = (p: Phrase): Note[] => noteList(p).filter(tonal);
export const peakDB = (p: Phrase): number => {
  const g = tonalNotes(p).map((n) => n.gain);
  return 20 * Math.log10(g.length ? Math.max(...g) : 1e-6);
};
export const pitch = (n: Note, x: number): number => n.contour.pitch(x * n.duration, n.duration);

export const padValues = [-1, 0, 1];
export const padGrid: VoiceAffect[] = (() => {
  const out: VoiceAffect[] = [];
  for (const p of padValues) for (const a of padValues) for (const d of padValues) out.push(VoiceAffect.make(p, a, d));
  return out;
})();

/// First phrase of a fresh generator (no novelty history) for a seed.
export function fresh(r: VoiceReaction, a: VoiceAffect, seed: bigint | number, fp: VoiceFingerprint = VoiceFingerprint.default): Phrase {
  return new PhraseGenerator(fp, BigInt(seed)).make(r, a);
}

export const mean = (xs: readonly number[]): number => xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
export const notesOf = noteList;
export const pitchAt = pitch;
/// Mean of a feature over the first phrase of `seeds` fresh generators.
export function meanOver(r: VoiceReaction, a: VoiceAffect, f: (p: Phrase) => number, seeds = 200): number {
  const xs: number[] = [];
  for (let i = 0; i < seeds; i++) xs.push(f(fresh(r, a, BigInt(i) * 7919n + 1n)));
  return mean(xs);
}

// MARK: Babble helpers

export const babbleCorpus = [
  'Yes.',
  'Sure thing.',
  'Okay, the lights are on.',
  'I turned on the kitchen lights for you.',
  'The living room is twenty one degrees and the heating is off right now.',
  'Your next meeting is with the design team at three, and it should take about forty five minutes in the big room.',
  'Absolutely, I can do that for you, and I will also remind you tomorrow morning when the coffee machine finishes its cleaning cycle, because last time it was forgotten.',
];

export const longReply =
  'Here is a summary of everything that happened in the house today. The washing machine finished its cycle at eleven ' +
  'forty, the front door was unlocked twice, and the temperature in the living room stayed between twenty and twenty ' +
  'two degrees. The robot vacuum cleaned the kitchen and the hallway but got stuck under the sofa for about ten minutes. ' +
  'Tomorrow it will rain in the afternoon, so you might want to bring an umbrella. Is there anything else you would like ' +
  'me to check before you go to bed tonight?';

export function babble(text: string, affect: VoiceAffect = VoiceAffect.neutral,
  o: { seed?: bigint; gen?: bigint; cap?: number; budget?: number; isLast?: boolean; answer?: VoiceReaction | null } = {}): BabblePlan {
  const g = new PhraseGenerator(VoiceFingerprint.default, o.gen ?? 7n);
  return g.makeBabble(makeBabbleRequest({
    text, affect, isLast: o.isLast ?? false, answer: o.answer ?? null, seed: o.seed ?? 1n,
    sentenceCap: o.cap ?? 1.5, budget: o.budget ?? 6,
  }));
}

/// The plan's last babble phrase and its notes.
export const lastPhrase = (p: BabblePlan): Phrase => p.items[p.items.length - 1].phrase;
export const lastPhraseNotes = (p: BabblePlan): Note[] => notesOf(lastPhrase(p));

export const last = <T>(xs: readonly T[]): T => xs[xs.length - 1];

// MARK: Fx (render helpers; host times are seconds here, port-note: mach ticks in Swift)

const host0 = 50;

export const Fx = {
  /// Arbitrary synthetic host-clock origin for offline renders (s).
  host0,

  renderer(fs = 48000, base = 660, maxHz = 1600, loudness = 0.7): VoiceRenderer {
    const r = new VoiceRenderer(fs);
    const fp = VoiceFingerprint.default;
    fp.basePitchHz = base; fp.maxPitchHz = maxHz; fp.loudness = loudness;
    r.setFingerprint(fp);
    return r;
  },

  /// Renders `seconds` in `chunk`-sized buffers with exact host times from `host0`; `before(n)` runs before each.
  render(r: VoiceRenderer, seconds: number, before?: (n: number) => void, chunk = 256, origin = host0): Float32Array {
    const fs = r.sampleRate;
    const total = Math.round(seconds * fs);
    const out = new Float32Array(total);
    const buf = new Float32Array(chunk);
    let n = 0;
    while (n < total) {
      const m = Math.min(chunk, total - n);
      before?.(n);
      r.render(m, origin + n / fs, buf);
      out.set(buf.subarray(0, m), n);
      n += m;
    }
    return out;
  },

  renderPhrase(p: Phrase, base: number, maxHz: number, seconds: number, delay = 0.01, fs = 48000): Float32Array {
    const r = Fx.renderer(fs, base, maxHz);
    r.enqueue(p, host0 + delay, 1);
    return Fx.render(r, seconds);
  },

  rms(x: ArrayLike<number>): number {
    if (x.length === 0) return 0;
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / x.length);
  },

  /// Writes 16-bit PCM mono WAV.
  writeWAV(x: ArrayLike<number>, fs: number, path: string): void {
    const b = Buffer.alloc(44 + x.length * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(fs, 24); b.writeUInt32LE(fs * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
    for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.trunc(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + 2 * i);
    writeFileSync(path, b);
  },

  /// `$env` (when set and non-empty) or `$TMPDIR/<fallback>`, created.
  outDir(env: string, fallback: string): string {
    const e = process.env[env];
    const dir = e ? e : join(tmpdir(), fallback);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
};
