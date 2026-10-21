// Port of FaceVoice/Generate/BabbleShaping+Melody.swift (merged into `BabbleShaping` by BabbleShaping.ts).
import type { NoteSpec, PhraseEnd, PhraseSpec } from './BabbleShaping';
import { BabbleShaping } from './BabbleShaping';
import type { PhraseParams } from './EmotionMapping';
import { draftNote, draftPhrase, type DraftPhrase } from './ReactionTemplates';
import { roundSchool, vClamp, vClamp01, vLerp, type VoiceRNG } from './VoiceRNG';

/// Where a phrase sits, for its melody.
export interface BabbleContext {
  /// Notes of the sentence before this phrase (sentence-wide declination).
  notesBefore: number;
  /// The reply's last chunk (its final statement settles a little more).
  lastChunk: boolean;
  /// Timing factor (≤ 1 compresses toward a cap).
  timeScale: number;
}
export const makeBabbleContext = (o: Partial<BabbleContext> = {}): BabbleContext =>
  ({ notesBefore: 0, lastChunk: false, timeScale: 1, ...o });

/// Babble melody: speech-like steps, an accent on long words, two-syllable sweeps and punctuation contours. The draft
/// goes through `PhraseShaping.realize` like every other phrase (jitter, pentatonic snap, swing, declination, scoop,
/// wobble, timbre from the mapping, range fit, level), so babble is the same creature as the chirps.
export const BabbleMelody = {
  /// Net declination per note (realize lowers 0.4 st per note; babble wants 0.3, so each note gets 0.1 back).
  declinationBack: 0.1,

  draft(spec: PhraseSpec, m: PhraseParams, c: BabbleContext, rng: VoiceRNG): DraftPhrase {
    const B = BabbleShaping;
    const d = draftPhrase({ swing: true });
    const syl = B.syllableDuration(m.speed01) * c.timeScale;
    const center = 0.6 * m.register;
    // A breath resets most of the sentence's declination, not all of it.
    let pitch = center - 0.12 * c.notesBefore + rng.sym(1);
    const stepMax = vLerp(1.4, 3, m.a01);
    const upP = 0.5 + 0.25 * m.pleasure;
    const n = spec.notes.length;
    spec.notes.forEach((ns, i) => {
      if (i > 0) {
        let dir = rng.chance(upP) ? 1 : -1;
        if (pitch > center + 2.5) dir = rng.chance(0.8) ? -1 : 1; else if (pitch < center - 2.5) dir = rng.chance(0.8) ? 1 : -1;
        pitch += rng.chance(0.12) ? rng.sym(0.3) : dir * rng.range(1, stepMax);
      }
      let p = pitch + BabbleMelody.declinationBack * i;
      const accent = ns.wordStart && ns.wordLength >= 2;
      if (accent) p += rng.range(1, 2);
      const note = draftNote({ dur: syl * B.lengthFactor(ns.syllables) * rng.range(0.9, 1.1), start: p,
        end: p + rng.sym(0.5) + 0.4 * m.glideBias });
      if (ns.syllables >= 2) {
        // Two syllables in one note: a glide through the middle and a vowel sweep ("ee-oo"), read as two.
        const up = rng.chance(0.5 + 0.3 * m.pleasure) ? 1 : -1;
        note.end = p + up * rng.range(1, 2);
        note.glideOnset = 0.45;
        note.glideEase = 0.5;
        const v = rng.chance(0.5) ? 0.3 : -0.3;
        note.vowelStart = vClamp01(m.vowel + v);
        note.vowelEnd = vClamp01(m.vowel - v + 0.1 * m.pleasure);
      } else {
        note.vowelDelta = rng.sym(0.25);    // each syllable its own vowel colour
      }
      note.accent = accent;
      note.gainDB = accent ? 0 : -1.5 + rng.sym(0.5);
      if (accent) { note.articulationBoost = 0.15; note.cutoffDelta = 0.04; }
      if (i > 0 && !ns.wordStart && rng.chance(0.45)) { note.slur = true; note.scoop = 0; }
      // Silence after this note: short inside a word, a little longer between words.
      const nextInWord = i + 1 < n && !spec.notes[i + 1].wordStart;
      note.gap = (nextInWord ? rng.range(0.012, 0.03) : vLerp(0.075, 0.035, m.a01) * rng.range(0.7, 1.3)) * c.timeScale;
      d.notes.push(note);
    });
    BabbleMelody.shapeEnding(d, spec.end, m, c, rng);
    return d;
  },

  /// Punctuation contours on the phrase's last note.
  shapeEnding(d: DraftPhrase, end: PhraseEnd, m: PhraseParams, c: BabbleContext, rng: VoiceRNG): void {
    const last = d.notes.pop();
    if (!last) return;
    const kind = end.kind === 'sentence' ? end.ending : end.kind;
    switch (kind) {
      case 'question':
        // A question glide: +4…+7 st from 35 % of a longer note, from a little below.
        last.start -= 0.5;
        last.end = last.start + rng.range(4, 7);
        last.dur *= 1.5;
        last.glideOnset = 0.35;
        last.glideEase = 0.5;
        last.vowelDelta = 0.1;
        last.vowelStart = null; last.vowelEnd = null;
        last.slur = false;
        last.accent = true;
        d.question = true;
        d.endsRising = true;
        break;
      case 'exclamation':
        // Bright and accented: the loudest note (+1.5 dB), a +1 st flick, a brighter cutoff, a firm onset.
        last.end = last.start + 1;
        last.glideOnset = 0.5;
        last.gainDB = 1.5;
        last.cutoffDelta = 0.12;
        last.articulationBoost = 0.25;
        last.accent = true;
        last.droop = 0;
        last.dur *= 1.15;
        d.endsRising = true;
        d.gainOffsetDB = 0.5;
        break;
      case 'statement':
        // Phrase-final lengthening and the usual droop (a little more at the end of the reply).
        last.dur *= 1.15;
        // A statement never ends on a rise: a rising sweep on the last note turns into a small fall.
        if (last.end > last.start + 0.8) last.end = last.start - 0.5 * (last.end - last.start);
        if (c.lastChunk) { last.droop = rng.range(1.4, 2.4); last.droopFraction = 0.45; }
        break;
      case 'comma':
        // A small lift before the comma's pause.
        last.end = last.start + rng.range(1, 2);
        last.glideOnset = 0.4;
        last.droop = 0;
        d.endsRising = true;
        break;
      case 'split':
        last.droop = rng.range(0, 0.4);
        break;
    }
    d.notes.push(last);
  },

  /// A text-free babble phrase (`PhraseGenerator.make('babble', …)`, the panel and the shared reaction tests):
  /// a short statement of 2–8 notes, as many as arousal gives.
  genericDraft(m: PhraseParams, rng: VoiceRNG): DraftPhrase {
    const n = Math.trunc(vClamp(roundSchool(vLerp(3, 7, m.a01) + rng.sym(1)), 2, 8));
    const notes: NoteSpec[] = [];
    while (notes.length < n) {
      const w = Math.min(n - notes.length, rng.chance(0.35) ? 2 : 1);
      for (let k = 0; k < w; k++) notes.push({ syllables: rng.chance(0.3) ? 2 : 1, wordStart: k === 0, wordLength: w + 1 });
    }
    return BabbleMelody.draft({ notes, end: { kind: 'sentence', ending: 'statement' } }, m, makeBabbleContext(), rng);
  },
};
