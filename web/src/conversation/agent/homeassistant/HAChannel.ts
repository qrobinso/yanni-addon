// Port of ConversationAgent/HomeAssistant/HAChannel.swift: the Home Assistant WebSocket seam.
// port-note: the display never talks to HA directly. The add-on relays a whitelisted set of HA WebSocket calls
// (server/src/relay.ts) over the display socket (`DisplayClient`), and authenticates upstream itself, so there is no
// URL, token, TLS pin, `auth` handshake or `HAURL` here. `displayClientChannel` is the real channel; tests use
// `FakeHomeAssistant`. Ids are the display's own call ids (the relay maps them upstream).
import type { HaRequest } from '@yanni/server/protocol';
import type { DisplayClient } from '../../../app/DisplayClient';

export type HAErrorKind =
  /** Shown as "token rejected" (unused through the relay: the add-on authenticates). */
  | 'authInvalid'
  /** A `result` with `success: false`. */
  | 'result'
  | 'closed'
  | 'timeout'
  | 'badURL'
  | 'insecureNotAllowed'
  | 'protocolError';

export class HAError extends Error {
  override name = 'HAError';
  constructor(readonly kind: HAErrorKind, readonly code: string | null = null, readonly detail = '') { super(kind); }
  static result(code: string, message: string): HAError { return new HAError('result', code, message); }
  static closed(): HAError { return new HAError('closed'); }
  static timeout(): HAError { return new HAError('timeout'); }
  static protocolError(why: string): HAError { return new HAError('protocolError', null, why); }
}

/** A subscription as the relay hands it back: its id, the `result` (the run accepted) and a local close. */
export interface HASubscriptionHandle {
  id: number;
  result: Promise<unknown>;
  /** Stops routing this subscription's events locally (doesn't tell HA). */
  close(): void;
}

/** The relay as the agent sees it. */
export interface HAChannel {
  /** The display socket is up and the add-on reports Home Assistant connected. */
  readonly isOpen: boolean;
  /** HA's version when known (the relay doesn't say: null, treated as current). */
  readonly haVersion: string | null;
  /** One command; resolves with `result`. Rejects with an error carrying `code` (`HaCallError`). */
  call(request: HaRequest, timeoutMs: number): Promise<unknown>;
  /** A subscribing command (`assist_pipeline/run`): events arrive on `onEvent` until `close()`. */
  subscribe(request: HaRequest, onEvent: (event: unknown) => void, timeoutMs: number): HASubscriptionHandle;
  /** Assist pipeline audio: the handler byte, then 16-bit PCM; no PCM ends the audio. False when not connected. */
  sendBinary(handlerId: number, pcm?: Int16Array): boolean;
  /** Called whenever `isOpen` may have changed. Returns the unsubscribe. */
  onOpenChange(fn: (open: boolean) => void): () => void;
}

type DisplayClientLike = Pick<DisplayClient, 'connected' | 'haConnected' | 'haCall' | 'haSubscribe' | 'sendAudio' | 'on'>;

/** The real channel: `DisplayClient`'s relay calls. */
export function displayClientChannel(client: DisplayClientLike): HAChannel {
  return {
    get isOpen() { return client.connected && client.haConnected; },
    haVersion: null,
    call: (request, timeoutMs) => client.haCall(request, timeoutMs),
    subscribe: (request, onEvent, timeoutMs) => client.haSubscribe(request, onEvent, timeoutMs),
    sendBinary: (handlerId, pcm) => client.sendAudio(handlerId, pcm),
    onOpenChange(fn) {
      const a = client.on('haStatus', () => fn(client.connected && client.haConnected));
      const b = client.on('status', () => fn(client.connected && client.haConnected));
      return () => { a(); b(); };
    },
  };
}
