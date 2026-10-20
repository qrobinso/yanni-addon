// Port of ConversationTurn/TurnAudioBuffer.swift.
import type { TurnAudioWindow } from './DetectorPorts';
import { TurnAudioFormat } from './TurnTunables';

/** The turn's 16 kHz audio (design §5.3): a 10 s circular buffer indexed by absolute sample number, preallocated and
 *  never grown. Smart Turn gets a copy of a range clipped to the last 8 s, right-aligned and zero-padded. */
export class TurnAudioBuffer {
  readonly capacity: number;
  private readonly storage: Float32Array;
  /** Absolute index of the next sample to be written (total samples appended). */
  endIndex = 0;
  /** Samples before this index belong to audio that must not reach Smart Turn (before a discard). */
  discardedBefore = 0;

  constructor(capacity: number = TurnAudioFormat.bufferSamples) {
    if (!(capacity > 0)) throw new RangeError('capacity must be > 0');
    this.capacity = capacity;
    this.storage = new Float32Array(capacity);
  }

  /** Oldest absolute index still held. */
  get startIndex(): number {
    return Math.max(0, this.endIndex - this.capacity);
  }

  append(samples: Float32Array): void {
    let src = samples;
    if (src.length === 0) return;
    if (src.length > this.capacity) {
      // only the newest `capacity` samples can be kept
      this.endIndex += src.length - this.capacity;
      src = src.subarray(src.length - this.capacity);
    }
    const n = src.length;
    const pos = this.endIndex % this.capacity;
    const first = Math.min(n, this.capacity - pos);
    this.storage.set(src.subarray(0, first), pos);
    if (first < n) this.storage.set(src.subarray(first), 0);
    this.endIndex += n;
  }

  /** Clears the buffer (mic open, rate change): indices keep counting. */
  discardAll(): void {
    // Nothing to zero: `copy` never reads before `startIndex`, and the next appends overwrite.
    this.discardedBefore = this.endIndex;
  }

  /** Copies `[from, to)` (absolute indices) into `window`, clipped to what is held, to `discardedBefore` and to the
   *  window's length (the newest samples win), right-aligned, zero-padded at the beginning. Returns samples copied. */
  copy(from: number, to: number, window: TurnAudioWindow): number {
    const out = window.samples;
    const hi = Math.min(to, this.endIndex);
    const lo = Math.max(from, this.startIndex, this.discardedBefore, hi - out.length);
    const n = hi > lo ? hi - lo : 0;
    const pad = out.length - n;
    if (pad > 0) out.fill(0, 0, pad);
    if (n > 0) {
      const pos = lo % this.capacity;
      const first = Math.min(n, this.capacity - pos);
      out.set(this.storage.subarray(pos, pos + first), pad);
      if (first < n) out.set(this.storage.subarray(0, n - first), pad + first);
    }
    window.validCount = n;
    return n;
  }
}
