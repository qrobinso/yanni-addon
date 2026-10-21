// Port of ConversationAgent/TurnOrchestrator+Turn.swift: speech start, capture, turn end, the gate.
import { describeError, makeDismissed, type Dismissed } from '../events/AgentEvents';
import type { SpeechStart, TurnEnd } from '../events/AgentIntents';
import { recentLine } from './DecisionQuestions';
import { HATextToSpeech } from './homeassistant/HASpeech';
import { GateVerdict } from './JevGate';
import { LocalDismissal } from './LocalDismissal';
import type { ReplyVoicing, TranscriptionSession } from './Ports';
import { characters, isLetterOrNumber } from './SentenceChunker';
import { reply, runAgent } from './TurnOrchestrator+Reply';
import type { TurnOrchestrator } from './TurnOrchestrator';
import { cancelCurrent, emitFor, emitForTurn, finish, remember, TurnRecord } from './TurnRecord';
import { SpokenReplyVoicer } from './voicing/SpokenReplyVoicer';

// MARK: Speech start (design §6.2)

export function speechStart(o: TurnOrchestrator, s: SpeechStart): void {
  if (!o.ready || !o.services) return;
  // While voicing: barge-in (the controller already flushed); while thinking: the turn is void.
  cancelCurrent(o, false);
  o.serialCounter += 1;
  const turn = new TurnRecord(o.serialCounter, o.generation, false, 'capturing');
  o.current = turn;
  turn.captureTask = capture(o, turn, s.onsetHostTime);
}

/** Where the ASR audio starts: `onset − preRoll`, clipped to the mic opening (the readable range) and the previous
 *  turn's end. */
export function preRollStart(o: TurnOrchestrator, onset: number): number {
  const audio = o.deps.audio;
  if (!audio) return 0;
  let start = audio.sampleIndex(onset - o.tunables.asrPreRoll) ?? 0;
  const r = audio.readableRange();
  if (r) start = Math.max(start, r.lower);
  if (o.lastTurnEndIndex !== null) start = Math.max(start, o.lastTurnEndIndex);
  return start;
}

/** Starts this turn's transcription through the recogniser (its own connect retry), then streams the pre-roll and live
 *  20 ms chunks until the turn end's index is reached. Returns the session, or null when it couldn't start or the
 *  turn was dropped. */
export async function capture(o: TurnOrchestrator, turn: TurnRecord, onset: number): Promise<TranscriptionSession | null> {
  const s = o.services, stt = o.speechToText;
  if (!s || !stt || turn.isCancelled) return null;
  let session: TranscriptionSession | null;
  try { session = await stt.start(s.agent.language, turn.signal); } catch (error) {
    session = null;
    turn.sttFailure = 'start: ' + describeError(error);
  }
  if (turn.isCancelled) { session?.close(); return null; }
  if (!session) {
    // Ask why (preparing, permission, language) off the turn's path: stt-failed isn't delayed by it.
    const gen = o.generation;
    void stt.describe(o.tunables.describeTimeout).then((h) => o.noteSpeechHealth(h, gen, true));
    return null;
  }
  o.health.asr = 'up';
  turn.asr = session;
  // The words so far, for the caption bubble only (never logged, never to the gate or the agent), while live.
  session.onPartial?.((text) => emitFor(o, turn, { kind: 'caption', caption: { kind: 'partial', text } }));
  if (turn.isCancelled) { session.close(); return null; }

  const audio = o.deps.audio;
  let next = preRollStart(o, onset);
  const cap = next + Math.trunc(o.tunables.maxTurnAudio * 16000);
  let grace = 5; // ≤ 100 ms for the ring to catch up with the turn-end time
  while (!turn.isCancelled) {
    let limit = cap;
    if (turn.endRequested) limit = Math.min(limit, turn.endIndex ?? next);
    if (audio && next < limit) {
      const r = audio.read(next, Math.min(limit - next, 16000));
      if (r.samples.length > 0) {
        const n = Math.min(r.samples.length, limit - r.start);
        let i = 0;
        try {
          while (i < n) {
            const j = Math.min(i + 320, n); // 20 ms, 640 bytes
            await session.send(r.samples.subarray(i, j));
            i = j;
          }
        } catch (error) {
          turn.sttFailure = 'send: ' + describeError(error);
          session.close();
          return turn.isCancelled ? null : session; // finish() then reports stt-failed
        }
        next = r.start + n;
      }
    }
    if (turn.endRequested) {
      if (next >= limit || !audio || grace === 0) return session;
      grace -= 1;
    }
    await o.clock.sleep(o.tunables.asrChunkInterval, turn.signal).catch(() => {});
  }
  session.close();
  return null;
}

// MARK: Turn end (design §6.3)

export function turnEnd(o: TurnOrchestrator, e: TurnEnd): void {
  const t = o.current;
  if (!t || t.proactive || t.phase !== 'capturing') return;
  t.endRequested = true;
  t.endIndex = o.deps.audio?.sampleIndex(e.hostTime) ?? null;
  if (t.endIndex !== null) o.lastTurnEndIndex = t.endIndex;
  t.phase = 'transcribing';
  t.mainTask = process(o, t);
}

export async function process(o: TurnOrchestrator, turn: TurnRecord): Promise<void> {
  const session = (await turn.captureTask) ?? null;
  if (turn.isCancelled) return;
  if (!session) {
    emitForTurn(o, turn, { kind: 'error', payload: { code: 'stt-failed', turnId: null, detail: turn.sttFailure ?? 'no session' } });
    finish(o, turn);
    return;
  }
  let text: string;
  try {
    text = await session.finish(o.tunables.transcriptTimeout, o.clock, turn.signal);
    session.close();
  } catch (error) {
    session.close();
    if (turn.isCancelled) return;
    const why = turn.sttFailure ?? 'finish: ' + describeError(error);
    emitForTurn(o, turn, { kind: 'error', payload: { code: 'stt-failed', turnId: null, detail: why } });
    finish(o, turn);
    return;
  }
  if (turn.isCancelled) return;
  o.turnCounter += 1;
  const turnId = `t-${o.turnCounter}`;
  turn.turnId = turnId;
  const chars = characters(text);
  emitForTurn(o, turn, { kind: 'turnEnded', payload: { turnId, transcriptChars: chars.length } });
  if (!chars.some(isLetterOrNumber)) {
    emitForTurn(o, turn, { kind: 'didNotUnderstand', payload: { turnId, reason: 'empty' } });
    finish(o, turn);
    return;
  }

  // The gate (Pass A), sequential: nothing reaches the agent before the verdict.
  turn.phase = 'gating';
  const outcome = await o.gate.passA(text, o.recent, turn.signal);
  if (turn.isCancelled) return; // a late answer for a voided turn is ignored
  let signOff: Dismissed | null = null;
  let decided = false;
  switch (outcome.kind) {
    case 'answered': {
      o.health.jev = 'up';
      o.health.jevRoundTripMs = outcome.roundTripMs;
      o.health.jevLatencyMs = outcome.latencyMs;
      o.health.breakerOpen = false;
      emitForTurn(o, turn, { kind: 'decision', payload: { turnId, pass: 'utterance', sentenceIndex: null,
        version: o.deps.questions.version, answers: outcome.answers } });
      decided = true;
      const v = GateVerdict.of(outcome.answers, o.tunables);
      switch (v.kind) {
        case 'notForMe':
          emitForTurn(o, turn, { kind: 'notForMe', payload: { turnId } });
          finish(o, turn);
          return;
        case 'dismissed':
          emitForTurn(o, turn, { kind: 'dismissed', payload: makeDismissed({ turnId, source: 'decision', probability: v.closing,
            sheepish: GateVerdict.sheepish(outcome.answers) }) });
          finish(o, turn);
          return;
        case 'signOff':
          signOff = makeDismissed({ turnId, source: 'decision', probability: v.closing, afterReply: true });
          break;
        case 'unclear':
          emitForTurn(o, turn, { kind: 'didNotUnderstand', payload: { turnId, reason: 'unclear' } });
          finish(o, turn);
          return;
        case 'addressed':
          break;
      }
      break;
    }
    case 'failedOpen':
      o.health.jev = 'down';
      o.health.breakerOpen = o.gate.breakerOpen;
      if (outcome.report !== null) emitForTurn(o, turn, { kind: 'decisionModelUnavailable', payload: { reason: outcome.report } });
      break;
    case 'disabled':
      break;
  }
  o.publishHealth();
  if (turn.isCancelled) return;
  // No decision model answer: the local matcher still catches an unmistakable short dismissal.
  if (!decided && LocalDismissal.matches(text)) {
    emitForTurn(o, turn, { kind: 'dismissed', payload: makeDismissed({ turnId, source: 'local' }) });
    finish(o, turn);
    return;
  }
  if (signOff) emitForTurn(o, turn, { kind: 'dismissed', payload: signOff });
  // Only now, past the gate: ignored speech never reaches the screen.
  emitFor(o, turn, { kind: 'caption', caption: { kind: 'transcript', turnId, text } });
  const before = [...o.recent];
  remember(o, 'person', text);
  turn.phase = 'replying';
  const voicer = replyVoicer(o);
  if (!voicer) {
    emitForTurn(o, turn, { kind: 'error', payload: { code: 'tts-failed', turnId, detail: null } });
    finish(o, turn);
    return;
  }
  await reply(o, turn, voicer, [...before, recentLine('person', text)], (feed) => runAgent(o, turn, text, feed));
  finish(o, turn);
}

export function replyVoicer(o: TurnOrchestrator): ReplyVoicing | null {
  const y = o.deps.voicers.yanni;
  if (o.services?.replyVoice === 'yanni' && y) return y;
  return spokenVoicer(o);
}

export function spokenVoicer(o: TurnOrchestrator): ReplyVoicing | null {
  const s = o.services, sink = o.deps.voicers.playoutSink;
  if (!s || !sink || !s.tts) return null;
  const ha = o.ha;
  if (!ha || !o.haTTSAvailable) return null;
  const tts = new HATextToSpeech(ha, s.tts.pipelineID, o.deps.makeMediaFetcher(s.homeAssistant), o.deps.mediaDecoder, o.tunables);
  return new SpokenReplyVoicer(tts, sink, o.tunables);
}
