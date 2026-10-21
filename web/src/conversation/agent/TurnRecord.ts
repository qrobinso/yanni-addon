// Port of ConversationAgent/TurnRecord.swift. One turn in the orchestrator (design §6.1): a user turn from
// `speech-start`, or a proactive turn; plus the orchestrator's turn bookkeeping and intents.
// port-note: Swift's capture/main/side tasks are promises that all share the turn's `AbortController` (cancelling
// the turn aborts them together); the chunk `AsyncStream` is an `AsyncQueue`; the `Mutex`-guarded flags are plain
// fields (single-threaded).
import type { AgentEvent } from '../events/AgentEvents';
import type { AgentIntent } from '../events/AgentIntents';
import { recentLine, type RecentSpeaker } from './DecisionQuestions';
import { conversationContextSnapshotEqual, makeConversationContextSnapshot, type ReplyTextChunk, type ReplyVoicingSession, type TranscriptionSession } from './Ports';
import { SentenceChunker, characters } from './SentenceChunker';
import { speechStart, turnEnd } from './TurnOrchestrator+Turn';
import { startProactive } from './TurnOrchestrator+Reply';
import type { OrchestratorOutput, TurnOrchestrator } from './TurnOrchestrator';

export type TurnPhase = 'capturing' | 'transcribing' | 'gating' | 'replying' | 'done';

/** An unbounded queue with finish; one reader (Swift's `AsyncStream`). */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: T | null) => void)[] = [];
  private finished = false;
  push(v: T): void {
    if (this.finished) return;
    const w = this.waiters.shift();
    if (w) w(v); else this.items.push(v);
  }
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const w of this.waiters.splice(0)) w(null);
  }
  /** The next item; null once finished and drained. */
  next(): Promise<T | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift()!);
    if (this.finished) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export class TurnRecord {
  turnId: string | null = null;
  ids: string[] = [];

  // Capture.
  endRequested = false;
  endIndex: number | null = null;
  asr: TranscriptionSession | null = null;
  /** Why speech-to-text failed (the event log's reason; never words). */
  sttFailure: string | null = null;
  captureTask: Promise<TranscriptionSession | null> | null = null;

  // Reply.
  mainTask: Promise<void> | null = null;
  sideTasks: Promise<void>[] = [];
  voicing: ReplyVoicingSession | null = null;
  subscriptionID: number | null = null;
  chunker = new SentenceChunker();
  chunkQueue: AsyncQueue<ReplyTextChunk> | null = null;
  chunkCount = 0;
  replyText = '';
  replyEnded = false;

  /** Aborted when the turn is cancelled: the capture, main and side tasks stop. */
  readonly abort = new AbortController();
  /** False once the turn is cancelled: nothing more is emitted for it (except the `interrupted` acknowledgement). */
  live = true;
  /** A chunk of the reply started voicing (a cut now is a barge-in, acknowledged with `interrupted`). */
  voiceStarted = false;

  constructor(readonly serial: number, readonly generation: number, readonly proactive: boolean, public phase: TurnPhase) {}

  get isCancelled(): boolean { return !this.live; }
  get signal(): AbortSignal { return this.abort.signal; }
}

// MARK: Emitting for a turn

/** Emits `o` only while the turn is live (so nothing follows `interrupted`). */
export function emitFor(orch: TurnOrchestrator, turn: TurnRecord, o: OrchestratorOutput): void {
  if (turn.live) orch.emitRaw(turn.generation, o);
}

export function emitForTurn(orch: TurnOrchestrator, turn: TurnRecord, e: AgentEvent): void {
  emitFor(orch, turn, { kind: 'event', event: e });
}

/** Cancels the current turn. `interrupted`: a cut reply is acknowledged (and a proactive turn reported interrupted). */
export function cancelCurrent(orch: TurnOrchestrator, silently: boolean): void {
  const t = orch.current;
  if (!t) return;
  orch.current = null;
  cancel(orch, t, !silently);
}

export function cancel(orch: TurnOrchestrator, t: TurnRecord, acknowledge: boolean): void {
  if (!t.live) return;
  t.live = false;
  t.phase = 'done';
  t.abort.abort();
  t.asr?.close();
  t.chunkQueue?.finish();
  if (t.voicing) void t.voicing.cancel();
  const ha = orch.ha;
  if (t.subscriptionID !== null && ha) void ha.unsubscribe(t.subscriptionID);
  const id = t.turnId;
  if (!acknowledge || id === null) return;
  if (t.voiceStarted) orch.emitRaw(t.generation, { kind: 'event', event: { kind: 'interrupted', payload: { turnId: id } } });
  if (t.proactive) {
    orch.emitRaw(t.generation, { kind: 'event', event: { kind: 'proactiveDone', payload: { turnId: id, ids: t.ids, status: 'interrupted' } } });
  }
}

export function finish(orch: TurnOrchestrator, t: TurnRecord): void {
  t.phase = 'done';
  if (orch.current === t) orch.current = null;
}

// MARK: Intents

export function handle(orch: TurnOrchestrator, intent: AgentIntent): void {
  switch (intent.kind) {
    case 'engage':
      orch.endConversationSession(); // a new conversation session: the next agent call starts a new HA conversation
      return;
    case 'greeted':
      remember(orch, 'yanni', intent.payload.text);
      return;
    case 'mood':
      orch.mood = intent.payload;
      orch.moodAt = orch.clock.now();
      publishContext(orch);
      return;
    case 'context':
      orch.contextUpdate = intent.payload;
      publishContext(orch);
      return;
    case 'proactive':
      startProactive(orch, intent.payload);
      return;
    case 'cancelTurn': {
      const t = orch.current;
      if (t && t.turnId === intent.payload.turnId) cancelCurrent(orch, true);
      return;
    }
    case 'speechStart':
      speechStart(orch, intent.payload);
      return;
    case 'turnEnd':
      turnEnd(orch, intent.payload);
      return;
  }
}

/** The mic closed (track disabled): a turn still being captured is dropped, without an end of audio, and nothing
 *  is emitted. */
export function micClosed(orch: TurnOrchestrator): void {
  if (orch.current?.phase === 'capturing') cancelCurrent(orch, true);
}

export function setAnnouncementPending(orch: TurnOrchestrator, on: boolean): void {
  orch.announcementPending = on;
  publishContext(orch);
}

export function remember(orch: TurnOrchestrator, speaker: RecentSpeaker, text: string): void {
  const t = text.trim();
  if (t === '') return;
  orch.recent.push(recentLine(speaker, characters(t).slice(0, 500).join('')));
  if (orch.recent.length > 4) orch.recent.splice(0, orch.recent.length - 4); // the last two exchanges
}

export function publishContext(orch: TurnOrchestrator): void {
  const pub = orch.deps.context;
  if (!pub) return;
  const fresh = orch.mood !== null && orch.clock.now() - orch.moodAt <= 120;
  const snap = makeConversationContextSnapshot({
    feel: fresh ? orch.mood!.label : null, moodLabel: fresh ? orch.mood!.moodLabel : null,
    peopleCount: orch.contextUpdate?.peopleCount ?? 0, quietMode: orch.contextUpdate?.quietMode ?? false,
    announcementPending: orch.announcementPending,
  });
  if (conversationContextSnapshotEqual(snap, orch.lastPublishedContext)) return;
  orch.lastPublishedContext = snap;
  pub.publish(snap);
}
