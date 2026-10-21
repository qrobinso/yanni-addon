// Port of FaceVoice/DSP/PhraseVoice.swift.
import { Note } from '../model/VoiceModel';
import { makeQueuedPhrase, type QueuedPhrase } from './PhraseRing';
import { formantFrequencies, noiseValue, polyBLEPSquare, SineTable, SVF, svfG, xorshiftNext } from './VoiceDSP';

/// Tuning constants of the synthesizer (all times in phrase seconds unless noted).
export const VoiceDSPConstants = {
  /// Control-rate block (≈ 0.67 ms): pitch, envelopes and filter coefficients are evaluated every block
  /// (32 samples at ≥ 32 kHz, 16 below) and linearly interpolated (amplitude, phase increment, FM index) or
  /// one-pole smoothed (filter g) between.
  blockSize(fs: number): number { return fs >= 32000 ? 32 : 16; },
  /// One-pole smoothing coefficient applied to filter g and mix weights per control block.
  coefSmoothing: 0.5,
  /// Slur: pitch glides from the previous note's end over 20…35 ms (wider intervals take longer).
  slurGlideMin: 0.020,
  slurGlideMax: 0.035,
  /// Slur: level dips to 0.35 inside a 15 ms raised-cosine window (no re-attack).
  slurDipDepth: 0.65,
  slurDipTime: 0.015,
  /// Fraction of the FM index spike / filter envelope a slurred note re-applies.
  slurArticulation: 0.3,
  /// Non-slurred notes: the previous note stops over the last 3 ms before the onset (glottal stop).
  hardStop: 0.003,
  /// Minimum fade at both ends of any note.
  minFade: 0.002,
  /// Release time constant = release / 5 (≈ −43 dB at the end of the release, then a 2 ms gate).
  releaseTauDivisor: 5,
  /// Vibrato only on notes at least this long.
  vibratoMinNote: 0.16,
  /// Noise onset burst decay (s).
  burstTau: 0.010,
  /// Low-pass: cutoff 0…1 → 400 Hz·30^c (400 Hz…12 kHz), key tracking exponent, Q mapping.
  cutoffMinHz: 400,
  cutoffSpan: 30,
  keyTracking: 0.3,
  /// Formant band-pass Q.
  formantQ: 6,
  /// Pitch compensation exponent (gain × (f/base)^−0.3) and short-note boost (+1.5 dB below 80 ms).
  pitchCompExponent: -0.3,
  shortNoteBoost: 1.1885,
  shortNoteLimit: 0.080,
  /// Accented notes: +1 dB.
  accentBoost: 1.122,
  /// Cancel / steal fade, in real seconds.
  cancelFade: 0.020,
  /// Overall headroom so a neutral phrase (fingerprint loudness 0.7, volume 1) peaks ≈ −6 dBFS.
  headroom: 0.52,
} as const;
const K = VoiceDSPConstants;

export type VoiceStage = 'free' | 'pending' | 'active';

/// Pure per-note curves (no state), shared by the voice and the tests.
export const NoteShape = {
  /// Level of `n` at local time `u` (before stop gate, tremolo, pitch compensation). `slurIn`/`levelIn`:
  /// a slurred note starts from the previous note's level instead of re-attacking.
  level(n: Note, u: number, slurIn: boolean, levelIn: number): number {
    const dur = Math.max(n.duration, K.minFade);
    if (u < dur) return body(n, u, dur, slurIn, levelIn);
    const rel = Math.max(n.envelope.release, K.minFade);
    const r = u - dur;
    if (!(r < rel)) return 0;
    const vEnd = body(n, dur, dur, slurIn, levelIn);
    return vEnd * Math.exp(-r * K.releaseTauDivisor / rel) * Math.min((rel - r) / K.minFade, 1);
  },

  noteGain(n: Note): number {
    let g = n.gain;
    if (n.accent) g *= K.accentBoost;
    if (n.duration < K.shortNoteLimit) g *= K.shortNoteBoost;
    return g;
  },

  /// Pitch (semitones rel. base) of `n` at local time `u`, with the slur glide offset and vibrato.
  pitch(n: Note, u: number, glideOffset: number, glideTime: number): number {
    const dur = Math.max(n.duration, K.minFade);
    let p = n.contour.pitch(u, dur);
    if (glideOffset !== 0 && u < glideTime) {
      const x = Math.max(u, 0) / glideTime;
      p += glideOffset * (1 - x * x * (3 - 2 * x));
    }
    const m = n.modulation;
    if (dur >= K.vibratoMinNote && m.vibratoDepth !== 0) {
      const delay = Math.max(m.vibratoDelay, 0.35 * dur);
      if (u > delay) {
        const fade = Math.min((u - delay) / Math.max(m.vibratoFadeIn, 1e-3), 1);
        p += m.vibratoDepth * fade * Math.sin(2 * Math.PI * m.vibratoRate * (u - delay));
      }
    }
    return p;
  },
};

function body(n: Note, u: number, dur: number, slurIn: boolean, levelIn: number): number {
  const e = n.envelope;
  const g = NoteShape.noteGain(n);
  const sus = Math.min(Math.max(e.sustain, 0), 1);
  const tauD = Math.max(e.decayFraction * dur, 1e-3);
  const shape = (sus + (1 - sus) * Math.exp(-u / tauD)) * g;
  const att = 1 - Math.exp(-Math.max(u, 0) / Math.max(e.attackTau, 0.0005));
  if (slurIn) {
    let v = levelIn + (shape - levelIn) * att;
    if (u < K.slurDipTime) {
      const s = Math.sin(Math.PI * u / K.slurDipTime);
      v *= 1 - K.slurDipDepth * s * s;
    }
    return v;
  }
  return shape * att * Math.min(Math.max(u, 0) / K.minFade, 1);
}

/// One phrase voice: a single continuous oscillator/filter chain that walks the phrase's notes in order
/// (continuous phase across notes; slurs glide, non-slurred notes get a hard stop). Lives in a preallocated table.
export class PhraseVoice {
  stage: VoiceStage = 'free';
  q: QueuedPhrase = makeQueuedPhrase();
  startSample = 0;
  cancelling = false;
  cancelGain = 1;

  // Timing (phrase time = real time / timeStretch).
  t = 0;                 // phrase time at the current control point
  dtp = 0;               // phrase seconds per sample
  blockLeft = 0;
  blockSize = 16;
  cancelStep = 0;        // cancel fade per block (full scale in `cancelFade`)
  endTime = 0;

  // Notes.
  noteIndex = -1;
  cur: Note = Note.silent;
  nxt: Note = Note.silent;
  hasNext = false;
  slurIn = false;
  levelIn = 0;
  glideOffset = 0;
  glideTime: number = K.slurGlideMin;

  // Interpolated per-sample values.
  amp = 0; dAmp = 0;
  inc = 0; dInc = 0;
  fmI = 0; dFmI = 0;
  nAmp = 0; dNAmp = 0;
  lastLevelTarget = 0;

  // Smoothed per-block parameters.
  wSine = 0; wSq = 0; wFM = 0;
  fmRatio = 1;
  formantAmt = 0;
  gLP = 0.5; gF1 = 0.05; gF2 = 0.15; gN = 0.2;
  noiseBandPass = false;
  paramsPrimed = false;
  // Per-note constants (recomputed when the current note changes).
  noteNoiseLin = 0;
  noteGN = 0.2;
  noteCutoffHz = 1000;
  noteFixedVowel = false;
  noteGF1 = 0.05; noteGF2 = 0.15;
  noteFs = 0;

  // Oscillators and filters.
  phase = 0;
  modPhase = 0;
  lp = new SVF();
  f1 = new SVF();
  f2 = new SVF();
  nf = new SVF();
  rng = 0x9e3779b9;

  cachedNoteIndex = Number.MIN_SAFE_INTEGER;

  /// Copies `item` in, sorts its notes by onset and resets the chain.
  activate(item: QueuedPhrase, startSample: number, fs: number, seed: number): void {
    this.q = { ...item, phrase: item.phrase.copy() };
    // Insertion sort by start (≤ 8 notes; generator output is normally already sorted).
    const notes = this.q.phrase.notes;
    const c = notes.length;
    for (let i = 1; i < c; i++) {
      const n = notes[i];
      let j = i - 1;
      while (j >= 0 && notes[j].start > n.start) { notes[j + 1] = notes[j]; j -= 1; }
      notes[j + 1] = n;
    }
    this.stage = 'pending';
    this.startSample = startSample;
    this.cancelling = false;
    this.cancelGain = 1;
    const ts = this.q.timeStretch;
    const stretch = Math.min(Math.max(Number.isFinite(ts) ? ts : 1, 1), 16);
    this.dtp = 1 / (fs * stretch);
    this.blockSize = K.blockSize(fs);
    this.cancelStep = this.blockSize / (K.cancelFade * fs);
    this.noteFs = 0;
    this.t = 0;
    this.blockLeft = 0;
    this.endTime = this.q.phrase.duration + 0.005;
    this.noteIndex = -1;
    this.hasNext = c > 0;
    this.nxt = c > 0 ? notes[0] : Note.silent;
    this.cur = this.nxt;
    this.slurIn = false; this.levelIn = 0; this.glideOffset = 0;
    this.amp = 0; this.dAmp = 0; this.inc = 0; this.dInc = 0; this.fmI = 0; this.dFmI = 0; this.nAmp = 0; this.dNAmp = 0;
    this.lastLevelTarget = 0;
    this.paramsPrimed = false;
    this.phase = 0; this.modPhase = 0;
    this.lp.reset(); this.f1.reset(); this.f2.reset(); this.nf.reset();
    this.rng = (seed | 1) >>> 0;
  }

  free(): void { this.stage = 'free'; }

  /// Starts a click-free fade to silence (cancel or voice steal).
  beginFadeOut(): void { this.cancelling = true; }

  /// Advances notes so that `cur` is the note sounding at phrase time `tc`, capturing slur continuity.
  private advanceNotes(tc: number): void {
    while (this.hasNext && tc >= this.nxt.start) {
      if (this.noteIndex >= 0 && this.nxt.slur) {
        const u = this.nxt.start - this.cur.start;
        const lIn = NoteShape.level(this.cur, u, this.slurIn, this.levelIn);
        const pIn = NoteShape.pitch(this.cur, u, this.glideOffset, this.glideTime);
        const target0 = this.nxt.contour.pitch(0, Math.max(this.nxt.duration, K.minFade));
        this.levelIn = lIn;
        this.glideOffset = pIn - target0;
        this.glideTime = K.slurGlideMin + (K.slurGlideMax - K.slurGlideMin) * Math.min(Math.abs(this.glideOffset) / 12, 1);
        this.slurIn = true;
      } else {
        this.levelIn = 0; this.glideOffset = 0; this.slurIn = false;
      }
      this.cur = this.nxt;
      this.noteIndex += 1;
      const c = this.q.phrase.notes.length;
      this.hasNext = this.noteIndex + 1 < c;
      if (this.hasNext) this.nxt = this.q.phrase.notes[this.noteIndex + 1];
    }
  }

  /// Per-note values that don't vary within a note (noise level, noise filter, base cutoff, fixed vowels).
  private cacheNoteConstants(fs: number): void {
    const tb = this.cur.timbre;
    this.noteFs = fs;
    this.cachedNoteIndex = this.noteIndex;
    this.noteNoiseLin = Math.pow(10, tb.noiseDB / 20);
    this.noteGN = svfG(tb.noiseFreq, fs);
    this.noteCutoffHz = K.cutoffMinHz * Math.pow(K.cutoffSpan, Math.min(Math.max(tb.cutoff, 0), 1));
    this.noteFixedVowel = tb.vowelStart === tb.vowelEnd;
    const ff = formantFrequencies(tb.vowelStart);
    this.noteGF1 = svfG(ff.f1, fs); this.noteGF2 = svfG(ff.f2, fs);
  }

  /// Computes control targets for the end of the next block and sets per-sample increments.
  /// Returns false when the voice has finished (or went non-finite) and should be freed after this block.
  control(fs: number): boolean {
    const n = this.blockSize;
    const tc = this.t + n * this.dtp;
    this.t += n * this.dtp;
    this.advanceNotes(tc);

    if (this.cancelling) this.cancelGain = Math.max(this.cancelGain - this.cancelStep, 0);

    const note = this.cur;
    const before = this.noteIndex < 0;
    const u = before ? 0 : tc - note.start;
    const tb = note.timbre;
    if (this.noteFs !== fs || this.cachedNoteIndex !== this.noteIndex) this.cacheNoteConstants(fs);

    // Level.
    let level = 0;
    if (!before) {
      level = NoteShape.level(note, u, this.slurIn, this.levelIn);
      if (this.hasNext && !this.nxt.slur) {
        const gate = (this.nxt.start - tc) / K.hardStop;
        if (gate < 1) level *= Math.max(gate, 0);
      }
      const m = note.modulation;
      if (m.tremoloDepth > 0) {
        level *= 1 - Math.min(m.tremoloDepth, 1) * 0.5 * (1 - Math.cos(2 * Math.PI * m.tremoloRate * u));
      }
    }
    this.lastLevelTarget = level;

    // Pitch.
    const p = NoteShape.pitch(note, u, before ? 0 : this.glideOffset, this.glideTime);
    const base = Math.max(this.q.baseHz, 20);
    let f = base * Math.pow(2, p / 12);
    f = Math.min(f, Math.max(this.q.maxHz, 20), 0.45 * fs);
    f = Math.max(f, 20);
    const log2Ratio = Math.log2(f / base);
    const comp = Math.pow(2, log2Ratio * K.pitchCompExponent);
    const master = Math.max(this.q.loudness, 0) * K.headroom * this.cancelGain;

    const ampT = level * comp * master;
    // FM index envelope.
    const art = this.slurIn ? K.slurArticulation : 1;
    const tauFM = Math.max(tb.fmIndexTau, 1e-3);
    const fmT = tb.fmIndexSustain + (tb.fmIndexPeak - tb.fmIndexSustain) * art * Math.exp(-u / tauFM);
    // Noise.
    const burst = this.slurIn ? 1 : 1 + (tb.noiseBurst - 1) * Math.exp(-u / K.burstTau);
    const nAmpT = level * master * this.noteNoiseLin * Math.max(burst, 0);

    const inv = 1 / n;
    this.dAmp = (ampT - this.amp) * inv;
    this.dNAmp = (nAmpT - this.nAmp) * inv;
    this.dFmI = (fmT - this.fmI) * inv;
    const incT = f / fs;
    if (!this.paramsPrimed) this.inc = incT;
    this.dInc = (incT - this.inc) / n;

    // Mix weights normalised by RMS (sine/FM RMS 0.707, square 1).
    const ws = Math.max(tb.sine, 0), wq = Math.max(tb.square, 0), wf = Math.max(tb.fm, 0);
    const rms = Math.sqrt(0.5 * ws * ws + wq * wq + 0.5 * wf * wf);
    const norm = rms > 1e-6 ? 0.7071 / rms : 0;

    // Low-pass cutoff: exp map + filter envelope + key tracking, clamped ≤ 0.45·fs.
    const envOct = tb.filterEnvOctaves * art * Math.exp(-u / Math.max(tb.filterEnvTau, 1e-3));
    const fc = this.noteCutoffHz * Math.pow(2, envOct + log2Ratio * K.keyTracking);
    const gLPT = svfG(fc, fs);
    const kLP = 1.414 * (1 - 0.85 * Math.min(Math.max(tb.resonance, 0), 1));

    // Formants.
    let gF1T = this.noteGF1, gF2T = this.noteGF2;
    if (!this.noteFixedVowel) {
      const x = Math.min(Math.max(u / Math.max(note.duration, K.minFade), 0), 1);
      const ff = formantFrequencies(tb.vowelStart + (tb.vowelEnd - tb.vowelStart) * x);
      gF1T = svfG(ff.f1, fs); gF2T = svfG(ff.f2, fs);
    }
    const faT = Math.min(Math.max(tb.formantAmount, 0), 1);

    // Noise filter.
    const gNT = this.noteGN;
    this.noiseBandPass = tb.noiseBandPass;

    const a = this.paramsPrimed ? K.coefSmoothing : 1;
    this.wSine += (ws * norm - this.wSine) * a;
    this.wSq += (wq * norm - this.wSq) * a;
    this.wFM += (wf * norm - this.wFM) * a;
    this.fmRatio += (Math.max(tb.fmRatio, 0) - this.fmRatio) * a;
    this.formantAmt += (faT - this.formantAmt) * a;
    this.gLP += (gLPT - this.gLP) * a;
    this.gF1 += (gF1T - this.gF1) * a;
    this.gF2 += (gF2T - this.gF2) * a;
    this.gN += (gNT - this.gN) * a;
    this.paramsPrimed = true;
    this.lp.setCoefficients(this.gLP, kLP);
    this.f1.setCoefficients(this.gF1, 1 / K.formantQ);
    this.f2.setCoefficients(this.gF2, 1 / K.formantQ);
    this.nf.setCoefficients(this.gN, this.noiseBandPass ? 0.5 : 1.414);

    // Denormal / NaN guard.
    const ok = this.lp.sanitize() && this.f1.sanitize() && this.f2.sanitize() && this.nf.sanitize() &&
      Number.isFinite(this.amp) && Number.isFinite(this.inc);
    if (!ok) return false;

    const finished = (tc >= this.endTime && ampT === 0 && this.amp < 1e-7) ||
      (this.cancelling && this.cancelGain === 0 && this.amp < 1e-7);
    return !finished;
  }

  /// Renders `count` samples (≤ remaining block) and adds them to `out` from `offset`.
  renderSamples(out: Float32Array, offset: number, count: number, table: Float32Array): void {
    const twoPiInv = 1 / (2 * Math.PI);
    const wSine = this.wSine, wSq = this.wSq, wFM = this.wFM;
    const useSq = wSq > 1e-6, useFM = wFM > 1e-6, useSine = wSine > 1e-6;
    const fa = this.formantAmt;
    const useFormant = fa > 1e-4;
    const useNoise = this.nAmp > 1e-9 || this.dNAmp > 1e-12;
    const dry = 1 - 0.6 * fa;
    const ratio = this.fmRatio;
    const dAmp = this.dAmp, dInc = this.dInc, dFmI = this.dFmI, dNAmp = this.dNAmp;
    let amp = this.amp, inc = this.inc, fmI = this.fmI, nAmp = this.nAmp;
    let phase = this.phase, modPhase = this.modPhase;
    const lp = this.lp, f1 = this.f1, f2 = this.f2, nf = this.nf;
    let rng = this.rng;
    const bp = this.noiseBandPass;
    const k1 = f1.k, k2 = f2.k, kn = nf.k;
    for (let i = 0; i < count; i++) {
      amp += dAmp; inc += dInc; fmI += dFmI; nAmp += dNAmp;
      phase += inc;
      if (phase >= 1) phase -= 1;
      const ph = phase;
      let x = 0;
      if (useSine) x += wSine * SineTable.sin01(table, ph);
      if (useSq) x += wSq * polyBLEPSquare(ph, inc);
      if (useFM) {
        modPhase += inc * ratio;
        if (modPhase >= 1) modPhase -= Math.floor(modPhase);
        const m = SineTable.sin01(table, modPhase);
        x += wFM * SineTable.sin(table, ph + fmI * m * twoPiInv);
      }
      let y = lp.tick(x);
      if (useFormant) {
        f1.tick(y);
        const b1 = f1.bp * k1;
        f2.tick(y);
        const b2 = f2.bp * k2;
        y = y * dry + fa * (1.2 * b1 + 1.0 * b2);
      }
      let s = amp * y;
      if (useNoise) {
        rng = xorshiftNext(rng);
        const w = noiseValue(rng);
        const rlp = nf.tick(w);
        const nOut = bp ? nf.bp * kn : w - kn * nf.bp - rlp;
        s += nAmp * nOut;
      }
      out[offset + i] += s;
    }
    this.amp = amp; this.inc = inc; this.fmI = fmI; this.nAmp = nAmp;
    this.phase = phase; this.modPhase = modPhase;
    this.rng = rng;
  }
}
