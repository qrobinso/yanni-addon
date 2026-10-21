// Port of ConversationTestSupport/AgentTestKit.swift.
import { CancellationError, type AgentClock } from '../../../src/conversation/agent/AgentTunables';
import type {
  ConversationContextPublishing, ConversationContextSnapshot, ReplyPlayoutSink, TurnAudioSource,
} from '../../../src/conversation/agent/Ports';

/** An unbounded async queue with close; `pop` resolves null once closed (in-memory sockets for the fake servers). */
export class AsyncMailbox<T> {
  private items: T[] = [];
  private waiters: ((v: T | null) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w(item); else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }

  get isClosed(): boolean { return this.closed; }

  /** The next item; null once closed and drained. */
  pop(): Promise<T | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** A manual host clock: `sleep` resolves once `advance` passes its deadline (or rejects when aborted). */
export class ManualAgentClock implements AgentClock {
  private t: number;
  private sleepers = new Map<number, { deadline: number; resolve: () => void }>();
  private next = 0;
  constructor(now = 1000) { this.t = now; }

  now(): number { return this.t; }

  sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new CancellationError());
    if (seconds <= 0) return Promise.resolve();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.sleepers.delete(id); reject(new CancellationError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.sleepers.set(id, { deadline: this.t + seconds, resolve: () => { signal?.removeEventListener('abort', onAbort); resolve(); } });
    });
  }

  /** Moves time forward and wakes every sleeper whose deadline passed. */
  advance(seconds: number): void {
    this.t += seconds;
    for (const [id, s] of [...this.sleepers]) {
      if (s.deadline <= this.t + 1e-9) { this.sleepers.delete(id); s.resolve(); }
    }
  }

  get pendingSleepers(): number { return this.sleepers.size; }
}

/** Lets queued work run (a few macrotask hops, each draining the microtasks). */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Polls `condition` for up to `seconds` of real time. */
export async function eventually(condition: () => boolean | Promise<boolean>, seconds = 3): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await settle(2);
  }
  return condition();
}

/** Swift `Int16(truncatingIfNeeded:)`. */
export const int16 = (i: number): number => ((((i + 32768) % 65536) + 65536) % 65536) - 32768;

/** 16 kHz Int16 turn audio from a counter: sample `i` has the value `int16(i)`, so a test can tell exactly which
 *  samples reached the recogniser. `writeIndex` advances as the test "captures". */
export class FakeTurnAudioSource implements TurnAudioSource {
  private start: number | null = null;
  private write = 0;
  private endHost = 0;
  get sampleRate(): number { return 16000; }

  /** The mic opens (a new readable range starts at the current index) at host time `t`. */
  open(t: number): void { this.start = this.write; this.endHost = t; }
  /** `seconds` of audio captured, ending at host time `t`. */
  capture(seconds: number, t: number): void {
    if (this.start === null) this.start = this.write;
    this.write += Math.round(seconds * 16000);
    this.endHost = t;
  }
  get writeIndex(): number { return this.write; }

  readableRange(): { lower: number; upper: number } | null {
    return this.start !== null && this.start < this.write ? { lower: this.start, upper: this.write } : null;
  }
  sampleIndex(hostTime: number): number | null {
    if (this.start === null) return null;
    const d = (hostTime - this.endHost) * 16000;
    return this.write + Math.sign(d) * Math.round(Math.abs(d));
  }
  read(from: number, maxFrames: number): { samples: Int16Array; start: number } {
    if (this.start === null) return { samples: new Int16Array(0), start: from };
    const a = Math.max(from, this.start);
    if (!(a < this.write) || maxFrames <= 0) return { samples: new Int16Array(0), start: a };
    const n = Math.min(maxFrames, this.write - a);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = int16(a + i);
    return { samples: out, start: a };
  }
}

/** The playout queue as the spoken voicer sees it: counts frames, optionally refuses (flushed). */
export class FakePlayoutSink implements ReplyPlayoutSink {
  framesQueued = 0;
  enqueues = 0;
  private accepting = true;
  constructor(readonly outputSampleRate = 48000) {}
  async enqueue(frames: Float32Array): Promise<boolean> {
    if (!this.accepting) return false;
    this.framesQueued += frames.length;
    this.enqueues += 1;
    return true;
  }
  setAccepting(on: boolean): void { this.accepting = on; }
}

/** Records the R2 context snapshots. */
export class RecordingContextPublisher implements ConversationContextPublishing {
  published: ConversationContextSnapshot[] = [];
  publish(context: ConversationContextSnapshot): void { this.published.push(context); }
}
