// Port of FaceVoice/Generate/PhraseGenerator.swift (+ the `makeBabble` / `makeLaughFit` extensions, which live in
// PhraseGenerator+Babble.ts and LaughFit.ts and are forwarded from here).
import { VoiceFingerprint } from '../model/VoiceFingerprint';
import { Phrase, type Note, type VoiceAffect, type VoiceReaction } from '../model/VoiceModel';
import type { BabblePlan, BabbleRequest } from './BabbleShaping';
import { EmotionMapping, type PhraseParams } from './EmotionMapping';
import { LaughFitTemplates, type LaughFitPart } from './LaughFit';
import { Novelty, NoveltyTracker } from './Novelty';
import { makeBabble } from './PhraseGenerator+Babble';
import { PhraseShaping } from './PhraseShaping';
import { ReactionTemplates, type DraftPhrase } from './ReactionTemplates';
import { VoiceRNG } from './VoiceRNG';

/// Plans phrases from affect + reaction + fingerprint. Pure apart from its own seeded RNG (never the face's).
/// Deterministic per seed: two generators with the same seed and calls produce identical phrases.
/// port-note: a Swift value type; `copy()` where the Swift copies it.
export class PhraseGenerator {
  fingerprint: VoiceFingerprint;
  rng: VoiceRNG;
  novelty = new NoveltyTracker();
  /// The laugh fit's last template (never the same twice in a row, `LaughFit.ts`).
  lastLaughTemplate = -1;
  /// Mixed into every babble seed, so a new generator seed changes the babble too (`makeBabble`).
  readonly babbleSalt: bigint;

  constructor(fingerprint: VoiceFingerprint = VoiceFingerprint.bundled(), seed: bigint | number = 0x564f494345n) {
    this.fingerprint = fingerprint;
    this.rng = new VoiceRNG(seed);
    this.babbleSalt = BigInt.asUintN(64, BigInt(seed));
  }

  /// The phrase-level targets for an affect (for the tuning panel read-out).
  parameters(affect: VoiceAffect): PhraseParams { return EmotionMapping.parameters(affect, this.fingerprint); }

  /// Plans one phrase. Every call differs; consecutive phrases of the same kind are never near-identical:
  /// up to 3 re-rolls, then a class-respecting perturbation (small register / timing shifts).
  make(reaction: VoiceReaction, affect: VoiceAffect): Phrase {
    const m = EmotionMapping.parameters(affect, this.fingerprint);
    const fp = this.fingerprint;
    return this.novelPhrase(reaction, affect, m, (rng) => ReactionTemplates.draft(reaction, m, fp, rng));
  }

  /// Realizes drafts until one is far enough from the recent phrases of its kind (up to 4 tries, then a perturbation).
  novelPhrase(reaction: VoiceReaction, affect: VoiceAffect, m: PhraseParams,
    makeDraft: (rng: VoiceRNG) => DraftPhrase): Phrase {
    let best: Note[] = [];
    let bestScore = -Infinity;
    let fixedTiming = false;
    for (let k = 0; k < 4; k++) {
      const draft = makeDraft(this.rng);
      fixedTiming = draft.fixedTiming;
      const notes = PhraseShaping.realize(draft, m, this.fingerprint, this.rng);
      const s = this.novelty.score(notes, reaction);
      if (s > bestScore) { best = notes; bestScore = s; }
      if (s >= Novelty.threshold) break;
    }
    if (bestScore < Novelty.threshold) best = this.perturb(best, reaction, fixedTiming);
    this.novelty.record(best, reaction);

    const p = new Phrase();
    p.reaction = reaction;
    p.affect = { ...affect };
    for (const n of best) if (p.notes.length < 8) p.notes.push(n);
    return p;
  }

  perturb(notes: readonly Note[], reaction: VoiceReaction, fixedTiming: boolean): Note[] {
    const small = reaction === 'startled' || reaction === 'engaged';
    const shifts = small ? [-1, -0.6, 0.6, 1] : [-1.5, -0.8, 0.8, 1.5];
    const scales = fixedTiming ? [1] : (small ? [0.94, 1.06] : [0.92, 1.08]);
    let best: Note[] = notes.map((n) => n.copy()), bestScore = -Infinity;
    for (const sh of shifts) {
      for (const k of scales) {
        const c = PhraseShaping.shiftAndStretch(notes, sh, k, this.fingerprint);
        const s = this.novelty.score(c, reaction);
        if (s > bestScore) { bestScore = s; best = c; }
      }
    }
    return best;
  }

  /// See `PhraseGenerator+Babble.ts`.
  makeBabble(req: BabbleRequest): BabblePlan { return makeBabble(this, req); }

  /// One laugh-fit phrase (reaction `.giggle`). `energy` 0…1 is the fit's current strength (scratch intensity ×
  /// build-up × fatigue): it moves the register, length, tempo, loudness and breathiness. Laughs never repeat their
  /// template twice in a row and pass the usual novelty check.
  makeLaughFit(part: LaughFitPart, energy: number, affect: VoiceAffect): Phrase {
    const m = EmotionMapping.parameters(affect, this.fingerprint);
    const fp = this.fingerprint;
    let t = 0;
    if (part === 'laugh') {
      t = LaughFitTemplates.pick(energy, this.lastLaughTemplate, this.rng);
      this.lastLaughTemplate = t;
    }
    return this.novelPhrase('giggle', affect, m, (rng) => LaughFitTemplates.draft(part, t, energy, m, fp, rng));
  }

  /// A value copy (Swift struct semantics).
  copy(): PhraseGenerator {
    const g = new PhraseGenerator(this.fingerprint.copy(), this.babbleSalt);
    g.rng = this.rng.copy();
    g.novelty = this.novelty.copy();
    g.lastLaughTemplate = this.lastLaughTemplate;
    return g;
  }

  /// Index of the note whose onset should land on the paired one-shot's first accent.
  static alignNoteIndex(phrase: Phrase): number { return PhraseGenerator.alignNoteIndexFor(phrase.reaction, phrase.notes.length); }

  static alignNoteIndexFor(reaction: VoiceReaction, n: number): number {
    if (n <= 0) return 0;
    switch (reaction) {
      case 'engaged': case 'doubleTake': case 'hmph': case 'sleepy': return Math.min(1, n - 1);   // the "dup", "huh!", peak, sigh
      case 'curious': return n - 1;                                          // the question note on the tilt
      default: return 0;
    }
  }
}

/// `Phrase.alignTime`: onset (s from phrase start) of the alignment note.
export function phraseAlignTime(p: Phrase): number {
  return p.notes.length > 0 ? p.notes[PhraseGenerator.alignNoteIndex(p)].start : 0;
}
