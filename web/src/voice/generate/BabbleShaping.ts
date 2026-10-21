// Port of FaceVoice/Generate/BabbleShaping.swift (the melody half, `BabbleShaping+Melody.swift`, is merged in from
// BabbleShaping+Melody.ts).
import { NoteBuffer, type Phrase, type VoiceAffect, type VoiceReaction } from '../model/VoiceModel';
import { BabbleMelody } from './BabbleShaping+Melody';
import { clauseSyllables, type BabbleEnding, type BabbleSentence } from './SyllableCounter';
import { roundSchool, vClamp01, vLerp } from './VoiceRNG';

/// One reply chunk to babble in Yanni's voice (direct Home Assistant design §7.2).
export interface BabbleRequest {
  /// The chunk's text (one sentence or the first clause, usually; any text works).
  text: string;
  /// The affect it is voiced with: the chunk's tag PAD, or the current mood when the tag missed its deadline.
  affect: VoiceAffect;
  /// The reply's last chunk (its ending settles a little more).
  isLast: boolean;
  /// The answer chirp that opens the chunk for a confident stance (`mmHm`, `mmHmBig`, `uhUh`, `nuhUh`).
  answer: VoiceReaction | null;
  /// Seed of this chunk's babble (from the turn and chunk ids): the same text in another reply never repeats.
  seed: bigint;
  /// Longest a sentence may last (s), including its breath gaps and last release.
  sentenceCap: number;
  /// Seconds left in the reply: nothing in the chunk ends after it; sentences that don't fit are dropped.
  budget: number;
  /// Silence between the answer chirp's last note and the babble (s).
  answerGap: number;
}

export function makeBabbleRequest(o: Pick<BabbleRequest, 'text' | 'affect'> & Partial<BabbleRequest>): BabbleRequest {
  return { isLast: false, answer: null, seed: 0n, sentenceCap: 1.5, budget: 6, answerGap: 0.15, ...o };
}

export interface BabblePlanItem {
  phrase: Phrase;
  /// Onset of the phrase's first note, seconds from the plan's start.
  offset: number;
  /// Sentence index inside the chunk, or −1 for the answer chirp.
  sentence: number;
}

/// The phrases one chunk becomes, back to back on the chunk's own timeline (offsets in seconds from its first
/// phrase). With an answer, item 0 is the answer chirp.
export class BabblePlan {
  items: BabblePlanItem[] = [];
  answer: VoiceReaction | null = null;
  /// Syllables estimated for the voiced text, and for the whole chunk.
  syllables = 0;
  textSyllables = 0;
  /// Sentences voiced, and dropped because the reply's budget ran out.
  sentences = 0;
  droppedSentences = 0;
  /// Notes were dropped or the timing compressed to keep a cap.
  compressed = false;
  /// Each voiced sentence's length (first onset → last release), seconds.
  sentenceDurations: number[] = [];
  /// The breath the director leaves before the next chunk (a sentence gap, 250–350 ms by tempo).
  nextGap = 0.3;

  /// End of the last release, seconds from the plan's start.
  get duration(): number { return this.items.reduce((a, it) => Math.max(a, it.offset + it.phrase.duration), 0); }
  /// End of the last note (before its release): the next chunk's gap counts from here.
  get lastNoteEnd(): number {
    return this.items.reduce((r, it) => {
      let e = 0;
      for (const n of it.phrase.notes) e = Math.max(e, n.start + n.duration);
      return Math.max(r, it.offset + e);
    }, 0);
  }
  get noteCount(): number { return this.items.reduce((a, it) => a + it.phrase.notes.length, 0); }
  /// The babble's notes only (no answer chirp).
  get babbleNoteCount(): number {
    return this.items.filter((it) => it.sentence >= 0).reduce((a, it) => a + it.phrase.notes.length, 0);
  }
  get isEmpty(): boolean { return this.items.length === 0; }
}

export interface NoteSpec {
  /// Syllables the note carries (0.5 when one syllable is split into two notes, "yes" → "ye-es").
  syllables: number;
  /// Starts a word (else it continues the previous note's word).
  wordStart: boolean;
  /// Syllables of the word the note starts in (accent on long words).
  wordLength: number;
}

export type PhraseEnd = { kind: 'split' } | { kind: 'comma' } | { kind: 'sentence'; ending: BabbleEnding };
export const phraseEndEquals = (a: PhraseEnd, b: PhraseEnd): boolean =>
  a.kind === b.kind && (a.kind !== 'sentence' || a.ending === (b as { ending: BabbleEnding }).ending);

export interface PhraseSpec { notes: NoteSpec[]; end: PhraseEnd }

/// Text → babble layout (how many notes, which syllables each carries, where the breaths go). Melody lives in
/// `BabbleShaping+Melody`; realisation and caps in `PhraseGenerator.makeBabble`. Every number is a starting point.
const Layout = {
  /// Syllables per note: calm 2 (one note per two syllables) … excited 1.
  syllablesPerNote(a01: number): number { return vLerp(2.0, 1.0, vClamp01(a01)); },
  /// Notes a sentence gets before any cap: ceil(syllables / spn), at least 2.
  noteTarget(s: number, a01: number): number {
    // f32: the ceil sits right on an integer at round tempos (6 syllables at a01 0.8 → 5 notes in Float32, 6 in float64).
    const spn = Math.fround(Layout.syllablesPerNote(Math.fround(a01)));
    return Math.max(2, Math.ceil(Math.fround(Math.max(s, 1) / spn)));
  },
  /// Length of one syllable's note (s) by tempo (speed01 0 slow … 1 quick).
  syllableDuration(speed01: number): number { return vLerp(0.15, 0.085, vClamp01(speed01)); },
  /// A note carrying `k` syllables lasts this many syllable durations.
  lengthFactor(k: number): number { return k < 1 ? 0.75 : 1 + 0.6 * (k - 1); },
  /// Breath gaps (s) before tempo scaling.
  splitGap: [0.12, 0.22] as const,
  commaGap: [0.18, 0.26] as const,
  sentenceGap: [0.25, 0.35] as const,
  /// A sentence needs at least this much budget to be voiced (s).
  minSentence: 0.3,
  /// Timing never compresses below this factor before notes run out (then a hard fit keeps the cap).
  minTimeScale: 0.75,

  gapScale(speed01: number): number { return vLerp(1.1, 0.9, vClamp01(speed01)); },

  // MARK: Layout

  /// Lays a sentence out as phrases of ≤ 8 notes, about `target` notes in all (each clause gets at least one).
  layout(s: BabbleSentence, target: number): PhraseSpec[] {
    const counts = Layout.apportion(s.clauses.map(clauseSyllables), Math.max(target, 2), 1);
    const out: PhraseSpec[] = [];
    const cap = NoteBuffer.capacity;
    s.clauses.forEach((clause, ci) => {
      const notes = Layout.clauseNotes(clause.words, counts[ci]);
      const lastClause = ci === s.clauses.length - 1;
      const end: PhraseEnd = lastClause ? { kind: 'sentence', ending: s.ending } : (clause.endsWithComma ? { kind: 'comma' } : { kind: 'split' });
      const parts = Math.trunc((notes.length + cap - 1) / cap);
      const cuts: number[] = [0];
      for (let p = 1; p < Math.max(parts, 1); p++) {
        let c = Math.trunc((notes.length * p + Math.trunc(parts / 2)) / parts);
        // Prefer a word start within ±2 notes, never making a part longer than 8 notes.
        const lastCut = cuts[cuts.length - 1];
        const w = [0, 1, -1, 2, -2].map((x) => c + x).find((k) =>
          k > lastCut && k < notes.length && notes[k].wordStart && k - lastCut <= cap && notes.length - k <= cap * (parts - p));
        if (w !== undefined) c = w;
        cuts.push(c);
      }
      cuts.push(notes.length);
      for (let k = 0; k < cuts.length - 1; k++) {
        if (!(cuts[k + 1] > cuts[k])) continue;
        out.push({ notes: notes.slice(cuts[k], cuts[k + 1]), end: k === cuts.length - 2 ? end : { kind: 'split' } });
      }
    });
    return out;
  },

  /// Largest-remainder split of `total` notes over parts weighted by `weights`, each ≥ `minEach`.
  apportion(weights: readonly number[], total: number, minEach: number): number[] {
    const w = weights.map((x) => Math.max(x, 1));
    const sum = w.reduce((a, b) => a + b, 0);
    const exact = w.map((x) => total * x / sum);
    const counts = exact.map((x) => Math.max(minEach, Math.floor(x)));
    let left = total - counts.reduce((a, b) => a + b, 0);
    // Ties keep index order (Swift's sort and JS's are both stable in practice).
    const order = exact.map((_, i) => i).sort((a, b) => (exact[b] - Math.floor(exact[b])) - (exact[a] - Math.floor(exact[a])));
    let k = 0;
    while (left > 0 && order.length > 0) { counts[order[k % order.length]] += 1; left -= 1; k += 1; }
    return counts;
  },

  /// Splits a clause's syllables into `count` notes, note boundaries snapped to word boundaries where they can be.
  clauseNotes(words: readonly number[], n: number): NoteSpec[] {
    const s = words.reduce((a, b) => a + b, 0);
    if (!(s > 0 && n > 0)) return [];
    // Word containing each syllable, and the word starts.
    const wordOf: number[] = [];
    const starts = new Set<number>();
    words.forEach((w, wi) => { starts.add(wordOf.length); for (let k = 0; k < w; k++) wordOf.push(wi); });
    if (n > s) {
      // More notes than syllables (a one-syllable "Yes."): split the last syllable.
      const out: NoteSpec[] = [];
      for (let k = 0; k < s; k++) out.push({ syllables: 1, wordStart: starts.has(k), wordLength: words[wordOf[k]] });
      const extra = n - s + 1;
      out[s - 1].syllables = 1 / extra;
      for (let k = 1; k < extra; k++) out.push({ syllables: 1 / extra, wordStart: false, wordLength: words[wordOf[s - 1]] });
      return out;
    }
    const bounds = [0];
    for (let j = 1; j < n; j++) {
      let b = Math.trunc(roundSchool(j * s / n));
      const lastB = bounds[bounds.length - 1];
      if (!starts.has(b)) {
        if (starts.has(b - 1) && b - 1 > lastB) b -= 1; else if (starts.has(b + 1) && b + 1 < s - (n - 1 - j)) b += 1;
      }
      b = Math.min(Math.max(b, lastB + 1), s - (n - j));
      bounds.push(b);
    }
    bounds.push(s);
    const out: NoteSpec[] = [];
    for (let k = 0; k < n; k++) {
      const b = bounds[k];
      out.push({ syllables: bounds[k + 1] - b, wordStart: starts.has(b), wordLength: words[wordOf[b]] });
    }
    return out;
  },
};

export const BabbleShaping = { ...Layout, ...BabbleMelody };
