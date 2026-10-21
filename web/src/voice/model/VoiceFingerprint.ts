// Port of FaceVoice/Model/VoiceFingerprint.swift.
import bundledJSON from './default-fingerprint.json';

/// Yanni's vocal identity. Emotions vary phrases around it so it always sounds like the same creature.
/// Defaults are starting points; the bundled `default-fingerprint.json` is the source of truth at runtime.
export class VoiceFingerprint {
  /// Base pitch in Hz (all note pitches are semitones relative to it).
  basePitchHz = 660;
  /// Maximum excursion either side of base (semitones); phrases are fitted into it, not clamped per note.
  rangeSemitones = 12;
  /// Hard cap on the highest fundamental (Hz) to avoid shrillness on small speakers.
  maxPitchHz = 1600;
  /// Default tone colour.
  sine = 0.4;
  square = 0;
  fm = 0.6;
  fmRatio = 1;
  fmIndexPeak = 3;
  fmIndexSustain = 0.8;
  /// Filter openness 0…1 at neutral affect.
  brightness = 0.6;
  /// Formant amount 0…1 and neutral vowel 0 ("oo")…1 ("ee").
  formantAmount = 0.5;
  vowel = 0.5;
  /// Breath noise level (dB relative to tone).
  breathDB = -26;
  /// Glide easing 0 (linear)…1 (eased).
  glideEase = 0.6;
  /// Onset scoop depth (semitones) at neutral affect.
  scoop = 1.2;
  /// Character vibrato.
  vibratoRateHz = 6.2;
  vibratoDepthSemitones = 0.2;
  /// 0…1 pull of intervals toward the pentatonic scale (major for P ≥ 0, minor for P < 0).
  scaleSnap = 0.6;
  /// Overall level 0…1 before volume settings.
  loudness = 0.7;

  static readonly keys = [
    'basePitchHz', 'rangeSemitones', 'maxPitchHz', 'sine', 'square', 'fm', 'fmRatio', 'fmIndexPeak', 'fmIndexSustain',
    'brightness', 'formantAmount', 'vowel', 'breathDB', 'glideEase', 'scoop', 'vibratoRateHz', 'vibratoDepthSemitones',
    'scaleSnap', 'loudness',
  ] as const;

  static get default(): VoiceFingerprint { return new VoiceFingerprint(); }

  /// Decodes JSON like Swift's `JSONDecoder`: every key is required and numeric, else nil.
  static decode(o: unknown): VoiceFingerprint | null {
    if (typeof o !== 'object' || o === null) return null;
    const fp = new VoiceFingerprint();
    const rec = o as Record<string, unknown>;
    for (const k of VoiceFingerprint.keys) {
      const v = rec[k];
      if (typeof v !== 'number') return null;
      fp[k] = v;
    }
    return fp;
  }

  /// The bundled default fingerprint (falls back to compiled defaults).
  static bundled(): VoiceFingerprint { return VoiceFingerprint.decode(bundledJSON) ?? VoiceFingerprint.default; }

  copy(): VoiceFingerprint { return Object.assign(new VoiceFingerprint(), this); }

  equals(o: VoiceFingerprint): boolean { return VoiceFingerprint.keys.every((k) => this[k] === o[k]); }

  /// Pretty-printed, sorted keys (as the Swift encoder).
  json(): string {
    const out: Record<string, number> = {};
    for (const k of [...VoiceFingerprint.keys].sort()) out[k] = this[k];
    return JSON.stringify(out, null, 2);
  }
}
