// Port of FaceVoice/Generate/PhraseShaping.swift.
import { VocalContour } from '../../model';
import type { VoiceFingerprint } from '../model/VoiceFingerprint';
import { makeEnvelope, makeModulation2, makeTimbre, Note } from '../model/VoiceModel';
import type { PhraseParams } from './EmotionMapping';
import { PentatonicSnap } from './PentatonicSnap';
import type { DraftPhrase } from './ReactionTemplates';
import { vClamp, vClamp01, vLerp, type VoiceRNG } from './VoiceRNG';

/// Turns a template draft into real notes: jitter → pentatonic snap → human timing → phrase shape
/// (declination, droop, scoop, wobble) → timbre/envelope/modulation → range fit → level → accents.
export const PhraseShaping = {
  declinationPerNote: 0.4,
  vibratoMinDuration: 0.16,

  realize(draft: DraftPhrase, m: PhraseParams, fp: VoiceFingerprint, rng: VoiceRNG): Note[] {
    const d = draft.notes.map((x) => ({ ...x }));   // Swift copies the draft's notes
    const n = d.length;
    if (n <= 0) return [];

    // 1. Per-note jitter: pitch ±0.6 st, contour depth ±20 %, duration ±12 %, gap ±15 %, gain ±10 %.
    const gainJ = new Array<number>(n).fill(1);
    for (let i = 0; i < n; i++) {
      const pj = rng.sym(0.6 * draft.pitchJitter);
      const k = 1 + rng.sym(0.2);
      const glide = (d[i].end - d[i].start) * k;
      d[i].start += pj;
      d[i].end = d[i].start + glide;
      if (d[i].scoop !== null) d[i].scoop = d[i].scoop! * k;
      if (d[i].wobbleDepth !== null) d[i].wobbleDepth = d[i].wobbleDepth! * k;
      if (d[i].droop !== null) d[i].droop = d[i].droop! * k;
      d[i].trillDepth *= k;
      d[i].dur *= 1 + rng.sym(0.12 * draft.durJitter);
      const r = d[i].durRange;
      if (r) d[i].dur = vClamp(d[i].dur, r[0], r[1]);
      d[i].gap *= 1 + rng.sym(0.15);
      gainJ[i] = 1 + rng.sym(0.1);
    }

    // 2. Snap note targets toward the pentatonic scale relative to the first tonal note (±12 cents residual).
    //    Small glides keep their size; big glides (≥ 2.5 st) snap their end too.
    const ref = d.findIndex((x) => !x.noiseOnly);
    if (ref >= 0) {
      const r0 = d[ref].start;
      const isMinor = m.pleasure < 0;
      for (let i = 0; i < n; i++) {
        if (d[i].noiseOnly) continue;
        const res = rng.sym(0.12);
        const glide = d[i].end - d[i].start;
        d[i].start = r0 + PentatonicSnap.snap(d[i].start - r0, fp.scaleSnap, isMinor) + res;
        if (Math.abs(glide) >= 2.5) {
          d[i].end = r0 + PentatonicSnap.snap(d[i].end - r0 + 0, fp.scaleSnap, isMinor) + res;
        } else {
          d[i].end = d[i].start + glide;
        }
      }
    }

    // 3. Timing: swing on inter-onset intervals, rubato, ±6 ms human onset jitter.
    const dur = d.map((x) => x.dur), gap = d.map((x) => x.gap);
    if (draft.swing && n >= 3 && m.swing > 1.01) {
      const r = m.swing;
      const fl = 2 * r / (1 + r), fs = 2 / (1 + r);
      for (let i = 0; i < n - 1; i++) {
        const f = i % 2 === 0 ? fl : fs;
        dur[i] *= f; gap[i] *= f;
      }
    }
    if (draft.tighten) {
      for (let i = 0; i < n - 1; i++) {
        const k = Math.pow(0.93, i);
        dur[i] *= k; gap[i] *= k;
      }
    }
    if (draft.stretchLast && n >= 2) gap[n - 2] *= 1.3;
    // Keep the template's note-length range: the rhythm lives in the inter-onset interval, so a clamped
    // note hands the difference to its gap (onsets unchanged where possible).
    for (let i = 0; i < n; i++) {
      const ioi = dur[i] + gap[i];
      const r = d[i].durRange;
      if (r) dur[i] = vClamp(dur[i], r[0], r[1]);
      dur[i] = vClamp(dur[i], 0.04, 0.9);
      gap[i] = Math.max(0.015, ioi - dur[i]);
    }
    const onset = new Array<number>(n).fill(0);
    for (let i = 1; i < Math.max(n, 1); i++) {
      const o = d[i].onset;
      if (draft.fixedTiming && o !== null) {
        onset[i] = o + rng.sym(0.004);
        const maxPrev = onset[i] - onset[i - 1] - 0.012;
        if (dur[i - 1] > maxPrev) dur[i - 1] = Math.max(0.04, maxPrev);
      } else if (d[i].slur) {
        onset[i] = onset[i - 1] + dur[i - 1];
      } else {
        const g = Math.max(0.015, gap[i - 1]) + rng.sym(0.006);
        onset[i] = onset[i - 1] + dur[i - 1] + Math.max(0.009, g);
      }
    }

    // 4. Phrase shape: declination, final droop, onset scoop, low-dominance wobble.
    for (let i = 0; i < n; i++) {
      const dec = PhraseShaping.declinationPerNote * i;
      d[i].start -= dec;
      d[i].end -= dec;
    }
    const finalDroops = !draft.endsRising && !draft.question;
    for (let i = 0; i < n; i++) {
      if (d[i].droop !== null) continue;
      if (i === n - 1 && finalDroops) {
        d[i].droop = rng.range(1, 2) * vLerp(1.15, 0.85, m.p01);
      } else {
        d[i].droop = 0;
      }
    }

    // 5. Build notes.
    const notes: Note[] = [];
    for (let i = 0; i < n; i++) {
      const dn = d[i];
      const len = dur[i];
      const scoop = dn.scoop ?? (dn.slur ? 0 : m.scoop * rng.range(0.8, 1.2));
      const wobble = dn.wobbleDepth ?? (len >= 0.1 ? m.wobbleDepth * rng.range(0.85, 1.15) : 0);
      const contour = new VocalContour({
        start: dn.start, end: dn.end, glideOnset: dn.glideOnset, glideEase: dn.glideEase ?? fp.glideEase,
        scoop, scoopTau: dn.scoopTau,
        wobbleDepth: wobble, wobbleRate: dn.wobbleRate ?? m.wobbleRate,
        trillDepth: dn.trillDepth, trillRate: dn.trillRate,
        droop: dn.droop ?? 0, droopFraction: dn.droopFraction,
      });

      const art = vClamp01(m.articulation + dn.articulationBoost);
      const tb = makeTimbre();
      tb.sine = fp.sine; tb.square = fp.square; tb.fm = fp.fm; tb.fmRatio = fp.fmRatio;
      tb.fmIndexPeak = dn.fmIndexPeak ?? vLerp(2.5, 4, art) * fp.fmIndexPeak / 3;
      tb.fmIndexSustain = m.fmIndexSustain;
      tb.fmIndexTau = 0.025;
      tb.cutoff = vClamp(m.cutoff + dn.cutoffDelta, 0.05, 1);
      tb.filterEnvOctaves = 1.5;
      tb.filterEnvTau = dn.filterEnvTau ?? 0.06;
      tb.noiseDB = dn.noiseDB ?? fp.breathDB;
      tb.noiseBurst = dn.noiseBurst ?? 3;
      const v = vClamp01(m.vowel + dn.vowelDelta);
      tb.vowelStart = dn.vowelStart ?? v;
      tb.vowelEnd = dn.vowelEnd ?? v;
      tb.formantAmount = fp.formantAmount;
      if (dn.noiseOnly) {
        tb.sine = 0; tb.square = 0; tb.fm = 0;
        tb.noiseDB = 0; tb.noiseBurst = 1;
        tb.noiseBandPass = true; tb.noiseFreq = 1200;
      }

      const env = makeEnvelope();
      env.attackTau = dn.attackTau ?? m.attackTau;
      env.sustain = m.sustain;
      env.decayFraction = 0.4;
      env.release = dn.release ?? m.release;

      const mod = makeModulation2();
      if (len >= PhraseShaping.vibratoMinDuration && !dn.noiseOnly) {
        mod.vibratoDepth = m.vibratoDepth * rng.range(0.85, 1.15);
        mod.vibratoRate = (dn.vibratoRate ?? m.vibratoRate) * (1 + rng.sym(0.08));
        mod.vibratoDelay = Math.max(0.06, 0.35 * len);
        mod.vibratoFadeIn = 0.08;
      } else {
        mod.vibratoDepth = 0;
      }
      mod.tremoloDepth = dn.tremolo;
      mod.tremoloRate = dn.tremoloRate;

      const g = Math.pow(10, dn.gainDB / 20) * gainJ[i];
      notes.push(new Note({ start: onset[i], duration: len, contour, timbre: tb, envelope: env, modulation: mod,
        gain: g, slur: dn.slur, accent: dn.accent }));
    }

    // 6. Fit into the fingerprint's range (compress intervals, then shift — never per-note clamps).
    PhraseShaping.fit(notes, fp);

    // 7. Level: loudest tonal note sits at the phrase target (mapping + reaction offset ± 0.3 dB).
    const targetDB = m.gainDB + draft.gainOffsetDB + rng.sym(0.3);
    PhraseShaping.normalizeGain(notes, targetDB);

    // 8. Accents (face hops).
    PhraseShaping.markAccents(notes);
    return notes;
  },

  // MARK: Range fitting

  isTonal(n: Note): boolean { return n.timbre.sine + n.timbre.square + n.timbre.fm > 0; },

  /// Highest allowed pitch (semitones): range and maxPitchHz, whichever is lower.
  ceiling(fp: VoiceFingerprint): number {
    return Math.min(fp.rangeSemitones, 12 * Math.log2(Math.max(fp.maxPitchHz, 1) / Math.max(fp.basePitchHz, 1)));
  },

  /// Sampled pitch extent of a note including vibrato.
  extent(n: Note): { lo: number; hi: number } {
    const steps = Math.max(64, Math.trunc(n.duration / 0.002));
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k <= steps; k++) {
      const t = n.duration * k / steps;
      const p = n.contour.pitch(t, n.duration);
      lo = Math.min(lo, p); hi = Math.max(hi, p);
    }
    const v = n.duration >= PhraseShaping.vibratoMinDuration ? Math.abs(n.modulation.vibratoDepth) : 0;
    return { lo: lo - v, hi: hi + v };
  },

  extentOf(notes: readonly Note[]): { lo: number; hi: number } {
    let lo = Infinity, hi = -Infinity;
    for (const n of notes) { const e = PhraseShaping.extent(n); lo = Math.min(lo, e.lo); hi = Math.max(hi, e.hi); }
    return { lo, hi };
  },

  /// Scales every pitch quantity about `anchor` by `s` (exactly scales the sampled contour) and adds `shift`.
  transformPitch(notes: Note[], anchor: number, s: number, shift: number): void {
    for (const n of notes) {
      const c = n.contour;
      c.start = anchor + (c.start - anchor) * s + shift;
      c.end = anchor + (c.end - anchor) * s + shift;
      c.scoop *= s; c.wobbleDepth *= s; c.trillDepth *= s; c.droop *= s;
      n.modulation.vibratoDepth *= s;
    }
  },

  fit(notes: Note[], fp: VoiceFingerprint): void {
    if (notes.length === 0) return;
    const margin = 0.02;
    const hiCap = PhraseShaping.ceiling(fp) - margin;
    const loCap = -fp.rangeSemitones + margin;
    if (!(hiCap > loCap)) return;
    let { lo, hi } = PhraseShaping.extentOf(notes);
    const span = hi - lo, avail = hiCap - loCap;
    if (span > avail) {
      const s = avail / span, a = (lo + hi) / 2;
      PhraseShaping.transformPitch(notes, a, s, 0);
      lo = a + (lo - a) * s; hi = a + (hi - a) * s;
    }
    let shift = 0;
    if (hi > hiCap) shift = hiCap - hi; else if (lo < loCap) shift = loCap - lo;
    if (shift !== 0) PhraseShaping.transformPitch(notes, 0, 1, shift);
  },

  // MARK: Level and accents

  normalizeGain(notes: Note[], targetDB: number): void {
    let ref = -Infinity;
    for (const n of notes) if (PhraseShaping.isTonal(n)) ref = Math.max(ref, n.gain);
    if (ref === -Infinity) ref = 1;
    if (!(ref > 0)) return;
    const k = Math.min(Math.pow(10, targetDB / 20), 1) / ref;
    for (const n of notes) n.gain = Math.min(n.gain * k, 1);
  },

  /// First tonal note, final note, the peak note, and notes ≥ 180 ms after the previous onset.
  markAccents(notes: Note[]): void {
    const first = notes.findIndex(PhraseShaping.isTonal);
    if (first < 0) return;
    notes[first].accent = true;
    notes[notes.length - 1].accent = true;
    let peak = first, peakP = -Infinity;
    notes.forEach((n, i) => {
      if (!PhraseShaping.isTonal(n)) return;
      const p = Math.max(n.contour.start, n.contour.end);
      if (p > peakP) { peakP = p; peak = i; }
    });
    notes[peak].accent = true;
    for (let i = 1; i < notes.length; i++) {
      if (notes[i].start - notes[i - 1].start >= 0.18 && PhraseShaping.isTonal(notes[i])) notes[i].accent = true;
    }
  },

  // MARK: Novelty perturbations (class-respecting)

  shiftAndStretch(notes: readonly Note[], shift: number, k: number, fp: VoiceFingerprint): Note[] {
    const out = notes.map((n) => n.copy());
    PhraseShaping.transformPitch(out, 0, 1, shift);
    if (k !== 1) {
      // Timing shift on the gaps only, so note lengths stay inside their template ranges.
      let shiftT = 0;
      for (let i = 1; i < out.length; i++) {
        const prevEnd = out[i - 1].start + out[i - 1].duration;
        const gap = out[i].start + shiftT - prevEnd;     // original gap (prev already moved by shiftT)
        const origStart = out[i].start;
        out[i].start = out[i].slur ? prevEnd : prevEnd + Math.max(0.009, gap * k);
        shiftT = out[i].start - origStart;
      }
    }
    PhraseShaping.fit(out, fp);
    return out;
  },
};
