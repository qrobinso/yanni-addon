// Port of ConversationAgent/HomeAssistant/HASpeech.swift: speech-to-text and text-to-speech through Home Assistant's
// Assist pipeline, the `tts_proxy` fetch and the decoder.
import { AgentTimeout, CancellationError, checkCancellation, childController, withAgentTimeout, type AgentClock, type AgentTunables } from '../AgentTunables';
import { at, stringValue } from '../JSONValue';
import { intValue } from '../JSONValue+Agent';
import type { SpeechToText, SpeechToTextHealth, TranscriptionSession } from '../Ports';
import { HAError } from './HAChannel';
import type { HAClient, HASubscription } from './HAClient';
import { pipelines, runSpeechToText, runTextToSpeech } from './HACommands';

export type HASpeechErrorKind =
  /** An `error` event (`stt-stream-failed`, `tts-not-supported`, …). */
  | 'run'
  /** The run ended (or sent something unusable) before the event Yanni needed. */
  | 'ended'
  | 'timeout'
  /** The TTS audio couldn't be fetched or decoded. */
  | 'media';

/** A pipeline stage that failed. Never carries text. */
export class HASpeechError extends Error {
  override name = 'HASpeechError';
  constructor(readonly kind: HASpeechErrorKind, readonly why: string | null = null) { super(why ? `${kind}(${why})` : kind); }
}

// MARK: - Speech-to-text through the pipeline

/** The recogniser that is Home Assistant's Assist pipeline (design §6.8): one stt-stage run per turn, HA's own VAD off.
 *  `pipeline` null = HA's preferred pipeline. */
export class HAPipelineSpeechToText implements SpeechToText {
  /** `ha` null when HA isn't connected (`start` then fails, `describe` says down). */
  constructor(readonly ha: HAClient | null, readonly pipeline: string | null, readonly tunables: AgentTunables) {}

  /** The pipeline's `stt_engine` from `assist_pipeline/pipeline/list`. */
  async describe(timeout: number): Promise<SpeechToTextHealth> {
    const ha = this.ha;
    if (!ha) return { kind: 'down', why: 'home assistant not connected' };
    let listed: Awaited<ReturnType<typeof pipelines>>;
    try { listed = await withAgentTimeout(timeout, ha.clock, (s) => pipelines(ha, s)); } catch {
      return { kind: 'up', engine: null }; // not answered: assume it works; the runs report their own errors
    }
    const p = listed.pipelines.find((x) => x.id === (this.pipeline ?? listed.preferred));
    if (!p) return { kind: 'down', why: 'pipeline not found' };
    if (p.sttEngine === null) return { kind: 'down', why: 'the pipeline has no speech-to-text' };
    return { kind: 'up', engine: p.sttEngine };
  }

  /** Starts the run (one retry), waiting up to the connect timeout for `run-start`. The pipeline's own language
   *  applies; `language` is unused. */
  async start(_language: string | null, signal?: AbortSignal): Promise<TranscriptionSession> {
    const ha = this.ha;
    if (!ha) throw HAError.closed();
    const t = this.tunables;
    try {
      return await HAPipelineTranscription.start(ha, this.pipeline, t.pipelineTimeout, t.wyomingConnectTimeout, signal);
    } catch (e) {
      if (e instanceof CancellationError) throw e;
      return HAPipelineTranscription.start(ha, this.pipeline, t.pipelineTimeout, t.wyomingConnectTimeout, signal);
    }
  }
}

/** One stt-stage run: `run-start` names the binary handler; audio goes as binary frames `[handler id] + PCM`; a frame
 *  of only the handler id ends it; `stt-end` carries the text. */
export class HAPipelineTranscription implements TranscriptionSession {
  private closed = false;
  /** Set once `stt-end` (or the run's end) was read, so `close` doesn't unsubscribe an ended run. */
  private finished = false;

  private constructor(private readonly ha: HAClient, private readonly subscription: HASubscription,
    private readonly handler: number) {}

  /** Starts the run and waits up to `within` seconds for its `run-start` (the binary handler id). */
  static async start(ha: HAClient, pipeline: string | null, timeout: number, within: number,
    signal?: AbortSignal): Promise<HAPipelineTranscription> {
    const sub = await runSpeechToText(ha, pipeline, timeout, signal);
    try {
      const handler = await withAgentTimeout(within, ha.clock, async (s) => {
        for (;;) {
          const ev = await sub.events.next(s);
          if (ev === null) break;
          switch (stringValue(at(ev, 'type'))) {
            case 'run-start': {
              const h = intValue(at(ev, 'data', 'runner_data', 'stt_binary_handler_id'));
              if (h === null || h < 0 || h > 255) throw new HASpeechError('ended');
              return h;
            }
            case 'error': throw new HASpeechError('run', stringValue(at(ev, 'data', 'code')) ?? 'error');
            case 'run-end': throw new HASpeechError('ended');
            default: continue;
          }
        }
        throw new HASpeechError('ended');
      }, signal);
      return new HAPipelineTranscription(ha, sub, handler);
    } catch (e) {
      void ha.unsubscribe(sub.id);
      if (e instanceof AgentTimeout) throw new HASpeechError('timeout');
      throw e;
    }
  }

  async send(samples: Int16Array): Promise<void> {
    if (samples.length === 0) return;
    await this.ha.sendBinary(this.handler, samples); // port-note: little-endian PCM (DisplayClient.sendAudio)
  }

  async finish(timeout: number, clock: AgentClock, signal?: AbortSignal): Promise<string> {
    await this.ha.sendBinary(this.handler); // the handler id alone ends the audio
    const events = this.subscription.events;
    try {
      const text = await withAgentTimeout(timeout, clock, async (s) => {
        for (;;) {
          const ev = await events.next(s);
          if (ev === null) break;
          switch (stringValue(at(ev, 'type'))) {
            case 'stt-end': return stringValue(at(ev, 'data', 'stt_output', 'text')) ?? '';
            case 'error': {
              const code = stringValue(at(ev, 'data', 'code')) ?? 'error';
              if (code === 'stt-no-text-recognized') return ''; // nothing recognised: an empty transcript
              throw new HASpeechError('run', code);
            }
            case 'run-end': throw new HASpeechError('ended');
            default: continue;
          }
        }
        throw new HASpeechError('ended');
      }, signal);
      this.finished = true;
      return text;
    } catch (e) {
      if (e instanceof AgentTimeout) throw new HASpeechError('timeout');
      throw e;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.finished) this.ha.endSubscription(this.subscription.id);
    else void this.ha.unsubscribe(this.subscription.id);
  }
}

// MARK: - Text-to-speech through the pipeline

/** GET of a path on the add-on (which proxies HA's `tts_proxy`). Returns the body and its MIME type. */
export interface HAMediaFetching {
  fetch(path: string, timeout: number, maxBytes: number, signal?: AbortSignal): Promise<{ data: Uint8Array; mimeType: string | null }>;
}

/** The real fetch: `fetch()` with the display's device token, and only paths under `/api/` on the display's own origin
 *  (a `tts_proxy` URL can never send Yanni elsewhere).
 *  port-note: the add-on serves `GET /api/tts_proxy/<file>` for a paired display (`Authorization: Bearer <device
 *  token>`) and fetches it from HA itself; the page is HTTPS on the add-on's own origin, so the Swift plain-http /
 *  pinning checks don't apply. */
export class FetchHAMediaFetcher implements HAMediaFetching {
  constructor(readonly base: string, readonly token: string, readonly fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  async fetch(path: string, timeout: number, maxBytes: number, signal?: AbortSignal): Promise<{ data: Uint8Array; mimeType: string | null }> {
    const url = FetchHAMediaFetcher.url(path, this.base);
    if (url === null) throw new HASpeechError('media', 'path');
    const signals = [AbortSignal.timeout(Math.max(timeout, 0) * 1000), ...(signal ? [signal] : [])];
    let response: Response;
    try {
      response = await this.fetchFn(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.any(signals), cache: 'no-store' });
    } catch (e) {
      if (signal?.aborted) throw new CancellationError();
      throw new HASpeechError('media', e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    if (response.status !== 200) throw new HASpeechError('media', 'status');
    const data = new Uint8Array(await response.arrayBuffer());
    // shortcut: the cap is checked after the download (the add-on is authenticated and local); stream it if that changes.
    if (data.byteLength > maxBytes) throw new HASpeechError('media', 'too large');
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || null;
    return { data, mimeType: mime };
  }

  /** `base` + an absolute `/api/…` path; null for anything else (another host, `..`, a query). */
  static url(path: string, base: string): string | null {
    if (!path.startsWith('/api/') || path.includes('..') || !/^[\p{L}\p{N}/._-]+$/u.test(path)) return null;
    let b: URL;
    try { b = new URL(base); } catch { return null; }
    const prefix = b.pathname.replace(/\/+$/, '');
    return `${b.origin}${prefix}${path}`;
  }
}

/** Compressed or container audio (MP3, WAV, FLAC, …) in memory → Float32 mono at `rate`. */
export interface MediaDecoder {
  monoFloats(data: Uint8Array, mimeType: string | null, rate: number, maxFrames: number): Promise<Float32Array>;
}

/** WebAudio's `decodeAudioData` on an `OfflineAudioContext` at the target rate (which resamples), channels averaged.
 *  port-note: replaces AudioToolbox's ExtAudioFile; the browser sniffs the container (the MIME type is unused). */
export class WebAudioMediaDecoder implements MediaDecoder {
  async monoFloats(data: Uint8Array, _mimeType: string | null, rate: number, maxFrames: number): Promise<Float32Array> {
    if (data.byteLength === 0 || !(rate > 0)) throw new HASpeechError('media', 'empty');
    let buf: AudioBuffer;
    try {
      buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data.slice().buffer);
    } catch { throw new HASpeechError('media', 'format'); }
    if (buf.length > maxFrames) throw new HASpeechError('media', 'over the per-chunk audio cap');
    if (buf.length === 0) throw new HASpeechError('media', 'no audio');
    const out = new Float32Array(buf.length);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < out.length; i++) out[i] += d[i] / buf.numberOfChannels;
    }
    return out;
  }
}

/** The pipeline's tts stage: one run per text, its `tts-end` URL fetched and decoded in memory (never stored) to
 *  Float32 mono at the caller's rate. HA's WebSocket can't ask for WAV, so this is usually MP3. */
export class HATextToSpeech {
  /** `pipeline` null = HA's preferred pipeline. */
  constructor(readonly ha: HAClient, readonly pipeline: string | null, readonly fetcher: HAMediaFetching,
    readonly decoder: MediaDecoder, readonly tunables: AgentTunables) {}

  /** The run and the fetch; aborting `signal` unsubscribes the run and cancels the fetch. */
  async synthesize(text: string, rate: number, signal?: AbortSignal): Promise<Float32Array> {
    const ha = this.ha, t = this.tunables;
    const sub = await runTextToSpeech(ha, text, this.pipeline, t.pipelineTimeout, signal);
    const c = childController(signal);
    const onAbort = () => { void ha.unsubscribe(sub.id); };
    c.signal.addEventListener('abort', onAbort, { once: true });
    try {
      let media: { path: string; mime: string | null };
      try {
        media = await withAgentTimeout(t.ttsFirstAudioTimeout, ha.clock, async (s) => {
          for (;;) {
            const ev = await sub.events.next(s);
            if (ev === null) break;
            switch (stringValue(at(ev, 'type'))) {
              case 'tts-end': {
                const url = stringValue(at(ev, 'data', 'tts_output', 'url'));
                if (url === null) throw new HASpeechError('ended');
                return { path: url, mime: stringValue(at(ev, 'data', 'tts_output', 'mime_type')) };
              }
              case 'error': throw new HASpeechError('run', stringValue(at(ev, 'data', 'code')) ?? 'error');
              case 'run-end': throw new HASpeechError('ended');
              default: continue;
            }
          }
          throw new HASpeechError('ended');
        }, c.signal);
      } catch (e) {
        void ha.unsubscribe(sub.id);
        if (e instanceof AgentTimeout) throw new HASpeechError('timeout');
        throw e;
      }
      ha.endSubscription(sub.id); // only run-end is left
      c.signal.removeEventListener('abort', onAbort);
      checkCancellation(c.signal);
      const body = await this.fetcher.fetch(media.path, t.ttsFetchTimeout, t.ttsFetchMaxBytes, c.signal);
      checkCancellation(c.signal);
      return await this.decoder.monoFloats(body.data, media.mime ?? body.mimeType, rate, Math.trunc(t.ttsMaxChunkAudio * rate));
    } finally {
      c.signal.removeEventListener('abort', onAbort);
      c.abort();
    }
  }
}
