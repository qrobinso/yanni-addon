// Port of ConversationTestSupport/Fakes.swift.
import type { AgentEvent, ServicesInfo } from '../../../src/conversation/events/AgentEvents';
import { agentIntentName, type AgentIntent, type ProactiveItem } from '../../../src/conversation/events/AgentIntents';
import {
  makePlayoutSnapshot, type AnnouncementDelivery, type CachedClip, type ConversationAudioControl, type ConversationPerception,
  type DecisionWireMessage, type EmotionSink, type GateEvent, type GreetingClips, type PlayoutSnapshot, type ProactiveBatch,
  type ProactiveOutcome, type TransportEvent, type TransportStatus, type VoiceTransport,
} from '../../../src/conversation/core/Ports';
import { makeVoiceServicesEndpoint, type VoiceServicesEndpoint } from '../../../src/conversation/core/VoiceServicesEndpoint';
import { roundHalfAway } from '../../../src/conversation/turn/TurnTunables';

/** A configured endpoint for tests (nothing connects to it). port-note: HA's pipeline only (no Wyoming hosts). */
export const testEndpoint = (): VoiceServicesEndpoint => makeVoiceServicesEndpoint();

/** The two turn intents, as the fake records them. */
export type TurnIntentKind = 'speech-start' | 'turn-end';

/** Scripted transport: records what the controller sends and lets a test play the voice services. */
export class FakeVoiceTransport implements VoiceTransport {
  onEvent: ((e: TransportEvent) => void) | null = null;
  status: TransportStatus = { kind: 'disconnected' };
  /** Every intent except the turn intents, in order. */
  sent: AgentIntent[] = [];
  micEnabled = false;
  micChanges: boolean[] = [];
  connects: VoiceServicesEndpoint[] = [];
  disconnects = 0;
  /** Turn intents as sent, and their host times (the onset for `speech-start`, the verdict for `turn-end`). */
  intents: TurnIntentKind[] = [];
  intentTimes: number[] = [];
  /** Ordered call trace hook (barge-in order tests): "send:<name>", "intent:<name>". */
  onCall: ((c: string) => void) | null = null;
  /** When true, `connect` goes straight to ready (with `autoInfo`). */
  autoReady = false;
  autoInfo: ServicesInfo | null = null;

  connect(services: VoiceServicesEndpoint): void {
    this.connects.push(services);
    this.setStatus({ kind: 'connecting' });
    if (this.autoReady) this.becomeReady(this.autoInfo);
  }

  disconnect(): void {
    this.disconnects += 1;
    if (this.status.kind !== 'disconnected') this.setStatus({ kind: 'disconnected' });
  }

  setMicEnabled(on: boolean): void {
    if (on === this.micEnabled) return;
    this.micEnabled = on;
    this.micChanges.push(on);
  }

  send(intent: AgentIntent): void {
    switch (intent.kind) {
      case 'speechStart':
        this.onCall?.(`intent:${agentIntentName(intent)}`);
        this.intents.push('speech-start');
        this.intentTimes.push(intent.payload.onsetHostTime);
        break;
      case 'turnEnd':
        this.onCall?.(`intent:${agentIntentName(intent)}`);
        this.intents.push('turn-end');
        this.intentTimes.push(intent.payload.hostTime);
        break;
      default:
        this.onCall?.(`send:${agentIntentName(intent)}`);
        this.sent.push(intent);
    }
  }

  // MARK: Voice services side

  becomeReady(info: ServicesInfo | null = null): void {
    this.status = { kind: 'ready' };
    if (info !== null) this.onEvent?.({ kind: 'agent', event: { kind: 'servicesInfo', payload: info } });
    this.onEvent?.({ kind: 'status', status: { kind: 'ready' } });
  }

  fail(why = 'test'): void { this.setStatus({ kind: 'failed', reason: why }); this.status = { kind: 'disconnected' }; }

  drop(): void { this.setStatus({ kind: 'disconnected' }); }

  agent(e: AgentEvent): void { this.onEvent?.({ kind: 'agent', event: e }); }

  clearSent(): void { this.sent = []; this.intents = []; this.intentTimes = []; }

  sentNames(): string[] { return this.sent.map(agentIntentName); }

  private setStatus(s: TransportStatus): void {
    this.status = s;
    this.onEvent?.({ kind: 'status', status: s });
  }
}

/** The audio engine as far as the controller can see: switches, a scripted playout snapshot and a recorded clip list. */
export class FakeConversationAudio implements ConversationAudioControl {
  conversationMode = false;
  modeChanges: boolean[] = [];
  captureEnabled = false;
  captureChanges: boolean[] = [];
  gain = 1;
  armedEpoch: number | null = null;
  flushes = 0;
  snapshot: PlayoutSnapshot = makePlayoutSnapshot();
  level: number | null = null;
  clips: { url: string; at: number; gain: number }[] = [];
  /** Clip length used to compute the audible end returned by `playClip`. */
  clipDuration = 0.6;
  /** When false, `playClip` returns null (can't play). */
  clipsPlayable = true;
  /** Ordered call trace hook (barge-in order tests): "flush". */
  onCall: ((c: string) => void) | null = null;
  /** When true, a mode switch stays in flight until `finishSwitch()`; otherwise it is ready at once. */
  switchesLater = false;
  private switchPending = false;
  /** Envelope samples the next `drainSpeechLevels` hands out (level, audible host time). */
  envelope: [number, number][] = [];

  get isAudioReady(): boolean { return !this.switchPending; }
  finishSwitch(): void { this.switchPending = false; }
  setConversationMode(on: boolean): void {
    this.conversationMode = on;
    this.modeChanges.push(on);
    this.switchPending = this.switchesLater;
  }
  setCaptureEnabled(on: boolean): void { this.captureEnabled = on; this.captureChanges.push(on); }
  setPlayoutGain(g: number): void { this.gain = g; }
  armReplyStart(epoch: number): void { this.armedEpoch = epoch; this.snapshot.replyStart = null; }
  flushPlayout(): void { this.onCall?.('flush'); this.flushes += 1; }
  playoutSnapshot(): PlayoutSnapshot { return { ...this.snapshot }; }
  speechLevel(_atOrBefore: number): number | null { return this.level; }
  drainSpeechLevels(body: (level: number, hostTime: number) => void): void {
    const e = this.envelope;
    this.envelope = [];
    for (const [l, t] of e) body(l, t);
  }
  playClip(url: string, atHostTime: number, gain: number): number | null {
    if (!this.clipsPlayable) return null;
    this.clips.push({ url, at: atHostTime, gain });
    return atHostTime + this.clipDuration;
  }

  // MARK: Scripting the render thread

  /** Pretends the reply's first frame was rendered now (for the armed epoch). */
  startReply(hostTime: number): void {
    const e = this.armedEpoch ?? 0;
    const s = this.snapshot;
    s.replyStart = { epoch: e, frame: s.framesPlayed, hostTime };
    s.lastBufferFrame = s.framesPlayed;
    s.lastBufferHostTime = hostTime;
    s.lastLoudHostTime = hostTime;
  }

  /** Advances the playout counter by `seconds` of audio rendered up to `hostTime`, optionally loud. */
  play(seconds: number, hostTime: number, loud: boolean): void {
    const s = this.snapshot;
    s.framesPlayed += roundHalfAway(seconds * s.sampleRate);
    s.lastBufferFrame = s.framesPlayed;
    s.lastBufferHostTime = hostTime;
    if (loud) s.lastLoudHostTime = hostTime;
  }
}

export type PerceptionCall =
  | { kind: 'pin'; id: number } | { kind: 'unpin' } | { kind: 'release' }
  | { kind: 'outcome'; id: number; spoke: boolean } | { kind: 'dryRun'; on: boolean };

export const pin = (id: number): PerceptionCall => ({ kind: 'pin', id });
export const unpin: PerceptionCall = { kind: 'unpin' };
export const release: PerceptionCall = { kind: 'release' };
export const outcome = (id: number, spoke: boolean): PerceptionCall => ({ kind: 'outcome', id, spoke });
export const dryRun = (on: boolean): PerceptionCall => ({ kind: 'dryRun', on });

/** Records perception's turn calls. */
export class FakePerception implements ConversationPerception {
  calls: PerceptionCall[] = [];
  pinTurn(id: number): void { this.calls.push(pin(id)); }
  unpinTurn(): void { this.calls.push(unpin); }
  releaseTurn(): void { this.calls.push(release); }
  noteEngagementOutcome(id: number, spoke: boolean): void { this.calls.push(outcome(id, spoke)); }
  setLookToTalkDryRun(on: boolean): void { this.calls.push(dryRun(on)); }
  get outcomes(): PerceptionCall[] { return this.calls.filter((c) => c.kind === 'outcome'); }
  /** Swift `calls.contains(c)`. */
  has(c: PerceptionCall): boolean { return this.calls.some((x) => JSON.stringify(x) === JSON.stringify(c)); }
  clear(): void { this.calls = []; }
}

/** An emotion layer stand-in that records everything and hands gate events back (optionally held for the test). */
export class RecordingEmotionSink implements EmotionSink {
  onGate: ((g: GateEvent) => void) | null = null;
  received: DecisionWireMessage[] = [];
  cancelled: string[] = [];
  sentenceStarts: { turnId: string; index: number; hostTime: number }[] = [];
  /** Echo gate messages back immediately (the real scheduler does after validating the turn). */
  echoGate = true;
  /** Ordered call trace hook (barge-in order tests): "emotion.cancelTurn". */
  onCall: ((c: string) => void) | null = null;
  receive(message: DecisionWireMessage): void {
    this.received.push(message);
    if (!this.echoGate) return;
    if (message.kind === 'notForMe') this.onGate?.({ kind: 'notForMe', turnId: message.payload.turnId });
    else if (message.kind === 'didNotUnderstand') this.onGate?.({ kind: 'didNotUnderstand', turnId: message.payload.turnId });
  }
  cancelTurn(turnId: string): void { this.onCall?.('emotion.cancelTurn'); this.cancelled.push(turnId); }
  sentenceAudioStarted(turnId: string, index: number, hostTime: number): void {
    this.sentenceStarts.push({ turnId, index, hostTime });
  }
}

/** A scripted announcement queue. */
export class FakeAnnouncements implements AnnouncementDelivery {
  pending: ProactiveItem[] = [];
  pendingIDs: string[] = [];
  allowed = true;
  taken: ProactiveBatch[] = [];
  finished: { id: number; outcome: ProactiveOutcome }[] = [];
  private nextID = 1;

  add(id: string, text: string): void {
    this.pendingIDs.push(id);
    this.pending.push({ kind: 'announcement', text, context: {} });
  }

  hasDeliverable(people: number, _engaged: boolean): boolean { return this.allowed && people > 0 && this.pending.length > 0; }

  takeBatch(people: number, engaged: boolean): ProactiveBatch | null {
    if (!this.hasDeliverable(people, engaged)) return null;
    const b: ProactiveBatch = { id: this.nextID, ids: this.pendingIDs, items: this.pending };
    this.nextID += 1;
    this.pending = [];
    this.pendingIDs = [];
    this.taken.push(b);
    return b;
  }

  finish(batchID: number, outcome: ProactiveOutcome): void { this.finished.push({ id: batchID, outcome }); }
}

/** Greeting clips from a fixed list, rotating without immediate repeats. */
export class FakeGreetings implements GreetingClips {
  private index = 0;
  picks = 0;
  constructor(public greetings: CachedClip[] = [{ url: '/tmp/hi.wav', text: 'hi!' }], public cantThink: CachedClip | null = null) {}
  nextGreeting(): CachedClip | null {
    if (this.greetings.length === 0) return null;
    this.picks += 1;
    const g = this.greetings[this.index];
    this.index = (this.index + 1) % this.greetings.length;
    return g;
  }
}

/** Host-seconds clock for tests. */
export class ManualClock {
  constructor(public now = 1000) {}
  advance(s: number): void { this.now += s; }
  readonly fn = (): number => this.now;
}
