// Port of YanniKiosk/HangMonitor.swift. Main-thread hang detection (hardening design §6.1). A watcher that is not the
// main thread (here a Worker, HangWatchdog.worker.ts) pings the main thread every 0.5 s and measures the answer:
// - > 250 ms: a hitch event (when the answer arrives);
// - > 2 s: a hang event (once per stall, while still stuck);
// - > 15 s, and only when `restartArmed`: `onRestart` fires.
// The callbacks run where the monitor runs (the worker); the main thread hears of them when it is free again.

export interface HangCounters { hitches: number; hangs: number; longestStall: number }

export class HangMonitor {
  static readonly pingInterval = 0.5;
  static readonly hitchThreshold = 0.25;
  static readonly hangThreshold = 2;
  static readonly restartThreshold = 15;

  onHitch: ((latency: number) => void) | null = null;
  onHang: ((stall: number) => void) | null = null;
  onRestart: ((stall: number) => void) | null = null;
  /// Self-restart on a > 15 s hang (off unless the owner turned it on).
  restartArmed = false;
  readonly counters: HangCounters = { hitches: 0, hangs: 0, longestStall: 0 };

  private outstanding: number | null = null;
  private hangReported = false;
  private restartFired = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  /// `clock`: monotonic seconds. `ping`: delivers a callback to the watched thread.
  constructor(private readonly clock: () => number, private readonly ping: (answer: () => void) => void) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.check(), HangMonitor.pingInterval / 2 * 1000);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.outstanding = null;
  }

  /// One look (the timer calls it every 0.25 s; tests call it directly).
  check(): void {
    const now = this.clock();
    const sent = this.outstanding;
    if (sent === null) {
      this.outstanding = now;
      this.hangReported = false;
      this.ping(() => this.answered(now));
      return;
    }
    const stall = now - sent;
    if (stall > this.counters.longestStall) this.counters.longestStall = stall;
    if (stall > HangMonitor.restartThreshold && this.restartArmed && !this.restartFired) {
      this.restartFired = true;
      this.onRestart?.(stall);
      return;
    }
    if (stall > HangMonitor.hangThreshold && !this.hangReported) {
      this.hangReported = true;
      this.counters.hangs += 1;
      this.onHang?.(stall);
    }
  }

  private answered(sentAt: number): void {
    const latency = this.clock() - sentAt;
    if (this.outstanding !== sentAt) return;
    this.outstanding = null;
    if (latency > HangMonitor.hitchThreshold && !this.hangReported) {
      this.counters.hitches += 1;
      this.onHitch?.(latency);
    }
  }
}

/// Messages between the main thread and HangWatchdog.worker.ts.
export type HangWorkerIn = { kind: 'pong'; id: number } | { kind: 'arm'; armed: boolean } | { kind: 'stop' };
export type HangWorkerOut =
  | { kind: 'ping'; id: number }
  | { kind: 'hitch' | 'hang' | 'restart'; seconds: number; counters: HangCounters };

export interface HangEvents {
  onHitch(latency: number): void;
  onHang(stall: number): void;
  onRestart(stall: number): void;
}

/// The main thread's half: answers the worker's pings at once and relays its events. Also watches long tasks
/// (`PerformanceObserver` 'longtask', Chromium only) as the hitch source when no Worker can start.
export class MainThreadHeartbeat {
  counters: HangCounters = { hitches: 0, hangs: 0, longestStall: 0 };
  private worker: Worker | null = null;
  private observer: PerformanceObserver | null = null;

  constructor(private readonly events: HangEvents) {}

  start(armed: boolean): void {
    if (this.worker || this.observer) return;
    try {
      const w = new Worker(new URL('./HangWatchdog.worker.ts', import.meta.url), { type: 'module', name: 'hang-watchdog' });
      w.onmessage = (e: MessageEvent<HangWorkerOut>) => this.receive(w, e.data);
      w.postMessage({ kind: 'arm', armed } satisfies HangWorkerIn);
      this.worker = w;
    } catch {
      this.observeLongTasks();
    }
  }

  arm(armed: boolean): void { this.worker?.postMessage({ kind: 'arm', armed } satisfies HangWorkerIn); }

  stop(): void {
    this.worker?.postMessage({ kind: 'stop' } satisfies HangWorkerIn);
    this.worker?.terminate();
    this.worker = null;
    this.observer?.disconnect();
    this.observer = null;
  }

  /// Exposed for tests: one message from the worker.
  receive(w: Pick<Worker, 'postMessage'>, m: HangWorkerOut): void {
    if (m.kind === 'ping') { w.postMessage({ kind: 'pong', id: m.id } satisfies HangWorkerIn); return; }
    this.counters = m.counters;
    if (m.kind === 'hitch') this.events.onHitch(m.seconds);
    else if (m.kind === 'hang') this.events.onHang(m.seconds);
    else this.events.onRestart(m.seconds);
  }

  private observeLongTasks(): void {
    if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
    const o = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const s = e.duration / 1000;
        if (s > this.counters.longestStall) this.counters.longestStall = s;
        if (s > HangMonitor.hangThreshold) { this.counters.hangs += 1; this.events.onHang(s); }
        else if (s > HangMonitor.hitchThreshold) { this.counters.hitches += 1; this.events.onHitch(s); }
      }
    });
    o.observe({ type: 'longtask', buffered: false });
    this.observer = o;
  }
}
