// Port of ConversationCore/Ports.swift. The controller's view of everything around it. Each port is small so tests
// can fake it; the real subsystems conform in Adapters.ts or in the app wiring.
import type { AgentState } from '../../engine/AgentState';
import type { FaceCommand, OneShotKind } from '../../engine/Commands';
import type { ActivityKind, LifePhase } from '../../life/LifeTypes';
import type { AgentEvent, DecisionModelUnavailable, DecisionPayload, DidNotUnderstand, NotForMe } from '../events/AgentEvents';
import type { ProactiveRequest } from '../events/AgentIntents';
import type { AgentIntent } from '../events/AgentIntents';
import type { CaptionText } from '../events/Captions';
import type { VoiceServicesEndpoint } from './VoiceServicesEndpoint';

// MARK: - Face

/** What the controller reads from and writes to the face engine. */
export interface ConversationFace {
  readonly conversationAgentState: AgentState;
  /** The person currently engaging (perception's look-to-talk), if any. */
  readonly conversationEngagedID: number | null;
  readonly conversationPeopleCount: number;
  /** Someone in view is facing Yanni (perception's `facing` at or above the life cycle's threshold). */
  readonly conversationSomeoneFacing: boolean;
  readonly conversationActiveOneShots: readonly OneShotKind[];
  readonly conversationCompletedOneShots: readonly OneShotKind[];
  setAgentState(s: AgentState): void;
  send(command: FaceCommand): void;
  setSpeechLevel(level: number): void;
  /** The listening glow: 1 while the mic is open, 0 when it closes. */
  setListeningGlow(target: number): void;
  /** The person speaking into the open mic (1 from speech start to the turn's end): the glow swells. */
  setListeningVoice(level: number): void;
  /** The live mic level 0…1 every frame while the person's turn is live (0 otherwise). */
  setListeningLevel(level: number): void;
}

// MARK: - Life cycle

export interface ConversationLife {
  readonly phase: LifePhase;
  readonly isBedtime: boolean;
  /** Debounced presence (someone confirmed in view). */
  readonly isPresent: boolean;
  readonly isForceSleepActive: boolean;
  noteActivity(kind: ActivityKind): void;
}

// MARK: - Procedural voice

export interface ConversationVoice {
  /** Until when (host seconds) Yanni's own chirps may be audible, incl. the director's 150 ms tail. */
  readonly audibleUntilHostTime: number;
  /** True while Yanni speaks (auto-vocalization pauses). */
  isSpeaking: boolean;
  /** Barge-in: fade out sound and drop pending face cues. */
  cancel(): void;
}

// MARK: - Perception (review H3)

export interface ConversationPerception {
  /** Keep the turn through look-aways (listening through speaking). */
  pinTurn(id: number): void;
  /** Normal release rules resume (follow-up end, back to noticing, disconnect). */
  unpinTurn(): void;
  /** End the current turn (follow-up over): a waiter still looking takes it at once. */
  releaseTurn(): void;
  /** Whether an engagement led to speech (false-engagement damping). */
  noteEngagementOutcome(id: number, spoke: boolean): void;
  /** The perception dry run is off while the controller is live; dormant, it follows perception's own setting. */
  setLookToTalkDryRun(on: boolean): void;
}

// MARK: - Audio

export interface ReplyStart { epoch: number; frame: number; hostTime: number }

/** The playout side as last published by the render thread. port-note: Int64 frame counters are plain numbers. */
export interface PlayoutSnapshot {
  /** Hardware output rate of the playout node (frames per second). */
  sampleRate: number;
  /** Frames rendered by the playout node since the engine started (monotonic). */
  framesPlayed: number;
  /** First frame of the most recent render buffer and its host time (seconds). */
  lastBufferFrame: number;
  lastBufferHostTime: number;
  /** Seconds from a render buffer's host time to audible output. */
  outputLatency: number;
  /** The start of the reply armed with `armReplyStart(epoch)`: the first rendered frame of that reply's audio. */
  replyStart: ReplyStart | null;
  /** Host time of the newest buffer whose pre-gain level was above the speech threshold. */
  lastLoudHostTime: number;
  /** Barge-in flush in progress (the 30 ms fade; the queued audio is dropped at its end). */
  flushing: boolean;
}

export function makePlayoutSnapshot(p: Partial<PlayoutSnapshot> = {}): PlayoutSnapshot {
  return {
    sampleRate: 48000, framesPlayed: 0, lastBufferFrame: 0, lastBufferHostTime: 0, outputLatency: 0, replyStart: null,
    lastLoudHostTime: -Infinity, flushing: false, ...p,
  };
}

/** Audible host time of a frame index (extrapolated from the newest buffer) incl. output latency. */
export function audibleHostTime(s: PlayoutSnapshot, frame: number): number {
  if (!(s.sampleRate > 0)) return s.lastBufferHostTime + s.outputLatency;
  return s.lastBufferHostTime + (frame - s.lastBufferFrame) / s.sampleRate + s.outputLatency;
}

/** The reply clock (design §7.4): where the controller reads the reply's audible progress. The playout queue in
 *  Spoken mode, the reply renderer in Yanni mode. */
export interface ReplyClock {
  /** The next reply's first audible frame gets this epoch. */
  armReplyStart(epoch: number): void;
  playoutSnapshot(): PlayoutSnapshot;
}

/** What the controller drives in the audio engine. Every call is cheap and non-blocking. The engine is also the
 *  default reply clock (its playout queue). */
export interface ConversationAudioControl extends ReplyClock {
  /** Conversation mode (mic + echo cancellation) vs ambient (output only). Returns at once. */
  setConversationMode(on: boolean): void;
  /** The last requested mode is live (no switch in flight): in conversation mode the mic may open. */
  readonly isAudioReady: boolean;
  /** Privacy gate: while false, no microphone sample reaches turn detection or the ASR (review L7). */
  setCaptureEnabled(on: boolean): void;
  /** Gain applied to the reply audio: voice volume × night factor. */
  setPlayoutGain(gain: number): void;
  /** Barge-in: fade the reply audio out over 30 ms, then drop everything queued. */
  flushPlayout(): void;
  /** The newest playout speech level (0…1) whose audible time is ≤ `hostTime`, if any. */
  speechLevel(atOrBefore: number): number | null;
  /** Every playout speech-envelope sample (level 0…1, audible host time) since the last call, oldest first. */
  drainSpeechLevels(body: (level: number, hostTime: number) => void): void;
  /** Plays a cached clip (greeting) starting at `hostTime`. Returns its audible end (host seconds), or null. */
  playClip(url: string, atHostTime: number, gain: number): number | null;
}

// MARK: - Transport

export type TransportStatus =
  | { kind: 'disconnected' }
  /** Home Assistant is authenticating and the voice services answer `describe`. */
  | { kind: 'connecting' }
  /** Home Assistant authenticated, the ASR answered (and the TTS too in Spoken mode): the session is usable. */
  | { kind: 'ready' }
  /** The attempt or session failed (the controller reconnects with backoff). */
  | { kind: 'failed'; reason: string };

export type TransportEvent =
  | { kind: 'status'; status: TransportStatus }
  | { kind: 'agent'; event: AgentEvent }
  /** Words for the caption bubbles (never logged or stored). */
  | { kind: 'caption'; caption: CaptionText };

/** The seam between the controller and the voice services (design §5): `LocalAgentTransport` in the app,
 *  `FakeVoiceTransport` in tests. */
export interface VoiceTransport {
  onEvent: ((e: TransportEvent) => void) | null;
  readonly status: TransportStatus;
  connect(services: VoiceServicesEndpoint): void;
  disconnect(): void;
  /** The mic state (paired with `setCaptureEnabled`): closing it drops a turn still being captured. */
  setMicEnabled(on: boolean): void;
  /** Never queued. Turn intents are dropped when the session isn't ready. */
  send(intent: AgentIntent): void;
}

// MARK: - Emotion (review H1)

/** Gate outcomes the emotion layer's decision scheduler validates and hands back. */
export type GateEvent = { kind: 'notForMe'; turnId: string } | { kind: 'didNotUnderstand'; turnId: string };

/** Every decision-family message. */
export type DecisionWireMessage =
  | { kind: 'decision'; payload: DecisionPayload }
  | { kind: 'notForMe'; payload: NotForMe }
  | { kind: 'didNotUnderstand'; payload: DidNotUnderstand }
  | { kind: 'decisionModelUnavailable'; payload: DecisionModelUnavailable };

/** The emotion layer as the conversation sees it (shaped like `EmotionLayer.receive / cancelTurn / onGate /
 *  sentenceAudioStarted`). */
export interface EmotionSink {
  /** A decoded decision-family message (Pass A applies on arrival, Pass B at audio start). */
  receive(message: DecisionWireMessage): void;
  /** Barge-in or abandoned turn: drop everything pending for it. */
  cancelTurn(turnId: string): void;
  /** A reply sentence became audible at `hostTime` (host seconds). */
  sentenceAudioStarted(turnId: string, index: number, hostTime: number): void;
  /** Gate events back to the controller (which owns the agent state). */
  onGate: ((g: GateEvent) => void) | null;
}

// MARK: - Announcements (review H2)

/** A batch of held announcements delivered as one proactive turn. */
export interface ProactiveBatch { id: number; ids: string[]; items: ProactiveRequest['items'] }

/** How a delivery ended (maps 1:1 onto YanniHome's `DeliveryResult`). */
export type ProactiveOutcome = 'spoken' | 'interrupted' | 'unavailable' | 'cancelled';

/** The announcement queue as the voice loop sees it. The loop pulls; the queue pushes only `requestProactiveTurn()`. */
export interface AnnouncementDelivery {
  hasDeliverable(people: number, engaged: boolean): boolean;
  takeBatch(people: number, engaged: boolean): ProactiveBatch | null;
  finish(batchID: number, outcome: ProactiveOutcome): void;
}

// MARK: - Greeting clips

/** A cached clip. port-note: a URL string (an object URL or a static asset) instead of a file URL. */
export interface CachedClip { url: string; text: string }

export interface GreetingClips {
  /** A random greeting, never the same one twice in a row; null when none is cached. */
  nextGreeting(): CachedClip | null;
  /** The optional "I can't think right now" line. */
  readonly cantThink: CachedClip | null;
}
