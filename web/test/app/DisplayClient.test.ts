import { parseClientMessage } from '@yanni/server/protocol';
import { describe, expect, test } from 'vitest';
import { DisplayClient, HaCallError, type SocketLike } from '../../src/app/DisplayClient';

class MockSocket implements SocketLike {
  readyState = 0;
  binaryType = 'blob';
  sent: (string | Uint8Array)[] = [];
  onopen: SocketLike['onopen'] = null;
  onclose: SocketLike['onclose'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {}
  send(d: string | ArrayBufferLike | ArrayBufferView) { this.sent.push(typeof d === 'string' ? d : new Uint8Array(d as ArrayBuffer)); }
  close() { this.serverClose(1000); }
  // test side
  open() { this.readyState = 1; this.onopen?.({}); }
  serverClose(code: number, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  push(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
  json(i = -1) { return JSON.parse(this.sent.at(i) as string); }
}

function rig(settings = { sounds: true }) {
  const sockets: MockSocket[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const c = new DisplayClient({
    url: 'ws://x/ws', token: 'tok', appVersion: '0.1.0', settings: () => settings, state: () => ({ face_state: 'idle' }),
    socket: (u) => { const s = new MockSocket(u); sockets.push(s); return s; },
    random: () => 0.5,
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (h) => { (h as { live: boolean }).live = false; },
  });
  const statuses: string[] = [];
  c.on('status', (s) => statuses.push(s));
  const runTimers = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
  const welcome = (s: MockSocket) => { s.open(); s.push({ type: 'welcome', protocol: 1, deviceId: 'abcd1234', room: 'Den', settings: { sounds: true, room: 'Den' }, ha: { connected: true } }); };
  return { c, sockets, timers, runTimers, statuses, welcome };
}

describe('DisplayClient', () => {
  test('says a valid hello with its settings and state, then emits welcome and settings', () => {
    const r = rig();
    const got: unknown[] = [];
    r.c.on('settings', (s) => got.push(s));
    r.c.connect();
    r.sockets[0].open();
    const hello = r.sockets[0].json();
    expect(hello).toMatchObject({ type: 'hello', protocol: 1, token: 'tok', settings: { sounds: true }, state: { face_state: 'idle' } });
    expect(parseClientMessage(JSON.stringify(hello))).not.toHaveProperty('error');
    expect(r.c.connected).toBe(false);
    r.sockets[0].push({ type: 'welcome', protocol: 1, deviceId: 'abcd1234', room: 'Den', settings: { sounds: false }, ha: { connected: true } });
    expect(r.c.connected).toBe(true);
    expect(r.c.room).toBe('Den');
    expect(got).toEqual([{ values: { sounds: false }, origin: 'welcome' }]);
    expect(r.statuses).toEqual(['connecting', 'connected']);
  });

  test('settings both ways; commands and announcements become events', () => {
    const r = rig();
    const events: unknown[] = [];
    r.c.on('settings', (s) => events.push(s));
    r.c.on('command', (c) => events.push(c));
    r.c.on('announce', (p) => events.push(p));
    r.c.connect();
    r.welcome(r.sockets[0]);
    events.length = 0;
    expect(r.c.sendSettings({ chirp_volume: 40 })).toBe(true);
    expect(r.sockets[0].json()).toEqual({ type: 'settings', values: { chirp_volume: 40 } });
    r.sockets[0].push({ type: 'settings', values: { quiet_mode: true }, origin: 'homeassistant' });
    r.sockets[0].push({ type: 'command', command: 'force_sleep' });
    r.sockets[0].push({ type: 'command', command: 'announce', payload: 'hi' });
    expect(events).toEqual([{ values: { quiet_mode: true }, origin: 'homeassistant' }, 'force_sleep', 'hi']);
  });

  test('drops sends while offline (the next hello carries everything)', () => {
    const r = rig();
    expect(r.c.sendSettings({ sounds: false })).toBe(false);
    r.c.connect();
    r.sockets[0].open();
    expect(r.c.sendState({ people_count: 1 })).toBe(false); // before welcome
    expect(r.sockets[0].sent).toHaveLength(1);
  });

  test('reconnects with jittered, growing backoff and resets it on welcome', () => {
    const r = rig();
    r.c.connect();
    r.sockets[0].serverClose(1006);
    expect(r.statuses.at(-1)).toBe('disconnected');
    const first = r.timers.at(-1)!.ms;
    r.runTimers();
    r.sockets[1].serverClose(1006);
    const second = r.timers.at(-1)!.ms;
    expect(second).toBeGreaterThan(first);
    for (let i = 0; i < 20; i++) { r.runTimers(); r.sockets.at(-1)!.serverClose(1006); }
    expect(r.timers.at(-1)!.ms).toBeLessThanOrEqual(DisplayClient.backoffMax);
    r.runTimers();
    r.welcome(r.sockets.at(-1)!);
    expect(r.c.attempts).toBe(0);
  });

  test('stops on an unknown token (unpaired) and on replacement', () => {
    const r = rig();
    r.c.connect();
    r.sockets[0].open();
    r.sockets[0].serverClose(4401, 'unknown device token');
    expect(r.c.status).toBe('unpaired');
    expect(r.timers.filter((t) => t.live)).toHaveLength(0);
    const r2 = rig();
    r2.c.connect();
    r2.welcome(r2.sockets[0]);
    r2.sockets[0].serverClose(4409);
    expect(r2.c.status).toBe('stopped');
    expect(r2.timers.filter((t) => t.live)).toHaveLength(0);
  });

  test('ha.call resolves and rejects by id; times out; fails on disconnect', async () => {
    const r = rig();
    r.c.connect();
    r.welcome(r.sockets[0]);
    const s = r.sockets[0];
    const a = r.c.haCall({ type: 'get_states' });
    const b = r.c.haCall({ type: 'jev/ask' });
    const ida = s.json(-2).id, idb = s.json(-1).id;
    expect(ida).not.toBe(idb);
    expect(parseClientMessage(s.sent.at(-1) as string)).not.toHaveProperty('error');
    s.push({ type: 'ha.result', id: idb, success: false, error: { code: 'not_allowed', message: 'no' } });
    s.push({ type: 'ha.result', id: ida, success: true, result: [1] });
    await expect(a).resolves.toEqual([1]);
    await expect(b).rejects.toMatchObject({ code: 'not_allowed' });

    const slow = r.c.haCall({ type: 'x' }, 1000);
    r.runTimers();
    await expect(slow).rejects.toMatchObject({ code: 'timeout' });

    const cut = r.c.haCall({ type: 'y' });
    s.serverClose(1006);
    await expect(cut).rejects.toBeInstanceOf(HaCallError);
    await expect(r.c.haCall({ type: 'z' })).rejects.toMatchObject({ code: 'disconnected' });
  });

  test('subscriptions get their events until closed', async () => {
    const r = rig();
    r.c.connect();
    r.welcome(r.sockets[0]);
    const events: unknown[] = [];
    const sub = r.c.haSubscribe({ type: 'assist_pipeline/run' }, (e) => events.push(e));
    const s = r.sockets[0];
    s.push({ type: 'ha.result', id: sub.id, success: true, result: null });
    await sub.result;
    s.push({ type: 'ha.event', id: sub.id, event: { type: 'run-start' } });
    sub.close();
    s.push({ type: 'ha.event', id: sub.id, event: { type: 'late' } });
    expect(events).toEqual([{ type: 'run-start' }]);
  });

  test('binary audio: handler byte then little-endian PCM; a lone byte ends the audio', () => {
    const r = rig();
    r.c.connect();
    expect(r.c.sendAudio(3, new Int16Array([1]))).toBe(false);
    r.welcome(r.sockets[0]);
    expect(r.c.sendAudio(3, new Int16Array([1, -2]))).toBe(true);
    expect(Array.from(r.sockets[0].sent.at(-1) as Uint8Array)).toEqual([3, 1, 0, 0xfe, 0xff]);
    r.c.sendAudio(3);
    expect(Array.from(r.sockets[0].sent.at(-1) as Uint8Array)).toEqual([3]);
  });
});
