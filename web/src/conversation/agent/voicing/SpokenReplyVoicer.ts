// Port of ConversationAgent/Voicing/SpokenReplyVoicer.swift. The Spoken reply voice (design §7.1, §6.8): per chunk,
// one TTS run through Home Assistant's pipeline, its audio decoded at the output rate into the playout queue. Timing
// comes from the frames actually queued: `offsetMs` = frames queued so far ÷ output rate. One synthesis at a time; the
// next chunk's request goes out as soon as the previous chunk's audio is in, so chunks queue ahead of playback.
// port-note: the Wyoming backend (and its PCMResampler) is dropped: browsers have no raw TCP.
import { roundHalfAway } from '../../turn/TurnTunables';
import type { AgentTunables } from '../AgentTunables';
import type { HATextToSpeech } from '../homeassistant/HASpeech';
import {
  ReplyVoicingError, type ChunkVoicing, type ReplyPlayoutSink, type ReplyTextChunk, type ReplyVoicing,
  type ReplyVoicingSession,
} from '../Ports';

export class SpokenReplyVoicer implements ReplyVoicing {
  constructor(readonly tts: HATextToSpeech, readonly sink: ReplyPlayoutSink, readonly tunables: AgentTunables) {}

  async beginReply(_turnId: string, _proactive: boolean): Promise<ReplyVoicingSession> {
    return new SpokenReplySession(this);
  }
}

export class SpokenReplySession implements ReplyVoicingSession {
  private framesQueued = 0;
  private cancelled = false;
  /** Stops the chunk in flight (cancels the TTS run and fetch). */
  private stop: (() => void) | null = null;

  constructor(private readonly voicer: SpokenReplyVoicer) {}

  private get outRate(): number { return this.voicer.sink.outputSampleRate; }

  async totalAudioMs(): Promise<number> { return SpokenReplySession.ms(this.framesQueued, this.outRate); }

  static ms(frames: number, rate: number): number { return rate > 0 ? roundHalfAway(frames / rate * 1000) : 0; }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.stop?.();
  }

  async voice(chunk: ReplyTextChunk, willStart: (offsetMs: number) => void): Promise<ChunkVoicing> {
    if (this.cancelled) throw ReplyVoicingError.cancelled();
    return this.voiceHomeAssistant(this.voicer.tts, chunk, willStart);
  }

  /** Through HA: the TTS run and fetch (decoded straight to the output rate), then queued in 100 ms slices. */
  private async voiceHomeAssistant(tts: HATextToSpeech, chunk: ReplyTextChunk, willStart: (offsetMs: number) => void): Promise<ChunkVoicing> {
    const rate = this.outRate;
    const job = new AbortController();
    this.stop = () => job.abort();
    try {
      let frames: Float32Array;
      try { frames = await tts.synthesize(chunk.text, rate, job.signal); } catch (e) {
        throw this.cancelled ? ReplyVoicingError.cancelled() : ReplyVoicingError.failed(`tts run: ${e instanceof Error ? e.message : typeof e}`);
      }
      const start = this.framesQueued;
      willStart(SpokenReplySession.ms(start, rate));
      const slice = Math.max(Math.trunc(rate / 10), 1);
      let i = 0;
      while (i < frames.length) {
        if (this.cancelled) throw ReplyVoicingError.cancelled();
        const j = Math.min(i + slice, frames.length);
        if (!(await this.voicer.sink.enqueue(frames.slice(i, j)))) throw ReplyVoicingError.cancelled();
        this.framesQueued += j - i;
        i = j;
      }
      return { offsetMs: SpokenReplySession.ms(start, rate), durationMs: SpokenReplySession.ms(frames.length, rate) };
    } finally {
      this.stop = null;
    }
  }
}
