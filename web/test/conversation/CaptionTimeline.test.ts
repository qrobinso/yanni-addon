// Port of ConversationCoreTests/CaptionTimelineTests.swift: the caption bubbles' timing (caption bubbles design §4):
// stream, dock, append, reveal, linger, fade, clear, and the type fit. Deterministic.
import { describe, expect, test } from 'vitest';
import { CaptionFit, CaptionTimeline, CaptionTimings } from '../../src/conversation/core/CaptionTimeline';
import type { Caption } from '../../src/conversation/events/Captions';

const reply = (t: string, i: number, at: number, d: number | null = null, turn = 't-1'): Caption =>
  ({ kind: 'replySentence', turnId: turn, index: i, text: t, audibleAtHostTime: at, audioSeconds: d });
const transcript = (turnId: string, text: string): Caption => ({ kind: 'transcript', turnId, text });
const partial = (text: string): Caption => ({ kind: 'transcriptPartial', text });
const ended = (turnId: string): Caption => ({ kind: 'replyEnded', turnId });
const cleared: Caption = { kind: 'cleared' };

describe('CaptionTimeline', () => {
  test('you then reply docks you and lingers after the end', () => {
    const t = new CaptionTimeline();
    t.apply(transcript('t-1', ' Tell me a story '), 10);
    expect(t.you?.text).toBe('Tell me a story');
    expect(t.you?.isFinal).toBe(true);
    expect(t.reply).toBeNull();
    expect(t.nextDeadline).toBe(22);
    t.apply(reply('Once upon a time,', 0, 11, 1.2), 11);
    expect(t.you?.text).toBe('Tell me a story');
    expect(t.youDocked).toBe(true);   // the you bubble docks under the reply
    const first = t.reply?.id;
    t.apply(reply('a dragon slept.', 1, 12.5, 1), 12.5);
    expect(t.reply?.text).toBe('Once upon a time, a dragon slept.');
    expect(t.reply?.id).toBe(first);   // pieces append in place
    t.apply(ended('t-1'), 14);
    expect(t.nextDeadline).toBe(18);
    t.tick(17.9);
    expect(t.reply).not.toBeNull();
    expect(t.you).not.toBeNull();
    t.tick(18);
    expect(t.isEmpty && t.nextDeadline === null).toBe(true);   // the pill goes with the reply
  });

  test('partials stream into one bubble then the transcript finalises it', () => {
    const t = new CaptionTimeline();
    t.apply(partial(''), 0);
    const id = t.you?.id;
    expect(t.you?.text).toBe('');   // the listening placeholder
    expect(t.you?.isFinal).toBe(false);
    t.apply(partial('turn of'), 0.4);
    t.apply(partial('turn off the'), 0.8);
    expect(t.you?.id).toBe(id);   // volatile words change in place
    expect(t.you?.text).toBe('turn off the');
    // What still matches shows at once; only the new words type in (the first character at once).
    expect(t.you?.revealed(0.8)).toBe(8);
    expect(t.you?.revealed(0.8 + 5.0 / 40)).toBe(12);
    t.apply(transcript('t-1', 'Turn off the lights'), 1.5);
    expect(t.you?.id).toBe(id);
    expect(t.you?.isFinal).toBe(true);
    expect(t.you?.text).toBe('Turn off the lights');
    expect(t.nextDeadline).toBe(13.5);   // the safety net runs from the last words
  });

  test('a partial bubble is removed by a clear and never docks', () => {
    const t = new CaptionTimeline();
    t.apply(partial('psst, did you see'), 0);
    t.apply(cleared, 1);   // not for me
    expect(t.isEmpty).toBe(true);
    t.apply(partial('hey'), 2);
    t.apply(reply('News!', 0, 3, 0.5, 'p-1'), 3);   // proactive, no transcript
    expect(t.you).toBeNull();
    expect(t.reply?.text).toBe('News!');
  });

  test('a new turn pops the old reply and pill', () => {
    const t = new CaptionTimeline();
    t.apply(transcript('t-1', 'hi'), 0);
    t.apply(reply('Hello!', 0, 1, 0.5), 1);
    t.apply(ended('t-1'), 2);
    const old = t.you?.id;
    t.apply(partial(''), 3);   // the follow-up
    expect(t.reply).toBeNull();
    expect(t.you?.id).not.toBe(old);
    expect(t.you?.isFinal).toBe(false);
  });

  test('reply words reveal over their audio', () => {
    const t = new CaptionTimeline();
    const tm = new CaptionTimings();
    tm.replyLead = 0;
    t.timings = tm;
    // Four words over 2 s from t = 10: one more word every half second, the first at once.
    t.apply(reply('one two three four', 0, 10, 2), 10);
    const r = t.reply!;
    expect(r.revealed(9.9)).toBe(0);
    expect(r.revealed(10)).toBe(3);      // "one"
    expect(r.revealed(10.49)).toBe(3);
    expect(r.revealed(10.5)).toBe(7);    // "one two"
    expect(r.revealed(11.0)).toBe(13);   // "one two three"
    expect(r.revealed(11.5)).toBe(18);
    expect(r.isRevealed(11.5)).toBe(true);
  });

  test('a new piece completes the previous and untimed pieces get their length later', () => {
    const t = new CaptionTimeline();
    const tm = new CaptionTimings();
    tm.replyLead = 0;
    tm.replyCharsPerSecond = 10;
    t.timings = tm;
    t.apply(reply('aa bb cc dd', 0, 0), 0);          // estimated 11 chars / 10 = 1.1 s
    expect(t.reply?.pieces[0]?.duration).toBe(1.1);
    t.apply({ kind: 'replyTiming', turnId: 't-1', index: 0, audioSeconds: 4 }, 0.2);
    expect(t.reply?.revealed(0.9)).toBe(2);   // slowed to the real length: still one word of four at 0.9 s
    t.apply(reply('ee ff', 1, 2, 1), 2);
    const r = t.reply!;
    expect(r.revealed(2)).toBe(14);   // the first piece completes as the next starts; its first word shows
    expect(r.revealed(2.5)).toBe(r.text.length);
  });

  test('words lead their audio slightly', () => {
    const t = new CaptionTimeline();
    t.apply(reply('one two', 0, 10, 1), 10);
    expect(t.reply?.revealed(10 - t.timings.replyLead)).toBe(3);   // a little ahead of the voice, never behind
  });

  test('long replies keep only the latest pieces', () => {
    const t = new CaptionTimeline();
    for (let i = 0; i < 10; i++) t.apply(reply(`Piece ${i}.`, i, i, 0.5), i);
    const r = t.reply!;
    expect(r.pieces.length).toBe(t.timings.replyMaxPieces);
    expect(r.text.startsWith('Piece 4.') && r.text.endsWith('Piece 9.')).toBe(true);
    expect(r.pieces[0].start).toBe(0);
    expect(r.revealed(20)).toBe(r.text.length);
  });

  test('cleared takes everything down at once', () => {
    const t = new CaptionTimeline();
    t.apply(transcript('t-1', 'hi'), 0);
    t.apply(reply('Hello!', 0, 1), 1);
    t.apply(cleared, 1.2);
    expect(t.isEmpty && t.nextDeadline === null).toBe(true);
  });

  test('safety nets never leave anything on screen', () => {
    const t = new CaptionTimeline();
    t.apply(transcript('t-1', 'hi'), 0);
    t.tick(12);
    expect(t.isEmpty).toBe(true);   // no reply ever came
    t.apply(reply('Oh, and…', 0, 20, null, 't-2'), 20);
    expect(t.nextDeadline).toBe(35);
    t.tick(35);
    expect(t.isEmpty).toBe(true);   // no end ever came
  });

  test('stray ends and blank words are ignored', () => {
    const t = new CaptionTimeline();
    t.apply(reply('News!', 0, 0), 0);  // proactive
    t.apply(transcript('t-2', 'what?'), 1);
    expect(t.reply).toBeNull();
    expect(t.you?.text).toBe('what?');
    t.apply(ended('t-1'), 2);
    expect(t.replyEndedAt).toBeNull();
    t.apply(transcript('t-3', '   '), 3);
    expect(t.isEmpty).toBe(true);   // blank words show nothing
  });

  test('the type fits largest first and overflows only at the minimum', () => {
    // A fake measure: the words need size × 20 / 1000 lines of 1.2 × size; the room is 150 high.
    const fits = (s: number): boolean => Math.ceil(s * 20 / 1000) * s * 1.2 <= 150;
    const a = CaptionFit.size(80, 20, fits);
    expect(!a.overflows && fits(a.size) && a.size <= 80 && a.size >= 20).toBe(true);
    expect(fits(a.size * 1.15)).toBe(false);   // about the largest that fits
    expect(CaptionFit.size(80, 20, () => true)).toEqual({ size: 80, overflows: false });
    expect(CaptionFit.size(80, 20, () => false)).toEqual({ size: 20, overflows: true });
    // A minimum above the maximum reads as it.
    expect(CaptionFit.size(20, 30, () => true)).toEqual({ size: 20, overflows: false });
  });

  test('everything shows at an infinite now', () => {
    const t = new CaptionTimeline();
    t.apply(transcript('a', 'hello there'), 10);
    t.apply(reply('Hi! How are you?', 0, 11, 2, 'a'), 11);
    expect(t.you?.revealed(Infinity)).toBe('hello there'.length);
    expect(t.reply?.revealed(Infinity)).toBe('Hi! How are you?'.length);
  });
});
