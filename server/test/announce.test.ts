import { describe, expect, it } from 'vitest';
import { parseAnnounce, sanitize } from '../src/announce.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('parseAnnounce (AnnouncementParser port)', () => {
  it('plain text from notify.send_message', () => {
    const r = parseAnnounce(enc('  The laundry\nis   done  '), 1800, 1_700_000_123_456);
    expect(r).toMatchObject({ kind: 'announce', announcement: { text: 'The laundry is done', priority: 'normal', expiresIn: 1800,
      context: {}, id: expect.stringMatching(/^msg-\d+-\d{3}$/) } });
  });

  it('structured announce: id, priority, expiry clamped, flat context capped', () => {
    const r = parseAnnounce(JSON.stringify({ kind: 'announce', id: 'dryer', text: 'Dryer done', priority: 'high', expires_in: 5,
      context: { b: 2, a: 'x', c: true, d: { nested: 1 }, e: null } }), 1800);
    expect(r).toEqual({ kind: 'announce', announcement: { id: 'dryer', text: 'Dryer done', priority: 'high', expiresIn: 60,
      context: { a: 'x', b: '2', c: 'true' } } });
    const long = parseAnnounce(JSON.stringify({ kind: 'announce', text: 'x', expires_in: 1e9 }), 1800);
    expect(long.kind === 'announce' && long.announcement.expiresIn).toBe(12 * 3600);
    const many = parseAnnounce(JSON.stringify({ kind: 'announce', text: 'x', context: Object.fromEntries([...'abcdefghij'].map((k) => [k, k])) }), 60);
    expect(many.kind === 'announce' && Object.keys(many.announcement.context)).toEqual([...'abcdefgh']);
  });

  it('nudge and cancel', () => {
    expect(parseAnnounce('{"kind":"nudge","feeling":"joy","strength":3,"look":"LEFT"}', 60))
      .toEqual({ kind: 'nudge', nudge: { feeling: 'joy', strength: 1, look: 'left' } });
    expect(parseAnnounce('{"kind":"nudge","feeling":"joy","look":"down"}', 60)).toEqual({ kind: 'nudge', nudge: { feeling: 'joy', strength: 0.5 } });
    expect(parseAnnounce('{"kind":"cancel","id":"dryer"}', 60)).toEqual({ kind: 'cancel', id: 'dryer' });
  });

  it('rejects what it cannot use', () => {
    expect(parseAnnounce('{"kind":"cancel"}', 60)).toMatchObject({ kind: 'rejected' });
    expect(parseAnnounce('{"kind":"nudge","feeling":"\\u200b"}', 60)).toMatchObject({ kind: 'rejected' });
    expect(parseAnnounce('{"kind":"announce","text":5}', 60)).toMatchObject({ kind: 'rejected' });
    expect(parseAnnounce('\u0000\u0001', 60)).toEqual({ kind: 'rejected', reason: 'empty' });
    expect(parseAnnounce(new Uint8Array([0xff, 0xfe]), 60)).toEqual({ kind: 'rejected', reason: 'not_utf8' });
    expect(parseAnnounce('x'.repeat(8193), 60)).toEqual({ kind: 'rejected', reason: 'too_large' });
  });

  it('JSON without a known kind is plain text; an invalid id gets a generated one', () => {
    expect(parseAnnounce('{"text":"hi"}', 60)).toMatchObject({ kind: 'announce', announcement: { text: '{"text":"hi"}' } });
    const r = parseAnnounce('{"kind":"announce","text":"hi","id":"no spaces"}', 60);
    expect(r.kind === 'announce' && r.announcement.id).toMatch(/^msg-/);
  });

  it('sanitize strips control, zero-width and bidi characters and caps by characters', () => {
    expect(sanitize('a‮b​c\u0007 \t d', 100)).toBe('abc d');
    expect(sanitize('😀😀😀', 2)).toBe('😀😀');
  });
});
