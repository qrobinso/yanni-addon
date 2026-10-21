// Port of ConversationTestSupport/FakeHomeAssistant.swift. An in-process Home Assistant behind the relay seam
// (`HAChannel`): `call_service` (jev.ask, ai_task.generate_data), `assist_pipeline/run` with streamed events and
// `unsubscribe_events`, `conversation/process`, the lists and `config_entries/get`; binary stt audio by handler id;
// the `tts_proxy` fetch. Every request is logged (with the display's id) so tests can check order and absence.
// port-note: no socket or auth handshake (the add-on authenticates upstream); `connected = false` plays "HA isn't
// connected", `drop()` plays the relay's `ha.status: false`.
import type { HaRequest } from '@yanni/server/protocol';
import type { HAChannel, HASubscriptionHandle } from '../../../src/conversation/agent/homeassistant/HAChannel';
import { HASpeechError, type HAMediaFetching, type MediaDecoder } from '../../../src/conversation/agent/homeassistant/HASpeech';
import { at, stringValue, type JSONObject, type JSONValue } from '../../../src/conversation/agent/JSONValue';
import { intValue } from '../../../src/conversation/agent/JSONValue+Agent';
import { AsyncMailbox } from './AgentTestKit';

/** How the fake answers one request. */
export type FakeHAReply = { kind: 'result'; value: JSONValue } | { kind: 'error'; code: string; message: string } | { kind: 'none' };
export const result = (value: JSONValue): FakeHAReply => ({ kind: 'result', value });
export const haError = (code: string, message: string): FakeHAReply => ({ kind: 'error', code, message });

export type Emit = (event: JSONValue) => void;

export interface FakeHAConfig {
  haVersion: string;
  pipelineSupported: boolean;
  jevEntries: JSONValue[];
  /** Pass A / Pass B (`service_data` in, reply out). Default: addressed, understood. */
  onJev: (data: JSONValue) => Promise<FakeHAReply>;
  /** The pipeline run: send events with `emit` (the result was already sent). Default: a streamed two-sentence reply. */
  onPipeline: (msg: JSONValue, emit: Emit) => Promise<void>;
  onProcess: (msg: JSONValue) => Promise<FakeHAReply>;
  onAITask: (data: JSONValue) => Promise<FakeHAReply>;
  /** An stt-stage run: the events after the end-of-audio frame, given the samples received. */
  onSTT: (samples: number[]) => Promise<JSONValue[]>;
  /** Refuse stt runs with this error code (e.g. `pipeline-not-found`)… */
  sttRefusal: string | null;
  /** …this many times (Infinity = always). */
  sttRefuseTimes: number;
  /** A tts-stage run (`run` counts from 0): its events. Default: run-start, tts-start, tts-end for a WAV token. */
  onTTS: (text: string, run: number) => Promise<JSONValue[]>;
  /** The `tts_proxy` body for a token (null = 404). Default: 0.5 s of a synthetic tone, 16 kHz WAV. */
  ttsMedia: (token: string) => Uint8Array | null;
  pipelines: JSONValue;
}

export class FakeHomeAssistant implements HAChannel, HAMediaFetching {
  config: FakeHAConfig = {
    haVersion: '2026.10.1', pipelineSupported: true,
    jevEntries: [{ entry_id: '01JEVENTRY', title: 'Jev', state: 'loaded', domain: 'jev' }],
    onJev: async () => result(FakeHA.jevResponse()),
    onPipeline: async (_m, emit) => FakeHA.stream(FakeHA.streamedRun(['Hello there, my friend! ', 'It is sunny today.']), emit),
    onProcess: async () => result(FakeHA.processResult("Done. The lights are off.", '01CONV')),
    onAITask: async () => result({ conversation_id: '01TASK', data: 'Hey, the laundry is done!' }),
    onSTT: async () => FakeHA.sttEnd("what's the weather like today?"),
    sttRefusal: null, sttRefuseTimes: Infinity,
    onTTS: async (_t, run) => FakeHA.ttsRun(`tts-${run}.wav`),
    ttsMedia: () => FakeHA.toneWAV(0.5),
    pipelines: { pipelines: [{ id: '01PIPE', name: 'Home', conversation_engine: 'conversation.jev', conversation_language: 'en',
      prefer_local_intents: false, stt_engine: 'stt.faster_whisper', tts_engine: 'tts.piper', tts_voice: 'en_US-lessac-medium' }],
    preferred_pipeline: '01PIPE' },
  };

  connected = true;
  log: JSONObject[] = [];
  /** Binary frame sizes in bytes (handler byte included). */
  binarySizes: number[] = [];
  /** The audio each finished stt run received (in order). */
  sttAudio: number[][] = [];
  fetches: string[] = [];
  private nextId = 1;
  private unsubscribed = new Set<number>();
  private closedLocal = new Set<number>();
  private nextHandler = 1;
  private sttMailboxes = new Map<number, AsyncMailbox<Int16Array>>();
  private sttHandlerBySub = new Map<number, number>();
  private ttsRuns = 0;
  private refusals = 0;
  private pending = new Set<(e: Error) => void>();
  private listeners = new Set<(open: boolean) => void>();

  configure(f: (c: FakeHAConfig) => void): void { f(this.config); }

  /** Logged message types, with `call_service` written as `call_service:<domain>.<service>`. */
  get logTypes(): string[] {
    return this.log.map((m) => {
      const t = stringValue(m.type) ?? '?';
      return t === 'call_service' ? `${t}:${stringValue(m.domain) ?? ''}.${stringValue(m.service) ?? ''}` : t;
    });
  }
  count(type: string): number { return this.logTypes.filter((t) => t === type).length; }
  get agentCalls(): number { return this.runs('intent').length + this.count('conversation/process'); }
  isUnsubscribed(id: number): boolean { return this.unsubscribed.has(id); }
  /** `assist_pipeline/run` messages by start stage. */
  runs(stage: string): JSONObject[] {
    return this.log.filter((m) => m.type === 'assist_pipeline/run' && m.start_stage === stage);
  }

  /** HA restarts (the relay's `ha.status: false`, then `true`): pending calls fail, subscriptions end, and a new
   *  connect succeeds again (Swift: the fake's sockets close, new opens work). */
  drop(): void {
    this.connected = false;
    for (const f of [...this.pending]) f(Object.assign(new Error('Home Assistant went away'), { code: 'ha_disconnected' }));
    this.pending.clear();
    for (const fn of [...this.listeners]) fn(false);
    this.connected = true;
  }

  /** Connects seen (each one asks for the Jev config entries): Swift's `opens`. */
  get opens(): number { return this.count('config_entries/get'); }

  // MARK: HAChannel

  get isOpen(): boolean { return this.connected; }
  get haVersion(): string | null { return this.config.haVersion; }

  onOpenChange(fn: (open: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  call(request: HaRequest, _timeoutMs: number): Promise<unknown> {
    return this.request(request, null).result;
  }

  subscribe(request: HaRequest, onEvent: (event: unknown) => void, _timeoutMs: number): HASubscriptionHandle {
    return this.request(request, onEvent);
  }

  sendBinary(handlerId: number, pcm?: Int16Array): boolean {
    if (!this.connected) return false;
    this.binarySizes.push(1 + (pcm?.byteLength ?? 0));
    // Binary frames go to the stt run whose handler id is their first byte (HA's binary handlers).
    this.sttMailboxes.get(handlerId)?.push(pcm ? pcm.slice() : new Int16Array(0));
    return true;
  }

  private request(request: HaRequest, onEvent: ((e: unknown) => void) | null): HASubscriptionHandle {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      if (!this.connected) { reject(Object.assign(new Error('not connected'), { code: 'disconnected' })); return; }
      const m = { ...(request as JSONObject), id } as JSONObject;
      this.log.push(m);
      const fail = (e: Error) => reject(e);
      this.pending.add(fail);
      const reply = (r: FakeHAReply) => {
        this.pending.delete(fail);
        if (r.kind === 'result') resolve(r.value);
        else if (r.kind === 'error') reject(Object.assign(new Error(r.message), { code: r.code }));
      };
      const emit: Emit = (event) => {
        if (!this.connected || this.unsubscribed.has(id) || this.closedLocal.has(id)) return;
        onEvent?.(event);
      };
      void this.handle(m, id, reply, emit);
    });
    return { id, result, close: () => { this.closedLocal.add(id); } };
  }

  private async handle(m: JSONObject, id: number, reply: (r: FakeHAReply) => void, emit: Emit): Promise<void> {
    const cfg = this.config;
    await Promise.resolve();
    switch (stringValue(m.type) ?? '') {
      case 'ping': return reply(result(null));
      case 'call_service': {
        const domain = stringValue(m.domain), service = stringValue(m.service);
        const data = m.service_data ?? null;
        let r: FakeHAReply;
        if (domain === 'jev' && service === 'ask') r = await cfg.onJev(data);
        else if (domain === 'ai_task' && service === 'generate_data') r = await cfg.onAITask(data);
        else r = haError('service_not_found', 'no such service');
        return reply(r.kind === 'result' ? result({ context: { id: '01CTX' }, response: r.value }) : r);
      }
      case 'assist_pipeline/run': {
        switch (stringValue(m.start_stage)) {
          case 'stt': return this.runSTT(id, cfg, reply, emit);
          case 'tts': {
            reply(result(null));
            const run = this.ttsRuns++;
            for (const e of await cfg.onTTS(stringValue(at(m, 'input', 'text')) ?? '', run)) emit(e);
            return;
          }
          default:
            // port-note: only the intent run is refused (the speech runs are the HA route's own here, not Wyoming).
            if (!cfg.pipelineSupported) return reply(haError('unknown_command', 'Unknown command.'));
            reply(result(null));
            return cfg.onPipeline(m, emit);
        }
      }
      case 'unsubscribe_events': {
        const sub = intValue(m.subscription);
        if (sub !== null) {
          this.unsubscribed.add(sub);
          const h = this.sttHandlerBySub.get(sub);
          if (h !== undefined) this.sttMailboxes.get(h)?.close();
        }
        return reply(result(null));
      }
      case 'conversation/process': return reply(await cfg.onProcess(m));
      case 'config_entries/get': return reply(result(cfg.jevEntries));
      case 'conversation/agent/list':
        return reply(result({ agents: [{ id: 'conversation.jev', name: 'Jev', supported_languages: '*' },
          { id: 'conversation.openai', name: 'OpenAI', supported_languages: ['en'] }] }));
      case 'assist_pipeline/pipeline/list': return reply(result(cfg.pipelines));
      // Already trimmed, as the relay hands it on (server/src/relay.ts filterStates).
      case 'get_states': return reply(result([
        { entity_id: 'ai_task.openai', state: 'unknown', attributes: { friendly_name: 'OpenAI AI Task' } },
        { entity_id: 'conversation.jev', state: 'unknown', attributes: { friendly_name: 'Jev' } },
        { entity_id: 'tts.piper', state: 'unknown', attributes: { friendly_name: 'Piper' } }]));
      default: return reply(haError('unknown_command', 'Unknown command.'));
    }
  }

  /** An stt run as HA runs it: a binary handler, `run-start` naming it, audio until a frame of only the handler id,
   *  then `onSTT`'s events. Unsubscribing ends it without events. */
  private async runSTT(id: number, cfg: FakeHAConfig, reply: (r: FakeHAReply) => void, emit: Emit): Promise<void> {
    if (cfg.sttRefusal !== null && this.refusals < cfg.sttRefuseTimes) {
      this.refusals += 1;
      return reply(haError(cfg.sttRefusal, 'refused'));
    }
    const box = new AsyncMailbox<Int16Array>();
    const handler = this.nextHandler;
    this.nextHandler = handler === 255 ? 1 : handler + 1;
    this.sttMailboxes.set(handler, box);
    this.sttHandlerBySub.set(id, handler);
    reply(result(null));
    emit(FakeHA.event('run-start', { pipeline: '01PIPE', language: 'en', runner_data: { stt_binary_handler_id: handler, timeout: 60 } }));
    emit(FakeHA.event('stt-start', { engine: 'stt.faster_whisper' }));
    const samples: number[] = [];
    let ended = false;
    for (;;) {
      const chunk = await box.pop();
      if (chunk === null) break;
      if (chunk.length === 0) { ended = true; break; }
      for (const s of chunk) samples.push(s);
    }
    this.sttMailboxes.delete(handler);
    if (!ended) return;
    this.sttAudio.push(samples);
    for (const e of await cfg.onSTT(samples)) emit(e);
  }

  // MARK: HAMediaFetching

  /** The `tts_proxy` fetch, served from `ttsMedia`. */
  async fetch(path: string): Promise<{ data: Uint8Array; mimeType: string | null }> {
    this.fetches.push(path);
    const prefix = '/api/tts_proxy/';
    const body = path.startsWith(prefix) ? this.config.ttsMedia(path.slice(prefix.length)) : null;
    if (!body) throw new HASpeechError('media', 'status');
    return { data: body, mimeType: 'audio/wav' };
  }
}

/** 16-bit PCM WAV → Float32 mono at `rate` (linear interpolation): the browser decoder's stand-in in Node tests. */
export class WAVMediaDecoder implements MediaDecoder {
  async monoFloats(data: Uint8Array, _mime: string | null, rate: number, maxFrames: number): Promise<Float32Array> {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.byteLength < 44) throw new HASpeechError('media', 'format');
    const channels = v.getUint16(22, true), srcRate = v.getUint32(24, true), size = v.getUint32(40, true);
    const n = Math.floor(size / 2 / channels);
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let c = 0; c < channels; c++) acc += v.getInt16(44 + (i * channels + c) * 2, true);
      src[i] = acc / channels / 32768;
    }
    const m = Math.round(n * rate / srcRate);
    if (m > maxFrames) throw new HASpeechError('media', 'over the per-chunk audio cap');
    const out = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const x = i * srcRate / rate, k = Math.floor(x), f = x - k;
      out[i] = (src[k] ?? 0) * (1 - f) + (src[k + 1] ?? src[k] ?? 0) * f;
    }
    return out;
  }
}

/** Builders for HA payloads (the same shapes as the fixtures). */
export const FakeHA = {
  /** The end of an stt run: `stt-end` with `text`, then `run-end`. */
  sttEnd(text: string): JSONValue[] { return [FakeHA.event('stt-end', { stt_output: { text } }), FakeHA.event('run-end', null)]; },

  /** A run's error, then `run-end`. */
  runError(code: string): JSONValue[] { return [FakeHA.event('error', { code, message: '…' }), FakeHA.event('run-end', null)]; },

  /** A tts run: run-start, tts-start, tts-end with `/api/tts_proxy/<token>`, run-end. */
  ttsRun(token: string, mimeType = 'audio/wav'): JSONValue[] {
    return [
      FakeHA.event('run-start', { pipeline: '01PIPE', language: 'en', runner_data: { stt_binary_handler_id: null, timeout: 60 } }),
      FakeHA.event('tts-start', { engine: 'tts.piper', language: 'en_US', voice: 'en_US-lessac-medium' }),
      FakeHA.event('tts-end', { tts_output: { media_id: `media-source://tts/-stream-/${token}`, token, url: `/api/tts_proxy/${token}`, mime_type: mimeType } }),
      FakeHA.event('run-end', null),
    ];
  },

  /** A synthetic tone as a 16-bit mono WAV (never speech, never a recording). */
  toneWAV(seconds: number, rate = 16000): Uint8Array {
    const n = Math.trunc(seconds * rate);
    const out = new Uint8Array(44 + n * 2);
    const v = new DataView(out.buffer);
    const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.trunc(Math.sin(i * 2 * Math.PI * 440 / rate) * 8000), true);
    return out;
  },

  /** A `jev.ask` response: noul P(yes) for addressed/understood, choice/score for the rest. */
  jevResponse(o: { addressed?: number; understood?: number; extra?: JSONObject; latencyMs?: number } = {}): JSONValue {
    const answers: JSONObject = {
      addressed: { type: 'noul', noul: o.addressed ?? 0.95 },
      understood: { type: 'noul', noul: o.understood ?? 0.97 },
      intent: { choice: 'question', probabilities: { question: 0.8, other: 0.2 }, confidence: 0.8 },
      feel: { choice: 'Happiness', probabilities: { Happiness: 0.7, Neutral: 0.3 }, confidence: 0.7 },
      reaction: { choice: 'none', probabilities: { none: 0.9, delight: 0.1 }, confidence: 0.9 },
      intensity: { score: 2, normalized: 0.5, nearest_level: 'clearly',
        probabilities: { 0: 0.05, 1: 0.15, 2: 0.5, 3: 0.2, 4: 0.1 }, confidence: 0.5 },
      stance: { choice: 'none', probabilities: { none: 0.9, yes: 0.1 }, confidence: 0.9 },
      ...(o.extra ?? {}),
    };
    return { answers, model: 'kev-latest', latency_ms: o.latencyMs ?? 42, usage: { input_tokens: 120, output_tokens: 0 } };
  },

  event(type: string, data: JSONValue = {}): JSONValue {
    return { type, data, timestamp: '2026-10-12T12:00:00+00:00' };
  },

  /** A streamed intent-only run: run-start, intent-start, a thinking delta, the assistant deltas, intent-end, run-end. */
  streamedRun(deltas: string[], conversationID = '01CONVSTREAM', endSpeech: string | null = null): JSONValue[] {
    const evs: JSONValue[] = [
      FakeHA.event('run-start', { pipeline: '01PIPE', language: 'en', conversation_id: conversationID }),
      FakeHA.event('intent-start', { engine: 'conversation.jev', language: 'en', intent_input: '…' }),
      FakeHA.event('intent-progress', { chat_log_delta: { role: 'assistant', thinking_content: 'Checking…' } }),
    ];
    deltas.forEach((d, i) => evs.push(FakeHA.event('intent-progress', { chat_log_delta: i === 0 ? { role: 'assistant', content: d } : { content: d } })));
    evs.push(FakeHA.event('intent-end', { processed_locally: false, intent_output: FakeHA.processResult(endSpeech ?? deltas.join(''), conversationID) }));
    evs.push(FakeHA.event('run-end'));
    return evs;
  },

  /** A run with no deltas (a device command Jev handled itself). */
  wholeRun(speech: string, conversationID = '01CONVWHOLE'): JSONValue[] {
    return [
      FakeHA.event('run-start', { pipeline: '01PIPE', language: 'en', conversation_id: conversationID }),
      FakeHA.event('intent-start', { engine: 'conversation.jev' }),
      FakeHA.event('intent-end', { intent_output: FakeHA.processResult(speech, conversationID) }),
      FakeHA.event('run-end'),
    ];
  },

  processResult(speech: string, conversationID: string | null, responseType = 'action_done', continueConversation = false): JSONValue {
    return {
      response: { speech: { plain: { speech, extra_data: null } }, response_type: responseType, language: 'en',
        data: { targets: [], success: [], failed: [] } },
      conversation_id: conversationID, continue_conversation: continueConversation,
    };
  },

  async stream(events: JSONValue[], emit: Emit, hold: AsyncMailbox<void> | null = null, holdAfter = 3): Promise<void> {
    for (let i = 0; i < events.length; i++) {
      if (hold && i === holdAfter) await hold.pop();
      emit(events[i]);
    }
  },
};
