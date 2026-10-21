// The notify payload parser (port of YanniHome's AnnouncementParser). The add-on parses every `…/announce/set`
// payload (and the owner page's test announcement) and sends the display a typed, validated command; the display's
// queue (web/src/conversation/announcements) holds and delivers it. No imports, no Node APIs (the web app imports
// the types as `@yanni/server/announce`).
//
// The payload is untrusted (anyone with publish rights on the topic: the broker ACL is the trust boundary). It is JSON
// only when it is an object with a known `kind`; otherwise the whole payload is plain text (what `notify.send_message`
// publishes). Control, zero-width and bidi characters are stripped and every field is capped.

export type AnnouncementPriority = 'normal' | 'high';
export type NudgeLook = 'left' | 'right' | 'up';

export interface Announcement {
  /** `[A-Za-z0-9_-]{1,64}`: a repeated id replaces the pending message; `cancel` removes it. */
  id: string;
  /** Untrusted, sanitised, ≤ 500 characters. Never logged or shown on a status page. */
  text: string;
  /** Small flat context (≤ 8 keys, ≤ 1 KB). */
  context: Record<string, string>;
  priority: AnnouncementPriority;
  /** Seconds from receipt (60 s … 12 h); the display stamps its own clock, so clock skew can't expire it early. */
  expiresIn: number;
}

/** A feeling for Yanni to show briefly (no speech): an expression name, strength 0…1, an optional glance. */
export interface Nudge { feeling: string; strength: number; look?: NudgeLook }

export type AnnounceCommand =
  | { kind: 'announce'; announcement: Announcement }
  | { kind: 'nudge'; nudge: Nudge }
  | { kind: 'cancel'; id: string };

export const ANNOUNCE_LIMITS = {
  maxText: 500, maxContextBytes: 1024, maxContextKeys: 8, maxIdLength: 64, maxPayload: 8 * 1024,
  minExpiry: 60, maxExpiry: 12 * 3600,
} as const;

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;

/** Removes control and format characters (newlines and tabs become spaces), collapses spaces, trims, caps. */
export function sanitize(s: string, cap: number): string {
  const cleaned = s.replace(/[\n\t\r]/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '');
  return [...cleaned.split(' ').filter(Boolean).join(' ')].slice(0, cap).join('');
}

export const validId = (s: unknown): string | undefined =>
  typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : undefined;

const clampExpiry = (e: number) => Math.min(Math.max(e, ANNOUNCE_LIMITS.minExpiry), ANNOUNCE_LIMITS.maxExpiry);

function generatedId(nowMs: number): string {
  return `msg-${Math.floor(nowMs) % 100_000_000}-${100 + Math.floor(Math.random() * 900)}`;
}

function context(v: unknown): Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  let size = 0;
  let n = 0;
  for (const k of Object.keys(v).sort()) {
    if (n >= ANNOUNCE_LIMITS.maxContextKeys) break;
    const raw = (v as Record<string, unknown>)[k];
    const key = sanitize(k, 32);
    const value = typeof raw === 'string' ? sanitize(raw, 200)
      : typeof raw === 'boolean' ? String(raw) : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : undefined;
    if (value === undefined || !key) continue;
    const sz = bytes(key) + bytes(value);
    if (size + sz > ANNOUNCE_LIMITS.maxContextBytes) break;
    size += sz;
    out[key] = value;
    n += 1;
  }
  return out;
}

/** Parses a notify payload. `defaultExpiry` (seconds) applies when the message doesn't say. */
export function parseAnnounce(payload: string | Uint8Array, defaultExpiry: number, nowMs = Date.now()):
  AnnounceCommand | { kind: 'rejected'; reason: string } {
  let raw: string;
  if (typeof payload === 'string') raw = payload;
  else {
    if (payload.length > ANNOUNCE_LIMITS.maxPayload) return { kind: 'rejected', reason: 'too_large' };
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(payload); } catch { return { kind: 'rejected', reason: 'not_utf8' }; }
  }
  if (bytes(raw) > ANNOUNCE_LIMITS.maxPayload) return { kind: 'rejected', reason: 'too_large' };
  let o: unknown;
  try { o = JSON.parse(raw); } catch { /* plain text */ }
  const obj = typeof o === 'object' && o !== null && !Array.isArray(o) ? o as Record<string, unknown> : undefined;
  if (obj && ['announce', 'nudge', 'cancel'].includes(obj.kind as string)) {
    const id = validId(obj.id);
    if (obj.kind === 'cancel') return id ? { kind: 'cancel', id } : { kind: 'rejected', reason: 'cancel needs a valid id' };
    if (obj.kind === 'nudge') {
      const feeling = typeof obj.feeling === 'string' ? sanitize(obj.feeling, 40) : '';
      if (!feeling) return { kind: 'rejected', reason: 'nudge needs a feeling' };
      const s = obj.strength;
      const strength = typeof s === 'number' && Number.isFinite(s) ? Math.min(Math.max(s, 0), 1) : 0.5;
      const look = typeof obj.look === 'string' ? obj.look.toLowerCase() : undefined;
      return { kind: 'nudge', nudge: { feeling, strength, ...(look === 'left' || look === 'right' || look === 'up' ? { look } : {}) } };
    }
    const text = typeof obj.text === 'string' ? sanitize(obj.text, ANNOUNCE_LIMITS.maxText) : '';
    if (!text) return { kind: 'rejected', reason: 'announce needs text' };
    const p = typeof obj.priority === 'string' ? obj.priority.toLowerCase() : 'normal';
    const e = obj.expires_in;
    return { kind: 'announce', announcement: { id: id ?? generatedId(nowMs), text, context: context(obj.context),
      priority: p === 'high' ? 'high' : 'normal',
      expiresIn: clampExpiry(typeof e === 'number' && Number.isFinite(e) ? e : defaultExpiry) } };
  }
  const text = sanitize(raw, ANNOUNCE_LIMITS.maxText);
  if (!text) return { kind: 'rejected', reason: 'empty' };
  return { kind: 'announce', announcement: { id: generatedId(nowMs), text, context: {}, priority: 'normal', expiresIn: clampExpiry(defaultExpiry) } };
}
