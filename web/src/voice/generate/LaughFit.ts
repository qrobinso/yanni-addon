// Port of FaceVoice/Generate/LaughFit.swift (`PhraseGenerator.makeLaughFit` lives in PhraseGenerator.ts).
import type { VoiceFingerprint } from '../model/VoiceFingerprint';
import type { PhraseParams } from './EmotionMapping';
import { draftNote, draftPhrase, type DraftNote, type DraftPhrase } from './ReactionTemplates';
import { roundSchool, vClamp, vClamp01, vLerp, type VoiceRNG } from './VoiceRNG';

/// One phrase of the tickle's laugh fit (`VoiceDirector` chains them back to back).
export type LaughFitPart =
  /// A giggle while the scratch goes on.
  | 'laugh'
  /// A small trailing "hehe" after the scratch stops.
  | 'hehe'
  /// The happy settle sigh that ends the fit.
  | 'sigh';

/// Laugh-fit phrase templates. `e` (energy 0…1) sets everything that makes a fit build, peak and tire: register, note
/// count, tempo, loudness, brightness and breath (low energy is breathier, darker, softer and slower).
export const LaughFitTemplates = {
  /// Laugh templates: "he-he-he", "a-ha-ha", the high "hee-HEE" squeal, a gasp into giggles, the quick "tee-hee".
  laughCount: 5,

  /// A laugh template, never `last`; the squeal and the gasp belong to the peak, "tee-hee" to the calm end.
  pick(e: number, last: number, rng: VoiceRNG): number {
    const w = [1, 0.9, 0.15 + 0.9 * e * e, 0.1 + 0.6 * e, 0.25 + 0.6 * (1 - e)];
    let total = 0;
    for (let i = 0; i < 5; i++) if (i !== last) total += w[i];
    let r = rng.unit() * total;
    for (let i = 0; i < 5; i++) {
      if (i === last) continue;
      r -= w[i];
      if (r < 0) return i;
    }
    return last === 0 ? 1 : 0;
  },

  draft(part: LaughFitPart, t: number, energy: number, m: PhraseParams, fp: VoiceFingerprint, rng: VoiceRNG): DraftPhrase {
    const e = vClamp01(energy);
    const d = draftPhrase({ endsRising: false, pitchJitter: 0.6 });
    const base = 0.6 * m.register + 2 + vLerp(-1, 2.5, e) + rng.sym(0.7);
    const len = vLerp(0.075, 0.055, e) * rng.range(0.9, 1.12);
    const gap = vLerp(0.075, 0.045, e) * rng.range(0.85, 1.2);
    const hee = (p: number, fall = 1.5, du: number | null = null): DraftNote => {
      const n = draftNote({ dur: du ?? len, gap: gap * rng.range(0.8, 1.25), start: p, end: p - fall * rng.range(0.6, 1.3) });
      n.durRange = [0.045, 0.16];
      n.vowelDelta = 0.25;
      n.wobbleDepth = 0;
      n.droop = 0;
      return n;
    };
    switch (part) {
      case 'laugh':
        d.gainOffsetDB = vLerp(-8, 1.5, e) + rng.sym(0.6);
        switch (t) {
          case 0: {   // "he-he-he-he": stepping down, often speeding up
            const n = Math.trunc(vClamp(roundSchool(vLerp(3, 6, e) + rng.sym(1)), 3, 7));
            let p = base + rng.range(0, 1.5);
            for (let k = 0; k < n; k++) { d.notes.push(hee(p)); p -= rng.range(0.4, 1.4); }
            d.tighten = rng.chance(0.6);
            break;
          }
          case 1: {   // "a-HA-ha-ha": open vowel, a lift on the second, then down
            const n = Math.trunc(vClamp(roundSchool(vLerp(3, 5, e) + rng.sym(1)), 3, 6));
            const lift = rng.range(1.5, 3);
            for (let i = 0; i < n; i++) {
              const p = base + (i === 1 ? lift : -Math.max(i - 1, 0) * rng.range(0.5, 1.2));
              const note = hee(p, 1, len * 1.25);
              note.vowelDelta = -0.15;
              d.notes.push(note);
            }
            d.swing = true;
            break;
          }
          case 2: {   // "hee-HEE(-hee)": the high squeal with a flutter
            const n = rng.chance(0.5) ? 2 : 3;
            for (let i = 0; i < n; i++) {
              const p = base + 2.5 + (i === 1 ? rng.range(1, 2.5) : -i * 0.8);
              const note = hee(p, rng.range(1.5, 3), rng.range(0.1, 0.15));
              note.tremolo = 0.25 * e;
              note.tremoloRate = rng.range(10, 13);
              note.glideOnset = 0.4;
              note.vowelDelta = 0.35;
              d.notes.push(note);
            }
            break;
          }
          case 3: {   // a gasp ("hih") into quick giggles
            const gasp = draftNote({ dur: rng.range(0.06, 0.09), gap: rng.range(0.03, 0.05), start: base, end: base + 2 });
            gasp.noiseOnly = true;
            gasp.gainDB = -11;
            gasp.attackTau = 0.02;
            gasp.release = 0.03;
            gasp.wobbleDepth = 0;
            gasp.droop = 0;
            d.notes.push(gasp);
            const n = Math.trunc(vClamp(roundSchool(vLerp(2, 5, e) + rng.sym(1)), 2, 6));
            let p = base + 1.5;
            for (let k = 0; k < n; k++) { d.notes.push(hee(p, 1.2)); p -= rng.range(0.3, 1.2); }
            d.tighten = true;
            break;
          }
          default: {  // "tee-HEE": low then higher, a soft little one
            d.notes.push(hee(base - 1, 0.5));
            const top = hee(base + rng.range(2, 3.5), rng.range(1.5, 2.5), len * 1.5);
            top.glideOnset = 0.35;
            d.notes.push(top);
            if (rng.chance(0.4)) d.notes.push(hee(base, 1));
          }
        }
        break;
      case 'hehe': {   // "he-he", small and low
        d.gainOffsetDB = vLerp(-12, -8, e) + rng.sym(0.8);
        const n = rng.chance(0.6) ? 2 : 3;
        let p = base - 1.5;
        for (let k = 0; k < n; k++) {
          const note = hee(p, 1, len * 0.9);
          note.gap = gap * 1.3;
          d.notes.push(note);
          p -= rng.range(0.5, 1.2);
        }
        d.stretchLast = true;
        break;
      }
      case 'sigh': {   // a happy "haah…": a little breath in, then a soft falling hum
        d.gainOffsetDB = -11 + rng.sym(0.8);
        const inhale = draftNote({ dur: rng.range(0.08, 0.11), gap: rng.range(0.03, 0.05), start: base - 1, end: base + 1 });
        inhale.noiseOnly = true;
        inhale.gainDB = -14;
        inhale.attackTau = 0.04;
        inhale.release = 0.04;
        inhale.wobbleDepth = 0;
        inhale.droop = 0;
        const top = base - 0.5 + rng.range(0, 1);
        const hum = draftNote({ dur: rng.range(0.26, 0.38), start: top, end: top - rng.range(2.5, 4) });
        hum.durRange = [0.24, 0.4];
        hum.glideOnset = 0.25;
        hum.glideEase = 0.5;
        hum.vowelStart = vClamp01(m.vowel + 0.15);
        hum.vowelEnd = vClamp01(m.vowel - 0.25);
        hum.cutoffDelta = -0.12;
        hum.attackTau = 0.03;
        hum.release = 0.14;
        hum.wobbleDepth = 0;
        d.notes = [inhale, hum];
        d.durJitter = 0.4;
        break;
      }
    }
    // Tired or calm: breathier, darker and softer onsets; at the peak: bright and crisp.
    for (const x of d.notes) {
      if (x.noiseOnly) continue;
      x.noiseDB = fp.breathDB + vLerp(12, 1, e);
      x.cutoffDelta += vLerp(-0.12, 0.08, e);
      if (x.attackTau === null) x.attackTau = vLerp(0.012, 0.004, e);
    }
    return d;
  },
};
