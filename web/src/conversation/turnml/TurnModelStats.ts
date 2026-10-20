// Port of ConversationTurnML/TurnModelStats.swift: cheap inference timings for the Status card.
// port-note: single-threaded JS needs no atomics or Mutex.

export interface TurnModelStatsSnapshot {
  vadFrames: number;
  vadLastMs: number;
  vadMeanMs: number;
  vadFailures: number;
  smartTurnRuns: number;
  smartTurnLastMs: number;
  /** Median over the last 20 runs. */
  smartTurnP50Ms: number;
  smartTurnFailures: number;
  /** Model load + warm-up, ms. */
  smartTurnLoadMs: number;
  vadLoadMs: number;
}

export class TurnModelStats {
  static readonly history = 20;
  private vadFrames = 0;
  private vadLast = 0;
  private vadTotal = 0;
  private vadFails = 0;
  private vadLoad = 0;
  private readonly ms = new Float64Array(TurnModelStats.history);
  private next = 0;
  private runs = 0;
  private last = 0;
  private failures = 0;
  private loadMs = 0;

  recordVAD(ms: number): void { this.vadFrames += 1; this.vadLast = ms; this.vadTotal += ms; }
  recordVADFailure(): void { this.vadFails += 1; }
  recordVADLoad(ms: number): void { this.vadLoad = ms; }
  recordSmartTurn(ms: number): void {
    this.ms[this.next] = ms;
    this.next = (this.next + 1) % TurnModelStats.history;
    this.runs += 1;
    this.last = ms;
  }
  recordSmartTurnFailure(): void { this.failures += 1; }
  recordSmartTurnLoad(ms: number): void { this.loadMs = ms; }

  get snapshot(): TurnModelStatsSnapshot {
    const n = Math.min(this.runs, TurnModelStats.history);
    let p50 = 0;
    if (n > 0) {
      const s = Array.from(this.ms.subarray(0, n)).sort((a, b) => a - b);
      p50 = n % 2 === 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
    }
    return {
      vadFrames: this.vadFrames, vadLastMs: this.vadLast, vadMeanMs: this.vadFrames > 0 ? this.vadTotal / this.vadFrames : 0,
      vadFailures: this.vadFails, smartTurnRuns: this.runs, smartTurnLastMs: this.last, smartTurnP50Ms: p50,
      smartTurnFailures: this.failures, smartTurnLoadMs: this.loadMs, vadLoadMs: this.vadLoad,
    };
  }
}

export const nowMs = (): number => performance.now();
