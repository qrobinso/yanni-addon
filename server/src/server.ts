// The two listeners. Display port (HTTPS when a cert is configured): the kiosk app, pairing, the display socket and
// the TTS audio proxy. Ingress port (HTTP, only from the Supervisor's ingress gateway): the owner pages.
import { createReadStream, statSync } from 'node:fs';
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, PROTOCOL_VERSION, type ServerMessage } from './protocol.js';
import type { Devices, DeviceRecord, SettingsStore } from './store.js';
import type { HaRelay } from './relay.js';
import type { HomeBridge } from './mqtt.js';
import { log } from './log.js';

export interface AppDeps {
  devices: Devices;
  settings: SettingsStore;
  relay?: HaRelay;
  /** Set once MQTT is up (may stay undefined without a broker). */
  bridge(): HomeBridge | undefined;
  /** HA's REST base, e.g. http://supervisor/core (the TTS proxy appends /api/tts_proxy/…). */
  haHttp?: string;
  haToken?: string;
  /** Pre-filled room for new pairing codes (add-on option default_room). */
  defaultRoom?: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.task': 'application/octet-stream',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 4096): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** Static files under `root`; unknown paths without an extension fall back to index.html (the app's routes). */
function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = normalize(join(root, path));
  if (!file.startsWith(normalize(root + sep)) && file !== normalize(root)) { res.writeHead(403).end(); return; }
  let st = statSafe(file);
  if (st?.isDirectory()) { file = join(file, 'index.html'); st = statSafe(file); }
  if (!st && !extname(path)) { file = join(root, 'index.html'); st = statSafe(file); }
  if (!st) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': st.size,
    'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
  createReadStream(file).pipe(res);
}

function statSafe(f: string) { try { return statSync(f); } catch { return undefined; } }

const source = (req: IncomingMessage) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

// ---- Display port ----

export interface Displays {
  /** Sends to a connected display; false when it is not connected. */
  send(id: string, m: ServerMessage): boolean;
  disconnect(id: string): void;
}

export function createDisplayServer(deps: AppDeps, webRoot: string, tls?: { cert: Buffer; key: Buffer }): { server: Server; displays: Displays } {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        const body = await readBody(req);
        const r = deps.devices.redeem(body?.code, source(req));
        if ('error' in r) return send(res, r.status, { error: r.error });
        log.info(`pair: display ${r.device.id} paired (${r.device.room})`);
        return send(res, 200, { deviceId: r.device.id, room: r.device.room, token: r.token });
      }
      if (url.pathname.startsWith('/api/tts_proxy/') && req.method === 'GET') return ttsProxy(deps, req, res, url);
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      serveStatic(webRoot, req, res);
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  };
  const server = tls ? createHttps(tls, handler) : createHttp(handler);
  return { server, displays: attachDisplaySocket(server, deps) };
}

/** TTS audio (`tts-end` gives `/api/tts_proxy/<token>.<ext>`): fetched from HA, only for a paired display. */
async function ttsProxy(deps: AppDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!deps.devices.authenticate(auth)) return send(res, 401, { error: 'device token required' });
  if (!deps.haHttp || !/^\/api\/tts_proxy\/[A-Za-z0-9_.-]+$/.test(url.pathname)) return send(res, 404, { error: 'not found' });
  const r = await fetch(deps.haHttp + url.pathname, { headers: deps.haToken ? { Authorization: `Bearer ${deps.haToken}` } : {} });
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

export const HELLO_TIMEOUT_MS = 5000;

/** `/ws`: hello with a device token first, then the protocol (see protocol.ts). One socket per display. */
export function attachDisplaySocket(server: Server, deps: AppDeps): Displays {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  const sockets = new Map<string, WebSocket>();
  wss.on('connection', (ws) => {
    let device: DeviceRecord | undefined;
    const out = (m: ServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    const timer = setTimeout(() => ws.close(4401, 'hello required'), HELLO_TIMEOUT_MS);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!device) return ws.close(4401, 'hello required');
        const err = deps.relay?.binary(device.id, data as Buffer);
        if (err) out({ type: 'error', code: 'bad_audio', message: err });
        return;
      }
      const m = parseClientMessage(data.toString());
      if ('error' in m) {
        if (!device) return ws.close(4400, m.error);
        return out({ type: 'error', code: 'bad_message', message: m.error });
      }
      if (!device) {
        if (m.type !== 'hello') return ws.close(4401, 'hello required');
        if (m.protocol !== PROTOCOL_VERSION) return ws.close(4426, `protocol ${PROTOCOL_VERSION} required`);
        device = deps.devices.authenticate(m.token);
        if (!device) return ws.close(4401, 'unknown device token');
        clearTimeout(timer);
        sockets.get(device.id)?.close(4409, 'replaced by a newer connection');
        sockets.set(device.id, ws);
        const { room, ...rest } = m.settings;
        if (room) deps.devices.rename(device.id, room);
        deps.settings.merge(device.id, rest); // the display is the source of truth on (re)connect
        const id = device.id;
        deps.relay?.addClient({ key: id, send: out });
        deps.bridge()?.displayOnline({ id, installId: device.installId, room: device.room }, m.appVersion,
          m.deviceModel ?? 'Browser', m.state);
        out({ type: 'welcome', protocol: PROTOCOL_VERSION, deviceId: id, room: device.room,
          settings: { ...deps.settings.get(id), room: device.room }, ha: { connected: deps.relay?.connected ?? false } });
        log.info(`display ${id} connected (${device.room})`);
        return;
      }
      const id = device.id;
      switch (m.type) {
        case 'hello': return out({ type: 'error', code: 'bad_message', message: 'already said hello' });
        case 'settings': {
          const { room, ...rest } = m.values;
          const changed = deps.settings.merge(id, rest);
          if (room && room !== device.room) { deps.devices.rename(id, room); changed.push('room'); }
          deps.bridge()?.settingsChanged(id, changed, { id, installId: device.installId, room: device.room });
          return;
        }
        case 'state': return deps.bridge()?.report(id, m.values);
        case 'event':
          return deps.bridge()?.event(id, m.entity, m.entity === 'announcement'
            ? { event_type: m.eventType, id: m.id, kind: 'announce', ...(m.reason ? { reason: m.reason } : {}) }
            : { event_type: m.eventType });
        case 'ha.call':
          if (!deps.relay) return out({ type: 'ha.result', id: m.id, success: false, error: { code: 'ha_unavailable', message: 'no Home Assistant configured' } });
          return deps.relay.call(id, m.id, m.request);
      }
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (!device || sockets.get(device.id) !== ws) return;
      sockets.delete(device.id);
      deps.relay?.removeClient(device.id);
      deps.bridge()?.displayOffline(device.id);
      log.info(`display ${device.id} disconnected`);
    });
  });
  return {
    send(id, m) {
      const ws = sockets.get(id);
      if (!ws || ws.readyState !== ws.OPEN) return false;
      ws.send(JSON.stringify(m));
      return true;
    },
    disconnect: (id) => sockets.get(id)?.close(4403, 'revoked'),
  };
}

// ---- Ingress port ----

/** The ingress gateway's address (HA docs: accept only the Supervisor, deny everything else). */
export const INGRESS_GATEWAY = '172.30.32.2';

export function createIngressServer(deps: AppDeps, ownerRoot: string, trusted: string[],
  onRevoke: (d: DeviceRecord) => void): Server {
  return createHttp(async (req, res) => {
    if (!trusted.includes(source(req))) { res.writeHead(403).end('forbidden'); return; }
    // Relative URLs only in the page: everything works under the X-Ingress-Path prefix.
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/api/status' && req.method === 'GET') {
        const b = deps.bridge();
        return send(res, 200, {
          ha: deps.relay?.connected ?? false, mqtt: b !== undefined, defaultRoom: deps.defaultRoom ?? 'Living Room',
          devices: deps.devices.list().map((d) => ({ id: d.id, room: d.room, pairedAt: d.pairedAt, online: b?.isOnline(d.id) ?? false })),
          codes: deps.devices.openCodes().map((c) => ({ code: c.code, room: c.room, expiresAt: c.expiresAt })),
        });
      }
      if (url.pathname === '/api/codes' && req.method === 'POST') {
        const body = await readBody(req);
        const r = deps.devices.createCode(String(body?.room ?? ''), body?.installId ? String(body.installId) : undefined);
        return send(res, 'error' in r ? 400 : 200, r);
      }
      const m = /^\/api\/devices\/([0-9a-f]{8})$/.exec(url.pathname);
      if (m && req.method === 'DELETE') {
        const d = deps.devices.get(m[1]!);
        if (!d || !deps.devices.revoke(d.id)) return send(res, 404, { error: 'no such display' });
        deps.settings.delete(d.id);
        onRevoke(d);
        log.info(`pair: display ${d.id} revoked`);
        return send(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      serveStatic(ownerRoot, req, res);
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });
}
