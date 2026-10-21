// Port of FaceVoice/Generate/ReactionTemplates.swift.
// Argument evaluation order matters (every rng call consumes the sequence): object literals evaluate their properties
// in source order, as Swift evaluates initializer arguments.
import type { VoiceFingerprint } from '../model/VoiceFingerprint';
import type { VoiceReaction } from '../model/VoiceModel';
import { BabbleShaping } from './BabbleShaping';
import type { PhraseParams } from './EmotionMapping';
import { PentatonicSnap } from './PentatonicSnap';
import { roundSchool, vClamp, vClamp01, vLerp, type VoiceRNG } from './VoiceRNG';

/// One planned note before jitter, snapping, timing and range fitting. Pitches are semitones relative to the
/// fingerprint base. `null` fields take the mapping's default in the shaping pass.
export interface DraftNote {
  dur: number;
  /// Silence after this note before the next onset (ignored when the next note is slurred).
  gap: number;
  start: number;
  end: number;
  glideOnset: number;
  glideEase: number | null;
  scoop: number | null;
  scoopTau: number;
  wobbleDepth: number | null;
  wobbleRate: number | null;
  trillDepth: number;
  trillRate: number;
  droop: number | null;
  droopFraction: number;
  /// Level relative to the phrase's loudest note.
  gainDB: number;
  slur: boolean;
  accent: boolean;
  tremolo: number;
  tremoloRate: number;
  attackTau: number | null;
  articulationBoost: number;
  fmIndexPeak: number | null;
  noiseDB: number | null;
  noiseBurst: number | null;
  /// Breath-only note (tone mix 0, band-passed noise) — the sleepy inhale.
  noiseOnly: boolean;
  vowelDelta: number;
  vowelStart: number | null;
  vowelEnd: number | null;
  cutoffDelta: number;
  filterEnvTau: number | null;
  release: number | null;
  vibratoRate: number | null;
  durRange: readonly [number, number] | null;
  /// Fixed onset (fixed-timing reactions aligned to a one-shot's bounces/beats).
  onset: number | null;
}

export function draftNote(o: Pick<DraftNote, 'dur' | 'start' | 'end'> & Partial<DraftNote>): DraftNote {
  return {
    gap: 0.03, glideOnset: 0, glideEase: null, scoop: null, scoopTau: 0.018, wobbleDepth: null, wobbleRate: null,
    trillDepth: 0, trillRate: 12, droop: null, droopFraction: 0.35, gainDB: 0, slur: false, accent: false, tremolo: 0,
    tremoloRate: 12, attackTau: null, articulationBoost: 0, fmIndexPeak: null, noiseDB: null, noiseBurst: null,
    noiseOnly: false, vowelDelta: 0, vowelStart: null, vowelEnd: null, cutoffDelta: 0, filterEnvTau: null,
    release: null, vibratoRate: null, durRange: null, onset: null, ...o,
  };
}

export interface DraftPhrase {
  notes: DraftNote[];
  /// Ends on a rising question (only curious / emote / confused may set this — review H1).
  question: boolean;
  /// Ends rising for another reason (no final droop).
  endsRising: boolean;
  swing: boolean;
  /// Delighted rubato: onsets tighten ×0.93 per note.
  tighten: boolean;
  /// Sleepy / sheepish rubato: last interval ×1.3.
  stretchLast: boolean;
  fixedTiming: boolean;
  /// Scales the generic per-note jitter (pitch ±0.6 st, duration ±12 %).
  pitchJitter: number;
  durJitter: number;
  /// Reaction loudness offset (dB). Offsets span −2…+3 so the spread stays ≤ 6 dB with jitter.
  gainOffsetDB: number;
}

export function draftPhrase(o: Partial<DraftPhrase> = {}): DraftPhrase {
  return {
    notes: [], question: false, endsRising: false, swing: false, tighten: false, stretchLast: false,
    fixedTiming: false, pitchJitter: 1, durJitter: 1, gainOffsetDB: 0, ...o,
  };
}

type M = PhraseParams;

/// Duration inside [lo, hi]: faster mood → shorter, plus a little free variation.
function dur(slow: number, fast: number, m: M, rng: VoiceRNG): number {
  const t = vClamp01(m.speed01 + rng.sym(0.2));
  return vLerp(slow, fast, t);
}

/// Per-reaction shapes (review H3 + Low). Mood moves each parameter inside the template's own range.
export const ReactionTemplates = {
  /// Laugh one-shot bounce times at rate 1 (s from the one-shot start).
  giggleBounces: [0.21, 0.50, 0.73] as readonly number[],
  danceBeatPeriod: 0.5,
  /// Answer accents at rate 1 (s from the one-shot start; `AnswerAccents` in FaceEngine). Each answer's second
  /// note starts `accents[1] − accents[0]` after its first, so both land on a hit.
  nodYesAccents: [0.19, 0.46] as readonly number[],
  nodYesBigAccents: [0.22, 0.47, 0.71, 0.875] as readonly number[],
  shakeNoAccents: [0.205, 0.435, 0.64] as readonly number[],
  shakeNoBigAccents: [0.195, 0.42, 0.645, 0.90] as readonly number[],

  draft(r: VoiceReaction, m: M, fp: VoiceFingerprint, rng: VoiceRNG): DraftPhrase {
    const T = ReactionTemplates;
    switch (r) {
      case 'engaged': return T.engaged(m, rng);
      case 'curious': return T.curious(m, rng);
      case 'delighted': return T.delighted(m, rng);
      case 'embarrassed': return T.embarrassed(m, rng);
      case 'startled': return T.startled(m, fp, rng);
      case 'sleepy': return T.sleepy(m, rng);
      case 'sheepish': return T.sheepish(m, rng);
      case 'giggle': return T.giggle(m, rng);
      case 'hmph': return T.hmph(m, fp, rng);
      case 'doubleTake': return T.doubleTake(m, fp, rng);
      case 'confused': return T.confused(m, rng);
      case 'danceBeat': return T.danceBeat(m, rng);
      case 'emote': return T.emote(m, rng);
      case 'mmHm': return T.mmHm(m, false, rng);
      case 'mmHmBig': return T.mmHm(m, true, rng);
      case 'uhUh': return T.uhUh(m, rng);
      case 'nuhUh': return T.nuhUh(m, fp, rng);
      case 'babble': return BabbleShaping.genericDraft(m, rng);
    }
  },

  // "bi-dup": 50–70 ms + 80–110 ms, slurred up +4 or +7 st.
  engaged(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ endsRising: true, pitchJitter: 0.5, gainOffsetDB: 0.5 });
    const base = 0.6 * m.register + rng.sym(0.5);
    // +4 or +7 (major); in a minor mood +5 or +7 so the pentatonic snap keeps a clear lift.
    const iv = rng.chance(0.3 + 0.4 * m.a01) ? 7 : (m.pleasure < 0 ? 5 : 4);
    const n1 = draftNote({ dur: dur(0.07, 0.05, m, rng), gap: 0, start: base, end: base });
    n1.durRange = [0.05, 0.07];
    n1.articulationBoost = 0.15;
    n1.cutoffDelta = 0.08;
    const top = base + iv;
    const n2 = draftNote({ dur: dur(0.11, 0.08, m, rng), start: top, end: top + 0.3 * Math.max(m.pleasure, 0) });
    n2.slur = true;
    n2.scoop = 0;
    n2.durRange = [0.08, 0.11];
    n2.cutoffDelta = 0.1;
    n2.accent = true;
    d.notes = [n1, n2];
    return d;
  },

  // 2–3 notes, the last 1.5–2× longer with a question rise starting at 35 % of the note.
  curious(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ question: true, endsRising: true, durJitter: 0.3 });
    const n = rng.chance(0.3 + 0.5 * m.a01) ? 3 : 2;
    const baseDur = dur(0.15, 0.08, m, rng);
    let pitch = 0.7 * m.register + rng.sym(0.8);
    for (let k = 0; k < n - 1; k++) {
      d.notes.push(draftNote({ dur: baseDur, gap: m.gap, start: pitch, end: pitch + 0.3 * m.glideBias }));
      pitch += rng.sym(1) * vLerp(1, 2.5, m.a01);
    }
    const rise = vLerp(4, 7, 0.7 * (1 - m.d01) + 0.3 * rng.unit());
    const last = draftNote({ dur: baseDur * rng.range(1.55, 1.95), start: pitch, end: pitch + rise });
    last.glideOnset = 0.35;
    last.glideEase = 0.5;
    last.vowelDelta = 0.1;
    d.notes.push(last);
    return d;
  },

  // Pentatonic up-up-down-up run of 4–7 notes (60–110 ms), final note 1.6× longer with a +1 st flick.
  delighted(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ endsRising: true, swing: true, tighten: true, pitchJitter: 0.35, gainOffsetDB: 0.5 });
    const n = Math.trunc(vClamp(roundSchool(vLerp(4, 7, m.a01) + rng.sym(0.8)), 4, 7));
    const isMinor = m.pleasure < 0;
    const noteDur = dur(0.11, 0.06, m, rng);
    const base = 0.5 * m.register + rng.sym(0.6);
    const dipAt = Math.min(2, n - 3);             // interval index of the single dip, always followed by an up
    let deg = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        if (i - 1 === dipAt) deg -= 1; else deg += rng.chance(0.25 * m.a01) ? 2 : 1;
      }
      const p = base + PentatonicSnap.degree(deg, isMinor);
      const last = i === n - 1;
      const note = draftNote({ dur: last ? noteDur * 1.6 : noteDur, gap: m.gap * 0.7, start: p, end: last ? p + 1 : p });
      note.durRange = last ? [0.096, 0.18] : [0.06, 0.11];
      if (last) note.glideOnset = 0.5;
      note.slur = i > 0 && !last && rng.chance(0.3);
      note.cutoffDelta = 0.05;
      note.vowelDelta = 0.1;
      d.notes.push(note);
    }
    return d;
  },

  // One 350–550 ms falling −5…−8 st gesture with a 0↔+1.5 st trill (11–14 Hz), 30 % tremolo, quiet, fading.
  embarrassed(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ durJitter: 0.5, gainOffsetDB: -1.8 });
    const start = 0.5 * m.register + 2 + rng.sym(0.6);
    const fall = vLerp(5, 8, 0.5 * rng.unit() + 0.5 * (1 - m.p01));
    const n = draftNote({ dur: dur(0.55, 0.35, m, rng), start, end: start - fall });
    n.durRange = [0.35, 0.55];
    n.glideOnset = 0.1;
    n.glideEase = 0.4;
    n.trillDepth = 1.5;
    n.trillRate = rng.range(11, 14);
    n.tremolo = 0.3;
    n.tremoloRate = n.trillRate;
    n.attackTau = Math.max(m.attackTau, 0.012);
    n.release = 0.12;
    n.cutoffDelta = -0.05;
    n.wobbleDepth = 0;
    d.notes = [n];
    return d;
  },

  // "eep" at +7…+10 st from base with a −1 st overshoot settling in ~25 ms; optional "-uh" falling tail.
  startled(m: M, fp: VoiceFingerprint, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ pitchJitter: 0.5, gainOffsetDB: 3 });
    const eep = rng.range(7, 10);               // measured from base, not register (review H2)
    const n1 = draftNote({ dur: dur(0.14, 0.08, m, rng), gap: 0, start: eep, end: eep });
    n1.durRange = [0.08, 0.14];
    n1.scoop = -1;
    n1.scoopTau = 0.009;
    n1.attackTau = 0.002;
    n1.fmIndexPeak = 4 * fp.fmIndexPeak / 3;
    n1.noiseBurst = 6;                        // +6 dB onset burst (3 → 6)
    n1.articulationBoost = 0.3;
    n1.cutoffDelta = 0.1;
    n1.wobbleDepth = 0;
    n1.accent = true;
    d.notes = [n1];
    if (rng.chance(0.55)) {
      const tail = draftNote({ dur: 0.12, start: eep - 4, end: eep - 6 });
      tail.slur = true;
      tail.gainDB = -8;
      tail.release = 0.08;
      tail.wobbleDepth = 0;
      tail.durRange = [0.1, 0.14];
      d.notes.push(tail);
    }
    return d;
  },

  // 150 ms rising breath inhale, then a slow exponential tonal fall (450–800 ms total), filter closing,
  // "oo"→"ah". The fall uses the contour's scoop term (negative = starts above) with τ = 0.35·dur.
  sleepy(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ stretchLast: true, durJitter: 0, gainOffsetDB: -2 });
    const r0 = 0.4 * m.register + 1 + rng.sym(0.5);
    const inhale = draftNote({ dur: 0.15, gap: rng.range(0.025, 0.04), start: r0 - 1, end: r0 + 1 });
    inhale.noiseOnly = true;
    inhale.gainDB = -14;
    inhale.scoop = 0;
    inhale.wobbleDepth = 0;
    inhale.droop = 0;
    inhale.attackTau = 0.05;
    inhale.release = 0.05;
    const total = vLerp(0.8, 0.45, vClamp01(m.speed01 + rng.sym(0.15)));
    const fallDur = vClamp(total - 0.15 - inhale.gap * 1.3, 0.28, 0.65);
    const fall = rng.range(5, 9);
    const target = r0 - fall;
    const sigh = draftNote({ dur: fallDur, start: target, end: target });
    sigh.scoop = -fall;
    sigh.scoopTau = 0.35 * fallDur;
    sigh.vowelStart = vClamp01(m.vowel - 0.4);      // "oo" …
    sigh.vowelEnd = vClamp01(m.vowel - 0.1);        // … → "ah"
    sigh.filterEnvTau = 0.35 * fallDur;
    sigh.cutoffDelta = -0.3;
    sigh.vibratoRate = 4.5;
    sigh.attackTau = Math.max(m.attackTau, 0.03);
    sigh.release = 0.12;
    sigh.wobbleDepth = 0;
    sigh.noiseDB = -20;
    d.notes = [inhale, sigh];
    return d;
  },

  // "uh-oh": 110–150 ms note with +0.5 st lift, hard 50–80 ms gap, 220–320 ms note −3…−4 st that droops
  // 1–2 st more with a 4 Hz 0.6 st wobble. Never ends rising.
  sheepish(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ stretchLast: true, durJitter: 0.5, gainOffsetDB: -1 });
    const p1 = 0.5 * m.register + 1 + rng.sym(0.5);
    const n1 = draftNote({ dur: dur(0.15, 0.11, m, rng), gap: rng.range(0.04, 0.0615), start: p1, end: p1 + 0.5 });
    n1.glideOnset = 0.3;
    n1.durRange = [0.11, 0.15];
    n1.wobbleDepth = 0;
    n1.droop = 0;
    const p2 = p1 + 0.5 - rng.range(3, 4);
    const n2 = draftNote({ dur: dur(0.32, 0.22, m, rng), start: p2, end: p2 });
    n2.durRange = [0.22, 0.32];
    n2.droop = rng.range(1, 2);
    n2.droopFraction = 0.6;
    n2.wobbleDepth = 0.6;
    n2.wobbleRate = 4;
    n2.accent = true;
    d.notes = [n1, n2];
    return d;
  },

  // Three quick "hee" chirps on the laugh one-shot's bounces (onsets relative to the first bounce).
  giggle(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ endsRising: false, fixedTiming: true, pitchJitter: 0.6 });
    const base = 0.6 * m.register + 2 + rng.sym(0.6);
    const shape = rng.pick([[2, 3, 1], [2, 4, 1], [3, 2, 0], [1, 3, 2]]);
    shape.forEach((off, i) => {
      const p = base + off;
      const n = draftNote({ dur: rng.range(0.06, 0.09), start: p, end: p - rng.range(1, 2) });
      n.onset = ReactionTemplates.giggleBounces[i] - ReactionTemplates.giggleBounces[0];
      n.durRange = [0.05, 0.1];
      n.vowelDelta = 0.25;
      n.cutoffDelta = 0.08;
      n.accent = true;
      n.wobbleDepth = 0;
      n.droop = 0;
      d.notes.push(n);
    });
    return d;
  },

  // Mock offense: low–HIGH–low slurred huff, firm attack, a little breath.
  hmph(m: M, _fp: VoiceFingerprint, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ pitchJitter: 0.6, gainOffsetDB: 1 });
    const low = 0.4 * m.register - 2 + rng.sym(0.5);
    const n1 = draftNote({ dur: dur(0.11, 0.08, m, rng), gap: 0, start: low, end: low });
    n1.durRange = [0.08, 0.11];
    n1.attackTau = Math.min(m.attackTau, 0.004);
    n1.noiseDB = -18;
    n1.noiseBurst = 4.5;
    const high = low + vLerp(3, 6, vClamp01(m.a01 + rng.sym(0.2)));
    const n2 = draftNote({ dur: dur(0.12, 0.09, m, rng), gap: 0, start: high, end: high });
    n2.slur = true;
    n2.durRange = [0.09, 0.12];
    n2.accent = true;
    n2.noiseDB = -20;
    const n3 = draftNote({ dur: dur(0.2, 0.14, m, rng), start: low - 0.5, end: low - 2.5 });
    n3.slur = true;
    n3.durRange = [0.14, 0.2];
    n3.noiseDB = -18;
    const notes = [n1, n2, n3];
    for (const x of notes) {
      x.articulationBoost = 0.2;
      x.cutoffDelta = -0.02;
      x.wobbleDepth = 0;
    }
    notes[2].droop = rng.range(0.5, 1);
    d.notes = notes;
    return d;
  },

  // "hm?" (short, small rise) … pause … "huh!" (sharp, higher, firm).
  doubleTake(m: M, fp: VoiceFingerprint, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ pitchJitter: 0.6, gainOffsetDB: 1 });
    const p = 0.5 * m.register + rng.sym(0.6);
    const hm = draftNote({ dur: dur(0.13, 0.09, m, rng), gap: rng.range(0.18, 0.26), start: p, end: p + 2 });
    hm.durRange = [0.09, 0.13];
    hm.glideOnset = 0.4;
    hm.gainDB = -2;
    hm.attackTau = Math.max(m.attackTau, 0.008);
    hm.vowelStart = vClamp01(m.vowel - 0.35);
    hm.vowelEnd = vClamp01(m.vowel - 0.25);
    hm.wobbleDepth = 0;
    hm.droop = 0;
    const top = p + rng.range(4, 6);
    const huh = draftNote({ dur: dur(0.14, 0.1, m, rng), start: top, end: top });
    huh.durRange = [0.1, 0.14];
    huh.attackTau = 0.003;
    huh.articulationBoost = 0.3;
    huh.fmIndexPeak = 4 * fp.fmIndexPeak / 3;
    huh.noiseBurst = 4.5;
    huh.cutoffDelta = 0.08;
    huh.wobbleDepth = 0;
    huh.accent = true;
    d.notes = [hm, huh];
    return d;
  },

  // Questioning wobble ending up: 2–3 notes, a dip, then a long wobbly rise.
  confused(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ question: true, endsRising: true });
    const n = rng.chance(0.5) ? 3 : 2;
    let p = 0.5 * m.register + rng.sym(0.6);
    const wob = Math.max(m.wobbleDepth, 0.5);
    for (let k = 0; k < n - 1; k++) {
      const note = draftNote({ dur: dur(0.16, 0.1, m, rng), gap: m.gap, start: p, end: p - 0.5 });
      note.wobbleDepth = wob;
      note.wobbleRate = vLerp(3, 4.5, m.a01);
      d.notes.push(note);
      p -= rng.range(1, 2);
    }
    const rise = vLerp(3, 5, vClamp01(1 - m.d01 + rng.sym(0.2)));
    const last = draftNote({ dur: dur(0.3, 0.2, m, rng), start: p, end: p + rise });
    last.glideOnset = 0.4;
    last.wobbleDepth = Math.max(wob, 0.7);
    last.wobbleRate = vLerp(3, 4.5, m.a01);
    last.accent = true;
    d.notes.push(last);
    return d;
  },

  // Four short chirps on 0.5 s beats.
  danceBeat(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ fixedTiming: true, pitchJitter: 0.5 });
    const base = 0.5 * m.register + rng.sym(0.6);
    const pattern = rng.pick([[0, 5, 3, 7], [0, 4, 7, 4], [0, 7, 5, 9], [0, 3, 5, 3], [0, 4, 2, 7]]);
    pattern.forEach((off, i) => {
      const p = base + off;
      const lift = i % 2 === 1 ? 0.8 : 0;
      const n = draftNote({ dur: rng.range(0.07, 0.1), start: p, end: p + lift });
      n.onset = i * ReactionTemplates.danceBeatPeriod;
      n.durRange = [0.06, 0.11];
      n.accent = true;
      n.wobbleDepth = 0;
      n.cutoffDelta = 0.04;
      d.notes.push(n);
    });
    return d;
  },

  // Free phrase straight from affect.
  emote(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ swing: true });
    const n = Math.trunc(vClamp(roundSchool(m.noteCount + rng.sym(1)), 1, 8));
    const question = rng.chance(m.questionChance);
    const upP = 0.5 + 0.3 * m.pleasure;
    let pitch = m.register + rng.sym(1);
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      if (i > 0) pitch += (rng.chance(upP) ? 1 : -1) * m.intervalWidth * rng.range(0.5, 1);
      const trend = n > 1 ? m.phraseTrend * i / (n - 1) - m.phraseTrend / 2 : 0;
      const s = pitch + trend;
      let glide: number;
      if (last) {
        glide = question ? rng.range(3, 6) : 2 * m.glideBias + rng.sym(1);   // big glides on the final note
      } else {
        glide = rng.sign() * rng.range(0.5, 1.5) * 0.6 + m.glideBias;
      }
      const du = m.noteDuration * (last ? rng.range(1.0, 1.4) : rng.range(0.9, 1.1));
      const note = draftNote({ dur: du, gap: m.gap, start: s, end: s + glide });
      if (last && question) { note.glideOnset = 0.35; note.glideEase = 0.5; }
      note.slur = i > 0 && !question && rng.chance(0.15);
      d.notes.push(note);
      if (last) d.endsRising = question || glide > 1;
    }
    d.question = question;
    return d;
  },

  // MARK: Answers

  // "mm-hm!": a soft closed "mm" (90–120 ms, small lift) on the first bob, then a brighter "hm!" 4–5 st higher with
  // a little upward flick on the second. Big ("mm-HM!"): shorter first note, a 7–9 st leap to a longer, brighter,
  // louder second note on the second bob. Ends rising, never a question.
  mmHm(m: M, big: boolean, rng: VoiceRNG): DraftPhrase {
    const acc = big ? ReactionTemplates.nodYesBigAccents : ReactionTemplates.nodYesAccents;
    const d = draftPhrase({ endsRising: true, fixedTiming: true, pitchJitter: 0.5, gainOffsetDB: big ? 1.5 : 0.5 });
    const base = 0.5 * m.register + (big ? 1 : 0) + rng.sym(0.5);
    const mm = draftNote({ dur: big ? rng.range(0.08, 0.1) : rng.range(0.09, 0.12), start: base, end: base + 0.5 });
    mm.durRange = big ? [0.075, 0.11] : [0.085, 0.125];
    mm.glideOnset = 0.3;
    mm.gainDB = big ? -2 : -3;
    mm.attackTau = Math.max(m.attackTau, 0.008);     // a hummed onset
    mm.vowelDelta = -0.3;                             // closed, "mm"
    mm.cutoffDelta = -0.05;
    mm.wobbleDepth = 0;
    mm.droop = 0;
    const leap = big ? (rng.chance(0.3 + 0.4 * m.a01) ? 9 : 7) : (rng.chance(0.5) ? 5 : 4);
    const top = base + leap;
    const hm = draftNote({ dur: big ? rng.range(0.13, 0.17) : rng.range(0.1, 0.13), start: top, end: top + (big ? 1.2 : 1.0) });
    hm.durRange = big ? [0.12, 0.18] : [0.095, 0.14];
    hm.onset = acc[1] - acc[0];
    hm.glideOnset = 0.45;
    hm.glideEase = 0.5;
    hm.articulationBoost = big ? 0.25 : 0.15;
    hm.cutoffDelta = big ? 0.12 : 0.08;
    hm.vowelDelta = 0.15;                             // opens toward "ee"
    hm.wobbleDepth = 0;
    hm.droop = 0;
    hm.accent = true;
    d.notes = [mm, hm];
    return d;
  },

  // "uh-uh": two short level-ish "uh"s on the first two swings, the second 3–4 st lower and sliding down a little
  // more. Gentle: soft attack, mid register, never rising.
  uhUh(m: M, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ fixedTiming: true, pitchJitter: 0.5, gainOffsetDB: 0 });
    const p1 = 0.5 * m.register + 1 + rng.sym(0.5);
    const n1 = draftNote({ dur: rng.range(0.09, 0.12), start: p1, end: p1 - 0.4 });
    n1.durRange = [0.085, 0.125];
    n1.vowelDelta = -0.1;
    n1.wobbleDepth = 0;
    n1.droop = 0;
    n1.accent = true;
    const p2 = p1 - rng.range(3, 4);
    const n2 = draftNote({ dur: rng.range(0.13, 0.17), start: p2, end: p2 - 1 });
    n2.durRange = [0.12, 0.18];
    n2.onset = ReactionTemplates.shakeNoAccents[1] - ReactionTemplates.shakeNoAccents[0];
    n2.glideOnset = 0.3;
    n2.scoop = 0;                                // a step down, not a scoop up into it
    n2.vowelDelta = -0.1;
    n2.wobbleDepth = 0;
    n2.droop = rng.range(0.3, 0.6);
    n2.accent = true;
    d.notes = [n1, n2];
    return d;
  },

  // "nuh-uh": lower and firmer. A clipped "nuh" (80–110 ms, firm attack, a breath of consonant) with a small lift,
  // then a longer "uh!" 4–5 st below, falling with a droop, firm and a little louder.
  nuhUh(m: M, _fp: VoiceFingerprint, rng: VoiceRNG): DraftPhrase {
    const d = draftPhrase({ fixedTiming: true, pitchJitter: 0.5, gainOffsetDB: 1 });
    const p1 = 0.4 * m.register - 0.5 + rng.sym(0.4);
    const nuh = draftNote({ dur: rng.range(0.08, 0.11), start: p1, end: p1 + 0.6 });
    nuh.durRange = [0.075, 0.115];
    nuh.glideOnset = 0.4;
    nuh.attackTau = Math.min(m.attackTau, 0.004);
    nuh.articulationBoost = 0.25;
    nuh.noiseBurst = 3;
    nuh.vowelDelta = -0.15;
    nuh.wobbleDepth = 0;
    nuh.droop = 0;
    nuh.accent = true;
    const p2 = p1 - rng.range(4, 5);
    const uh = draftNote({ dur: rng.range(0.16, 0.21), start: p2, end: p2 - 1.5 });
    uh.durRange = [0.15, 0.22];
    uh.onset = ReactionTemplates.shakeNoBigAccents[1] - ReactionTemplates.shakeNoBigAccents[0];
    uh.glideOnset = 0.35;
    uh.scoop = 0;
    uh.attackTau = Math.min(m.attackTau, 0.004);
    uh.articulationBoost = 0.25;
    uh.noiseDB = -20;
    uh.vowelDelta = -0.1;
    uh.wobbleDepth = 0;
    uh.droop = rng.range(0.5, 1);
    uh.accent = true;
    d.notes = [nuh, uh];
    return d;
  },
};
