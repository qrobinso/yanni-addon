// Port of FaceVoice/Model/VoiceModel.swift.
// port-note: Swift keeps these BitwiseCopyable for the audio thread; here they are plain objects with copy()/equals()
// (value semantics are explicit: copy wherever the Swift relies on a copy).
import type { V3 } from '../../core/vec';
import { VocalContour } from '../../model';

/// Named vocal reactions. Each has its own shape; mood colours it.
export type VoiceReaction =
  | 'engaged'      // "bi-dup": short bright two-note slur, rising
  | 'curious'      // 2–3 notes ending on a long rising glide
  | 'delighted'    // fast bouncy pentatonic run, final flick
  | 'embarrassed'  // quiet falling trill gesture ("not for me")
  | 'startled'     // sharp "eep" with overshoot, optional falling tail
  | 'sleepy'       // breathy inhale then slow low falling sigh
  | 'sheepish'     // "uh-oh": lifted note, hard gap, drooping wobbly second note
  | 'giggle'       // laugh one-shot: chirps on the bounces
  | 'hmph'         // mock offense: low-high-low huff
  | 'doubleTake'   // "hm?… huh!"
  | 'confused'     // questioning wobble ending up
  | 'danceBeat'    // little chirps on the dance beats
  | 'emote'        // free phrase straight from affect
  | 'mmHm'         // "yes": bright rising two-note "mm-hm!" on the nod's bobs
  | 'mmHmBig'      // "absolutely yes": a bigger, brighter rising double chirp on the first two bobs
  | 'uhUh'         // "no": a falling two-tone "uh-uh" on the shake's first two swings
  | 'nuhUh'        // "absolutely not": a firmer, lower "nuh-uh" on the first two wide swings
  | 'babble';      // Yanni's own voice "saying" a reply: text-driven, speech-like phrases (`makeBabble`)

/// `VoiceReaction.allCases` in declaration order (raw values 0…17).
export const allVoiceReactions: readonly VoiceReaction[] = [
  'engaged', 'curious', 'delighted', 'embarrassed', 'startled', 'sleepy', 'sheepish', 'giggle', 'hmph', 'doubleTake',
  'confused', 'danceBeat', 'emote', 'mmHm', 'mmHmBig', 'uhUh', 'nuhUh', 'babble',
];

/// Pleasure / arousal / dominance snapshot the phrase is planned from (each -1…1).
export interface VoiceAffect { pleasure: number; arousal: number; dominance: number }
export const VoiceAffect = {
  make: (pleasure: number, arousal: number, dominance: number): VoiceAffect => ({ pleasure, arousal, dominance }),
  fromPAD: (pad: V3): VoiceAffect => ({ pleasure: pad.x, arousal: pad.y, dominance: pad.z }),
  get neutral(): VoiceAffect { return { pleasure: 0.2, arousal: 0.15, dominance: 0.1 }; },
  equals: (a: VoiceAffect, b: VoiceAffect): boolean =>
    a.pleasure === b.pleasure && a.arousal === b.arousal && a.dominance === b.dominance,
};

/// Tone colour of one note. Time-varying parts (FM index, filter) are described by start/settle values.
export interface Timbre {
  /// Mix weights (normalised by RMS at render): sine, PolyBLEP square, 2-operator FM.
  sine: number; square: number; fm: number;
  /// FM modulator ratio (1 = full harmonic series; 2/3 = hollow/robotic).
  fmRatio: number;
  /// FM index decays from `fmIndexPeak` to `fmIndexSustain` with time constant `fmIndexTau` (s).
  fmIndexPeak: number; fmIndexSustain: number; fmIndexTau: number;
  /// Low-pass openness 0…1 (mapped exponentially, clamped below 0.45·fs).
  cutoff: number;
  /// Filter envelope: cutoff starts this many octaves higher and settles with `filterEnvTau` (s).
  filterEnvOctaves: number; filterEnvTau: number;
  resonance: number;
  /// Breath noise level in dB relative to the tone (e.g. -26), and onset burst multiplier.
  noiseDB: number; noiseBurst: number;
  /// Noise high-pass (Hz) or band centre when `noiseBandPass` is true (sleepy sigh).
  noiseFreq: number; noiseBandPass: boolean;
  /// Formant "vowel" (0 = "oo", 1 = "ee") at note start and end; `formantAmount` 0 disables formants.
  vowelStart: number; vowelEnd: number; formantAmount: number;
}
export const makeTimbre = (o: Partial<Timbre> = {}): Timbre => ({
  sine: 0.4, square: 0, fm: 0.6, fmRatio: 1, fmIndexPeak: 3, fmIndexSustain: 0.8, fmIndexTau: 0.025, cutoff: 0.6,
  filterEnvOctaves: 1.5, filterEnvTau: 0.06, resonance: 0.2, noiseDB: -26, noiseBurst: 3, noiseFreq: 2000,
  noiseBandPass: false, vowelStart: 0.5, vowelEnd: 0.5, formantAmount: 0.5, ...o,
});

/// Amplitude envelope. Attack 1−e^(−t/τ); decay to `sustain` with τ = `decayFraction`·duration; exponential release.
export interface Envelope { attackTau: number; sustain: number; decayFraction: number; release: number }
export const makeEnvelope = (o: Partial<Envelope> = {}): Envelope =>
  ({ attackTau: 0.008, sustain: 0.75, decayFraction: 0.4, release: 0.06, ...o });

/// Vibrato (pitch) and tremolo (amplitude). Vibrato applies only to notes ≥ 160 ms.
export interface Modulation2 {
  vibratoDepth: number;   // semitones
  vibratoRate: number;    // Hz
  vibratoDelay: number;   // s
  vibratoFadeIn: number;  // s
  tremoloDepth: number;   // 0…1
  tremoloRate: number;    // Hz
}
export const makeModulation2 = (o: Partial<Modulation2> = {}): Modulation2 => ({
  vibratoDepth: 0.2, vibratoRate: 6.2, vibratoDelay: 0.06, vibratoFadeIn: 0.08, tremoloDepth: 0, tremoloRate: 12, ...o,
});

const shallowEq = <T extends object>(a: T, b: T): boolean => {
  for (const k in a) if (a[k] !== b[k]) return false;
  return true;
};

export interface NoteInit {
  start: number; duration: number; contour: VocalContour; timbre?: Timbre; envelope?: Envelope;
  modulation?: Modulation2; gain?: number; slur?: boolean; accent?: boolean;
}

export class Note {
  /// Onset in seconds from phrase start.
  start: number;
  /// Length in seconds.
  duration: number;
  contour: VocalContour;
  timbre: Timbre;
  envelope: Envelope;
  modulation: Modulation2;
  /// 0…1 relative level (before fingerprint loudness and volume).
  gain: number;
  /// Slurred into from the previous note: no re-attack; pitch glides from the previous end (20–35 ms) and
  /// level dips to ~0.35 for 15 ms. Non-slurred notes get a hard ~3 ms stop before them.
  slur: boolean;
  /// Accented note (face hop, slight level accent).
  accent: boolean;

  constructor(o: NoteInit) {
    this.start = o.start; this.duration = o.duration; this.contour = o.contour;
    this.timbre = o.timbre ?? makeTimbre(); this.envelope = o.envelope ?? makeEnvelope();
    this.modulation = o.modulation ?? makeModulation2(); this.gain = o.gain ?? 1;
    this.slur = o.slur ?? false; this.accent = o.accent ?? false;
  }

  static get silent(): Note { return new Note({ start: 0, duration: 0, contour: VocalContour.flat(0), gain: 0 }); }

  copy(): Note {
    return new Note({
      start: this.start, duration: this.duration, contour: this.contour.copy(), timbre: { ...this.timbre },
      envelope: { ...this.envelope }, modulation: { ...this.modulation }, gain: this.gain, slur: this.slur,
      accent: this.accent,
    });
  }

  equals(o: Note): boolean {
    return this.start === o.start && this.duration === o.duration && this.contour.equals(o.contour) &&
      shallowEq(this.timbre, o.timbre) && shallowEq(this.envelope, o.envelope) &&
      shallowEq(this.modulation, o.modulation) && this.gain === o.gain && this.slur === o.slur &&
      this.accent === o.accent;
  }
}

/// Up to 8 notes stored inline. port-note: a plain array here; `NoteBuffer.append` keeps the capacity rule.
export const NoteBuffer = {
  capacity: 8,
  /// Appends if there is room; returns false when full.
  append(notes: Note[], n: Note): boolean {
    if (notes.length >= NoteBuffer.capacity) return false;
    notes.push(n);
    return true;
  },
  equals(a: readonly Note[], b: readonly Note[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!a[i].equals(b[i])) return false;
    return true;
  },
};

/// A planned vocalization: plain data, handed to the synth and mirrored to the face as cues.
export class Phrase {
  notes: Note[] = [];
  reaction: VoiceReaction = 'emote';
  affect: VoiceAffect = VoiceAffect.neutral;
  /// Monotonic id assigned by the director (used to match "phrase started" reports).
  id = 0;

  /// End of the last note including its release.
  get duration(): number {
    let end = 0;
    for (const n of this.notes) end = Math.max(end, n.start + n.duration + n.envelope.release);
    return end;
  }

  copy(): Phrase {
    const p = new Phrase();
    p.notes = this.notes.map((n) => n.copy());
    p.reaction = this.reaction; p.affect = { ...this.affect }; p.id = this.id;
    return p;
  }

  equals(o: Phrase): boolean {
    return NoteBuffer.equals(this.notes, o.notes) && this.reaction === o.reaction &&
      VoiceAffect.equals(this.affect, o.affect) && this.id === o.id;
  }
}
