// The Home Assistant relay: one upstream WebSocket (ws://supervisor/core/websocket with SUPERVISOR_TOKEN, an admin
// identity), shared by every display. Displays never hold an HA token, so this whitelist IS the security boundary:
// anything not listed here is refused before it leaves the add-on.
import WebSocket from 'ws';
import type { HaRequest, ServerMessage } from './protocol.js';
import { log } from './log.js';

const STAGES = ['stt', 'intent', 'tts'];
const SERVICES: Record<string, string[]> = { jev: ['ask'], ai_task: ['generate_data'] };
const STATE_DOMAINS = ['ai_task', 'conversation', 'stt', 'tts', 'assist_satellite'];

/** Why a request is refused, or undefined when it may go upstream. Pure, so it is tested on its own. */
export function checkRequest(r: HaRequest): string | undefined {
  const keys = Object.keys(r);
  const only = (allowed: string[]) => keys.every((k) => allowed.includes(k));
  switch (r.type) {
    case 'assist_pipeline/run':
      // Text or audio in, the pipeline's own agent and voice out; no wake word stage (that would stream forever).
      if (!STAGES.includes(String(r.start_stage)) || !STAGES.includes(String(r.end_stage))) return 'only the stt, intent and tts stages';
      return undefined;
    case 'assist_pipeline/pipeline/list':
    case 'assist_pipeline/pipeline/get':
    case 'conversation/process':
    case 'conversation/agent/list':
    case 'get_states':
    case 'unsubscribe_events':
    case 'ping': // answered by the add-on itself
      return undefined;
    case 'config_entries/get':
      // Finding the HA-Jev entry (several Jev installs); nothing else about the integrations.
      return r.domain === 'jev' && only(['type', 'domain']) ? undefined : 'config_entries/get is limited to domain jev';
    case 'call_service': {
      if (!only(['type', 'domain', 'service', 'service_data', 'return_response'])) return 'call_service takes no target';
      if (!SERVICES[String(r.domain)]?.includes(String(r.service))) return `service ${String(r.domain)}.${String(r.service)} is not allowed`;
      if (r.return_response !== true) return 'call_service needs return_response: true';
      const data = r.service_data;
      if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) return 'service_data must be an object';
      // AI Task attachments can pull any camera or media in HA into a model: never through the relay.
      if (r.domain === 'ai_task' && data && 'attachments' in data) return 'ai_task attachments are not allowed';
      return undefined;
    }
    default:
      return `${String(r.type).slice(0, 60)} is not allowed`;
  }
}

/** `get_states` trimmed to the entities Yanni's settings pick from (AI Task, conversation agents, STT, TTS). */
export function filterStates(result: unknown): unknown {
  if (!Array.isArray(result)) return [];
  return result
    .filter((s) => typeof s?.entity_id === 'string' && STATE_DOMAINS.includes(s.entity_id.split('.')[0]))
    .map((s) => ({ entity_id: s.entity_id, state: s.state, attributes: { friendly_name: s.attributes?.friendly_name } }));
}

export interface RelayClient {
  /** The device id (one entry per connected display socket). */
  key: string;
  send(msg: ServerMessage): void;
}

interface ClientState {
  client: RelayClient;
  tokens: number;
  refilledAt: number;
  /** Display id -> upstream id, for every call or subscription still open. */
  open: Map<number, number>;
  /** Binary handler ids of this display's running STT stages. */
  handlers: Set<number>;
}

interface Route { cs: ClientState; clientId: number; kind: 'call' | 'run' | 'states'; handler?: number }

export const RATE_BURST = 30;
export const RATE_PER_SECOND = 1;
export const MAX_OPEN = 16;
export const MAX_BINARY = 16 * 1024;

export interface RelayOptions { url: string; token: string; now?: () => number }

export class HaRelay {
  private ws?: WebSocket;
  private ready = false;
  private nextId = 1;
  private routes = new Map<number, Route>();
  private clients = new Map<string, ClientState>();
  private retry = 1;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly opts: RelayOptions) { this.now = opts.now ?? Date.now; }

  get connected(): boolean { return this.ready; }

  start(): void { this.stopped = false; this.open(); }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  addClient(client: RelayClient): void {
    this.removeClient(client.key);
    this.clients.set(client.key, { client, tokens: RATE_BURST, refilledAt: this.now(), open: new Map(), handlers: new Set() });
  }

  /** A display left: its open runs are unsubscribed upstream. */
  removeClient(key: string): void {
    const cs = this.clients.get(key);
    if (!cs) return;
    this.clients.delete(key);
    for (const [, up] of cs.open) {
      const r = this.routes.get(up);
      this.routes.delete(up);
      if (r?.kind === 'run') this.sendUp({ id: this.nextId++, type: 'unsubscribe_events', subscription: up });
    }
  }

  /** One `ha.call` from a display. The answer always comes back as `ha.result` (and `ha.event`s for runs). */
  call(key: string, clientId: number, request: HaRequest): void {
    const cs = this.clients.get(key);
    if (!cs) return;
    const fail = (code: string, message: string) =>
      cs.client.send({ type: 'ha.result', id: clientId, success: false, error: { code, message } });
    const refused = checkRequest(request);
    if (refused) return fail('not_allowed', refused);
    if (!this.take(cs)) return fail('rate_limited', 'too many Home Assistant calls; slow down');
    if (cs.open.has(clientId)) return fail('id_in_use', `id ${clientId} is still open`);
    if (request.type === 'ping') return cs.client.send({ type: 'ha.result', id: clientId, success: true, result: null });
    if (!this.ready) return fail('ha_unavailable', 'Home Assistant is not connected');
    let msg: Record<string, unknown> = { ...request };
    if (request.type === 'unsubscribe_events') {
      // Only the display's own runs, by its own id.
      const up = cs.open.get(Number(request.subscription));
      if (up === undefined || this.routes.get(up)?.kind !== 'run') return fail('not_found', 'no such subscription');
      this.closeRoute(up);
      msg = { type: 'unsubscribe_events', subscription: up };
    } else if (cs.open.size >= MAX_OPEN) {
      return fail('too_many_open', `at most ${MAX_OPEN} open calls`);
    }
    const id = this.nextId++;
    const kind = request.type === 'assist_pipeline/run' ? 'run' : request.type === 'get_states' ? 'states' : 'call';
    this.routes.set(id, { cs, clientId, kind });
    cs.open.set(clientId, id);
    this.sendUp({ ...msg, id });
  }

  /** A binary audio frame: forwarded only to an STT handler of this display's own run. Returns an error or undefined. */
  binary(key: string, data: Buffer): string | undefined {
    const cs = this.clients.get(key);
    if (!cs || data.length < 1 || data.length > MAX_BINARY) return 'bad audio frame';
    if (!cs.handlers.has(data[0]!) || !this.ready) return 'no such audio handler';
    this.ws!.send(data, { binary: true });
    return undefined;
  }

  // ---- Upstream ----

  private take(cs: ClientState): boolean {
    const t = this.now();
    cs.tokens = Math.min(RATE_BURST, cs.tokens + ((t - cs.refilledAt) / 1000) * RATE_PER_SECOND);
    cs.refilledAt = t;
    if (cs.tokens < 1) return false;
    cs.tokens -= 1;
    return true;
  }

  private sendUp(m: Record<string, unknown>): void {
    if (this.ready) this.ws!.send(JSON.stringify(m));
  }

  private open(): void {
    const ws = new WebSocket(this.opts.url, { maxPayload: 32 * 1024 * 1024 });
    this.ws = ws;
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, 30_000).unref();
    ws.on('pong', () => { alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m: any;
      try { m = JSON.parse(data.toString()); } catch { return; }
      for (const x of Array.isArray(m) ? m : [m]) this.handle(x);
    });
    ws.on('error', (e) => log.warn(`ha: ${e.message}`));
    ws.on('close', () => {
      clearInterval(ping);
      const was = this.ready;
      this.ready = false;
      this.dropAll();
      if (was) { log.warn('ha: disconnected'); this.broadcast({ type: 'ha.status', connected: false }); }
      if (this.stopped) return;
      this.timer = setTimeout(() => this.open(), this.retry * 1000).unref();
      this.retry = Math.min(this.retry * 2, 30);
    });
  }

  private handle(m: any): void {
    switch (m?.type) {
      case 'auth_required':
        this.ws!.send(JSON.stringify({ type: 'auth', access_token: this.opts.token }));
        return;
      case 'auth_ok':
        this.ready = true;
        this.retry = 1;
        log.info(`ha: connected (Home Assistant ${m.ha_version ?? '?'})`);
        this.broadcast({ type: 'ha.status', connected: true });
        return;
      case 'auth_invalid':
        log.warn('ha: token refused; check SUPERVISOR_TOKEN / HA_TOKEN');
        this.retry = 30;
        this.ws!.close();
        return;
      case 'result': {
        const r = this.routes.get(m.id);
        if (!r) return;
        if (r.kind !== 'run' || !m.success) this.closeRoute(m.id);
        r.cs.client.send(m.success
          ? { type: 'ha.result', id: r.clientId, success: true, result: r.kind === 'states' ? filterStates(m.result) : m.result ?? null }
          : { type: 'ha.result', id: r.clientId, success: false,
              error: { code: String(m.error?.code ?? 'unknown_error'), message: String(m.error?.message ?? '') } });
        return;
      }
      case 'event': {
        const r = this.routes.get(m.id);
        if (!r) return;
        const ev = m.event;
        const h = ev?.type === 'run-start' ? ev?.data?.runner_data?.stt_binary_handler_id : undefined;
        if (Number.isInteger(h) && h >= 0 && h <= 255) {
          r.handler = h;
          r.cs.handlers.add(h);
        }
        r.cs.client.send({ type: 'ha.event', id: r.clientId, event: ev });
        if (ev?.type === 'run-end') this.closeRoute(m.id);
        return;
      }
    }
  }

  private closeRoute(up: number): void {
    const r = this.routes.get(up);
    if (!r) return;
    this.routes.delete(up);
    r.cs.open.delete(r.clientId);
    if (r.handler !== undefined) r.cs.handlers.delete(r.handler);
  }

  private dropAll(): void {
    for (const [up, r] of this.routes) {
      if (r.kind !== 'run') {
        r.cs.client.send({ type: 'ha.result', id: r.clientId, success: false,
          error: { code: 'ha_unavailable', message: 'Home Assistant disconnected' } });
      }
      this.closeRoute(up);
    }
  }

  private broadcast(m: ServerMessage): void { for (const cs of this.clients.values()) cs.client.send(m); }
}
