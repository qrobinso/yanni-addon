// The display side of the add-on's `/ws` socket (protocol: server/src/protocol.ts). Hello with the display's settings
// and state (the display is the source of truth on reconnect), welcome, then settings both ways, live state, HA
// commands, the whitelisted `ha.call` relay with replies matched by id, and binary Assist pipeline audio. Reconnects
// with jittered exponential backoff unless the server says the token is no good.
import {
  PROTOCOL_VERSION,
  type AnnouncementOutcome, type ClientMessage, type DisplayState, type EntitySettings, type Gesture, type HaCommand,
  type HaRequest, type ServerMessage,
} from '@yanni/server/protocol';

type Listener<T> = (value: T) => void;

/** A minimal typed event emitter. */
export class Emitter<E extends Record<string, unknown>> {
  private listeners: { [K in keyof E]?: Set<Listener<E[K]>> } = {};
  on<K extends keyof E>(name: K, fn: Listener<E[K]>): () => void {
    (this.listeners[name] ??= new Set()).add(fn);
    return () => this.listeners[name]?.delete(fn);
  }
  emit<K extends keyof E>(name: K, value: E[K]): void {
    for (const fn of this.listeners[name] ?? []) fn(value);
  }
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'unpaired' | 'stopped';

export interface DisplayClientEvents extends Record<string, unknown> {
  status: ConnectionStatus;
  welcome: { deviceId: string; room: string; settings: Partial<EntitySettings>; ha: boolean };
  /** Settings changed elsewhere (or the merged set from welcome). Apply without sending them back. */
  settings: { values: Partial<EntitySettings>; origin: 'welcome' | 'homeassistant' | 'owner' };
  command: HaCommand;
  /** The raw notify payload (the display parses it). */
  announce: string;
  haStatus: boolean;
  error: { code: string; message: string };
}

export class HaCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** The subset of the browser WebSocket the client uses (tests pass a mock). */
export interface SocketLike {
  readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface DisplayClientOptions {
  url: string;
  token: string;
  appVersion: string;
  deviceModel?: string;
  /** The display's current settings and live state, read at each hello. */
  settings: () => Partial<EntitySettings>;
  state?: () => Partial<DisplayState>;
  socket?: (url: string) => SocketLike;
  random?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

/** Close codes after which reconnecting cannot help (server.ts). */
const UNPAIRED = new Set([4401, 4403]);
const FATAL = new Set([4409, 4426]);
const OPEN = 1;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: unknown;
  onEvent?: (event: unknown) => void;
}

export class DisplayClient extends Emitter<DisplayClientEvents> {
  static readonly backoffMin = 500;
  static readonly backoffMax = 30_000;
  static readonly callTimeout = 15_000;

  status: ConnectionStatus = 'disconnected';
  deviceId: string | undefined;
  room: string | undefined;
  haConnected = false;
  /** Consecutive failed attempts (reset by welcome). */
  attempts = 0;

  private ws: SocketLike | undefined;
  private welcomed = false;
  private nextId = 1;
  private calls = new Map<number, Pending>();
  private retry: unknown;
  private stopped = true;

  constructor(private readonly o: DisplayClientOptions) { super(); }

  private get timers() {
    return { set: this.o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)), clear: this.o.clearTimeout ?? ((h) => clearTimeout(h as number)) };
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  /** Closes for good (no reconnect). */
  close(): void {
    this.stopped = true;
    if (this.retry !== undefined) this.timers.clear(this.retry);
    this.retry = undefined;
    this.ws?.close(1000, 'bye');
    this.dropSocket();
    this.setStatus('stopped');
  }

  get connected(): boolean { return this.welcomed && this.ws?.readyState === OPEN; }

  private setStatus(s: ConnectionStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.emit('status', s);
  }

  private open(): void {
    this.retry = undefined;
    this.setStatus('connecting');
    const ws = (this.o.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(this.o.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.welcomed = false;
    ws.onopen = () => this.raw({ type: 'hello', protocol: PROTOCOL_VERSION, token: this.o.token,
      appVersion: this.o.appVersion, ...(this.o.deviceModel ? { deviceModel: this.o.deviceModel } : {}),
      settings: this.o.settings(), ...(this.o.state ? { state: this.o.state() } : {}) });
    ws.onmessage = (e) => { if (typeof e.data === 'string') this.receive(e.data); };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.dropSocket();
      if (this.stopped) return;
      if (UNPAIRED.has(e.code)) { this.stopped = true; this.setStatus('unpaired'); return; }
      if (FATAL.has(e.code)) { this.stopped = true; this.emit('error', { code: `close_${e.code}`, message: e.reason }); this.setStatus('stopped'); return; }
      this.setStatus('disconnected');
      this.attempts += 1;
      this.retry = this.timers.set(() => this.open(), this.backoff());
    };
  }

  /** Full jitter over an exponential cap (0.5 s doubling to 30 s). */
  backoff(): number {
    const cap = Math.min(DisplayClient.backoffMax, DisplayClient.backoffMin * 2 ** Math.max(this.attempts - 1, 0));
    return DisplayClient.backoffMin / 2 + (this.o.random ?? Math.random)() * (cap - DisplayClient.backoffMin / 2);
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = undefined;
    this.welcomed = false;
    if (ws) ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null;
    this.failCalls('disconnected', 'the display socket closed');
  }

  private failCalls(code: string, message: string): void {
    for (const [id, p] of this.calls) {
      this.timers.clear(p.timer);
      p.reject(new HaCallError(code, message));
      this.calls.delete(id);
    }
  }

  private receive(text: string): void {
    let m: ServerMessage;
    try { m = JSON.parse(text) as ServerMessage; } catch { return; }
    switch (m.type) {
      case 'welcome':
        this.welcomed = true;
        this.attempts = 0;
        this.deviceId = m.deviceId;
        this.room = m.room;
        this.haConnected = m.ha.connected;
        this.setStatus('connected');
        this.emit('welcome', { deviceId: m.deviceId, room: m.room, settings: m.settings, ha: m.ha.connected });
        this.emit('settings', { values: m.settings, origin: 'welcome' });
        return;
      case 'settings': return this.emit('settings', { values: m.values, origin: m.origin });
      case 'command':
        if (m.command === 'announce') return this.emit('announce', (m as { payload: string }).payload);
        return this.emit('command', m.command);
      case 'ha.result': {
        const p = this.calls.get(m.id);
        if (!p) return;
        this.timers.clear(p.timer);
        if (!p.onEvent || !m.success) this.calls.delete(m.id);
        if (m.success) p.resolve(m.result); else p.reject(new HaCallError(m.error.code, m.error.message));
        return;
      }
      case 'ha.event': return this.calls.get(m.id)?.onEvent?.(m.event);
      case 'ha.status':
        this.haConnected = m.connected;
        if (!m.connected) this.failCalls('ha_disconnected', 'Home Assistant went away');
        return this.emit('haStatus', m.connected);
      case 'error': return this.emit('error', { code: m.code, message: m.message });
    }
  }

  private raw(m: ClientMessage): boolean {
    if (this.ws?.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  private send(m: ClientMessage): boolean { return this.connected && this.raw(m); }

  // ---- Display -> add-on (dropped while offline: the next hello carries the full settings and state) ----

  sendSettings(values: Partial<EntitySettings>): boolean { return this.send({ type: 'settings', values }); }
  sendState(values: Partial<DisplayState>): boolean { return this.send({ type: 'state', values }); }
  sendGesture(eventType: Gesture): boolean { return this.send({ type: 'event', entity: 'last_gesture', eventType }); }
  sendAnnouncement(eventType: AnnouncementOutcome, id: string, reason?: string): boolean {
    return this.send({ type: 'event', entity: 'announcement', eventType, id, ...(reason ? { reason } : {}) });
  }

  /** One HA WebSocket command through the relay. Rejects with `HaCallError` on an error, a timeout or a disconnect. */
  haCall(request: HaRequest, timeoutMs = DisplayClient.callTimeout): Promise<unknown> {
    return this.call(request, timeoutMs).result;
  }

  /** A subscription (e.g. `assist_pipeline/run`): events arrive on `onEvent` until `close()` or a disconnect. */
  haSubscribe(request: HaRequest, onEvent: (event: unknown) => void, timeoutMs = DisplayClient.callTimeout):
    { id: number; result: Promise<unknown>; close(): void } {
    return this.call(request, timeoutMs, onEvent);
  }

  private call(request: HaRequest, timeoutMs: number, onEvent?: (event: unknown) => void) {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      if (!this.send({ type: 'ha.call', id, request })) {
        reject(new HaCallError('disconnected', 'not connected'));
        return;
      }
      const timer = this.timers.set(() => {
        this.calls.delete(id);
        reject(new HaCallError('timeout', `${request.type} timed out`));
      }, timeoutMs);
      this.calls.set(id, { resolve, reject, timer, onEvent });
    });
    return { id, result, close: () => { const p = this.calls.get(id); if (p) { this.timers.clear(p.timer); this.calls.delete(id); } } };
  }

  /** Assist pipeline STT audio: byte 0 = the run's `stt_binary_handler_id`, then 16-bit LE PCM. No PCM = end of audio. */
  sendAudio(handlerId: number, pcm?: Int16Array): boolean {
    if (!this.connected) return false;
    const n = pcm?.byteLength ?? 0;
    const out = new Uint8Array(1 + n);
    out[0] = handlerId;
    if (pcm) out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, n), 1); // shortcut: assumes a little-endian host (every browser)
    this.ws!.send(out);
    return true;
  }
}
