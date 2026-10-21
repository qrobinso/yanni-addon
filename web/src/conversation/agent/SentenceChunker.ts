// Port of ConversationAgent/SentenceChunker.swift. Splits the streamed reply into voiceable chunks (design §6.6).
// Pure and incremental: `append` the text as it streams, `finish` at the end of the reply.
// - chunk 0 ends at the first clause break (`,` `;` `:` + space) after ≥ 4 words, or at the first sentence end;
// - later chunks end at sentence ends (`.` `!` `?` `…` followed by whitespace or the end of the reply), never after
//   common abbreviations or inside numbers (`3.5`);
// - a chunk longer than 220 characters breaks at its last comma or space;
// - each chunk is cleaned (markdown, emoji, URLs removed, whitespace collapsed); an empty chunk is dropped.
// port-note: Swift `Character`s are grapheme clusters; `Intl.Segmenter` gives the same units.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Grapheme clusters (Swift `Character`s). */
export const characters = (s: string): string[] => Array.from(segmenter.segment(s), (x) => x.segment);

const isWhitespace = (c: string): boolean => /^\s/u.test(c);
/** Swift `Character.isLetter || .isNumber`. */
export const isLetterOrNumber = (c: string): boolean => /^[\p{L}\p{N}]/u.test(c);

export class SentenceChunker {
  static readonly maxChunk = 220;
  static readonly terminators = new Set(['.', '!', '?', '…']);
  static readonly clauseBreaks = new Set([',', ';', ':']);
  static readonly closers = new Set(['.', '!', '?', '…', '"', "'", '”', '’', ')', ']', '*', '_', '`']);
  static readonly abbreviations = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'e.g', 'i.e', 'jr', 'sr', 'prof', 'no']);

  private buffer: string[] = [];
  emittedChunks = 0;

  /** Appends streamed text; returns the chunks it completed. */
  append(text: string): string[] {
    this.buffer.push(...characters(text));
    return this.drain(false);
  }

  /** The end of the reply: everything left, chunked. */
  finish(): string[] { return this.drain(true); }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const cut = SentenceChunker.findBreak(this.buffer, final, this.emittedChunks === 0 && out.length === 0);
      if (cut === null) break;
      const raw = this.buffer.slice(0, cut).join('');
      this.buffer.splice(0, cut);
      const cleaned = ReplyTextCleaner.clean(raw);
      if (cleaned !== '') {
        out.push(cleaned);
        this.emittedChunks += 1;
      }
    }
    if (final && this.buffer.length > 0) {
      const cleaned = ReplyTextCleaner.clean(this.buffer.join(''));
      this.buffer = [];
      if (cleaned !== '') { out.push(cleaned); this.emittedChunks += 1; }
    }
    return out;
  }

  /** The exclusive end of the next chunk in `b`, or null when more text is needed. */
  static findBreak(b: readonly string[], final: boolean, first: boolean): number | null {
    if (b.length === 0) return null;
    let words = 0;
    let inWord = false;
    let i = 0;
    while (i < b.length) {
      const c = b[i];
      if (isWhitespace(c)) inWord = false;
      else if (!inWord) { inWord = true; words += 1; }
      if (i >= SentenceChunker.maxChunk) return SentenceChunker.longBreak(b);
      if (first && SentenceChunker.clauseBreaks.has(c) && words >= 4 && i + 1 < b.length && isWhitespace(b[i + 1])) {
        return i + 1;
      }
      if (SentenceChunker.terminators.has(c)) {
        let j = i + 1;
        while (j < b.length && SentenceChunker.closers.has(b[j])) j += 1;
        if (j === b.length) {
          if (final) return j;
          return null; // can't tell yet whether the sentence ends here
        }
        if (isWhitespace(b[j]) && !(c === '.' && SentenceChunker.isAbbreviation(b, i))) return j;
        i = j;
        continue;
      }
      i += 1;
    }
    return null;
  }

  /** A too-long chunk breaks at its last comma, else its last space, within the limit. */
  static longBreak(b: readonly string[]): number {
    const window = b.slice(0, Math.min(SentenceChunker.maxChunk, b.length));
    const c = window.lastIndexOf(',');
    if (c > 0) return c + 1;
    let s = -1;
    for (let k = window.length - 1; k >= 0; k--) if (isWhitespace(window[k])) { s = k; break; }
    if (s > 0) return s + 1;
    return window.length;
  }

  static isAbbreviation(b: readonly string[], i: number): boolean {
    let k = i - 1;
    while (k >= 0 && !isWhitespace(b[k])) k -= 1;
    return SentenceChunker.abbreviations.has(b.slice(k + 1, i).join('').toLowerCase());
  }
}

/** Removes what a speech voice must not read out (design §6.6): markdown markers, emoji, URLs; collapses whitespace. */
export const ReplyTextCleaner = {
  clean(s: string): string {
    let t = s;
    // [label](url) → label
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1');
    t = t.replace(/(https?:\/\/|www\.)\S+/gu, '');
    t = t.replace(/^\s*(#{1,6}\s*|>\s*|[-*+]\s+|\p{Nd}+[.)]\s+)/gmu, '');
    t = t.replace(/(\*\*|__|~~|`+|\*|(?<=\s)_|_(?=\s))/gu, '');
    t = characters(t).filter((c) => !ReplyTextCleaner.isEmoji(c)).join('');
    t = t.replace(/\s+/gu, ' ');
    t = t.replace(/\s+([,.;:!?…])/gu, '$1');
    t = t.trim();
    // Nothing worth saying (only punctuation left).
    if (!characters(t).some(isLetterOrNumber)) return '';
    return t;
  },

  isEmoji(c: string): boolean {
    const scalars = Array.from(c);
    const first = scalars[0];
    if (first === undefined || first.codePointAt(0)! < 0x80) return false;
    if (scalars.some((x) => /\p{Emoji_Presentation}/u.test(x))) return true;
    if (/\p{Emoji}/u.test(first) && scalars.length > 1) return true; // ☺️ + VS16, ZWJ sequences
    return false;
  },
};
