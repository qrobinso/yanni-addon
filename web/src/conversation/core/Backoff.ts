// Port of ConversationCore/Backoff.swift.

/** Reconnect delays: 1, 2, 4 … 30 s, each jittered by ±`jitter` (fraction). Reset on a ready session. */
export class Backoff {
  private _failures = 0;

  /** `random`: uniform 0…1 source (injected for deterministic tests). */
  constructor(o: { base?: number; cap?: number; jitter?: number; random?: () => number } = {}) {
    this.base = o.base ?? 1;
    this.cap = o.cap ?? 30;
    this.jitter = o.jitter ?? 0.2;
    this.random = o.random ?? Math.random;
  }
  base: number;
  cap: number;
  jitter: number;
  private random: () => number;

  get failures(): number { return this._failures; }

  /** The delay before the next attempt after one more failure. */
  nextDelay(): number {
    const raw = Math.min(this.base * 2 ** Math.min(this._failures, 16), this.cap);
    this._failures += 1;
    const j = 1 + this.jitter * (2 * Math.min(Math.max(this.random(), 0), 1) - 1);
    return Math.max(raw * j, 0.1);
  }

  reset(): void { this._failures = 0; }
}
