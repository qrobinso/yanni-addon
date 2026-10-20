import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createDisplayServer, createIngressServer } from '../src/server.js';
import { Devices, SettingsStore } from '../src/store.js';

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
  const ingress = createIngressServer(deps, web, trusted, () => {});
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
