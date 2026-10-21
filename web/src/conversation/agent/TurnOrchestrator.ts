// Port of ConversationAgent/TurnOrchestrator.swift. Turn orchestration inside the transport (design §6): ASR from
// `speech-start`, the sequential Pass A gate, the HA agent reply, the sentence chunker with Pass B, the reply voice and
// its timing, proactive announcements. Transcripts and replies are never logged.
// port-note: the actor becomes a class (JS is single-threaded; awaits interleave like actor reentrancy); its output
// stream is the `onOutput` callback; tasks are promises cancelled through `AbortSignal`s. The +Turn / +Reply /
// TurnRecord extensions are free functions over this class. Wyoming and Apple's recogniser are dropped (browsers
// have no raw TCP and no on-device recogniser): speech goes through Home Assistant's pipeline.
import type { AgentEvent, ServicesInfo } from '../events/AgentEvents';
import type { AgentIntent, ContextUpdate, MoodReportPayload } from '../events/AgentIntents';
import type { CaptionText } from '../events/Captions';
import type { ExpressiveAskResult, ExpressiveFeatures } from '../events/ExpressiveEvents';
import type { TransportStatus } from '../core/Ports';
import { asrLabel, clampedAgentTunables, makeAgentTunables, ttsLabel, type ASRSelection, type HAEndpoint, type TTSSelection, type VoiceServicesEndpoint } from '../core/VoiceServicesEndpoint';
import { roundHalfAway } from '../turn/TurnTunables';
import { makeServicesHealth, SystemAgentClock, withAgentTimeout, type AgentClock, type AgentTunables, type ServicesHealth } from './AgentTunables';
import { HAClipVoice } from './ClipRenderer';
import { DecisionQuestions, type RecentLine } from './DecisionQuestions';
import { HAError, type HAChannel } from './homeassistant/HAChannel';
import { HAClient } from './homeassistant/HAClient';
import { configEntries, haVersionAtLeast, jevAsk, pipelines, type HAPipelineInfo } from './homeassistant/HACommands';
import { FetchHAMediaFetcher, HAPipelineSpeechToText, WebAudioMediaDecoder, type HAMediaFetching, type MediaDecoder } from './homeassistant/HASpeech';
import { JevGate, type JevAsk } from './JevGate';
import type {
  ConversationContextPublishing, ConversationContextSnapshot, ReplyPlayoutSink, ReplyVoicing, SpeechToText,
  SpeechToTextHealth, TurnAudioSource,
} from './Ports';
import { cancelCurrent, handle, micClosed, setAnnouncementPending, type TurnRecord } from './TurnRecord';

/** What the orchestrator tells its facade, tagged with the connect generation it belongs to. */
export type OrchestratorOutput =
  | { kind: 'status'; status: TransportStatus }
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'health'; health: ServicesHealth }
  /** Words for the caption bubbles (never logged; the controller drops them when captions are off). */
  | { kind: 'caption'; caption: CaptionText };

/** The reply voices the app provides. Spoken is built per connect from the TTS selection and the playout sink; the
 *  Yanni voice (FaceVoice babble through the reply renderer) is injected as it is. */
export interface ReplyVoicers {
  playoutSink: ReplyPlayoutSink | null;
  yanni: ReplyVoicing | null;
}

/** What a recogniser may need at connect: this connection's HA client, the tunables. */
export interface SpeechToTextContext { ha: HAClient | null; tunables: AgentTunables }

/** Everything the orchestrator talks to, injected (fakes in tests). */
export interface OrchestratorDependencies {
  makeHAClient: () => HAClient;
  audio: TurnAudioSource | null;
  voicers: ReplyVoicers;
  context: ConversationContextPublishing | null;
  questions: DecisionQuestions;
  clock: AgentClock;
  /** Fetches the TTS audio (`/api/tts_proxy/…`) from the add-on. */
  makeMediaFetcher: (ep: HAEndpoint) => HAMediaFetching;
  /** Decodes it (WebAudio in the app, a fake in Node tests). */
  mediaDecoder: MediaDecoder;
  /** The recogniser for a connect (the seam, design §6.8); null = `standardSpeechToText`. */
  makeSpeechToText?: ((selection: ASRSelection, ctx: SpeechToTextContext) => SpeechToText) | null;
}

export const OrchestratorDependencies = {
  /** The built-in recogniser: Home Assistant's pipeline (port-note: no Wyoming, no Apple recogniser). */
  standardSpeechToText(selection: ASRSelection, ctx: SpeechToTextContext): SpeechToText {
    return new HAPipelineSpeechToText(ctx.ha, selection.pipelineID, ctx.tunables);
  },

  /** The real stack: the add-on relay (`displayClientChannel(displayClient)`), the `tts_proxy` fetch with the
   *  display's device token from the page's own origin, WebAudio decoding, the host clock. */
  live(o: {
    channel: HAChannel; audio: TurnAudioSource | null; voicers: ReplyVoicers; context: ConversationContextPublishing | null;
    deviceToken: string; baseURL?: string;
  }): OrchestratorDependencies {
    const clock = new SystemAgentClock();
    const base = o.baseURL ?? document.baseURI;
    return {
      makeHAClient: () => new HAClient(o.channel, clock), audio: o.audio, voicers: o.voicers, context: o.context,
      questions: DecisionQuestions.bundled(), clock,
      makeMediaFetcher: () => new FetchHAMediaFetcher(base, o.deviceToken), mediaDecoder: new WebAudioMediaDecoder(),
    };
  },
};

export type AgentPath = 'streamed' | 'whole';

/** The speech voice at connect: the HA pipeline's `tts_engine`. */
export interface VoiceCheck {
  up: boolean;
  engine: string | null;
  pipeline: HAPipelineInfo | null;
  /** Why it's down (null = simply not configured). */
  problem: string | null;
}

const healthEqual = (a: ServicesHealth, b: ServicesHealth): boolean =>
  (Object.keys(a) as (keyof ServicesHealth)[]).every((k) => a[k] === b[k]);

export class TurnOrchestrator {
  /** Every output, tagged with its generation (the facade's), so a dropped session's late output is ignored. */
  onOutput: ((generation: number, output: OrchestratorOutput) => void) | null = null;

  services: VoiceServicesEndpoint | null = null;
  tunables: AgentTunables = makeAgentTunables();
  generation = 0;
  ready = false;
  ha: HAClient | null = null;
  connectAbort: AbortController | null = null;
  /** Re-asks a preparing recogniser until it's ready (its progress on Status). */
  speechHealthAbort: AbortController | null = null;
  health: ServicesHealth = makeServicesHealth();
  readonly gate: JevGate;
  /** Expressive asks (expressive decisions design §4): the same `jev.ask`, its own breaker. */
  readonly expressiveGate: JevGate;

  agentPath: AgentPath = 'streamed';
  /** This connection's recogniser (built at connect from `services.asr`). */
  speechToText: SpeechToText | null = null;
  /** Through HA: the pipeline the speech voice runs on (resolved at connect) and whether it has a TTS engine. */
  speechPipeline: HAPipelineInfo | null = null;
  haTTSAvailable = false;

  // Conversation session (from `engage` until the next one or a disconnect).
  conversationID: string | null = null;
  recent: RecentLine[] = [];
  lastContinueConversation = false;

  // Context for the R2 sensor.
  mood: MoodReportPayload | null = null;
  moodAt = -Infinity;
  contextUpdate: ContextUpdate | null = null;
  announcementPending = false;
  lastPublishedContext: ConversationContextSnapshot | null = null;

  // Turns.
  turnCounter = 0;
  serialCounter = 0;
  current: TurnRecord | null = null;
  lastTurnEndIndex: number | null = null;

  constructor(readonly deps: OrchestratorDependencies) {
    this.gate = new JevGate(deps.questions, makeAgentTunables(), deps.clock);
    this.expressiveGate = new JevGate(deps.questions, makeAgentTunables(), deps.clock);
  }

  get clock(): AgentClock { return this.deps.clock; }

  // MARK: Expressive asks

  /** One expressive ask (expressive decisions design §4–§5): only the documented features go out, on the expressive
   *  gate's own breaker and timeout. Disabled while not connected or without HA-Jev. */
  async expressive(features: ExpressiveFeatures): Promise<ExpressiveAskResult> {
    if (!this.ready || !this.ha) return { kind: 'disabled' };
    return this.expressiveGate.expressive(features);
  }

  // MARK: Output

  emitRaw(generation: number, o: OrchestratorOutput): void { this.onOutput?.(generation, o); }
  emit(o: OrchestratorOutput): void { this.emitRaw(this.generation, o); }
  emitEvent(e: AgentEvent): void { this.emit({ kind: 'event', event: e }); }
  publishHealth(): void { this.emit({ kind: 'health', health: { ...this.health } }); }

  // MARK: Intents

  handle(intent: AgentIntent): void { handle(this, intent); }
  /** The mic closed: a turn still being captured is dropped, and nothing is emitted. */
  micClosed(): void { micClosed(this); }
  setAnnouncementPending(on: boolean): void { setAnnouncementPending(this, on); }

  // MARK: Session

  /** Connects; outputs carry `generation` (the facade's), so a dropped session's late output is ignored. */
  connect(s: VoiceServicesEndpoint, generation: number): void {
    this.teardown();
    this.generation = generation;
    this.services = s;
    this.tunables = clampedAgentTunables(s.tunables);
    const gen = this.generation;
    this.emit({ kind: 'status', status: { kind: 'connecting' } });
    const c = new AbortController();
    this.connectAbort = c;
    void this.runConnect(s, gen, c.signal);
  }

  disconnect(generation: number): void {
    this.teardown();
    this.generation = generation;
    this.services = null;
  }

  private teardown(): void {
    this.connectAbort?.abort();
    this.connectAbort = null;
    this.speechHealthAbort?.abort();
    this.speechHealthAbort = null;
    cancelCurrent(this, true);
    const old = this.ha;
    this.ha = null;
    this.ready = false;
    this.speechToText = null;
    this.speechPipeline = null;
    this.haTTSAvailable = false;
    old?.close();
    this.endConversationSession();
  }

  endConversationSession(): void {
    this.conversationID = null;
    this.recent = [];
    this.lastContinueConversation = false;
  }

  private async runConnect(s: VoiceServicesEndpoint, gen: number, signal: AbortSignal): Promise<void> {
    const t = this.tunables;
    const h = makeServicesHealth();
    const client = this.deps.makeHAClient();
    client.setOnClosed((error) => queueMicrotask(() => this.haClosed(gen, error)));
    const live = () => gen === this.generation && !signal.aborted;
    let version: string;
    try {
      version = await client.connect(s.homeAssistant, Math.max(t.requestTimeout, 1), t.pingInterval, t.pongTimeout);
    } catch (error) {
      if (!live()) return;
      h.homeAssistant = 'down';
      this.health = h;
      this.publishHealth();
      this.emit({ kind: 'status', status: { kind: 'failed', reason: TurnOrchestrator.describe(error) } });
      return;
    }
    if (!live()) { client.close(); return; }
    this.ha = client;
    h.homeAssistant = 'up';
    h.haVersion = version;

    // Speech-to-text through the recogniser seam; the speech voice through HA's pipeline. TTS is required in Spoken
    // mode, optional (announcements) in Yanni mode (design §6.8).
    const stt = (this.deps.makeSpeechToText ?? OrchestratorDependencies.standardSpeechToText)(s.asr, { ha: client, tunables: t });
    this.speechToText = stt;
    h.asrRoute = asrLabel(s.asr);
    h.ttsRoute = s.tts ? ttsLabel(s.tts) : null;
    const [asrState, tts] = await Promise.all([stt.describe(t.describeTimeout), this.describeVoice(s.tts, client, t)]);
    if (!live()) return;
    // Only an unreachable or missing recogniser fails the connect. One that is preparing or unusable on this device
    // connects: its turns fail (stt-failed) and Status says why.
    let speechProblem: string | null = null;
    TurnOrchestrator.apply(asrState, h);
    if (asrState.kind === 'down') speechProblem = asrState.why;
    else if (asrState.kind === 'notConfigured') speechProblem = 'no speech recognizer configured';
    this.speechPipeline = tts.pipeline;
    this.haTTSAvailable = tts.up;
    h.pipelineName = tts.pipeline?.name ?? null;
    h.ttsProgram = tts.engine;
    h.tts = tts.up ? 'up' : tts.problem !== null ? 'down' : (s.replyVoice === 'yanni' ? 'not used' : 'not configured');
    const ttsUp = tts.up;
    if (speechProblem === null && s.replyVoice === 'spoken' && !ttsUp) speechProblem = tts.problem ?? 'no speech voice configured';

    // The decision model: HA-Jev present (a config entry) → the gate runs; none → disabled (every utterance
    // addressed). An error asking is treated as present (the gate then fails open on its own).
    let entries: unknown[] | null = null;
    try { entries = await configEntries(client, 'jev'); } catch { entries = null; }
    if (!live()) return;
    const jevPresent = entries === null ? true : entries.length > 0;
    this.gate.setTunables(t);
    this.expressiveGate.setTunables(t);
    if (jevPresent) {
      const entry = s.agent.jevConfigEntry;
      const ask: JevAsk = (state, questions, sig) => jevAsk(client, state, questions, entry, sig);
      this.gate.setAsk(ask);
      this.expressiveGate.setAsk(ask);
      h.jev = 'unknown';
    } else {
      this.gate.setAsk(null);
      this.expressiveGate.setAsk(null);
      h.jev = 'not configured';
    }
    this.agentPath = haVersionAtLeast(version, 2025, 3) ? 'streamed' : 'whole';
    h.agentPath = this.agentPath;
    this.health = h;
    this.publishHealth();

    if (speechProblem !== null) {
      this.emit({ kind: 'status', status: { kind: 'failed', reason: speechProblem } });
      return;
    }
    this.ready = true;
    this.emitEvent({ kind: 'servicesInfo', payload: this.servicesInfo(version, jevPresent, ttsUp) });
    this.emit({ kind: 'status', status: { kind: 'ready' } });
    if (asrState.kind === 'preparing') this.watchSpeechHealth(stt, gen);
  }

  /** A recogniser's state into the health (state, engine, why not yet). */
  static apply(state: SpeechToTextHealth, h: ServicesHealth): void {
    h.asrDetail = null;
    switch (state.kind) {
      case 'up': h.asr = 'up'; h.asrProgram = state.engine; break;
      case 'down': h.asr = 'down'; h.asrDetail = state.why; break;
      case 'preparing': h.asr = 'preparing'; h.asrDetail = `preparing ${roundHalfAway(state.progress * 100)} %`; break;
      case 'unavailable': h.asr = 'down'; h.asrDetail = state.why; break;
      case 'notConfigured': h.asr = 'not configured'; break;
    }
  }

  /** While the recogniser prepares, asks it again every second and publishes each change, until it's done. */
  watchSpeechHealth(stt: SpeechToText, gen: number): void {
    this.speechHealthAbort?.abort();
    const t = this.tunables, clock = this.clock;
    const c = new AbortController();
    this.speechHealthAbort = c;
    void (async () => {
      while (!c.signal.aborted) {
        await clock.sleep(1, c.signal).catch(() => {});
        if (c.signal.aborted) return;
        const state = await stt.describe(t.describeTimeout);
        if (c.signal.aborted || !this.noteSpeechHealth(state, gen)) return;
      }
    })();
  }

  /** Applies a fresh recogniser state (after a failed start, "up" still means down); true while it's preparing. */
  noteSpeechHealth(state: SpeechToTextHealth, gen: number, failedStart = false): boolean {
    if (gen !== this.generation || !this.ready) return false;
    const h = { ...this.health };
    TurnOrchestrator.apply(state, h);
    if (failedStart && state.kind === 'up') h.asr = 'down';
    if (!healthEqual(h, this.health)) { this.health = h; this.publishHealth(); }
    return state.kind === 'preparing';
  }

  async describeVoice(tts: TTSSelection | null, client: HAClient, t: AgentTunables): Promise<VoiceCheck> {
    if (tts === null) return { up: false, engine: null, pipeline: null, problem: null };
    let listed: Awaited<ReturnType<typeof pipelines>>;
    try { listed = await withAgentTimeout(t.describeTimeout, this.deps.clock, (sig) => pipelines(client, sig)); } catch {
      return { up: true, engine: null, pipeline: null, problem: null }; // not answered: assume it works; the runs report their own errors
    }
    const p = listed.pipelines.find((x) => x.id === (tts.pipelineID ?? listed.preferred));
    if (!p) return { up: false, engine: null, pipeline: null, problem: 'pipeline not found' };
    if (p.ttsEngine === null) return { up: false, engine: null, pipeline: p, problem: 'the pipeline has no speech voice' };
    return { up: true, engine: [p.ttsEngine, p.ttsVoice].filter((x): x is string => x !== null).join(' · '), pipeline: p, problem: null };
  }

  servicesInfo(version: string, jevPresent: boolean, ttsUp: boolean): ServicesInfo {
    const voiceId = this.services?.tts ? (this.speechPipeline ? HAClipVoice.voiceId(this.speechPipeline) : null) : null;
    return { haVersion: version, voiceId, decisionModel: jevPresent ? 'up' : 'disabled',
      replyVoice: this.services?.replyVoice ?? 'spoken', ttsAvailable: ttsUp };
  }

  private haClosed(gen: number, error: HAError): void {
    if (gen !== this.generation || !this.ha) return;
    this.ha = null;
    this.ready = false;
    this.health = { ...this.health, homeAssistant: 'down' };
    this.publishHealth();
    const turn = this.current;
    if (turn && turn.phase !== 'capturing' && !turn.isCancelled) {
      if (turn.live) this.emitRaw(turn.generation, { kind: 'event', event: { kind: 'error', payload: { code: 'llm-failed', turnId: turn.turnId, detail: null } } });
    }
    cancelCurrent(this, true);
    this.emit({ kind: 'status', status: { kind: 'failed',
      reason: error.kind === 'timeout' ? 'home assistant keep-alive timed out' : 'home assistant connection lost' } });
  }

  static describe(error: unknown): string {
    if (error instanceof HAError) {
      switch (error.kind) {
        case 'authInvalid': return 'token rejected';
        case 'insecureNotAllowed': return `insecure connection refused: ${error.detail}`;
        case 'badURL': return 'home assistant URL unusable';
        case 'timeout': return 'home assistant timed out';
        default: break;
      }
    }
    return 'home assistant unreachable';
  }

  // MARK: Status read-outs

  get currentHealth(): ServicesHealth { return this.health; }
  get isReady(): boolean { return this.ready; }
  get currentConversationID(): string | null { return this.conversationID; }
}
