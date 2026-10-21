// Port of FaceVoice/Generate/EmotionMapping.swift.
import type { VoiceFingerprint } from '../model/VoiceFingerprint';
import type { VoiceAffect } from '../model/VoiceModel';
import { vClamp, vClamp01, vLerp } from './VoiceRNG';

/// Phrase-level targets derived from affect + fingerprint. Templates place their own parameters inside their
/// own ranges using the normalised values (`param = lerp(tmin, tmax, normalised)`), so a delighted chirp stays
/// delighted whatever the mood, while mood shades where inside its range it lands.
export interface PhraseParams {
  /// Raw affect, clamped to −1…1.
  pleasure: number; arousal: number; dominance: number;
  /// Affect normalised to 0…1.
  p01: number; a01: number; d01: number;
  /// 0 = slowest / longest notes, 1 = fastest / shortest (mostly arousal, a little pleasure).
  speed01: number;
  /// Free-phrase note count target (continuous; ±1 jitter, 1…8).
  noteCount: number;
  /// Free-phrase note length (s).
  noteDuration: number;
  /// Free-phrase gap between notes (s).
  gap: number;
  /// Long/short inter-onset ratio for bouncy rhythm (1 = straight, up to 1.6).
  swing: number;
  /// Register centre in semitones relative to the fingerprint base.
  register: number;
  /// Typical interval between notes (semitones).
  intervalWidth: number;
  /// Per-note glide bias (+1.5·P semitones) and phrase-level trend (+3·P semitones).
  glideBias: number; phraseTrend: number;
  /// Filter openness 0…1, vowel 0 "oo"…1 "ee".
  cutoff: number; vowel: number;
  /// Attack sharpness 0…1 (drives FM peak index and sustain level).
  articulation: number;
  fmIndexPeak: number; fmIndexSustain: number; attackTau: number; sustain: number; release: number;
  /// Phrase peak level in dB (before the reaction's offset). Spread between reactions stays ≤ 6 dB.
  gainDB: number;
  /// Irregular low-dominance wobble (applied to notes ≥ 100 ms).
  wobbleDepth: number; wobbleRate: number;
  /// Vibrato (applied only to notes ≥ 160 ms).
  vibratoDepth: number; vibratoRate: number;
  /// High arousal + low dominance: fast nervous vibrato.
  nervous: boolean;
  /// Default onset scoop depth (semitones below target).
  scoop: number;
  /// Probability of a rising question ending — honoured only by `.curious`, `.emote`, `.confused`.
  questionChance: number;
}

export const EmotionMapping = {
  /// Starting-point constants (see the voice design doc §5 and review H1–H4, M4).
  parameters(affect: VoiceAffect, fp: VoiceFingerprint): PhraseParams {
    const P = vClamp(affect.pleasure, -1, 1);
    const A = vClamp(affect.arousal, -1, 1);
    const D = vClamp(affect.dominance, -1, 1);
    const p01 = (P + 1) / 2, a01 = (A + 1) / 2, d01 = (D + 1) / 2;

    // Tempo: excited is quick, sad is longer.
    const longest = 0.24 * 1.2, shortest = 0.075 * 0.9;
    const noteDuration = vLerp(0.24, 0.075, a01) * vLerp(1.2, 0.9, p01);
    const speed01 = vClamp01((longest - noteDuration) / (longest - shortest));

    // Swing: straight at P ≤ 0, reaching 1.25 by P = 0.15 and 1.6 at P = 1.
    const swing = 1 + vClamp01(P / 0.15) * (0.25 + 0.35 * Math.max(P, 0));

    const cutoff = vClamp(fp.brightness + 0.3 * P + 0.1 * A, 0.08, 1);
    const articulation = vClamp01(0.55 * d01 + 0.45 * a01);

    const unsure = Math.max(-D, 0);
    const wobbleDepth = unsure >= 0.1 ? vLerp(0.4, 1.2, (unsure - 0.1) / 0.9) : 0;
    const nervous = A > 0.3 && D < -0.2;

    return {
      pleasure: P, arousal: A, dominance: D, p01, a01, d01, speed01,
      noteCount: vLerp(1.5, 6.5, a01),
      noteDuration,
      gap: vLerp(0.09, 0.025, a01),
      swing,
      register: vLerp(-3, 5, a01) + 2 * P,
      intervalWidth: vLerp(1.5, 7, a01),
      glideBias: 1.5 * P,
      phraseTrend: 3 * P,
      cutoff,
      vowel: vClamp01(fp.vowel + 0.3 * P),
      articulation,
      fmIndexPeak: vLerp(2.5, 4, articulation) * fp.fmIndexPeak / 3,
      fmIndexSustain: vLerp(0.6, 1.0, cutoff) * fp.fmIndexSustain / 0.8,
      attackTau: vLerp(0.014, 0.003, d01) * vLerp(1.25, 0.8, a01),
      sustain: vLerp(0.65, 0.8, articulation),
      release: vLerp(0.12, 0.04, 0.6 * a01 + 0.4 * d01),
      gainDB: -3.3 + vLerp(-3, 0, d01) + vLerp(-0.8, 0, a01),
      wobbleDepth,
      wobbleRate: vLerp(3, 4.5, a01),
      vibratoDepth: fp.vibratoDepthSemitones * vLerp(1.6, 0.6, d01),
      vibratoRate: nervous ? vLerp(8, 10, vClamp01((A - 0.3) / 0.7)) : fp.vibratoRateHz,
      nervous,
      scoop: vClamp(fp.scoop * (1 + 1.0 * unsure + 0.6 * Math.max(-P, 0)), 0.5, 3),
      questionChance: D < -0.2 ? Math.min(1, 0.1 + 0.9 * (-D - 0.2) / 0.8) : 0,
    };
  },
};
