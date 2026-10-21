// Port of ConversationAgentTests/AgentControllerRig.swift. The real `ConversationController` and face engine over
// `LocalAgentTransport`, with the fake HA behind it (S8: the old controller rows, end to end). One host clock drives
// the controller, the orchestrator and the fake turn audio; the fake audio engine "plays" what the spoken voicer
// queued. port-note: speech through the fake HA's pipeline (no Wyoming); `AgentFakeLife` / `AgentFakeVoice` are the
// ConversationCore rig's `FakeLife` / `FakeVoice`.
import { Backoff } from '../../../src/conversation/core/Backoff';
import { conversationFace } from '../../../src/conversation/core/Adapters';
import { ConversationController, type ConversationLogEntry, type ConversationPhase } from '../../../src/conversation/core/ConversationController';
import { makeAgentSelection, makeVoiceServicesEndpoint } from '../../../src/conversation/core/VoiceServicesEndpoint';
import type { AgentEvent, ReplyVoice } from '../../../src/conversation/events/AgentEvents';
import type { AgentState } from '../../../src/engine/AgentState';
import { makePersonTarget } from '../../../src/engine/Commands';
import { FaceEngine } from '../../../src/engine/FaceEngine';
import { DecisionQuestions } from '../../../src/conversation/agent/DecisionQuestions';
import { HAClient } from '../../../src/conversation/agent/homeassistant/HAClient';
import { LocalAgentTransport } from '../../../src/conversation/agent/LocalAgentTransport';
import { FakePlayoutSink, FakeTurnAudioSource, ManualAgentClock, settle } from '../support/AgentTestKit';
import { FakeHomeAssistant, WAVMediaDecoder } from '../support/FakeHomeAssistant';
import type { FakeSpeechToText } from '../support/FakeSpeechToText';
import { FakeAnnouncements, FakeConversationAudio, FakePerception, ManualClock, RecordingEmotionSink } from '../support/Fakes';
import { FakeLife, FakeVoice } from '../support/Rig';
import { FakeTurnDetection } from '../support/TurnFakes';
import { OrchRig } from './OrchestratorRig';

export class AgentControllerRig {
  readonly clock = new ManualClock();
  readonly agentClock: ManualAgentClock;
  readonly engine = new FaceEngine();
  readonly audio = new FakeConversationAudio();
  readonly perception = new FakePerception();
  readonly emotion = new RecordingEmotionSink();
  readonly announcements = new FakeAnnouncements();
  readonly voice = new FakeVoice();
  readonly detector = new FakeTurnDetection();
  readonly life: FakeLife;
  readonly ha = new FakeHomeAssistant();
  readonly turnAudio = new FakeTurnAudioSource();
  readonly sink = new FakePlayoutSink(48000);
  readonly transport: LocalAgentTransport;
  readonly controller: ConversationController;
  events: AgentEvent[] = [];
  log: ConversationLogEntry[] = [];
  reachability: boolean[] = [];
  static readonly dt = 1.0 / 60;
  private playedFrames = 0;

  constructor(o: { replyVoice?: ReplyVoice; tts?: boolean; aiTask?: string | null; stt?: FakeSpeechToText | null } = {}) {
    this.agentClock = new ManualAgentClock(this.clock.now);
    this.life = new FakeLife(this.engine);
    this.engine.setAgentState('idle');
    const stt = o.stt ?? null;
    this.transport = new LocalAgentTransport({
      makeHAClient: () => new HAClient(this.ha, this.agentClock), audio: this.turnAudio,
      voicers: { playoutSink: this.sink, yanni: null }, context: null, questions: DecisionQuestions.bundled(),
      clock: this.agentClock, makeMediaFetcher: () => this.ha, mediaDecoder: new WAVMediaDecoder(),
      makeSpeechToText: stt ? () => stt : null,
    });
    const services = makeVoiceServicesEndpoint({
      asr: { kind: 'homeAssistant', pipelineID: null, language: 'en' },
      tts: o.tts === false ? null : { kind: 'homeAssistant', pipelineID: null },
      agent: makeAgentSelection({ agentID: 'conversation.jev', aiTaskEntityID: o.aiTask ?? null }), replyVoice: o.replyVoice ?? 'spoken',
    });
    this.controller = new ConversationController({
      face: conversationFace(this.engine), life: this.life, audio: this.audio, transport: this.transport, voice: this.voice,
      backoff: new Backoff({ random: () => 0.5 }), clock: this.clock.fn,
    });
    const c = this.controller;
    c.perception = this.perception;
    c.emotion = this.emotion;
    c.announcements = this.announcements;
    c.turn = this.detector;
    c.onLog = (e) => this.log.push(e);
    c.onServicesReachabilityChange = (r) => this.reachability.push(r);
    this.transport.onAgentEvent = (e) => this.events.push(e);
    c.endpoint = services;
  }

  get state(): AgentState { return this.engine.state.agentState; }
  get phase(): ConversationPhase { return this.controller.phase; }
  has(name: string): boolean { return this.events.map(OrchRig.name).includes(name); }

  /** One 60 fps frame on both clocks, with the agent's tasks given a chance to run; queued reply audio "plays". */
  async frame(): Promise<void> {
    const dt = AgentControllerRig.dt;
    this.clock.advance(dt);
    this.agentClock.advance(dt);
    if (this.audio.captureEnabled) this.turnAudio.capture(dt, this.clock.now);
    await settle(3);
    const queued = this.sink.framesQueued;
    if (this.phase === 'thinking' && queued > this.playedFrames && this.audio.snapshot.replyStart?.epoch !== this.audio.armedEpoch) {
      this.audio.startReply(this.clock.now);
    }
    if (this.phase === 'speaking' && queued > this.playedFrames) {
      const n = Math.min(Math.trunc(dt * 48000), queued - this.playedFrames);
      this.playedFrames += n;
      this.audio.play(n / 48000, this.clock.now, true);
    }
    this.engine.tick(dt, this.clock.now);
    this.controller.afterFrame(this.clock.now);
  }

  async run(seconds: number): Promise<void> { for (let i = 0; i < Math.round(seconds / AgentControllerRig.dt); i++) await this.frame(); }

  async runUntil(limit: number, cond: () => boolean): Promise<boolean> {
    const start = this.clock.now;
    while (this.clock.now - start < limit) {
      await this.frame();
      if (cond()) return true;
    }
    return cond();
  }

  person(id = 1, engaged = false): void {
    this.engine.setPeople([makePersonTarget(id, { x: 0, y: 0 })], id, engaged ? id : null);
    this.life.isPresent = true;
    if (this.state === 'idle') this.engine.setAgentState('noticing');
  }

  leave(): void {
    this.engine.setPeople([], null, null);
    this.life.isPresent = false;
  }

  async toListening(): Promise<boolean> {
    this.person();
    if (!(await this.runUntil(3, () => this.transport.status.kind === 'ready'))) return false;
    if (this.turnAudio.readableRange() === null) this.turnAudio.open(this.clock.now);
    this.person(1, true);
    return this.runUntil(3, () => this.phase === 'listening');
  }

  speak(): void { this.detector.speechStarted(this.clock.now - 0.08); }
  endTurn(): void { this.detector.turnEnded(this.clock.now - 0.2, this.clock.now); }

  /** Listening → speech → 0.4 s → turn end. */
  async userTurn(): Promise<void> {
    this.speak();
    await this.run(0.4);
    this.endTurn();
    await this.frame();
  }

  lookAwayAndBack(): void {
    const people = this.engine.state.people.slice();
    this.engine.setPeople(people, people[0]?.id ?? null, null);
    this.engine.setAgentState('noticing');
    this.person(1, true);
  }

  get cancelsSent(): string[] { return this.log.filter((e) => e.kind === 'thinking').map((e) => e.detail); }
}
