// Port of ConversationCore/VoiceServicesEndpoint.swift: the orchestrator's tunables and where the voice services are.
// port-note: in the add-on the display never holds an HA token or URL (the add-on server relays a whitelisted set of
// HA WebSocket calls), so `HAEndpoint` only names the relay; Wyoming (raw TCP) and Apple's recogniser don't exist in a
// browser, so the ASR and TTS selections are Home Assistant's pipeline only.
import type { ReplyVoice } from '../events/AgentEvents';

/** The orchestrator's tunables (design §6.7). Seconds unless named otherwise. */
export interface AgentTunables {
  /** Pass A must answer within this (300…1500 ms); later answers are ignored and the gate fails open. */
  gateTimeout: number;
  /** P(addressed = no) at or above this → not for me. */
  notForMeThreshold: number;
  /** P(understood = no) at or above this → did not understand (unclear). */
  unclearThreshold: number;
  /** P(closing = only) ≥ this → dismissed; P(closing = withRequest) ≥ this → the mic closes after the reply. */
  closingThreshold: number;
  /** Consecutive decision failures that open the breaker, and its backoff (doubling). */
  breakerFailures: number;
  breakerInitialBackoff: number;
  breakerMaxBackoff: number;
  /** A Pass B call slower than this counts as a failure. */
  passBTimeout: number;
  /** An expressive ask slower than this counts as a failure on the expressive breaker. */
  expressiveTimeout: number;
  /** At most this many Pass B calls in flight. */
  passBConcurrency: number;
  /** Yanni mode: a chunk waits this long for its Pass B tag (chunk 0 uses `yanniPassBDeadlineFirst`). */
  yanniPassBDeadline: number;
  yanniPassBDeadlineFirst: number;
  /** `audio-stop` → `transcript`. */
  transcriptTimeout: number;
  /** ASR audio starts this long before the speech onset (clipped to the mic opening and the previous turn end). */
  asrPreRoll: number;
  /** The ASR stream stops growing after this much audio. */
  maxTurnAudio: number;
  /** The live ASR stream is drained this often (20 ms chunks). */
  asrChunkInterval: number;
  /** Connect timeout (the pipeline run's `run-start`). */
  wyomingConnectTimeout: number;
  /** `synthesize` → first audio. */
  ttsFirstAudioTimeout: number;
  /** At most this much audio per TTS chunk. */
  ttsMaxChunkAudio: number;
  /** `ai_task.generate_data` for an announcement. */
  proactivePhrasingTimeout: number;
  /** `describe` probe at connect. */
  describeTimeout: number;
  /** HA WebSocket keep-alive (port-note: the add-on server keeps the upstream socket alive). */
  pingInterval: number;
  pongTimeout: number;
  /** Through HA: the TTS audio fetch (`/api/tts_proxy/…`), and its size cap. */
  ttsFetchTimeout: number;
  ttsFetchMaxBytes: number;
  /** HA's own pipeline timeout (seconds) sent with `assist_pipeline/run`. */
  pipelineTimeout: number;
  /** Requests that aren't on a turn's latency path (lists, config entries). */
  requestTimeout: number;
}

export function makeAgentTunables(t: Partial<AgentTunables> = {}): AgentTunables {
  return {
    gateTimeout: 0.6, notForMeThreshold: 0.8, unclearThreshold: 0.7, closingThreshold: 0.6, breakerFailures: 3,
    breakerInitialBackoff: 5, breakerMaxBackoff: 60, passBTimeout: 3, expressiveTimeout: 1.2, passBConcurrency: 2,
    yanniPassBDeadline: 0.3, yanniPassBDeadlineFirst: 0.3, transcriptTimeout: 3, asrPreRoll: 0.3, maxTurnAudio: 30,
    asrChunkInterval: 0.02, wyomingConnectTimeout: 1, ttsFirstAudioTimeout: 2, ttsMaxChunkAudio: 30,
    proactivePhrasingTimeout: 6, describeTimeout: 2, pingInterval: 30, pongTimeout: 10, ttsFetchTimeout: 10,
    ttsFetchMaxBytes: 8 * 1024 * 1024, pipelineTimeout: 60, requestTimeout: 10, ...t,
  };
}

/** Every value inside its documented range. */
export function clampedAgentTunables(src: AgentTunables): AgentTunables {
  const t = { ...src };
  t.gateTimeout = Math.min(Math.max(src.gateTimeout, 0.3), 1.5);
  t.notForMeThreshold = Math.min(Math.max(src.notForMeThreshold, 0.5), 1);
  t.unclearThreshold = Math.min(Math.max(src.unclearThreshold, 0.5), 1);
  t.closingThreshold = Math.min(Math.max(src.closingThreshold, 0.5), 1);
  t.breakerFailures = Math.max(src.breakerFailures, 1);
  t.passBConcurrency = Math.max(src.passBConcurrency, 1);
  t.expressiveTimeout = Number.isFinite(src.expressiveTimeout) ? Math.min(Math.max(src.expressiveTimeout, 0.3), 3) : 1.2;
  t.asrPreRoll = Math.min(Math.max(src.asrPreRoll, 0), 1);
  return t;
}

/** Home Assistant. port-note: the add-on relay; `url` is the display socket (informational) and `token` is empty. */
export interface HAEndpoint { url: string; token: string; certSHA256: string | null; allowInsecureLocal: boolean }

export const makeHAEndpoint = (url = 'relay:', token = ''): HAEndpoint => ({ url, token, certSHA256: null, allowInsecureLocal: false });

/** Which agent answers and which HA-side entities Yanni uses. */
export interface AgentSelection {
  /** `conversation.*` entity id (or agent id); null = HA's preferred pipeline. */
  agentID: string | null;
  /** An Assist pipeline id; when set it wins over `agentID` on the streaming path. */
  pipelineID: string | null;
  /** HA-Jev config entry id, only when several exist. */
  jevConfigEntry: string | null;
  /** AI Task entity for proactive phrasing; null = the template. */
  aiTaskEntityID: string | null;
  language: string | null;
}

export const makeAgentSelection = (a: Partial<AgentSelection> = {}): AgentSelection =>
  ({ agentID: null, pipelineID: null, jevConfigEntry: null, aiTaskEntityID: null, language: null, ...a });

/** Which recogniser turns speech into text (design §6.8): the Assist pipeline's stt stage (null = HA's preferred). */
export type ASRSelection = { kind: 'homeAssistant'; pipelineID: string | null; language: string | null };
/** Where the spoken voice comes from: the Assist pipeline's tts stage (null = HA's preferred pipeline). */
export type TTSSelection = { kind: 'homeAssistant'; pipelineID: string | null };

export const asrLabel = (_a: ASRSelection): string => 'home assistant';
export const ttsLabel = (_t: TTSSelection): string => 'home assistant';

/** Everything the transport needs to reach the voice services. */
export interface VoiceServicesEndpoint {
  homeAssistant: HAEndpoint;
  asr: ASRSelection;
  /** null = no speech voice (fine in Yanni mode, except for announcements). */
  tts: TTSSelection | null;
  agent: AgentSelection;
  replyVoice: ReplyVoice;
  tunables: AgentTunables;
}

export function makeVoiceServicesEndpoint(e: Partial<VoiceServicesEndpoint> = {}): VoiceServicesEndpoint {
  return {
    homeAssistant: makeHAEndpoint(), asr: { kind: 'homeAssistant', pipelineID: null, language: null },
    tts: { kind: 'homeAssistant', pipelineID: null }, agent: makeAgentSelection(), replyVoice: 'spoken',
    tunables: makeAgentTunables(), ...e,
  };
}

/** Structural equality (Swift's synthesized `Equatable`). */
export function voiceServicesEndpointEqual(a: VoiceServicesEndpoint | null, b: VoiceServicesEndpoint | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
