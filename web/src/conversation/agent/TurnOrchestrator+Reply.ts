// Port of ConversationAgent/TurnOrchestrator+Reply.swift: the reply (chunker, Pass B, voicing), the agent, proactive
// announcements.
import type { AgentErrorCode } from '../events/AgentEvents';
import type { ProactiveItem, ProactiveRequest } from '../events/AgentIntents';
import { withAgentTimeout } from './AgentTunables';
import { makeAgentSelection } from '../core/VoiceServicesEndpoint';
import type { RecentLine } from './DecisionQuestions';
import { HAError } from './homeassistant/HAChannel';
import type { HAClient } from './homeassistant/HAClient';
import { aiTaskGenerate, conversationProcess, haConversationResult, runIntentPipeline } from './homeassistant/HACommands';
import { at, stringValue } from './JSONValue';
import { ChunkTag, ReplyVoicingError, type ReplyTextChunk, type ReplyVoicing } from './Ports';
import { ProactivePhraser } from './ProactivePhraser';
import { characters, SentenceChunker } from './SentenceChunker';
import { spokenVoicer } from './TurnOrchestrator+Turn';
import type { TurnOrchestrator } from './TurnOrchestrator';
import { AsyncQueue, cancelCurrent, emitFor, emitForTurn, finish, remember, TurnRecord } from './TurnRecord';

export type Feed = (text: string) => Promise<void>;

// MARK: The reply: chunker, Pass B, voicing (design §6.6, §7)

/** Runs `produce` (the agent, or the proactive phrasing), chunking its text as it streams; each chunk gets a Pass B
 *  call and goes to the voicer in order. Emits `sentence-start` from the voicer's real timing and `reply-end` (or the
 *  error) at the end. */
export async function reply(o: TurnOrchestrator, turn: TurnRecord, voicer: ReplyVoicing, recentForPassB: readonly RecentLine[],
  produce: (feed: Feed) => Promise<AgentErrorCode | null>): Promise<void> {
  const turnId = turn.turnId;
  if (turnId === null || turn.isCancelled) return;
  const stream = new AsyncQueue<ReplyTextChunk>();
  turn.chunkQueue = stream;
  turn.chunker = new SentenceChunker();
  const session = await voicer.beginReply(turnId, turn.proactive);
  turn.voicing = session;
  if (turn.isCancelled) { await session.cancel(); return; }
  const voiceTask = (async (): Promise<{ sentences: number; failure: string | null }> => {
    let sentences = 0;
    for (;;) {
      const chunk = await stream.next();
      if (!chunk || turn.isCancelled) break;
      try {
        await session.voice(chunk, (offset) => {
          turn.voiceStarted = true;
          emitFor(o, turn, { kind: 'caption', caption: { kind: 'sentence', turnId, index: chunk.index, text: chunk.text } });
          emitForTurn(o, turn, { kind: 'sentenceStart', payload: { turnId, sentenceIndex: chunk.index, offsetMs: offset } });
        });
        sentences += 1;
      } catch (error) {
        if (error instanceof ReplyVoicingError) {
          if (error.kind === 'capReached') return { sentences, failure: null };
          if (error.kind === 'failed') return { sentences, failure: error.why ?? 'failed' };
        }
        return { sentences, failure: null }; // cancelled
      }
    }
    return { sentences, failure: null };
  })();
  const passBRecent = recentForPassB;
  const failure = await produce(async (text) => feedText(o, turn, text, passBRecent));
  finishFeed(o, turn, passBRecent);
  const voiced = await voiceTask;
  if (turn.isCancelled) return;
  const started = turn.voiceStarted;
  if (voiced.failure !== null && !started) {
    // The reason is for the caller's Status counters only; it never carries text.
    if (turn.proactive) emitForTurn(o, turn, { kind: 'proactiveDone', payload: { turnId, ids: turn.ids, status: 'unavailable' } });
    else emitForTurn(o, turn, { kind: 'error', payload: { code: 'tts-failed', turnId, detail: null } });
    return;
  }
  if (voiced.sentences === 0 && !started) {
    // Nothing to say: the agent failed or answered with nothing.
    if (turn.proactive) emitForTurn(o, turn, { kind: 'proactiveDone', payload: { turnId, ids: turn.ids, status: 'unavailable' } });
    else emitForTurn(o, turn, { kind: 'error', payload: { code: failure ?? 'llm-failed', turnId, detail: null } });
    return;
  }
  // A failure after something was heard ends the reply gracefully with what was voiced (review R6).
  const audioMs = await session.totalAudioMs();
  if (turn.isCancelled) return;
  emitForTurn(o, turn, { kind: 'replyEnd', payload: { turnId, sentences: voiced.sentences, audioMs } });
  if (turn.proactive) emitForTurn(o, turn, { kind: 'proactiveDone', payload: { turnId, ids: turn.ids, status: 'spoken' } });
  else remember(o, 'yanni', turn.replyText);
}

export function feedText(o: TurnOrchestrator, turn: TurnRecord, text: string, recent: readonly RecentLine[]): void {
  if (turn.isCancelled || text === '') return;
  turn.replyText += text;
  for (const c of turn.chunker.append(text)) yieldChunk(o, turn, c, false, recent);
}

export function finishFeed(o: TurnOrchestrator, turn: TurnRecord, recent: readonly RecentLine[]): void {
  if (turn.isCancelled) return;
  const rest = turn.chunker.finish();
  rest.forEach((c, i) => yieldChunk(o, turn, c, i === rest.length - 1, recent));
  turn.chunkQueue?.finish();
}

/** A new chunk: its Pass B starts now (never delaying the voice), and it goes to the voicer. */
export function yieldChunk(o: TurnOrchestrator, turn: TurnRecord, text: string, isFinal: boolean, recent: readonly RecentLine[]): void {
  const turnId = turn.turnId;
  if (turnId === null) return;
  const index = turn.chunkCount;
  turn.chunkCount += 1;
  const tag = new ChunkTag(o.clock);
  const gate = o.gate;
  const version = o.deps.questions.version;
  turn.sideTasks.push((async () => {
    const r = await gate.passB(text, recent, turn.signal);
    switch (r.kind) {
      case 'answered': {
        const d = { turnId, pass: 'sentence' as const, sentenceIndex: index, version, answers: r.answers };
        if (!turn.isCancelled) emitForTurn(o, turn, { kind: 'decision', payload: d });
        tag.fulfil(turn.isCancelled ? null : d);
        break;
      }
      case 'failedOpen':
        tag.fulfil(null);
        if (r.report !== null) emitForTurn(o, turn, { kind: 'decisionModelUnavailable', payload: { reason: r.report } });
        break;
      case 'disabled':
        tag.fulfil(null);
        break;
    }
  })());
  turn.chunkQueue?.push({ turnId, index, text, isFinal, tag });
}

// MARK: The agent (design §6.5)

/** Sends the (unmodified) user text to the HA agent; streamed or whole. Returns an error code, or null. */
export async function runAgent(o: TurnOrchestrator, turn: TurnRecord, text: string, feed: Feed): Promise<AgentErrorCode | null> {
  const ha = o.ha;
  if (!ha) return 'llm-failed';
  if (o.agentPath === 'streamed') {
    const r = await runPipeline(o, turn, ha, text, feed);
    if (r.kind === 'done') return null;
    if (r.kind === 'failed') return r.code;
    o.agentPath = 'whole'; // for good (this connection)
    o.health.agentPath = o.agentPath;
    o.publishHealth();
  }
  if (turn.isCancelled) return null;
  const sel = o.services?.agent ?? makeAgentSelection();
  try {
    const r = await conversationProcess(ha, text, o.conversationID, sel.agentID, sel.language, turn.signal);
    if (turn.isCancelled) return null;
    if (r.conversationID !== null) o.conversationID = r.conversationID;
    o.lastContinueConversation = r.continueConversation;
    if (r.responseType === 'error' && r.speech === '') return 'llm-failed';
    await feed(r.speech);
    return null;
  } catch {
    return 'llm-failed';
  }
}

type PipelineResult = { kind: 'done' } | { kind: 'failed'; code: AgentErrorCode } | { kind: 'unsupported' };

export async function runPipeline(o: TurnOrchestrator, turn: TurnRecord, ha: HAClient, text: string, feed: Feed): Promise<PipelineResult> {
  const sel = o.services?.agent ?? makeAgentSelection();
  let sub;
  try {
    sub = await runIntentPipeline(ha, text, sel.pipelineID ?? sel.agentID, o.conversationID, o.tunables.pipelineTimeout, turn.signal);
  } catch (e) {
    if (e instanceof HAError && e.kind === 'result' && e.code === 'unknown_command') return { kind: 'unsupported' };
    return { kind: 'failed', code: 'llm-failed' };
  }
  turn.subscriptionID = sub.id;
  if (turn.isCancelled) { await ha.unsubscribe(sub.id); return { kind: 'done' }; }
  let streamed = '';
  let assistantOpen = false;
  let failure: AgentErrorCode | null = null;
  try {
    loop: for (;;) {
      const ev = await sub.events.next(turn.signal);
      if (ev === null || turn.isCancelled) break;
      const data = at(ev, 'data');
      switch (stringValue(at(ev, 'type'))) {
        case 'run-start': {
          const c = stringValue(at(data, 'conversation_id'));
          if (c !== null) o.conversationID = c;
          break;
        }
        case 'intent-progress': {
          const delta = at(data, 'chat_log_delta');
          if (delta === undefined) continue;
          const role = stringValue(at(delta, 'role'));
          if (role !== null) {
            assistantOpen = role === 'assistant';
            if (assistantOpen && streamed !== '') { streamed += ' '; await feed(' '); }
          }
          // thinking_content, tool_calls and tool results are never voiced.
          const c = stringValue(at(delta, 'content'));
          if (assistantOpen && c !== null && c !== '') {
            streamed += c;
            await feed(c);
          }
          break;
        }
        case 'intent-end': {
          const r = haConversationResult(at(data, 'intent_output') ?? null);
          if (r.conversationID !== null) o.conversationID = r.conversationID;
          o.lastContinueConversation = r.continueConversation;
          if (streamed === '') {
            if (r.responseType === 'error' && r.speech === '') failure = 'llm-failed'; else await feed(r.speech);
          } else {
            const all = characters(r.speech), had = characters(streamed).length;
            if (r.speech.startsWith(streamed) && all.length > had) await feed(all.slice(had).join('')); // a tail the deltas missed
          }
          break;
        }
        case 'error': {
          const code = stringValue(at(data, 'code')) ?? '';
          failure = code.includes('timeout') ? 'llm-timeout' : 'llm-failed';
          break;
        }
        case 'run-end':
          break loop;
        default:
          continue;
      }
    }
  } catch {
    if (failure === null && !turn.isCancelled) failure = 'llm-failed';
  }
  turn.subscriptionID = null;
  ha.endSubscription(sub.id);
  if (failure !== null) return { kind: 'failed', code: failure };
  return { kind: 'done' };
}

// MARK: Proactive (design §9)

export function startProactive(o: TurnOrchestrator, p: ProactiveRequest): void {
  if (!o.ready || !o.services) {
    o.emitEvent({ kind: 'proactiveDone', payload: { turnId: null, ids: p.ids, status: 'unavailable' } });
    return;
  }
  cancelCurrent(o, true);
  // An announcement exists to get information across: it needs a speech voice, even in Yanni mode (review R1).
  const voicer = spokenVoicer(o);
  if (!voicer) {
    o.emitEvent({ kind: 'proactiveDone', payload: { turnId: null, ids: p.ids, status: 'unavailable' } });
    return;
  }
  o.serialCounter += 1;
  o.turnCounter += 1;
  const turn = new TurnRecord(o.serialCounter, o.generation, true, 'replying');
  turn.turnId = `t-${o.turnCounter}`;
  turn.ids = p.ids;
  o.current = turn;
  emitForTurn(o, turn, { kind: 'turnStarted', payload: { turnId: turn.turnId, kind: 'proactive', ids: p.ids } });
  turn.mainTask = runProactive(o, turn, p, voicer);
}

export async function runProactive(o: TurnOrchestrator, turn: TurnRecord, p: ProactiveRequest, voicer: ReplyVoicing): Promise<void> {
  const text = await phrase(o, p.items, turn.signal);
  const turnId = turn.turnId;
  if (turn.isCancelled || turnId === null) return;
  if (text === '') {
    emitForTurn(o, turn, { kind: 'proactiveDone', payload: { turnId, ids: turn.ids, status: 'cancelled' } });
    finish(o, turn);
    return;
  }
  // Pass A is skipped (there is no utterance); Pass B runs per chunk. Never the conversation agent.
  await reply(o, turn, voicer, o.recent, async (feed) => { await feed(text); return null; });
  finish(o, turn);
}

/** `ai_task.generate_data` when an AI Task entity is set, else (or on an error / timeout) the template. */
export async function phrase(o: TurnOrchestrator, items: readonly ProactiveItem[], signal?: AbortSignal): Promise<string> {
  const entity = o.services?.agent.aiTaskEntityID;
  const ha = o.ha;
  if (entity && ha) {
    const instructions = ProactivePhraser.instructions(items);
    try {
      const text = await withAgentTimeout(o.tunables.proactivePhrasingTimeout, o.clock,
        (s) => aiTaskGenerate(ha, entity, ProactivePhraser.taskName, instructions, s), signal);
      if (text.trim() !== '') return text;
    } catch { /* the template */ }
  }
  return ProactivePhraser.template(items);
}
