// Voice parity against the Swift recorder (tools/golden/Sources/golden-record/VoiceScenarios.swift →
// fixtures/golden/voice/*.json.gz). Plan level: discrete fields (note count, reaction, slur, accent, band-pass)
// exactly, numbers within PLAN_TOL (Swift plans in Float32). PCM: Int16 samples within PCM_TOL of full scale, plus peak
// and RMS.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import {
  BabbleText, Phrase, PhraseGenerator, SyllableCounter, VoiceAffect, VoiceFingerprint, VoiceRenderer,
  makeBabbleRequest, type LaughFitPart, type Note, type VoiceReaction,
} from '../../src/voice';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/golden/voice');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture JSON, shape documented in VoiceScenarios.swift
type J = any;
const load = (name: string): J => JSON.parse(gunzipSync(readFileSync(join(DIR, `${name}.json.gz`))).toString('utf8'));

/// Absolute + relative float tolerance for plan fields (Float32 vs float64 arithmetic).
const PLAN_TOL = { abs: 2e-4, rel: 1e-4 };
/// PCM: max sample difference (full scale 1) and RMS of the difference.
const PCM_TOL = { max: 3e-4, rms: 3e-5 };   // measured: ≤ 2 Int16 LSB (6.1e-5), RMS ≤ 6.3e-6

const close = (a: number, b: number, t = PLAN_TOL): boolean => Math.abs(a - b) <= t.abs + t.rel * Math.abs(b);
const seedOf = (s: string): bigint => BigInt(s);
const pad = (a: number[]): VoiceAffect => VoiceAffect.make(a[0], a[1], a[2]);
const fp = (): VoiceFingerprint => VoiceFingerprint.bundled();

function noteRow(n: Note): number[] {
  const c = n.contour, t = n.timbre, e = n.envelope, m = n.modulation;
  return [n.start, n.duration, c.start, c.end, c.glideOnset, c.glideEase, c.scoop, c.scoopTau, c.wobbleDepth, c.wobbleRate,
    c.trillDepth, c.trillRate, c.droop, c.droopFraction, t.sine, t.square, t.fm, t.fmRatio, t.fmIndexPeak, t.fmIndexSustain,
    t.fmIndexTau, t.cutoff, t.filterEnvOctaves, t.filterEnvTau, t.resonance, t.noiseDB, t.noiseBurst, t.noiseFreq,
    t.noiseBandPass ? 1 : 0, t.vowelStart, t.vowelEnd, t.formantAmount, e.attackTau, e.sustain, e.decayFraction, e.release,
    m.vibratoDepth, m.vibratoRate, m.vibratoDelay, m.vibratoFadeIn, m.tremoloDepth, m.tremoloRate, n.gain,
    n.slur ? 1 : 0, n.accent ? 1 : 0];
}
const DISCRETE = new Set(['timbre.noiseBandPass', 'slur', 'accent']);

/// First divergence between a TS phrase and a recorded one, or '' when they match.
function diffPhrase(fields: string[], p: Phrase, rec: J, where: string): string {
  if (p.reaction !== rec.reaction) return `${where}: reaction ${p.reaction} ≠ ${rec.reaction}`;
  if (p.notes.length !== rec.notes.length) return `${where}: ${p.notes.length} notes ≠ ${rec.notes.length}`;
  for (let i = 0; i < p.notes.length; i++) {
    const row = noteRow(p.notes[i]);
    for (let k = 0; k < fields.length; k++) {
      const a = row[k], b = rec.notes[i][k] as number;
      const ok = DISCRETE.has(fields[k]) ? a === b : close(a, b);
      if (!ok) return `${where}: note ${i} ${fields[k]} ${a} ≠ ${b}`;
    }
  }
  if (!close(p.duration, rec.duration)) return `${where}: duration ${p.duration} ≠ ${rec.duration}`;
  return '';
}

describe('voice golden: plans', () => {
  test('params', () => {
    const g = load('params');
    const gen = new PhraseGenerator(fp());
    for (const row of g.rows as number[][]) {
      const m = gen.parameters(VoiceAffect.make(row[0], row[1], row[2])) as unknown as Record<string, number | boolean>;
      (g.fields as string[]).forEach((f, k) => {
        const v = m[f];
        const a = typeof v === 'boolean' ? (v ? 1 : 0) : v;
        if (!close(a, row[3 + k])) expect.fail(`params ${row.slice(0, 3)} ${f}: ${a} ≠ ${row[3 + k]}`);
      });
    }
  });

  const reactions = load('reactions');
  test.each((reactions.runs as J[]).map((r) => [`${r.seed} ${r.affect}`, r]))('reactions %s', (_, run: J) => {
    const gen = new PhraseGenerator(fp(), seedOf(run.seed));
    const a = pad(run.pad);
    let k = 0;
    for (const r of reactions.reactions as VoiceReaction[]) {
      for (let rep = 0; rep < 2; rep++) {
        expect(diffPhrase(reactions.noteFields, gen.make(r, a), run.phrases[k], `${r} #${rep}`)).toBe('');
        k += 1;
      }
    }
  });

  const laugh = load('laughfit');
  test.each((laugh.runs as J[]).map((r) => [r.affect, r]))('laughfit %s', (_, run: J) => {
    const gen = new PhraseGenerator(fp());
    const a = pad(run.pad);
    (run.phrases as J[]).forEach((x, i) => {
      expect(diffPhrase(laugh.noteFields, gen.makeLaughFit(x.part as LaughFitPart, x.energy, a), x.phrase, `${i} ${x.part}`)).toBe('');
    });
  });

  const babble = load('babble');
  test.each((babble.runs as J[]).map((r) => [r.affect, r]))('babble %s', (_, run: J) => {
    const gen = new PhraseGenerator(fp());
    const a = pad(run.pad);
    for (const c of run.plans as J[]) {
      const p = gen.makeBabble(makeBabbleRequest({ text: c.text, affect: a, isLast: c.isLast, answer: c.answer,
        seed: seedOf(c.seed), sentenceCap: c.sentenceCap, budget: c.budget }));
      const where = JSON.stringify(c.text.slice(0, 24));
      expect(p.items.length, `${where} items`).toBe(c.items.length);
      p.items.forEach((it, i) => {
        const r = c.items[i];
        expect(it.sentence, `${where} item ${i} sentence`).toBe(r.sentence);
        expect(close(it.offset, r.offset), `${where} item ${i} offset ${it.offset} ≠ ${r.offset}`).toBe(true);
        expect(diffPhrase(babble.noteFields, it.phrase, r.phrase, `${where} item ${i}`)).toBe('');
      });
      expect([p.answer, p.syllables, p.textSyllables, p.sentences, p.droppedSentences, p.compressed])
        .toEqual([c.planAnswer, c.syllables, c.textSyllables, c.sentences, c.droppedSentences, c.compressed]);
      expect(p.sentenceDurations.length).toBe(c.sentenceDurations.length);
      p.sentenceDurations.forEach((d, i) => expect(close(d, c.sentenceDurations[i])).toBe(true));
      for (const [a1, b1] of [[p.nextGap, c.nextGap], [p.duration, c.duration], [p.lastNoteEnd, c.lastNoteEnd]]) {
        expect(close(a1, b1), `${where} ${a1} ≠ ${b1}`).toBe(true);
      }
    }
  });

  test('syllables and sentences', () => {
    for (const w of babble.syllables as J[]) expect(SyllableCounter.countWord(w.word), w.word).toBe(w.count);
    for (const t of babble.texts as J[]) {
      expect(SyllableCounter.count(t.text), t.text).toBe(t.count);
      const s = new BabbleText(t.text).sentences.map((x) => ({
        ending: x.ending, clauses: x.clauses.map((c) => ({ words: c.words, comma: c.endsWithComma })),
      }));
      expect(s, t.text).toEqual(t.sentences);
      expect(BabbleText.sentenceStrings(t.text), t.text).toEqual(t.sentenceStrings);
    }
  });
});

// MARK: - PCM

function decodeInt16(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const out = new Float32Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32767;
  return out;
}

function comparePCM(got: Float32Array, rec: J): { max: number; rms: number; report: string } {
  const want = decodeInt16(rec.int16);
  if (got.length !== want.length) return { max: Infinity, rms: Infinity, report: `${got.length} frames ≠ ${want.length}` };
  let max = 0, sum = 0, at = 0, peak = 0, e = 0;
  for (let i = 0; i < got.length; i++) {
    const q = Math.max(-32767, Math.min(32767, Math.round(got[i] * 32767))) / 32767;
    const d = Math.abs(q - want[i]);
    if (d > max) { max = d; at = i; }
    sum += d * d;
    peak = Math.max(peak, Math.abs(got[i]));
    e += got[i] * got[i];
  }
  const rms = Math.sqrt(sum / got.length);
  const r: string[] = [];
  if (max > PCM_TOL.max) r.push(`max diff ${max.toExponential(2)} at ${at}`);
  if (rms > PCM_TOL.rms) r.push(`rms diff ${rms.toExponential(2)}`);
  if (!close(peak, rec.peak, { abs: 2e-3, rel: 0 })) r.push(`peak ${peak} ≠ ${rec.peak}`);
  if (!close(Math.sqrt(e / got.length), rec.rms, { abs: 2e-4, rel: 0 })) r.push(`rms ${Math.sqrt(e / got.length)} ≠ ${rec.rms}`);
  return { max, rms, report: r.join('; ') };
}

/// Builds a TS phrase from its recorded notes (the PCM check isolates the synth from the planner).
function phraseFrom(fields: string[], rec: J): Phrase {
  const gen = new PhraseGenerator(fp());
  const p = gen.make(rec.reaction as VoiceReaction, VoiceAffect.neutral);   // a template to overwrite
  p.notes = (rec.notes as number[][]).map((row) => {
    const n = (p.notes[0] ?? gen.make('engaged', VoiceAffect.neutral).notes[0]).copy();
    fields.forEach((f, k) => {
      const v = row[k];
      const [obj, key] = f.includes('.') ? f.split('.') : [null, f];
      const target = (obj === null ? n : (n as unknown as Record<string, object>)[obj]) as Record<string, number | boolean>;
      target[key] = DISCRETE.has(f) ? v === 1 : v;
    });
    return n;
  });
  return p;
}

describe('voice golden: pcm', () => {
  const pcm = load('pcm');
  const fields = pcm.noteFields as string[];
  const alone = (pcm.renders as J[]).filter((r) => r.label !== 'mix');
  test.each(alone.map((r) => [r.label, r]))('render %s', (_, r: J) => {
    const p = phraseFrom(fields, r.phrase);
    const rd = new VoiceRenderer(r.rate);
    rd.setFingerprint(fp());
    rd.enqueue(p, 1, r.stretch);
    const out = new Float32Array(r.frames);
    rd.render(r.frames, 1, out);
    expect(comparePCM(out, r).report).toBe('');
  });

  test('render mix (overlap, cancel, stretch, volume, mute, gain)', () => {
    const r = (pcm.renders as J[]).find((x) => x.label === 'mix');
    const phrases = (r.phrases as J[]).map((x) => phraseFrom(fields, x));
    const rd = new VoiceRenderer(r.rate);
    rd.setFingerprint(fp());
    const out = new Float32Array(r.frames);
    const n = r.buffer as number;
    for (let k = 0; k * n < r.frames; k++) {
      for (const ev of (r.events as J[]).filter((e) => e.buffer === k)) {
        const a = ev.args as J[];
        switch (ev.call) {
          case 'enqueue': rd.enqueue(phrases[a[0]], a[1], a[2]); break;
          case 'cancelAll': rd.cancelAll(); break;
          case 'setVolume': rd.setVolume(a[0]); break;
          case 'setMuted': rd.setMuted(a[0]); break;
          case 'setGain': rd.setGain(a[0]); break;
        }
      }
      rd.render(n, 1 + (k * n) / r.rate, out, null, k * n);
    }
    expect(comparePCM(out, r).report).toBe('');
  });
});
