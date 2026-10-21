// Port of ConversationAgent/AgentTunables.swift: the services health card, the orchestrator's clock and timeouts.
// port-note: Swift structured concurrency becomes promises plus `AbortSignal` for cancellation. A cancelled operation
// rejects with `CancellationError`; `withAgentTimeout` aborts the operation's signal when the time runs out.
export type { AgentTunables } from '../core/VoiceServicesEndpoint';
export { clampedAgentTunables, makeAgentTunables } from '../core/VoiceServicesEndpoint';

export type ServicesHealthState = 'unknown' | 'up' | 'down' | 'preparing' | 'not used' | 'not configured';

/** One state per integration, for the Status card and the HA diagnostic sensor (design §13.3–§13.4). */
export interface ServicesHealth {
  homeAssistant: ServicesHealthState;
  asr: ServicesHealthState;
  tts: ServicesHealthState;
  jev: ServicesHealthState;
  haVersion: string | null;
  asrProgram: string | null;
  /** Why speech recognition can't be used yet; never anything said. */
  asrDetail: string | null;
  ttsProgram: string | null;
  /** The last Pass A round trip (ms) and Jev's own `latency_ms` (HA → backend). */
  jevRoundTripMs: number | null;
  jevLatencyMs: number | null;
  /** The decision breaker is open (calls paused). */
  breakerOpen: boolean;
  /** The agent path in use: "streamed" (assist_pipeline/run) or "whole" (conversation/process). */
  agentPath: string | null;
  asrRoute: string | null;
  ttsRoute: string | null;
  /** Through HA: the pipeline the speech voice runs on. */
  pipelineName: string | null;
}

export const makeServicesHealth = (h: Partial<ServicesHealth> = {}): ServicesHealth => ({
  homeAssistant: 'unknown', asr: 'unknown', tts: 'unknown', jev: 'unknown', haVersion: null, asrProgram: null,
  asrDetail: null, ttsProgram: null, jevRoundTripMs: null, jevLatencyMs: null, breakerOpen: false, agentPath: null,
  asrRoute: null, ttsRoute: null, pipelineName: null, ...h,
});

/** A cancelled task (Swift `CancellationError`). */
export class CancellationError extends Error {
  override name = 'CancellationError';
}

/** `withAgentTimeout` ran out. */
export class AgentTimeout extends Error {
  override name = 'AgentTimeout';
}

/** Host-seconds time and sleeping for the orchestrator. The system clock in the app; a manual one in tests. */
export interface AgentClock {
  /** Host seconds (the same base as audio host times and the controller's clock). */
  now(): number;
  /** Sleeps `seconds`; rejects with `CancellationError` when `signal` aborts. */
  sleep(seconds: number, signal?: AbortSignal): Promise<void>;
}

/** Throws `CancellationError` if the signal has aborted (Swift `Task.checkCancellation`). */
export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancellationError();
}

/** `performance.now()` in seconds and `setTimeout`. */
export class SystemAgentClock implements AgentClock {
  now(): number { return SystemAgentClock.hostSeconds(); }
  sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new CancellationError()); return; }
      if (!(seconds > 0)) { resolve(); return; }
      const onAbort = () => { clearTimeout(h); reject(new CancellationError()); };
      const h = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, seconds * 1000);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  static hostSeconds(): number { return performance.now() / 1000; }
}

/** A child signal: aborts when `parent` does, or when `abort()` is called. */
export function childController(parent?: AbortSignal): AbortController {
  const c = new AbortController();
  if (parent) {
    if (parent.aborted) c.abort();
    else {
      const on = () => c.abort();
      parent.addEventListener('abort', on, { once: true });
      // A long-lived parent (the HA ping's, for weeks) must not keep every finished child.
      c.signal.addEventListener('abort', () => parent.removeEventListener('abort', on), { once: true });
    }
  }
  return c;
}

/** Runs `operation`, or rejects with `AgentTimeout` when `seconds` pass first (the operation's signal aborts). */
export async function withAgentTimeout<T>(seconds: number, clock: AgentClock,
  operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const c = childController(signal);
  checkCancellation(c.signal);
  try {
    return await Promise.race([
      operation(c.signal),
      clock.sleep(seconds, c.signal).then(() => { throw new AgentTimeout(); }),
    ]);
  } finally {
    c.abort();
  }
}
