// Port of ConversationAudio/AsrAudioTap.swift (+ ConversationAgent/AsrAudioTap+TurnAudioSource.swift). The 16 kHz
// mono Int16 ring the ASR audio is taken from (direct Home Assistant design §6.2). Fed with the same 16 kHz frames turn
// detection gets (`ConversationAudio.onFrame`); the orchestrator reads it. Preallocated (8 s); indexed by absolute
// sample number since launch, with the host time of the newest sample. It only receives samples while the mic is
// open, so its privacy gate is turn detection's. A discontinuity (mic reopened) starts a new readable range.
// port-note: single-threaded, so no lock. The app calls `noteDiscontinuity()` whenever the mic (re)opens.
import type { TurnAudioSource } from '../agent/Ports';

export class AsrAudioTap implements TurnAudioSource {
  static readonly rate = 16000;
  readonly capacity: number;
  private readonly ring: Int16Array;
  /** Next absolute index to write. */
  private writeIndex = 0;
  /** First index of the current continuous stream (since the mic opened or the last gap); null = none yet. */
  private streamStart: number | null = null;
  /** Host time just after the newest sample. */
  private endHostTime = 0;

  constructor(seconds = 8) {
    this.capacity = Math.trunc(seconds * AsrAudioTap.rate);
    this.ring = new Int16Array(this.capacity);
  }

  get sampleRate(): number { return AsrAudioTap.rate; }

  // MARK: Producer

  /** Appends Float32 samples (clipped, converted to Int16). Allocation-free. */
  write(samples: Float32Array, endHostTime: number): void {
    if (samples.length === 0) return;
    if (this.streamStart === null) this.streamStart = this.writeIndex;
    let w = this.writeIndex;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i])) * 32767;
      this.ring[w % this.capacity] = Math.sign(v) * Math.round(Math.abs(v));
      w += 1;
    }
    this.writeIndex = w;
    this.endHostTime = endHostTime;
  }

  /** A gap in the stream (new mic generation, overrun): older samples are no longer readable for a new turn. */
  noteDiscontinuity(): void { this.streamStart = null; }

  // MARK: Reader

  /** `[oldest, next)` of the current stream still in the ring; null before any sample since the last gap. */
  readableRange(): { lower: number; upper: number } | null {
    const start = this.streamStart;
    if (start === null || !(this.writeIndex > start)) return null;
    return { lower: Math.max(start, this.writeIndex - this.capacity), upper: this.writeIndex };
  }

  /** The sample index at `hostTime`, extrapolated from the newest stamp. */
  sampleIndex(hostTime: number): number | null {
    if (this.streamStart === null || !(this.writeIndex > 0)) return null;
    const d = (hostTime - this.endHostTime) * AsrAudioTap.rate;
    return this.writeIndex + Math.sign(d) * Math.round(Math.abs(d));
  }

  /** Up to `maxFrames` samples from `from` (clamped into the readable range). */
  read(from: number, maxFrames: number): { samples: Int16Array; start: number } {
    const start0 = this.streamStart;
    if (start0 === null || !(this.writeIndex > start0) || maxFrames <= 0) return { samples: new Int16Array(0), start: from };
    const lower = Math.max(start0, this.writeIndex - this.capacity);
    const start = Math.max(from, lower);
    if (!(start < this.writeIndex)) return { samples: new Int16Array(0), start };
    const n = Math.min(maxFrames, this.writeIndex - start);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = this.ring[(start + i) % this.capacity];
    return { samples: out, start };
  }
}
