// Port of ConversationCore/CaptionTimeline.swift (CaptionTimings, CaptionTimeline, CaptionFit).
import type { Caption } from '../events/Captions';

// port-note: Swift counts `Character`s (grapheme clusters); this port counts code points (`Array.from`), so an emoji
// built from several code points counts as several. `text`, `start` and `count` all use the same unit.
const chars = (s: string): string[] => Array.from(s);
const isWhitespace = (c: string): boolean => /\s/u.test(c);

/// When the caption bubbles show, dock and fade (caption bubbles design §4). Seconds.
export class CaptionTimings {
  /// The reply bubble (and the docked "you" pill) linger this long after the reply's last audio, then pop out.
  replyLinger = 4;
  /// Safety nets: the "you" bubble with no reply after it (from its last words), and a reply with no next piece and
  /// no end.
  youMaxAge = 12;
  replyMaxAge = 15;
  /// The "you" words type in at this rate, never longer than `youTypeMax` per update.
  youCharsPerSecond = 40;
  youTypeMax = 1;
  /// A reply piece shown before its audio length is known is paced at this speaking rate until it is.
  replyCharsPerSecond = 15;
  /// Reply words lead their audio by this much (slightly ahead, never behind).
  replyLead = 0.15;
  /// At most this many reply pieces stay in the bubble (older ones have scrolled away).
  replyMaxPieces = 6;
}

/// One stretch of a bubble's text revealed over its own time: typed in (the person's words) or word by word over its
/// audio (a reply piece).
export interface CaptionPiece {
  /// The reply piece's index (−1 for the person's words).
  index: number;
  /// Where it starts in the bubble's text and how long it is (characters).
  start: number;
  count: number;
  /// When it starts revealing (host seconds; a reply piece `replyLead` before its audio) and over how long.
  at: number;
  duration: number;
  /// Word by word (a reply piece) or character by character (typing).
  byWord: boolean;
}

/// One bubble's content (Swift `CaptionTimeline.Bubble`; port-note: renamed so it doesn't clash with the
/// `CaptionBubble` view). `id` changes only for a new bubble (the view pops it); the words may grow in place.
export class CaptionBubbleContent {
  constructor(
    public id: number,
    public text: string,
    public shownAt: number,
    /// The words last changed (the safety nets run from here).
    public updatedAt: number,
    /// The person's words: final (past the gate). Before that they are partial ("Listening").
    public isFinal: boolean,
    /// The reveal: everything before the first piece shows at once; each piece reveals over its own time.
    public pieces: CaptionPiece[],
  ) {}

  copy(): CaptionBubbleContent {
    return new CaptionBubbleContent(this.id, this.text, this.shownAt, this.updatedAt, this.isFinal,
      this.pieces.map((p) => ({ ...p })));
  }

  /// The text's length in the timeline's characters.
  get length(): number { return chars(this.text).length; }

  /// How many characters of `text` show at `now` (reply pieces at word boundaries). A piece is complete once the next
  /// one has started.
  revealed(now: number): number {
    const cs = chars(this.text);
    if (!Number.isFinite(now)) return cs.length;   // Reduce Motion and stills show everything
    const pieces = this.pieces;
    let shown = pieces.length > 0 ? pieces[0].start : cs.length;
    for (let k = 0; k < pieces.length; k++) {
      const p = pieces[k];
      const end = Math.min(p.start + p.count, cs.length);
      const start = p.at;
      if (k + 1 < pieces.length && now >= pieces[k + 1].at) { shown = end; continue; }
      if (!(now >= start && p.count > 0)) return shown;
      const f = p.duration > 0 ? Math.min((now - start) / p.duration, 1) : 1;
      if (p.byWord) {
        const words = CaptionBubbleContent.wordEnds(cs, p.start, end);
        const n = Math.min(words.length, Math.trunc(f * words.length) + 1);
        return n > 0 ? words[n - 1] : p.start;
      }
      return Math.min(end, p.start + Math.trunc(f * p.count) + 1);
    }
    return cs.length;
  }

  /// The end offsets of the words in `chars[from..<to]` (a word ends before whitespace or at `to`).
  static wordEnds(cs: string[], from: number, to: number): number[] {
    const ends: number[] = [];
    let i = from;
    while (i < to) {
      while (i < to && isWhitespace(cs[i])) i += 1;
      if (!(i < to)) break;
      while (i < to && !isWhitespace(cs[i])) i += 1;
      ends.push(i);
    }
    return ends;
  }

  /// Whether `now` is past the whole reveal.
  isRevealed(now: number): boolean { return this.revealed(now) >= this.length; }
}

/// The caption bubbles' state machine: pure and clock-driven, so the app's model only feeds it captions and wakes it
/// at `nextDeadline` (one timer, never a frame loop). Holds the words only while they are on screen.
export class CaptionTimeline {
  /// The person's words ("YOU"). While Yanni replies they stay, docked as a slim pill under the reply.
  private _you: CaptionBubbleContent | null = null;
  /// Yanni's reply ("YANNI"): its pieces append as each is heard.
  private _reply: CaptionBubbleContent | null = null;
  /// The reply has finished playing at this time (the linger runs from here).
  private _replyEndedAt: number | null = null;
  private turnId: string | null = null;
  private serial = 0;

  constructor(public timings: CaptionTimings = new CaptionTimings()) {}

  get you(): CaptionBubbleContent | null { return this._you; }
  get reply(): CaptionBubbleContent | null { return this._reply; }
  get replyEndedAt(): number | null { return this._replyEndedAt; }

  get isEmpty(): boolean { return this._you === null && this._reply === null; }

  /// The "you" bubble is docked under a reply (the slim pill).
  get youDocked(): boolean { return this._you !== null && this._reply !== null; }

  apply(c: Caption, now: number): void {
    switch (c.kind) {
      case 'transcriptPartial': {
        const t = c.text.trim();
        const y = this._you;
        if (y && !y.isFinal && this._reply === null) {
          this._you = this.typed(y, t, now, false);
        } else {
          this.clear();
          this._you = this.newYou(t, now, false);
        }
        break;
      }
      case 'transcript': {
        const t = c.text.trim();
        const y = this._you;
        if (y && !y.isFinal && this._reply === null) {
          this._you = t.length === 0 ? null : this.typed(y, t, now, true);
        } else {
          this.clear();
          this._you = t.length === 0 ? null : this.newYou(t, now, true);
        }
        this.turnId = c.turnId;
        break;
      }
      case 'replySentence': {
        if (c.turnId !== this.turnId) { this.clear(); this.turnId = c.turnId; }   // a proactive turn has no transcript
        const t = c.text.trim();
        if (t.length === 0) break;
        if (this._you?.isFinal === false) this._you = null;        // a stray partial never docks
        const count = chars(t).length;
        const duration = c.audioSeconds ?? count / this.timings.replyCharsPerSecond;
        const audible = c.audibleAtHostTime - this.timings.replyLead;
        const r = this._reply;
        if (r) {
          const start = r.length + 1;
          r.text += ' ' + t;
          r.pieces.push({ index: c.index, start, count, at: audible, duration, byWord: true });
          r.updatedAt = now;
          if (r.pieces.length > this.timings.replyMaxPieces) this.drop(r);
        } else {
          this.serial += 1;
          this._reply = new CaptionBubbleContent(this.serial, t, now, now, true,
            [{ index: c.index, start: 0, count, at: audible, duration, byWord: true }]);
        }
        this._replyEndedAt = null;
        break;
      }
      case 'replyTiming': {
        const r = this._reply;
        if (c.turnId !== this.turnId || !r) break;
        const p = r.pieces.find((q) => q.index === c.index);
        if (p) p.duration = Math.max(c.audioSeconds, 0);
        break;
      }
      case 'replyEnded':
        if (c.turnId !== this.turnId || this._reply === null) break;
        this._replyEndedAt = now;
        break;
      case 'cleared':
        this.clear();
        break;
    }
    this.tick(now);
  }

  /// Applies any deadline that has passed.
  tick(now: number): void {
    const r = this._reply;
    if (r) {
      const end = this._replyEndedAt !== null ? this._replyEndedAt + this.timings.replyLinger : r.updatedAt + this.timings.replyMaxAge;
      if (now >= end) this.clear();
    } else if (this._you && now >= this._you.updatedAt + this.timings.youMaxAge) {
      this._you = null;
    }
    if (this.isEmpty) this.turnId = null;
  }

  /// The next time `tick` changes something (null = nothing on screen).
  get nextDeadline(): number | null {
    const r = this._reply;
    if (r) return this._replyEndedAt !== null ? this._replyEndedAt + this.timings.replyLinger : r.updatedAt + this.timings.replyMaxAge;
    return this._you ? this._you.updatedAt + this.timings.youMaxAge : null;
  }

  private newYou(t: string, now: number, final: boolean): CaptionBubbleContent {
    this.serial += 1;
    return new CaptionBubbleContent(this.serial, t, now, now, final, [this.typing(0, chars(t).length, now)]);
  }

  /// The person's words grow in place: what still matches stays, the rest types in.
  private typed(y: CaptionBubbleContent, t: string, now: number, final: boolean): CaptionBubbleContent {
    const b = y.copy();
    const a = chars(y.text), n = chars(t);
    let same = 0;
    while (same < a.length && same < n.length && a[same] === n[same]) same += 1;
    b.text = t;
    b.isFinal = final;
    b.updatedAt = now;
    b.pieces = [this.typing(same, n.length, now)];
    return b;
  }

  private typing(from: number, to: number, now: number): CaptionPiece {
    const n = Math.max(to - from, 0);
    return { index: -1, start: from, count: n, at: now,
      duration: Math.min(n / this.timings.youCharsPerSecond, this.timings.youTypeMax), byWord: false };
  }

  /// Drops the oldest reply piece (it has long scrolled out of the bubble).
  private drop(r: CaptionBubbleContent): void {
    const cut = r.pieces[1].start;
    r.text = chars(r.text).slice(cut).join('');
    r.pieces.shift();
    for (const p of r.pieces) p.start -= cut;
  }

  private clear(): void {
    this._you = null; this._reply = null; this._replyEndedAt = null; this.turnId = null;
  }
}

/// The caption type's fit (caption bubbles design §5): the largest size from `max` down to `min` (in `steps` equal
/// ratios) at which `fits` says the words fit the bubble; at `min` they may still overflow, and the bubble then shows
/// the latest lines. Pure, so it's tested without a screen.
export const CaptionFit = {
  size(hi: number, lo: number, fits: (s: number) => boolean, steps = 10): { size: number; overflows: boolean } {
    lo = Math.min(lo, hi);
    if (!(steps > 0 && hi > lo)) return { size: lo, overflows: !fits(lo) };
    const ratio = Math.pow(lo / hi, 1 / steps);
    let s = hi;
    for (let i = 0; i < steps; i++) {
      if (fits(s)) return { size: s, overflows: false };
      s *= ratio;
    }
    return { size: lo, overflows: !fits(lo) };
  },
};
