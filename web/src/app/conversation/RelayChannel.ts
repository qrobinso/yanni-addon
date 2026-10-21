// The orchestrator's Home Assistant channel before and after pairing: the add-on relay (`displayClientChannel`) once a
// `DisplayClient` exists, closed until then. With `?fakeha` the in-process fake Home Assistant (the tests'
// `FakeHomeAssistant`: a jev.ask gate, a streamed two-sentence reply, a fixed transcript and a synthetic-tone TTS)
// stands in, so the whole voice loop runs with no Home Assistant at all (dev only, never in a normal load).
import type { HaRequest } from '@yanni/server/protocol';
import { displayClientChannel, type HAChannel, type HASubscriptionHandle } from '../../conversation/agent/homeassistant/HAChannel';
import type { HAMediaFetching } from '../../conversation/agent/homeassistant/HASpeech';
import type { DisplayClient } from '../DisplayClient';

const notConnected = () => Object.assign(new Error('Home Assistant is not connected'), { code: 'disconnected' });

export class RelayChannel implements HAChannel {
  readonly haVersion: string | null = null;
  private inner: HAChannel | null = null;
  private off: (() => void) | null = null;
  private listeners = new Set<(open: boolean) => void>();

  /** Routes everything through `client` from now on (pairing finished or re-paired). */
  attach(client: DisplayClient | HAChannel): void {
    this.off?.();
    const inner = 'haCall' in client ? displayClientChannel(client) : client;
    this.inner = inner;
    this.off = inner.onOpenChange((open) => this.notify(open));
    this.notify(inner.isOpen);
  }

  get isOpen(): boolean { return this.inner?.isOpen ?? false; }

  call(request: HaRequest, timeoutMs: number): Promise<unknown> {
    return this.inner ? this.inner.call(request, timeoutMs) : Promise.reject(notConnected());
  }

  subscribe(request: HaRequest, onEvent: (event: unknown) => void, timeoutMs: number): HASubscriptionHandle {
    if (this.inner) return this.inner.subscribe(request, onEvent, timeoutMs);
    const result = Promise.reject(notConnected());
    result.catch(() => {});
    return { id: -1, result, close: () => {} };
  }

  sendBinary(handlerId: number, pcm?: Int16Array): boolean { return this.inner?.sendBinary(handlerId, pcm) ?? false; }

  onOpenChange(fn: (open: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(open: boolean): void { for (const l of [...this.listeners]) l(open); }
}

/** `?fakeha`: the fake Home Assistant as the channel and the TTS media source (loaded only when asked for). */
export async function fakeHomeAssistant(): Promise<HAChannel & HAMediaFetching> {
  const { FakeHomeAssistant } = await import('../../../test/conversation/support/FakeHomeAssistant');
  return new FakeHomeAssistant();
}
