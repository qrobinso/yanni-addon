// Port of ConversationAgentTests/OrchestratorRig.swift. The orchestrator with a fake HA (the relay seam), a
// counter-valued turn audio source, a frame-counting playout sink and a manual clock.
// port-note: no fake Wyoming server; speech goes through the fake HA's stt and tts runs (the default), or the
// recogniser seam's `FakeSpeechToText` (with HA's tts).
import type { AgentEvent, DecisionPayload, ReplyEnd, SentenceStart, TurnEnded } from '../../../src/conversation/events/AgentEvents';
import type { TransportStatus } from '../../../src/conversation/core/Ports';
import { makeAgentSelection, makeAgentTunables, makeVoiceServicesEndpoint, type AgentTunables, type VoiceServicesEndpoint } from '../../../src/conversation/core/VoiceServicesEndpoint';
import type { ReplyVoice } from '../../../src/conversation/events/AgentEvents';
import { DecisionQuestions } from '../../../src/conversation/agent/DecisionQuestions';
import { HAClient } from '../../../src/conversation/agent/homeassistant/HAClient';
import type { ReplyVoicing } from '../../../src/conversation/agent/Ports';
import { TurnOrchestrator, type OrchestratorOutput } from '../../../src/conversation/agent/TurnOrchestrator';
import { FakePlayoutSink, FakeTurnAudioSource, ManualAgentClock, RecordingContextPublisher, settle } from '../support/AgentTestKit';
import { FakeHA, FakeHomeAssistant, WAVMediaDecoder } from '../support/FakeHomeAssistant';
import { FakeSpeechToText } from '../support/FakeSpeechToText';

export type Speech = 'homeAssistant' | 'fakeRecognizer';

export class OrchRig {
  readonly clock = new ManualAgentClock();
  readonly ha = new FakeHomeAssistant();
  readonly audio = new FakeTurnAudioSource();
  readonly sink: FakePlayoutSink;
  readonly ctx = new RecordingContextPublisher();
  readonly stt = new FakeSpeechToText();
  readonly orch: TurnOrchestrator;
  readonly outs: OrchestratorOutput[] = [];
  transcript = "what's the weather like today?";
  services: VoiceServicesEndpoint;
  private gen = 0;

  constructor(o: { replyVoice?: ReplyVoice; tts?: boolean; aiTask?: string | null; yanni?: ReplyVoicing | null;
    sinkRate?: number; tunables?: AgentTunables; speech?: Speech } = {}) {
    this.sink = new FakePlayoutSink(o.sinkRate ?? 48000);
    this.services = makeVoiceServicesEndpoint({
      asr: { kind: 'homeAssistant', pipelineID: null, language: 'en' },
      tts: o.tts === false ? null : { kind: 'homeAssistant', pipelineID: null },
      agent: makeAgentSelection({ agentID: 'conversation.jev', aiTaskEntityID: o.aiTask ?? null, language: 'en' }),
      replyVoice: o.replyVoice ?? 'spoken', tunables: o.tunables ?? makeAgentTunables(),
    });
    const fake = this.stt;
    this.orch = new TurnOrchestrator({
      makeHAClient: () => new HAClient(this.ha, this.clock), audio: this.audio,
      voicers: { playoutSink: this.sink, yanni: o.yanni ?? null }, context: this.ctx,
      questions: DecisionQuestions.bundled(), clock: this.clock, makeMediaFetcher: () => this.ha,
      mediaDecoder: new WAVMediaDecoder(),
      makeSpeechToText: o.speech === 'fakeRecognizer' ? () => fake : null,
    });
    this.ha.configure((c) => { c.onSTT = async () => FakeHA.sttEnd(this.transcript); });
    this.orch.onOutput = (_g, out) => this.outs.push(out);
  }

  get events(): AgentEvent[] { return this.outs.flatMap((o) => (o.kind === 'event' ? [o.event] : [])); }
  get statuses(): TransportStatus[] { return this.outs.flatMap((o) => (o.kind === 'status' ? [o.status] : [])); }
  get eventNames(): string[] { return this.events.map(OrchRig.name); }

  static name(e: AgentEvent): string {
    switch (e.kind) {
      case 'decision': return e.payload.pass === 'utterance' ? 'decisionA' : 'decisionB';
      case 'dismissed': return e.payload.afterReply ? 'dismissed:afterReply' : `dismissed:${e.payload.source}`;
      case 'didNotUnderstand': return `didNotUnderstand:${e.payload.reason}`;
      case 'decisionModelUnavailable': return `unavailable:${e.payload.reason}`;
      case 'proactiveDone': return `proactiveDone:${e.payload.status}`;
      case 'error': return `error:${e.payload.code}`;
      default: return e.kind;
    }
  }

  has(name: string): boolean { return this.eventNames.includes(name); }

  /** Advances virtual time in 10 ms steps (letting the tasks run) until `cond` holds; false after `limit` seconds. */
  async drive(limit: number, cond: () => boolean): Promise<boolean> {
    let t = 0;
    while (t < limit) {
      if (cond()) return true;
      await settle();
      if (cond()) return true;
      this.clock.advance(0.01);
      t += 0.01;
    }
    return cond();
  }

  async connect(): Promise<boolean> {
    this.gen += 1;
    this.orch.connect(this.services, this.gen);
    await this.drive(3, () => this.statuses.some((s) => s.kind === 'ready' || s.kind === 'failed'));
    return this.statuses.some((s) => s.kind === 'ready');
  }

  /** The mic opens; 0.5 s of audio is already in the ring; speech starts (onset 100 ms ago). */
  async startSpeaking(): Promise<number> {
    if (this.audio.readableRange() === null) this.audio.open(this.clock.now());
    this.audio.capture(0.5, this.clock.now());
    const onset = this.clock.now() - 0.1;
    this.orch.handle({ kind: 'speechStart', payload: { onsetHostTime: onset } });
    await settle(1);
    return onset;
  }

  /** `seconds` of live audio while the ASR stream drains it. */
  async talk(seconds: number): Promise<void> {
    for (let t = 0; t < seconds - 1e-9; t += 0.02) {
      this.clock.advance(0.02);
      this.audio.capture(0.02, this.clock.now());
      await settle();
    }
  }

  async endTurn(): Promise<void> {
    this.orch.handle({ kind: 'turnEnd', payload: { hostTime: this.clock.now() } });
    await settle(1);
  }

  /** A whole user turn: speech start, 0.4 s of talking, turn end. */
  async userTurn(): Promise<void> {
    await this.startSpeaking();
    await this.talk(0.4);
    await this.endTurn();
  }

  turnEnded(): TurnEnded | undefined { return this.events.flatMap((e) => (e.kind === 'turnEnded' ? [e.payload] : [])).at(-1); }
  sentenceStarts(): SentenceStart[] { return this.events.flatMap((e) => (e.kind === 'sentenceStart' ? [e.payload] : [])); }
  replyEnds(): ReplyEnd[] { return this.events.flatMap((e) => (e.kind === 'replyEnd' ? [e.payload] : [])); }
  decisions(): DecisionPayload[] { return this.events.flatMap((e) => (e.kind === 'decision' ? [e.payload] : [])); }
  /** The texts the tts runs were asked to say. */
  ttsTexts(): string[] { return this.ha.runs('tts').map((m) => String((m.input as { text?: string }).text)); }
}
