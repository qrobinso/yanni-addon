// Port of FaceVoice/Bridge/VoiceDirector+Reply.swift (forwarded from `VoiceDirector`).
//
// Yanni's own reply voice (direct Home Assistant design §7.2–§7.3): each chunk of reply text becomes babble on the
// reply renderer, back to back, with face cues like any chirp. Babble is a reply, not a chirp: it plays with Sounds
// off and in quiet mode, at the night factor at a bedtime night wake, and it is not an auto-vocalisation (no rate
// limit; auto chirps pause while it plays). Barge-in: `cancel()` (both renderers) or `cancelReply()`.
//
// Orchestrator flow per reply: `beginReplyTurn(turnId)`; per chunk, wait for its Pass B tag up to
// `replySettings.tagDeadlineFor(chunkIndex, hostedJev)`, get the emotion layer's sentence tag (null when it missed),
// `voiceReplyChunk(chunk)`, then report `startHostTime` / `offset` as the sentence start (the emotion layer plays the
// stance nod there) and, after the last chunk, `replyDuration` as the reply's length.
import { FaceCommand, type OneShotKind, type SentenceTag } from '../../engine';
import { BabblePlan, BabbleShaping, makeBabbleRequest } from '../generate/BabbleShaping';
import { VoiceReactionTables } from '../generate/ReactionTables';
import { VoiceAffect, type Phrase, type VoiceReaction } from '../model/VoiceModel';
import { BabbleSeed, type ReplyChunk, type VoicedReplyChunk } from './ReplyBabble';
import { ScheduledPhrase, VoiceDirector } from './VoiceDirector';

export const ReplyConstants = {
  /// Yanni's greeting in its own voice (no "hi" clip): the engaged chirp, played on the engaged entry as always.
  greetingReaction: 'engaged' as VoiceReaction,
  /// "I can't think right now" in its own voice: the sheepish "uh-oh", played on the sheepish entry as always.
  cantThinkReaction: 'sheepish' as VoiceReaction,
  /// The nod must be at least this far ahead to start on time (s).
  answerFaceLead: 0.02,
};

/// A babble reply is scheduled or audible (+150 ms): auto-vocalisation pauses, as while speaking.
export const isReplying = (d: VoiceDirector): boolean => d.clock() < d.reply.audibleUntil;

/// The current reply's length so far (s): origin → the end of its last release.
export function replyDuration(d: VoiceDirector): number {
  const o = d.reply.origin, e = d.reply.end;
  if (o === null || e === null) return 0;
  return Math.max(0, e - o);
}

/// Starts a reply seeded from its turn id (stable across launches; two turns never babble alike).
export function beginReplyTurn(d: VoiceDirector, turnId: string): void { d.beginReply(BabbleSeed.make(turnId)); }

/// The affect a chunk is voiced with: the current mood moved toward the tag's PAD by its strength; the mood alone
/// when there is no tag (it missed its deadline) or it carries no feel.
export function babbleAffect(d: VoiceDirector, tag: SentenceTag | null): VoiceAffect {
  const mood = d.affectSnapshot();
  const pad = tag?.pad;
  if (!tag || !pad || !(Number.isFinite(pad.x) && Number.isFinite(pad.y) && Number.isFinite(pad.z))) return mood;
  const c = (v: number): number => Math.min(Math.max(v, -1), 1);
  const k = tag.strength;
  return VoiceAffect.make(c(mood.pleasure + k * (pad.x - mood.pleasure)), c(mood.arousal + k * (pad.y - mood.arousal)),
    c(mood.dominance + k * (pad.z - mood.dominance)));
}

/// Plans and schedules one chunk right after the previous one (a 250–350 ms breath), or as soon as possible.
/// With a claimed stance (`tag.answer`, the first one of the reply only) its answer chirp opens the chunk on the
/// nod's accents; `withFace` also plays the nod (the preview — in a conversation the emotion layer plays it at
/// `startHostTime`).
export function voiceReplyChunk(d: VoiceDirector, chunk: ReplyChunk, withFace: boolean): VoicedReplyChunk {
  const reply = d.reply;
  const now = d.clock();
  if (!reply.active || (chunk.index === 0 && reply.origin !== null)) {
    d.beginReply(BabbleSeed.mix(0x5eedbab1n, reply.count + 1));
  }
  const affect = babbleAffect(d, chunk.tag);
  const usedMood = !chunk.tag?.pad;
  let kind: OneShotKind | null = reply.answered ? null : (chunk.tag?.answer ?? null);
  const answer = kind !== null ? VoiceReactionTables.forOneShot(kind) : null;
  if (answer === null) kind = null;
  const latency = d.output?.outputLatency ?? 0;
  const settings = d.settings;
  // Nod start → the chirp's first note (the face leads by `visualLead`; `avOffset` delays the face).
  let accentLead = kind !== null ? VoiceDirector.accentTime(kind) / d.oneShotRate + VoiceDirector.visualLead - settings.avOffset : 0;
  let sound = now + d.lead + latency;
  if (kind !== null) sound = Math.max(sound, now + ReplyConstants.answerFaceLead + accentLead);
  if (reply.lastNoteEnd !== null) sound = Math.max(sound, reply.lastNoteEnd + reply.nextGap);
  const origin = reply.origin ?? (sound - accentLead);
  const budget = d.replySettings.replyCap - (sound - origin);
  const result: VoicedReplyChunk = {
    index: chunk.index, plan: new BabblePlan(), phrases: [], startHostTime: sound, firstNoteHostTime: sound,
    endHostTime: sound, offset: sound - origin, replyDuration: replyDuration(d), affect, usedMood, answer: null,
    dropped: true, capped: budget < BabbleShaping.minSentence,
  };
  if (!(budget >= BabbleShaping.minSentence)) {
    if (chunk.isLast) reply.active = false;
    return result;
  }
  const req = makeBabbleRequest({
    text: chunk.text, affect, isLast: chunk.isLast, answer,
    seed: chunk.seed ?? BabbleSeed.mix(reply.seed, chunk.index),
    sentenceCap: d.replySettings.sentenceCap, budget, answerGap: d.replySettings.answerGap,
  });
  const plan = d.generator.makeBabble(req);
  if (chunk.isLast) reply.active = false;
  result.plan = plan;
  result.capped = plan.droppedSentences > 0;
  if (plan.isEmpty) return result;
  if (plan.answer === null) { kind = null; accentLead = 0; }
  const start = sound - accentLead;

  const phrases: ScheduledPhrase[] = [];
  for (const item of plan.items) {
    phrases.push(scheduleReply(d, item.phrase, sound + item.offset - latency, latency, item.sentence < 0 ? kind : null, now));
  }
  if (withFace && kind !== null && phrases.length > 0) {
    d.engine.send(FaceCommand.playOneShotAt(kind, start));
    d.pending.push({ kind, hostTime: start, phraseID: phrases[0].phrase.id, confirmed: false });
  }
  if (kind !== null) reply.answered = true;
  reply.origin = reply.origin ?? start;
  reply.lastNoteEnd = sound + plan.lastNoteEnd;
  reply.end = Math.max(reply.end ?? 0, sound + plan.duration);
  reply.nextGap = plan.nextGap;

  result.phrases = phrases;
  result.startHostTime = start;
  result.firstNoteHostTime = sound + (plan.items[0]?.offset ?? 0);
  result.endHostTime = sound + plan.duration;
  result.offset = start - (reply.origin ?? start);
  result.replyDuration = replyDuration(d);
  result.answer = kind;
  result.dropped = false;
  return result;
}

/// Barge-in on the reply only: fades the reply renderer (30 ms) and drops the face cues still to come.
export function cancelReply(d: VoiceDirector): void {
  const now = d.clock();
  d.replyRenderer.cancelAll();
  d.engine.send(FaceCommand.cancelVocalCues(now));
  d.records = d.records.filter((r) => !r.onReply);
  d.reply.cancel(now, VoiceDirector.audibleTail);
  d.onPlayoutCut?.(now + VoiceDirector.audibleTail);
}

/// Plays a reaction now on the reply renderer (never muted): a chirp that is part of a reply, e.g. the sheepish
/// "uh-oh" standing in for "I can't think right now" when someone chose to talk. No face one-shot.
export function replyChirp(d: VoiceDirector, r: VoiceReaction): ScheduledPhrase {
  const now = d.clock();
  const affect = d.affectSnapshot();
  const p = d.generator.make(r, affect);
  p.affect = { ...affect };
  const latency = d.output?.outputLatency ?? 0;
  return scheduleReply(d, p, now + d.lead, latency, null, now);
}

/// Enqueues one reply phrase on the reply renderer at `start` (renderer host seconds) and sends its face cues.
export function scheduleReply(d: VoiceDirector, planned: Phrase, start: number, latency: number,
  paired: OneShotKind | null, now: number): ScheduledPhrase {
  const phrase = planned.copy();
  d.nextID += 1;
  phrase.id = d.nextID;
  d.activeSince = now;
  const out = d.output;
  if (out && out.isIdle) out.setIdle?.(false);
  const running = out?.isRunning === true;
  const enqueued = running && d.replyRenderer.enqueue(phrase, start, 1);
  const cues = d.makeCues(phrase, start, 1, latency, paired);
  for (const c of cues) d.engine.send(FaceCommand.vocalCue(c));
  const rec = new ScheduledPhrase(phrase, start, 1, latency, cues, paired, null, false, enqueued, enqueued);
  rec.onReply = true;
  d.records.push(rec);
  // Speaking from now until the last release + 150 ms, audible or not (auto chirps pause; turn detection's
  // echo margin uses it when audible).
  d.reply.audibleUntil = Math.max(d.reply.audibleUntil, rec.audibleEnd + VoiceDirector.audibleTail);
  if (enqueued) d.onPlayout?.(start + latency, rec.audibleEnd);
  d.lastPhrase = phrase;
  d.lastScheduled = rec;
  d.lastPhraseTime = now;
  return rec;
}
