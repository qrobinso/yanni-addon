// The echo rule's view of the playout (port of the parts of ConversationAudio/PlayoutTap.swift the turn logic reads:
// `lastLoudHostTime` and `outputLatency`). On the iPad the render thread stamps every loud buffer as it plays; on the
// web the reply audio is scheduled ahead, so its loud spans are marked up front (`markPlayout`, host seconds, before
// output latency) and `lastLoudHostTime(now)` is the latest loud instant that has been reached by `now`.

export class PlayoutAudibility {
  /** Pre-gain RMS at or above which a block counts as speech (≈ −40 dBFS). */
  static readonly defaultSpeechThreshold = 0.01;
  /** Loudness is measured per block of this length (s). */
  static readonly blockSeconds = 0.01;
  /** Spans kept (oldest pruned first). */
  static readonly capacity = 64;

  outputLatency = 0;
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];

  /** Yanni is audible (loud) over [start, end] host seconds. */
  markPlayout(start: number, end: number): void {
    if (!(end >= start) || !Number.isFinite(start) || !Number.isFinite(end)) return;
    if (this.starts.length >= PlayoutAudibility.capacity) { this.starts.shift(); this.ends.shift(); }
    this.starts.push(start);
    this.ends.push(end);
  }

  /** Barge-in: nothing after `at` will play (the 30 ms fade is still audible). */
  cutAfter(at: number): void {
    for (let i = this.starts.length - 1; i >= 0; i--) {
      if (this.starts[i] > at) { this.starts.splice(i, 1); this.ends.splice(i, 1); } else if (this.ends[i] > at) this.ends[i] = at;
    }
  }

  /** The newest loud instant at or before `now`, −∞ if none. */
  lastLoudHostTime(now: number): number {
    let t = -Infinity;
    for (let i = 0; i < this.starts.length; i++) {
      if (this.starts[i] <= now) t = Math.max(t, Math.min(this.ends[i], now));
    }
    return t;
  }

  /** Loud spans of `samples` (pre-gain RMS per 10 ms block ≥ threshold), merged, as offsets in seconds. */
  static loudSpans(samples: Float32Array, rate: number, threshold = PlayoutAudibility.defaultSpeechThreshold): [number, number][] {
    const hop = Math.max(1, Math.round(rate * PlayoutAudibility.blockSeconds));
    const spans: [number, number][] = [];
    for (let i = 0; i < samples.length; i += hop) {
      const n = Math.min(hop, samples.length - i);
      let s = 0;
      for (let j = i; j < i + n; j++) s += samples[j] * samples[j];
      if (Math.sqrt(s / n) < threshold) continue;
      const a = i / rate, b = (i + n) / rate;
      const last = spans[spans.length - 1];
      if (last && last[1] >= a - 1e-9) last[1] = b; else spans.push([a, b]);
    }
    return spans;
  }
}
