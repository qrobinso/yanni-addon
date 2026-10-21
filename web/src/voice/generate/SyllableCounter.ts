// Port of FaceVoice/Generate/SyllableCounter.swift.
// port-note: Swift walks grapheme clusters (Character); this walks code points, which only differs for combining
// marks (an "e" + U+0301 counts the mark as a non-Latin letter here — babble needs no more than a rough count).

const isWS = (c: string): boolean => /\s/u.test(c);
const isLetter = (c: string): boolean => /\p{L}/u.test(c);
const isVowel = (c: string): boolean => c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u' || c === 'y';
/// Swift `.whitespaces` (no newlines) and `.whitespacesAndNewlines`.
const trimSpaces = (s: string): string => s.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '');
const trimAll = (s: string): string => s.replace(/^\s+|\s+$/gu, '');

/// A rough, deterministic, English-tuned syllable estimate (direct Home Assistant design §7.2). It never needs to be
/// right: babble compresses a reply, it doesn't transcribe it.
///
/// Per word: vowel groups (a e i o u y), minus a silent final "e" (not "-le" after a consonant), at least 1; digits
/// count 1 each; a token with no Latin letters or digits counts 1 per 3 characters.
export const SyllableCounter = {
  /// Syllables in a whole text (sum over its words).
  count(text: string): number {
    return BabbleText.words(text).reduce((a, w) => a + SyllableCounter.countWord(w), 0);
  },

  /// Syllables in one whitespace-free token.
  countWord(word: string): number {
    let letters = 0, digits = 0, others = 0, groups = 0;
    let inVowel = false;
    let last = ' ', beforeLast = ' ', third = ' ';
    for (const ch of word.toLowerCase()) {
      if (ch >= 'a' && ch <= 'z') {
        letters += 1;
        const v = isVowel(ch);
        if (v && !inVowel) groups += 1;
        inVowel = v;
        third = beforeLast;
        beforeLast = last;
        last = ch;
      } else if (ch >= '0' && ch <= '9') {
        digits += 1;
        inVowel = false;
      } else if (isLetter(ch)) {
        others += 1;      // accented or non-Latin letters
        inVowel = false;
      } else {
        inVowel = false;  // apostrophes, hyphens, symbols
      }
    }
    const div3 = (x: number): number => Math.trunc((x + 2) / 3);
    if (letters > 0) {
      // Silent final "e" ("make", "time"), but not "-le" after a consonant ("table") or "-ee" ("free").
      if (last === 'e' && groups > 1 && !isVowel(beforeLast) && beforeLast !== 'l') groups -= 1;
      // Silent "-ed" ("turned", not "wanted") and "-es" ("makes", not "boxes").
      if (groups > 1 && beforeLast === 'e' && !isVowel(third)) {
        if (last === 'd' && third !== 't' && third !== 'd') groups -= 1;
        if (last === 's' && !'sxzcgh'.includes(third)) groups -= 1;
      }
      return Math.max(1, groups) + digits + div3(others);
    }
    if (digits > 0) return digits + div3(others);
    return others > 0 ? Math.max(1, div3(others)) : 0;
  },
};

export type BabbleEnding =
  /// `.`, `…` or no punctuation: the usual final droop.
  | 'statement'
  /// `?`: a rising question glide on the last note.
  | 'question'
  /// `!`: a bright, accented final note.
  | 'exclamation';

export interface BabbleClause {
  /// Syllables of each word, in order (every word ≥ 1).
  words: number[];
  /// Ends at a comma (or `;`, `:`, a dash): the note before it lifts and a comma gap follows.
  endsWithComma: boolean;
}
export interface BabbleSentence { clauses: BabbleClause[]; ending: BabbleEnding }

export const clauseSyllables = (c: BabbleClause): number => c.words.reduce((a, b) => a + b, 0);
export const sentenceSyllables = (s: BabbleSentence): number => s.clauses.reduce((a, c) => a + clauseSyllables(c), 0);

const TRAIL = '.!?…,;:—–"\')]”’';

/// A reply chunk split for babble: sentences → clauses (comma, semicolon, colon, dash) → words with syllables.
export class BabbleText {
  sentences: BabbleSentence[];
  get syllables(): number { return this.sentences.reduce((a, s) => a + sentenceSyllables(s), 0); }

  /// Abbreviations whose period doesn't end a sentence.
  static readonly abbreviations = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'jr', 'sr', 'no']);

  constructor(text: string) {
    const sentences: BabbleSentence[] = [];
    let clauses: BabbleClause[] = [];
    let words: number[] = [];
    const chars = Array.from(text);
    let i = 0;
    const flushClause = (comma: boolean): void => {
      if (words.length > 0) clauses.push({ words, endsWithComma: comma });
      words = [];
    };
    const flushSentence = (e: BabbleEnding): void => {
      flushClause(false);
      if (clauses.length > 0) {
        clauses[clauses.length - 1].endsWithComma = false;
        sentences.push({ clauses, ending: e });
      }
      clauses = [];
    };
    while (i < chars.length) {
      // One whitespace-separated token.
      while (i < chars.length && isWS(chars[i])) i += 1;
      if (i >= chars.length) break;
      let j = i;
      while (j < chars.length && !isWS(chars[j])) j += 1;
      const token = chars.slice(i, j);
      i = j;
      let core = token;
      let trail = '';
      while (core.length > 0 && TRAIL.includes(core[core.length - 1])) {
        trail = core[core.length - 1] + trail;
        core = core.slice(0, -1);
      }
      const coreS = core.join('');
      if (coreS === '-' || coreS === '—' || coreS === '–') { flushClause(true); continue; }
      const syl = SyllableCounter.countWord(coreS);
      if (syl > 0) words.push(syl);
      const lower = coreS.toLowerCase().replace(/^["'([]+|["'([]+$/g, '');
      if (trail.includes('?')) flushSentence('question');
      else if (trail.includes('!')) flushSentence('exclamation');
      else if ((trail.includes('.') || trail.includes('…')) && !(trail.startsWith('.') && BabbleText.abbreviations.has(lower))) {
        flushSentence('statement');
      } else if (trail.includes(',') || trail.includes(';') || trail.includes(':') || trail.includes('—') || trail.includes('–')) {
        flushClause(true);
      }
    }
    flushSentence('statement');
    this.sentences = sentences;
  }

  /// Whitespace-separated words, stripped of surrounding punctuation (empty tokens dropped).
  static words(text: string): string[] {
    return text.split(/\s+/u).map((w) => w.replace(/^\p{P}+|\p{P}+$/gu, '')).filter((w) => w.length > 0);
  }

  /// The text's sentences as separate strings (the preview splits a typed reply into chunks with it).
  static sentenceStrings(text: string): string[] {
    const out: string[] = [];
    let cur = '';
    const chars = Array.from(text);
    for (let k = 0; k < chars.length; k++) {
      const c = chars[k];
      cur += c;
      const next = k + 1 < chars.length ? chars[k + 1] : null;
      if ('.!?…'.includes(c) && (next === null || isWS(next))) {
        const parts = cur.split(/\s+/u).filter((x) => x.length > 0);
        const last = parts.length > 0 ? parts[parts.length - 1].toLowerCase() : '';
        if (c === '.' && BabbleText.abbreviations.has(Array.from(last).slice(0, -1).join(''))) continue;
        const s = trimSpaces(cur);
        if (s.length > 0) out.push(s);
        cur = '';
      }
    }
    const rest = trimAll(cur);
    if (rest.length > 0) out.push(rest);
    return out;
  }
}
