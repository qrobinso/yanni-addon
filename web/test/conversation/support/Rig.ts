// Port of Tests/ConversationCoreTests/Rig.swift.
import { Backoff } from '../../../src/conversation/core/Backoff';
import { conversationFace } from '../../../src/conversation/core/Adapters';
import {
  ConversationController, type ConversationLogEntry, type ConversationPhase,
} from '../../../src/conversation/core/ConversationController';
import type { ConversationLife, ConversationVoice } from '../../../src/conversation/core/Ports';
import type { ServicesInfo } from '../../../src/conversation/events/AgentEvents';
import type { AgentIntent, CancelTurn, Engage, MoodReportPayload, ProactiveRequest } from '../../../src/conversation/events/AgentIntents';
import type { AgentState } from '../../../src/engine/AgentState';
import { makePersonTarget } from '../../../src/engine/Commands';
import { FaceEngine } from '../../../src/engine/FaceEngine';
import { LifePhase, type ActivityKind } from '../../../src/life/LifeTypes';
import {
  FakeAnnouncements, FakeConversationAudio, FakeGreetings, FakePerception, FakeVoiceTransport, ManualClock,
  RecordingEmotionSink, testEndpoint,
} from './Fakes';
import { FakeTurnDetection } from './TurnFakes';

/** Life cycle stand-in: phase follows the face, presence and bedtime are scripted. */
export class FakeLife implements ConversationLife {
  isPresent = false;
  isBedtime = false;
  isForceSleepActive = false;
  activity: ActivityKind[] = [];
  constructor(readonly face: FaceEngine) {}
  get phase(): LifePhase { return LifePhase.of(this.face.state.agentState); }
  noteActivity(kind: ActivityKind): void { this.activity.push(kind); }
}

/** Voice stand-in: the audible end of the "engaged chirp" is scripted. */
export class FakeVoice implements ConversationVoice {
  audibleUntilHostTime = 0;
  isSpeaking = false;
  cancels = 0;
  onCall: ((c: string) => void) | null = null;
  cancel(): void { this.onCall?.('voice.cancel'); this.cancels += 1; }
}

/** A real face engine with fake everything else, ticked at 60 fps on a manual clock. */
export class Rig {
  readonly clock = new ManualClock();
  readonly engine = new FaceEngine();
  readonly transport = new FakeVoiceTransport();
  readonly audio = new FakeConversationAudio();
  readonly perception = new FakePerception();
  readonly emotion = new RecordingEmotionSink();
  readonly announcements = new FakeAnnouncements();
  readonly greetings = new FakeGreetings();
  readonly voice = new FakeVoice();
  readonly detector = new FakeTurnDetection();
  readonly life: FakeLife;
  readonly controller: ConversationController;
  log: ConversationLogEntry[] = [];
  reachability: boolean[] = [];
  states: AgentState[] = [];
  static readonly dt = 1.0 / 60;

  constructor(o: { configured?: boolean; autoReady?: boolean; info?: ServicesInfo | null } = {}) {
    this.life = new FakeLife(this.engine);
    this.engine.setAgentState('idle');
    this.controller = new ConversationController({
      face: conversationFace(this.engine), life: this.life, audio: this.audio, transport: this.transport, voice: this.voice,
      backoff: new Backoff({ random: () => 0.5 }), clock: this.clock.fn,
    });
    const c = this.controller;
    c.perception = this.perception;
    c.emotion = this.emotion;
    c.announcements = this.announcements;
    c.greetings = this.greetings;
    c.turn = this.detector;
    c.onLog = (e) => this.log.push(e);
    c.onServicesReachabilityChange = (r) => this.reachability.push(r);
    this.transport.autoReady = o.autoReady ?? true;
    this.transport.autoInfo = o.info ?? null;
    if (o.configured ?? true) c.endpoint = testEndpoint();
  }

  get state(): AgentState { return this.engine.state.agentState; }
  get phase(): ConversationPhase { return this.controller.phase; }

  frame(): void {
    this.clock.advance(Rig.dt);
    this.engine.tick(Rig.dt, this.clock.now);
    this.controller.afterFrame(this.clock.now);
    if (this.states[this.states.length - 1] !== this.state) this.states.push(this.state);
  }

  run(seconds: number): void {
    const n = Math.round(seconds / Rig.dt);
    for (let i = 0; i < n; i++) this.frame();
  }

  /** Runs until `cond` holds; returns the elapsed seconds or null after `limit`. */
  runUntil(limit: number, cond: () => boolean): number | null {
    const start = this.clock.now;
    while (this.clock.now - start < limit) {
      this.frame();
      if (cond()) return this.clock.now - start;
    }
    return null;
  }

  // MARK: Scripting

  person(id = 1, o: { engaged?: boolean; facing?: number } = {}): void {
    this.engine.setPeople([makePersonTarget(id, { x: 0, y: 0 }, 1.5, 0.5, o.facing ?? 1)], id, o.engaged ? id : null);
    this.life.isPresent = true;
    if (this.state === 'idle') this.engine.setAgentState('noticing');   // what the life cycle does
  }

  lookAway(): void {
    const people = this.engine.state.people.slice();
    this.engine.setPeople(people, people[0]?.id ?? null, null);
  }

  leave(): void {
    this.engine.setPeople([], null, null);
    this.life.isPresent = false;
  }

  /** Presence → session ready → engagement → unmuted listening. */
  toListening(id = 1): void {
    this.person(id);
    this.run(0.2);
    this.person(id, { engaged: true });
    this.runUntil(2, () => this.phase === 'listening');
  }

  /** The detector confirms speech (onset 80 ms ago). */
  speak(): void { this.detector.speechStarted(this.clock.now - 0.08); }

  /** The detector ends the turn: speech ended 0.2 s ago, Smart Turn said complete now. */
  endTurn(): void { this.detector.turnEnded(this.clock.now - 0.2, this.clock.now); }

  /** The transport's `turn-ended` for the turn the device ended. */
  transportTurnEnded(turn: string, chars = 12): void {
    this.transport.agent({ kind: 'turnEnded', payload: { turnId: turn, transcriptChars: chars } });
  }

  toThinking(turn = 't1'): void {
    this.toListening();
    this.speak();
    this.run(0.5);
    this.endTurn();
    this.transportTurnEnded(turn);
    this.frame();
  }

  toSpeaking(turn = 't1'): void {
    this.toThinking(turn);
    this.run(0.3);
    this.audio.startReply(this.clock.now);
    this.frame();
  }

  /** Simulates reply audio playing for `seconds` (loud), frame by frame. */
  playReply(seconds: number, loud = true): void {
    const n = Math.round(seconds / Rig.dt);
    for (let i = 0; i < n; i++) {
      this.audio.play(Rig.dt, this.clock.now + Rig.dt, loud);
      this.frame();
    }
  }

  sentClient<T>(pick: (i: AgentIntent) => T | null): T[] {
    const out: T[] = [];
    for (const i of this.transport.sent) { const v = pick(i); if (v !== null) out.push(v); }
    return out;
  }

  get engages(): Engage[] { return this.sentClient((i) => (i.kind === 'engage' ? i.payload : null)); }
  get moods(): MoodReportPayload[] { return this.sentClient((i) => (i.kind === 'mood' ? i.payload : null)); }
  get cancels(): CancelTurn[] { return this.sentClient((i) => (i.kind === 'cancelTurn' ? i.payload : null)); }
  get proactives(): ProactiveRequest[] { return this.sentClient((i) => (i.kind === 'proactive' ? i.payload : null)); }

  /** The log as "kind: detail" lines. */
  get lines(): string[] { return this.log.map((e) => `${e.kind}: ${e.detail}`); }
}

export function mood(label: string, version = 1): MoodReportPayload {
  return { version, felt: { p: 0.4, a: 0.3, d: 0.1 }, mood: { p: 0.2, a: 0.1, d: 0.1 }, label, moodLabel: 'cheerful', boredom: 0, conditions: [] };
}
