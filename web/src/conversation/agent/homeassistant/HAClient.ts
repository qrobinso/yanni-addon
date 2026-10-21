// Port of ConversationAgent/HomeAssistant/HAClient.swift. The Home Assistant WebSocket API subset Yanni uses (design
// §21 V7): request/response, subscriptions with `unsubscribe_events` to cancel, and a 30 s ping with a 10 s pong
// deadline. One instance per connection; a closed client is not reused (the controller's backoff reconnects through a
// new one).
// port-note: implemented over the add-on relay (`HAChannel`): no socket of its own, no auth handshake (the add-on
// authenticates), ids are the relay's; HA's version is unknown through the relay ('' = treated as current). The actor
// becomes a class; cancellation is an `AbortSignal`.
import type { HaRequest } from '@yanni/server/protocol';
import { CancellationError, SystemAgentClock, withAgentTimeout, type AgentClock } from '../AgentTunables';
import type { HAEndpoint } from '../../core/VoiceServicesEndpoint';
import type { JSONObject, JSONValue } from '../JSONValue';
import { HAError, type HAChannel, type HASubscriptionHandle } from './HAChannel';

/** A subscription's events, read one at a time. Finishes when the run ends, is unsubscribed or the channel closes
 *  (then with `HAError.closed`). */
export class HAEventStream {
  private items: JSONValue[] = [];
  private finished = false;
  private error: unknown = null;
  private waiters: { resolve: (v: JSONValue | null) => void; reject: (e: unknown) => void }[] = [];

  push(v: JSONValue): void {
    if (this.finished) return;
    const w = this.waiters.shift();
    if (w) w.resolve(v); else this.items.push(v);
  }

  finish(error: unknown = null): void {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) if (error !== null) w.reject(error); else w.resolve(null);
  }

  /** The next event; null once finished and drained. Rejects with the finishing error, or `CancellationError` when
   *  `signal` aborts (the waiter is removed, so nothing is lost). */
  next(signal?: AbortSignal): Promise<JSONValue | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift()!);
    if (this.finished) return this.error !== null ? Promise.reject(this.error) : Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(new CancellationError());
    return new Promise((resolve, reject) => {
      const w = {
        resolve: (v: JSONValue | null) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
        reject: (e: unknown) => { signal?.removeEventListener('abort', onAbort); reject(e); },
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new CancellationError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(w);
    });
  }
}

export interface HASubscription { id: number; events: HAEventStream }

/** A relay error (`HaCallError`: `code` + `message`) → `HAError`. */
export function haErrorOf(e: unknown): HAError {
  if (e instanceof HAError) return e;
  const code = (e as { code?: unknown } | null)?.code;
  const message = (e as { message?: unknown } | null)?.message;
  if (typeof code !== 'string') return HAError.closed();
  switch (code) {
    case 'disconnected': case 'ha_disconnected': case 'ha_unavailable': return HAError.closed();
    case 'timeout': return HAError.timeout();
    default: return HAError.result(code, typeof message === 'string' ? message : '');
  }
}

export class HAClient {
  /** The relay's own backstop for one request (the callers time their calls themselves). */
  static readonly relayTimeoutMs = 120_000;

  private subscriptions = new Map<number, { stream: HAEventStream; handle: HASubscriptionHandle }>();
  private failPending = new Set<(e: unknown) => void>();
  private pingAbort: AbortController | null = null;
  private offOpen: (() => void) | null = null;
  private connected = false;
  private isClosed = false;
  private onClosed: ((e: HAError) => void) | null = null;
  haVersion: string | null = null;

  constructor(readonly channel: HAChannel, readonly clock: AgentClock = new SystemAgentClock()) {}

  /** Called once when the channel closes or the keep-alive fails after a successful `connect`. */
  setOnClosed(handler: ((e: HAError) => void) | null): void { this.onClosed = handler; }

  /** Checks the relay is up. Returns HA's version ('' when unknown). Throws `HAError`.
   *  port-note: `ep` names the relay only; there's nothing to open or authenticate, so `timeout` is unused. */
  async connect(_ep: HAEndpoint, _timeout: number, pingInterval: number, pongTimeout: number): Promise<string> {
    if (this.isClosed || !this.channel.isOpen) { this.isClosed = true; throw HAError.closed(); }
    const version = this.channel.haVersion ?? '';
    this.haVersion = version;
    this.connected = true;
    this.offOpen = this.channel.onOpenChange((open) => { if (!open) this.shutdown(HAError.closed(), true); });
    this.startPing(pingInterval, pongTimeout);
    return version;
  }

  // MARK: Requests

  /** Sends `{type, …payload}` and returns `result` (null when absent). Throws `HAError.result` on failure. */
  call(type: string, payload: JSONObject = {}, signal?: AbortSignal): Promise<JSONValue> {
    if (!this.connected || this.isClosed) return Promise.reject(HAError.closed());
    const request = { ...payload, type } as HaRequest;
    return this.guard(this.channel.call(request, HAClient.relayTimeoutMs), signal).then((r) => (r ?? null) as JSONValue);
  }

  /** Sends a subscribing command; resolves once HA accepted it (`result` success). Events then flow on the stream. */
  async subscribe(type: string, payload: JSONObject, signal?: AbortSignal): Promise<HASubscription> {
    if (!this.connected || this.isClosed) throw HAError.closed();
    const stream = new HAEventStream();
    const handle = this.channel.subscribe({ ...payload, type } as HaRequest, (e) => stream.push((e ?? null) as JSONValue),
      HAClient.relayTimeoutMs);
    this.subscriptions.set(handle.id, { stream, handle });
    try {
      await this.guard(handle.result, signal);
    } catch (e) {
      this.subscriptions.delete(handle.id);
      handle.close();
      stream.finish(e);
      throw e;
    }
    return { id: handle.id, events: stream };
  }

  /** Cancels a subscription (for a pipeline run this cancels HA's run task). Local events stop at once. */
  async unsubscribe(id: number): Promise<void> {
    // Sent even when the local stream already ended (a cancelled reader may have closed it first).
    const s = this.subscriptions.get(id);
    this.subscriptions.delete(id);
    s?.stream.finish();
    if (!this.connected || this.isClosed) { s?.handle.close(); return; }
    try {
      await this.channel.call({ type: 'unsubscribe_events', subscription: id }, HAClient.relayTimeoutMs);
    } catch { /* the run may have ended already */ }
    s?.handle.close();
  }

  /** A binary frame (a speech-to-text run's audio: the handler id byte, then PCM; no PCM ends the audio). */
  async sendBinary(handlerId: number, pcm?: Int16Array): Promise<void> {
    if (!this.connected || this.isClosed) throw HAError.closed();
    if (!this.channel.sendBinary(handlerId, pcm)) throw HAError.closed();
  }

  /** Ends a subscription's stream without telling HA (the run already ended). */
  endSubscription(id: number): void {
    const s = this.subscriptions.get(id);
    this.subscriptions.delete(id);
    s?.stream.finish();
    s?.handle.close();
  }

  close(): void { this.shutdown(HAError.closed(), false); }

  get isConnected(): boolean { return this.connected && !this.isClosed; }

  // MARK: Internals

  /** The relay's answer, or a rejection on cancellation or shutdown. */
  private guard(p: Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new CancellationError());
    return new Promise((resolve, reject) => {
      const fail = (e: unknown) => { cleanup(); reject(e); };
      const onAbort = () => fail(new CancellationError());
      const cleanup = () => { this.failPending.delete(fail); signal?.removeEventListener('abort', onAbort); };
      this.failPending.add(fail);
      signal?.addEventListener('abort', onAbort, { once: true });
      p.then((v) => { cleanup(); resolve(v); }, (e) => fail(haErrorOf(e)));
    });
  }

  private startPing(interval: number, pongTimeout: number): void {
    if (!(interval > 0)) return;
    const c = new AbortController();
    this.pingAbort = c;
    void (async () => {
      while (!c.signal.aborted) {
        try { await this.clock.sleep(interval, c.signal); } catch { return; }
        try {
          await withAgentTimeout(pongTimeout, this.clock, (s) => this.call('ping', {}, s), c.signal);
        } catch (e) {
          if (e instanceof CancellationError || c.signal.aborted) return;
          this.shutdown(HAError.timeout(), true);
          return;
        }
      }
    })();
  }

  private shutdown(error: HAError, notify: boolean): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.offOpen?.();
    this.offOpen = null;
    this.pingAbort?.abort();
    for (const f of [...this.failPending]) f(HAError.closed());
    this.failPending.clear();
    for (const [, s] of this.subscriptions) { s.stream.finish(HAError.closed()); s.handle.close(); }
    this.subscriptions.clear();
    if (notify && this.haVersion !== null) this.onClosed?.(error);
  }
}
