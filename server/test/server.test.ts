import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createDisplayServer, createIngressServer } from '../src/server.js';
import { Devices, SettingsStore } from '../src/store.js';
import { redactUrl } from '../src/mqtt.js';

let close: (() => void)[] = [];
afterEach(() => { close.forEach((f) => f()); close = []; });

async function rig(trusted = ['127.0.0.1']) {
  const dir = mkdtempSync(join(tmpdir(), 'yanni-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<title>face</title>');
  mkdirSync(join(web, 'ort'));
  writeFileSync(join(web, 'ort', 'x.wasm'), 'w');
  writeFileSync(join(web, 'ort', 'x.mjs'), 'm');
  const deps = { devices: new Devices(dir), settings: new SettingsStore(dir), bridge: () => undefined };
  const { server, displays } = createDisplayServer(deps, web);
  const ingress = createIngressServer(deps, web, trusted, (d) => displays.disconnect(d.id), displays);
  await Promise.all([server, ingress].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  close.push(() => { server.close(); ingress.close(); server.closeAllConnections(); });
  const url = (s: typeof server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { deps, displays, display: url(server), ingress: url(ingress) };
}

const post = (u: string, body: unknown) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('servers', () => {
  it('pairs through ingress + /api/pair, then the socket needs the token', async () => {
    const r = await rig();
    const { code } = await (await post(`${r.ingress}/api/codes`, { room: 'Office' })).json();
    const paired = await (await post(`${r.display}/api/pair`, { code })).json();
    expect(paired).toMatchObject({ room: 'Office', deviceId: expect.stringMatching(/^[0-9a-f]{8}$/) });

    const bad = new WebSocket(`${r.display.replace('http', 'ws')}/ws`);
    await new Promise((res) => bad.on('open', res));
    bad.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'nope', appVersion: '0', settings: {} }));
    expect(await new Promise((res) => bad.on('close', res))).toBe(4401);

    const ws = new WebSocket(`${r.display.replace('http', 'ws')}/ws`);
    await new Promise((res) => ws.on('open', res));
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: paired.token, appVersion: '0.1.0', settings: { sounds: false } }));
    const welcome = JSON.parse(String(await new Promise((res) => ws.once('message', res))));
    expect(welcome).toMatchObject({ type: 'welcome', deviceId: paired.deviceId, room: 'Office', settings: { sounds: false, room: 'Office' } });
    ws.send(JSON.stringify({ type: 'ha.call', id: 1, request: { type: 'get_states' } }));
    expect(JSON.parse(String(await new Promise((res) => ws.once('message', res))))).toMatchObject({ type: 'ha.result', id: 1, success: false });
    expect(r.displays.send(paired.deviceId, { type: 'command', command: 'force_wake' })).toBe(true);
    ws.close();
  });

  it('serves the app with an SPA fallback and no path traversal', async () => {
    const r = await rig();
    expect(await (await fetch(`${r.display}/some/route`)).text()).toContain('face');
    expect((await fetch(`${r.display}/..%2f..%2fetc/passwd`)).status).not.toBe(200);
  });

  it('serves the display cross-origin isolated, with wasm and module MIME types', async () => {
    const r = await rig();
    for (const [path, type] of [['/', 'text/html'], ['/ort/x.wasm', 'application/wasm'], ['/ort/x.mjs', 'text/javascript']]) {
      const res = await fetch(`${r.display}${path}`);
      expect(res.headers.get('content-type')).toContain(type);
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    }
  });

  it('ingress refuses anyone but the gateway', async () => {
    const r = await rig(['172.30.32.2']);
    expect((await fetch(`${r.ingress}/api/status`)).status).toBe(403);
  });
});

const json = { 'content-type': 'application/json' };
const put = (u: string, body: unknown) => fetch(u, { method: 'PUT', headers: json, body: JSON.stringify(body) });

/** Pairs a display and opens its socket; `next()` resolves the next server message. */
async function paired(r: Awaited<ReturnType<typeof rig>>, settings: Record<string, unknown> = {}) {
  const { code } = await (await post(`${r.ingress}/api/codes`, { room: 'Office' })).json();
  const p = await (await post(`${r.display}/api/pair`, { code })).json();
  const ws = new WebSocket(`${r.display.replace('http', 'ws')}/ws`);
  await new Promise((res) => ws.on('open', res));
  const queue: any[] = [];
  let waiter: ((m: any) => void) | undefined;
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (waiter) { waiter(m); waiter = undefined; } else queue.push(m); });
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise<any>((res) => { waiter = res; }));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: p.token, appVersion: '0.1.0', settings }));
  expect(await next()).toMatchObject({ type: 'welcome' });
  close.push(() => ws.close());
  return { id: p.deviceId as string, ws, next };
}

describe('owner pages (ingress)', () => {
  it('changes settings with validation and syncs them to the display', async () => {
    const r = await rig();
    const d = await paired(r, { sounds: true });
    const u = `${r.ingress}/api/devices/${d.id}/settings`;
    expect((await put(u, { values: { admin: true } })).status).toBe(400);
    expect((await put(u, { values: { chirp_volume: 101 } })).status).toBe(400);
    expect((await put(u, { values: { room_understanding: true } })).status).toBe(400);
    expect((await put(u, { values: {} })).status).toBe(400);
    const ok = await put(u, { values: { sounds: false, game_yo_yo: false, room: 'Den' } });
    expect(ok.status).toBe(200);
    expect(await d.next()).toEqual({ type: 'settings', values: { sounds: false, game_yo_yo: false, room: 'Den' }, origin: 'owner' });
    const got = await (await fetch(`${r.ingress}/api/devices/${d.id}`)).json();
    expect(got.device.room).toBe('Den');
    expect(got.settings).toMatchObject({ sounds: false, game_yo_yo: false, chirp_volume: 70 }); // defaults fill in
    expect(got.status).toMatchObject({ online: true, appVersion: '0.1.0' });
  });

  it('keeps the latest state report for the Status page', async () => {
    const r = await rig();
    const d = await paired(r);
    d.ws.send(JSON.stringify({ type: 'state', values: { face_state: 'idle', fps: 59.8, frame_gap_p99_ms: 18.2, render_tier: 'full' } }));
    d.ws.send(JSON.stringify({ type: 'state', values: { face_state: 'listening' } }));
    await new Promise((res) => setTimeout(res, 30));
    const got = await (await fetch(`${r.ingress}/api/devices/${d.id}`)).json();
    expect(got.status.state).toEqual({ face_state: 'listening', fps: 59.8, frame_gap_p99_ms: 18.2, render_tier: 'full' });
  });

  it('sends a test announcement as a typed command; 409 while offline', async () => {
    const r = await rig();
    const d = await paired(r);
    const u = `${r.ingress}/api/devices/${d.id}/announce`;
    expect((await post(u, { text: '' })).status).toBe(400);
    expect((await post(u, { text: 'Test', priority: 'high' })).status).toBe(200);
    expect(await d.next()).toMatchObject({ type: 'command', command: 'announce',
      announce: { kind: 'announce', announcement: { text: 'Test', priority: 'high', expiresIn: 1800 } } });
    d.ws.close();
    await new Promise((res) => setTimeout(res, 30));
    expect((await post(u, { text: 'Test' })).status).toBe(409);
  });

  it('revoking closes the socket and forgets the status', async () => {
    const r = await rig();
    const d = await paired(r);
    const closed = new Promise((res) => d.ws.on('close', res));
    expect((await fetch(`${r.ingress}/api/devices/${d.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await closed).toBe(4403);
    expect((await fetch(`${r.ingress}/api/devices/${d.id}`)).status).toBe(404);
  });
});

describe('security', () => {
  it('owner routes exist only on ingress, and ingress only for the gateway', async () => {
    const r = await rig();
    for (const [method, path] of [['GET', '/api/status'], ['POST', '/api/codes'], ['GET', '/api/devices/a1b2c3d4'],
      ['DELETE', '/api/devices/a1b2c3d4'], ['PUT', '/api/devices/a1b2c3d4/settings'], ['POST', '/api/devices/a1b2c3d4/announce']]) {
      expect((await fetch(`${r.display}${path}`, { method, headers: json, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' })).status, path).toBe(404);
    }
    const locked = await rig(['172.30.32.2']);
    for (const path of ['/', '/api/status', '/api/devices/a1b2c3d4', '/app.js']) {
      expect((await fetch(`${locked.ingress}${path}`)).status, path).toBe(403);
    }
    expect((await fetch(`${locked.ingress}/api/devices/a1b2c3d4/settings`, { method: 'PUT', headers: json, body: '{}' })).status).toBe(403);
  });

  it('mutating owner requests need a JSON body (no cross-site form posts)', async () => {
    const r = await rig();
    const form = await fetch(`${r.ingress}/api/codes`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'room=x' });
    expect(form.status).toBe(415);
    expect((await fetch(`${r.ingress}/api/codes`, { method: 'POST', body: '{"room":"x"}' })).status).toBe(415);
    expect((await post(`${r.ingress}/api/codes`, { room: 'bad\u0007room' })).status).toBe(400);
  });

  it('serves the owner pages with a strict CSP', async () => {
    const r = await rig();
    const res = await fetch(`${r.ingress}/`);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('the TTS proxy needs a device token', async () => {
    const r = await rig();
    expect((await fetch(`${r.display}/api/tts_proxy/abc.mp3`)).status).toBe(401);
    expect((await fetch(`${r.display}/api/tts_proxy/abc.mp3`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('closes a display socket that floods text frames', async () => {
    const r = await rig();
    const d = await paired(r);
    const closed = new Promise((res) => d.ws.on('close', res));
    for (let i = 0; i < 250; i++) d.ws.send(JSON.stringify({ type: 'state', values: { people_count: i % 2 } }));
    expect(await closed).toBe(4429);
  });

  it('never logs broker credentials', () => {
    expect(redactUrl('mqtt://user:secret@core-mosquitto:1883')).toBe('mqtt://core-mosquitto:1883');
    expect(redactUrl('mqtts://broker:8883')).toBe('mqtts://broker:8883');
  });
});
