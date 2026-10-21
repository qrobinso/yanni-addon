// The two listeners. Display port (HTTPS when a cert is configured): the kiosk app, pairing, the display socket and
// the TTS audio proxy. Ingress port (HTTP, only from the Supervisor's ingress gateway): the owner pages.
import { createReadStream, statSync } from 'node:fs';
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, PROTOCOL_VERSION, SETTINGS_CHECKS, type DisplayStatus, type EntitySettings,
  type ServerMessage } from './protocol.js';
import { SETTING_DEFAULTS } from './settingsSchema.js';
import { parseAnnounce } from './announce.js';
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
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.tflite': 'application/octet-stream', '.binarypb': 'application/octet-stream',
};

/** Cross-origin isolation for the kiosk app (SharedArrayBuffer: onnxruntime-web's wasm threads). Every subresource is
 *  same-origin, so require-corp costs nothing; CORP marks our own files as same-origin only. */
export const ISOLATION_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
} as const;

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
function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, extra: Record<string, string> = {}): void {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = normalize(join(root, path));
  if (!file.startsWith(normalize(root + sep)) && file !== normalize(root)) { res.writeHead(403).end(); return; }
  let st = statSafe(file);
  if (st?.isDirectory()) { file = join(file, 'index.html'); st = statSafe(file); }
  if (!st && !extname(path)) { file = join(root, 'index.html'); st = statSafe(file); }
  if (!st) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { ...extra, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': st.size,
    'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
  createReadStream(file).pipe(res);
}

function statSafe(f: string) { try { return statSync(f); } catch { return undefined; } }

const source = (req: IncomingMessage) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

// ---- Display port ----

export interface Displays {
  /** Sends to a connected display; false when it is not connected. */
  send(id: string, m: ServerMessage): boolean;
  disconnect(id: string): void;
  /** The last hello and state reports (kept after a disconnect until revoked; memory only). */
  status(id: string): DisplayStatus | undefined;
}

/** Text frames per display socket per 10 s (state at 4 Hz, settings, events, relay calls). Audio frames don't count. */
export const SOCKET_MESSAGES_PER_10S = 200;
/** Sockets that haven't said hello yet (each lives at most HELLO_TIMEOUT_MS). */
export const MAX_PENDING_SOCKETS = 32;

/** Stores settings from the display or the owner pages, renames, tells MQTT, and (owner) tells the display.
 *  Returns the keys that changed. Values are validated by the caller. */
export function applySettings(deps: AppDeps, displays: Displays | undefined, id: string, values: Partial<EntitySettings>,
  origin: 'display' | 'owner'): (keyof EntitySettings)[] {
  const d = deps.devices.get(id);
  if (!d) return [];
  const { room, ...rest } = values;
  const changed = deps.settings.merge(id, rest);
  if (room !== undefined && room !== d.room) { deps.devices.rename(id, room); changed.push('room'); }
  if (!changed.length) return changed;
  deps.bridge()?.settingsChanged(id, changed, { id, installId: d.installId, room: d.room });
  if (origin === 'owner') {
    const out = Object.fromEntries(changed.map((k) => [k, values[k]])) as Partial<EntitySettings>;
    displays?.send(id, { type: 'settings', values: out, origin: 'owner' });
  }
  return changed;
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
      serveStatic(webRoot, req, res, ISOLATION_HEADERS);
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
  const statuses = new Map<string, DisplayStatus>();
  let pending = 0;
  const displays: Displays = {
    send(id, m) {
      const ws = sockets.get(id);
      if (!ws || ws.readyState !== ws.OPEN) return false;
      ws.send(JSON.stringify(m));
      return true;
    },
    disconnect: (id) => { statuses.delete(id); sockets.get(id)?.close(4403, 'revoked'); },
    status: (id) => statuses.get(id),
  };
  wss.on('connection', (ws) => {
    if (pending >= MAX_PENDING_SOCKETS) { ws.close(4429, 'too many connections'); return; }
    pending += 1;
    let device: DeviceRecord | undefined;
    const out = (m: ServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    const timer = setTimeout(() => ws.close(4401, 'hello required'), HELLO_TIMEOUT_MS);
    let waiting = true;
    const settle = () => { if (waiting) { waiting = false; pending -= 1; clearTimeout(timer); } };
    let windowStart = Date.now(), count = 0;
    ws.on('message', (data, isBinary) => {
      if (device) {
        const st = statuses.get(device.id);
        if (st) st.lastSeenAt = new Date().toISOString();
      }
      if (!isBinary) {
        const t = Date.now();
        if (t - windowStart >= 10_000) { windowStart = t; count = 0; }
        if (++count > SOCKET_MESSAGES_PER_10S) return ws.close(4429, 'too many messages');
      }
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
        settle();
        sockets.get(device.id)?.close(4409, 'replaced by a newer connection');
        sockets.set(device.id, ws);
        const { room, ...rest } = m.settings;
        if (room) deps.devices.rename(device.id, room);
        deps.settings.merge(device.id, rest); // the display is the source of truth on (re)connect
        const id = device.id;
        const now = new Date().toISOString();
        statuses.set(id, { online: true, appVersion: m.appVersion, deviceModel: m.deviceModel ?? 'Browser', connectedAt: now,
          lastSeenAt: now, state: { ...m.state } });
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
        case 'settings': applySettings(deps, displays, id, m.values, 'display'); return;
        case 'state':
          Object.assign(statuses.get(id)?.state ?? {}, m.values);
          return deps.bridge()?.report(id, m.values);
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
      settle();
      if (!device || sockets.get(device.id) !== ws) return;
      sockets.delete(device.id);
      const st = statuses.get(device.id);
      if (st) st.online = false;
      deps.relay?.removeClient(device.id);
      deps.bridge()?.displayOffline(device.id);
      log.info(`display ${device.id} disconnected`);
    });
  });
  return displays;
}

// ---- Ingress port ----

/** The ingress gateway's address (HA docs: accept only the Supervisor, deny everything else). */
export const INGRESS_GATEWAY = '172.30.32.2';

/** The owner pages' security headers: same-origin everything; HA's frontend frames the page (same origin). */
const OWNER_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
};

/** A JSON body only (a cross-site form can't send application/json without a CORS preflight, which is never granted). */
async function readJson(req: IncomingMessage): Promise<any> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('JSON required'), { status: 415 });
  return readBody(req);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createIngressServer(deps: AppDeps, ownerRoot: string, trusted: string[],
  onRevoke: (d: DeviceRecord) => void, displays?: Displays): Server {
  return createHttp(async (req, res) => {
    if (!trusted.includes(source(req))) { res.writeHead(403).end('forbidden'); return; }
    // Relative URLs only in the pages: everything works under the X-Ingress-Path prefix.
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/api/status' && req.method === 'GET') {
        const b = deps.bridge();
        return send(res, 200, {
          ha: deps.relay?.connected ?? false, mqtt: b !== undefined, defaultRoom: deps.defaultRoom ?? 'Living Room',
          devices: deps.devices.list().map((d) => ({ id: d.id, room: d.room, pairedAt: d.pairedAt,
            online: displays?.status(d.id)?.online ?? b?.isOnline(d.id) ?? false })),
          codes: deps.devices.openCodes().map((c) => ({ code: c.code, room: c.room, expiresAt: c.expiresAt })),
        });
      }
      if (url.pathname === '/api/codes' && req.method === 'POST') {
        const body = await readJson(req);
        const r = deps.devices.createCode(String(body?.room ?? ''), body?.installId ? String(body.installId) : undefined);
        return send(res, 'error' in r ? 400 : 200, r);
      }
      const m = /^\/api\/devices\/([0-9a-f]{8})(\/settings|\/announce)?$/.exec(url.pathname);
      const d = m ? deps.devices.get(m[1]!) : undefined;
      if (m && !d) return send(res, 404, { error: 'no such display' });
      if (d && !m![2] && req.method === 'GET') {
        return send(res, 200, {
          device: { id: d.id, room: d.room, pairedAt: d.pairedAt },
          settings: { ...SETTING_DEFAULTS, ...deps.settings.get(d.id), room: d.room },
          status: displays?.status(d.id) ?? null,
        });
      }
      if (d && !m![2] && req.method === 'DELETE') {
        if (!deps.devices.revoke(d.id)) return send(res, 404, { error: 'no such display' });
        deps.settings.delete(d.id);
        onRevoke(d);
        log.info(`pair: display ${d.id} revoked`);
        return send(res, 200, { ok: true });
      }
      if (d && m![2] === '/settings' && req.method === 'PUT') {
        const body = await readJson(req);
        const values = body?.values;
        if (!isObj(values) || !Object.keys(values).length) return send(res, 400, { error: 'values required' });
        for (const [k, v] of Object.entries(values)) {
          if (!Object.hasOwn(SETTINGS_CHECKS, k)) return send(res, 400, { error: `unknown setting ${k.slice(0, 40)}`, key: k.slice(0, 40) });
          if (!SETTINGS_CHECKS[k as keyof EntitySettings](v)) return send(res, 400, { error: `invalid value for ${k}`, key: k });
        }
        // Consent rule (as from Home Assistant): the owner pages may turn room understanding off, never on.
        if (values.room_understanding === true) return send(res, 400, { error: 'only the display can turn room understanding on', key: 'room_understanding' });
        const changed = applySettings(deps, displays, d.id, values as Partial<EntitySettings>, 'owner');
        return send(res, 200, { changed, settings: { ...SETTING_DEFAULTS, ...deps.settings.get(d.id), room: deps.devices.get(d.id)!.room } });
      }
      if (d && m![2] === '/announce' && req.method === 'POST') {
        const body = await readJson(req);
        const minutes = deps.settings.get(d.id).announcement_expiry_minutes ?? SETTING_DEFAULTS.announcement_expiry_minutes;
        const cmd = parseAnnounce(JSON.stringify({ ...(isObj(body) ? body : {}), kind: 'announce' }), minutes * 60);
        if (cmd.kind === 'rejected') return send(res, 400, { error: cmd.reason });
        if (!displays?.send(d.id, { type: 'command', command: 'announce', announce: cmd })) return send(res, 409, { error: 'the display is not connected' });
        log.info(`owner: test announcement for ${d.id}`);
        return send(res, 200, { ok: true, id: cmd.kind === 'announce' ? cmd.announcement.id : '' });
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      serveStatic(ownerRoot, req, res, OWNER_HEADERS);
    } catch (e) {
      send(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message });
    }
  });
}
