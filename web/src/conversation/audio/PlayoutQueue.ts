// Port of ConversationAudio/PlayoutQueue.swift (+ ConversationAgent/PlayoutQueue+ReplyPlayoutSink.swift). The spoken
// reply's audio on its way to the speaker (direct Home Assistant design §14): the agent's `ReplyPlayoutSink` and the
// controller's `ReplyClock` (Spoken mode).
// - `enqueue` schedules each slice back to back through `ConversationAudio.playPcm`. After a flush it refuses audio
//   (resolves false) until the next reply is armed, so a cancelled reply's late chunks never play.
// - The clock: a monotonic count of reply frames, mapped to host time by the scheduled spans. `framesPlayed` is the
//   frames whose scheduled start has passed; the reply start is the first span of the armed reply once it plays.
// port-note: no SPSC ring or render thread (WebAudio schedules buffers): `framesPlayed` counts reply audio only, not
// rendered silence, so a TTS underrun between chunks doesn't make the reply look finished early (the iPad's render
// counter does count it). `lastLoudHostTime` is not tracked (echo margins live in `PlayoutAudibility`); `flushing` is
// the 30 ms fade window.
import type { ReplyPlayoutSink } from '../agent/Ports';
import { makePlayoutSnapshot, type PlayoutSnapshot, type ReplyClock } from '../core/Ports';
import { hostNow } from './TurnAudioPump';

/** What the queue needs from `ConversationAudio`. */
export interface PlayoutOutput {
  playPcm(samples: Float32Array, rate: number): { start: number; end: number };
  flushPlayout(): void;
  readonly context: { readonly sampleRate: number; readonly outputLatency?: number };
}

interface Span { frame: number; host: number; frames: number }

export class PlayoutQueue implements ReplyPlayoutSink, ReplyClock {
  private accepting = true;
  /** Reply frames scheduled since launch (absolute frame index of the next one). */
  private written = 0;
  private spans: Span[] = [];
  /** Frames played before the last flush (the dropped ones never play, so `framesPlayed` skips them). */
  private playedBase = 0;
  private armed: number | null = null;
  private replyStart: PlayoutSnapshot['replyStart'] = null;
  private replyFirstSpan: Span | null = null;
  private flushUntil = -Infinity;

  constructor(private readonly audio: PlayoutOutput, private readonly now: () => number = hostNow) {}

  get outputSampleRate(): number { return this.audio.context.sampleRate; }

  /** The next reply's first played frame gets `epoch`; audio is accepted again. */
  armReplyStart(epoch: number): void {
    this.accepting = true;
    this.armed = epoch;
    this.replyFirstSpan = null;
  }

  /** Barge-in: refuse more audio, fade out over 30 ms and drop everything queued. */
  flush(): void {
    this.accepting = false;
    this.playedBase = this.framesPlayed(this.now());
    this.written = this.playedBase;
    this.spans = [];
    this.flushUntil = this.now() + 0.03;
    this.audio.flushPlayout();
  }

  async enqueue(frames: Float32Array): Promise<boolean> {
    if (!this.accepting) return false;
    if (frames.length === 0) return true;
    const rate = this.outputSampleRate;
    const { start } = this.audio.playPcm(frames, rate);
    const span = { frame: this.written, host: start, frames: frames.length };
    this.spans.push(span);
    if (this.spans.length > 512) this.spans.splice(0, this.spans.length - 512);
    if (this.armed !== null && !this.replyFirstSpan) this.replyFirstSpan = span;
    this.written += frames.length;
    return this.accepting;
  }

  private framesPlayed(now: number): number {
    const rate = this.outputSampleRate;
    let played = this.playedBase;
    for (const s of this.spans) {
      if (s.host > now) break;
      played = s.frame + Math.min(s.frames, Math.floor((now - s.host) * rate + 1e-6));
    }
    return Math.max(played, this.playedBase);
  }

  playoutSnapshot(): PlayoutSnapshot {
    const now = this.now();
    const rate = this.outputSampleRate;
    let current: Span | null = null;
    for (const s of this.spans) { if (s.host > now) break; current = s; }
    const first = this.replyFirstSpan;
    if (this.armed !== null && first && first.host <= now) {
      this.replyStart = { epoch: this.armed, frame: first.frame, hostTime: first.host };
      this.armed = null;
    }
    return makePlayoutSnapshot({
      sampleRate: rate, framesPlayed: this.framesPlayed(now),
      lastBufferFrame: current?.frame ?? this.playedBase, lastBufferHostTime: current?.host ?? now, outputLatency: 0,
      replyStart: this.replyStart, flushing: now < this.flushUntil,
    });
  }
}
