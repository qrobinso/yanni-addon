// Port of ConversationAgent/Ports.swift: the agent's ports (turn audio, speech-to-text, reply voicing, playout,
// per-turn context).
import type { DecisionPayload } from '../events/AgentEvents';
import { childController, type AgentClock } from './AgentTunables';

// MARK: - Turn audio (fed by the turn-detection runtime)

/** The 16 kHz mono Int16 stream the ASR audio is taken from (design §6.2, `AsrAudioTap`): the voice-processed mic as
 *  turn detection resamples it, indexed by absolute sample number since launch, with host-time stamps. It only receives
 *  samples while capture is enabled (after engagement), so its privacy gate is the turn detector's.
 *  port-note: Int64 sample indices are plain numbers; ranges are `{ lower, upper }` (upper exclusive). */
export interface TurnAudioSource {
  /** Always 16 000. */
  readonly sampleRate: number;
  /** `[oldest, next)`: the indices still readable since the mic last opened; null while closed or nothing captured. */
  readableRange(): { lower: number; upper: number } | null;
  /** The absolute sample index captured at `hostTime`, extrapolated from the newest stamp; null when nothing has been
   *  captured since the mic opened. */
  sampleIndex(hostTime: number): number | null;
  /** Up to `maxFrames` samples from `from` (clamped up to the readable range's lower bound) and the first one's index. */
  read(from: number, maxFrames: number): { samples: Int16Array; start: number };
}

// MARK: - Speech-to-text (the recogniser seam)

/** A recogniser's state, for `ready` and the Status card. */
export type SpeechToTextHealth =
  /** Ready; `engine` names it (the pipeline's `stt_engine`, …). */
  | { kind: 'up'; engine: string | null }
  /** Can't be reached now (the reason is shown on Status; never text anyone said). The connect fails and retries. */
  | { kind: 'down'; why: string }
  /** Getting ready, 0…1. The connect still succeeds; turns fail until ready. */
  | { kind: 'preparing'; progress: number }
  /** Can't be used on this device until the owner acts. The connect still succeeds; turns fail and Status says why. */
  | { kind: 'unavailable'; why: string }
  | { kind: 'notConfigured' };

/** A speech recogniser (design §6.2, §6.8): Home Assistant's pipeline (`HAPipelineSpeechToText`). One
 *  `TranscriptionSession` per user turn, started at `speech-start`, never before.
 *  port-note: Wyoming and Apple's on-device recogniser don't exist in a browser. */
export interface SpeechToText {
  describe(timeout: number): Promise<SpeechToTextHealth>;
  /** Starts one turn's transcription (including any connect retry). Throws when it can't start. */
  start(language: string | null, signal?: AbortSignal): Promise<TranscriptionSession>;
}

/** One turn's transcription: audio streams from `speech-start`; `finish` ends the audio and returns the transcript
 *  ("" = nothing recognised). */
export interface TranscriptionSession {
  /** 16 kHz mono Int16 samples. */
  send(samples: Int16Array): Promise<void>;
  finish(timeout: number, clock: AgentClock, signal?: AbortSignal): Promise<string>;
  /** Drops the turn (no transcript asked for). */
  close(): void;
  /** Where the words heard so far go (the caption bubble only). Set once, before the first `send`. Optional: recognisers
   *  without partial results leave it out. */
  onPartial?(handler: (text: string) => void): void;
}

/** A recogniser that can't run here: unavailable, never starts. */
export class UnavailableSpeechToText implements SpeechToText {
  constructor(readonly reason: string) {}
  async describe(_timeout: number): Promise<SpeechToTextHealth> { return { kind: 'unavailable', why: this.reason }; }
  async start(): Promise<TranscriptionSession> { throw new NotAvailable(); }
}
export class NotAvailable extends Error { override name = 'NotAvailable'; }

// MARK: - Reply voicing (spoken: HA TTS; yanni: babble)

/** One chunk of reply text, as the chunker made it. */
export interface ReplyTextChunk {
  turnId: string;
  /** 0 = the reply's first clause. */
  index: number;
  text: string;
  /** The chunk was emitted at the end of the agent's reply (so it is the last one). */
  isFinal: boolean;
  /** The chunk's Pass B decision, when (and if) it arrives. Yanni mode waits for it up to a short deadline (design
   *  §7.3); spoken mode never waits (Pass B never delays TTS). */
  tag: ChunkTag;
}

/** A chunk's Pass B tag: fulfilled once (with the decision, or null when Pass B failed or is disabled). */
export class ChunkTag {
  private resolved = false;
  private value: DecisionPayload | null = null;
  private waiters: ((d: DecisionPayload | null) => void)[] = [];

  constructor(private readonly clock: AgentClock) {}

  /** A tag that is already known (tests, proactive phrasing without Pass B). */
  static resolved(d: DecisionPayload | null, clock: AgentClock): ChunkTag {
    const t = new ChunkTag(clock);
    t.fulfil(d);
    return t;
  }

  fulfil(d: DecisionPayload | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.value = d;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w(d);
  }

  /** Whether Pass B has answered (or given up). */
  get isResolved(): boolean { return this.resolved; }

  /** The decision if it has arrived (null = not yet, or no decision). */
  get current(): DecisionPayload | null { return this.value; }

  /** Waits up to `seconds` for the tag; null when it missed the deadline, there is none, or `signal` aborts. */
  async wait(seconds: number, signal?: AbortSignal): Promise<DecisionPayload | null> {
    if (this.resolved) return this.value;
    const c = childController(signal);
    try {
      return await Promise.race([
        new Promise<DecisionPayload | null>((resolve) => {
          this.waiters.push(resolve);
          c.signal.addEventListener('abort', () => resolve(null), { once: true });
        }),
        this.clock.sleep(seconds, c.signal).then(() => null, () => null),
      ]);
    } finally {
      c.abort();
    }
  }
}

/** When a chunk's first audio is queued (spoken) or its first babble note scheduled (yanni), and how much audio it
 *  added. Times are in the reply's own timeline (ms from the reply's first frame). */
export interface ChunkVoicing { offsetMs: number; durationMs: number }

export type ReplyVoicingErrorKind =
  /** The voice couldn't produce audio (TTS run failed, no audio in time, caps exceeded). */
  | 'failed'
  /** The reply was cancelled (barge-in, cancel-turn). */
  | 'cancelled'
  /** The reply is over its length cap: the rest of the reply is dropped (Yanni mode, design §7.2). */
  | 'capReached';

export class ReplyVoicingError extends Error {
  override name = 'ReplyVoicingError';
  constructor(readonly kind: ReplyVoicingErrorKind, readonly why: string | null = null) { super(kind); }
  static failed(why: string): ReplyVoicingError { return new ReplyVoicingError('failed', why); }
  static readonly cancelled = (): ReplyVoicingError => new ReplyVoicingError('cancelled');
  static readonly capReached = (): ReplyVoicingError => new ReplyVoicingError('capReached');
}

/** A reply voice (design §7): `SpokenReplyVoicer` (HA TTS into the playout queue) or the babble voicer (FaceVoice
 *  babble through the reply renderer). The orchestrator hands it chunks in order, one at a time. */
export interface ReplyVoicing {
  /** Starts a reply. Called once per reply, before the first chunk. */
  beginReply(turnId: string, proactive: boolean): Promise<ReplyVoicingSession>;
}

/** One reply being voiced. Chunks arrive in order; `voice` resolves when the chunk is fully queued / scheduled. */
export interface ReplyVoicingSession {
  /** Voices one chunk. `willStart(offsetMs)` must be called exactly once, just before the chunk's first audio is queued
   *  (or its first note scheduled), with the chunk's offset in the reply's timeline from the voicer's real timing.
   *  Rejects with `ReplyVoicingError`. */
  voice(chunk: ReplyTextChunk, willStart: (offsetMs: number) => void): Promise<ChunkVoicing>;
  /** The reply's total audio so far (ms, same origin as the offsets): `reply-end.audioMs`. */
  totalAudioMs(): Promise<number>;
  /** Barge-in or cancel: stop at once (cancel the TTS run, stop scheduling); the controller flushes playout. */
  cancel(): Promise<void>;
}

// MARK: - Playout

/** Where spoken reply audio goes: the playout queue (design §14), Float32 mono at the output rate. */
export interface ReplyPlayoutSink {
  /** The output rate (frames per second). */
  readonly outputSampleRate: number;
  /** Queues frames. Resolves false when the reply was flushed and nothing more should be queued. */
  enqueue(frames: Float32Array): Promise<boolean>;
}

// MARK: - Per-turn context (review R2)

/** What the `conversation_context` sensor carries. Fixed vocabulary only, never free text from anyone. */
export interface ConversationContextSnapshot {
  /** The emotion layer's felt label (e.g. "Happiness"); null when the mood report is older than 2 minutes. */
  feel: string | null;
  /** The slow mood's plain-word bucket (cheerful, playful, …). */
  moodLabel: string | null;
  peopleCount: number;
  quietMode: boolean;
  announcementPending: boolean;
}

export const makeConversationContextSnapshot = (s: Partial<ConversationContextSnapshot> = {}): ConversationContextSnapshot =>
  ({ feel: null, moodLabel: null, peopleCount: 0, quietMode: false, announcementPending: false, ...s });

export const conversationContextSnapshotEqual = (a: ConversationContextSnapshot | null, b: ConversationContextSnapshot | null): boolean =>
  a === b || (a !== null && b !== null && a.feel === b.feel && a.moodLabel === b.moodLabel && a.peopleCount === b.peopleCount
    && a.quietMode === b.quietMode && a.announcementPending === b.announcementPending);

/** The sensor state (≤ 255 characters, HA's limit): "Yanni feels cheerful, mood lately playful; 2 people here;
 *  quiet mode on". */
export function sensorState(s: ConversationContextSnapshot): string {
  const parts: string[] = [];
  if (s.feel !== null && s.moodLabel !== null) parts.push(`Yanni feels ${s.feel.toLowerCase()}, mood lately ${s.moodLabel}`);
  else if (s.feel !== null) parts.push(`Yanni feels ${s.feel.toLowerCase()}`);
  else if (s.moodLabel !== null) parts.push(`Yanni's mood lately ${s.moodLabel}`);
  if (s.peopleCount > 0) parts.push(s.peopleCount === 1 ? '1 person here' : `${s.peopleCount} people here`);
  if (s.quietMode) parts.push('quiet mode on');
  if (s.announcementPending) parts.push('Yanni has a message to pass on');
  return Array.from(parts.join('; ')).slice(0, 255).join('');
}

/** The app wires this to the MQTT `conversation_context` sensor. The user's text sent to the agent is never modified. */
export interface ConversationContextPublishing {
  publish(context: ConversationContextSnapshot): void;
}
