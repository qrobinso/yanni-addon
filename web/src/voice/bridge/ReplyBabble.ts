// Port of FaceVoice/Bridge/ReplyBabble.swift.
import type { OneShotKind, SentenceTag } from '../../engine';
import type { BabblePlan } from '../generate/BabbleShaping';
import type { VoiceAffect } from '../model/VoiceModel';
import type { ScheduledPhrase } from './VoiceDirector';

/// Tunables of Yanni's babble reply voice (direct Home Assistant design §6.7, §7.2–§7.3). Every number is a
/// starting point; the Tune › Sound › Reply babble panel moves them live.
export class ReplyBabbleSettings {
  /// Longest a sentence may babble (s).
  sentenceCap = 1.5;
  /// Longest a whole reply may babble (s); later chunks are dropped.
  replyCap = 6;
  /// How long a chunk waits for its Pass B tag before it is voiced with the current mood (s).
  tagDeadline = 0.300;
  /// Chunk 0's wait with hosted Jev (review R10): the first sentence is on the latency path.
  hostedFirstTagDeadline = 0.150;
  /// Silence between a stance's answer chirp and the babble (s).
  answerGap = 0.15;
  /// Reply volume factor at a bedtime night wake (voice volume × this, like spoken replies).
  nightVoiceFactor = 0.5;

  constructor(o: Partial<ReplyBabbleSettings> = {}) { Object.assign(this, o); }

  /// The Pass B wait for chunk `index`: 150 ms for chunk 0 with hosted Jev, else `tagDeadline`.
  tagDeadlineFor(chunkIndex: number, hostedJev: boolean): number {
    return chunkIndex === 0 && hostedJev ? Math.min(this.hostedFirstTagDeadline, this.tagDeadline) : this.tagDeadline;
  }

  validated(): ReplyBabbleSettings {
    const d = new ReplyBabbleSettings();
    const c = (x: number, lo: number, hi: number, f: number): number => Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : f;
    const s = this.copy();
    s.sentenceCap = c(this.sentenceCap, 0.4, 6, d.sentenceCap);
    s.replyCap = c(this.replyCap, 0.5, 30, d.replyCap);
    s.tagDeadline = c(this.tagDeadline, 0, 2, d.tagDeadline);
    s.hostedFirstTagDeadline = c(this.hostedFirstTagDeadline, 0, 2, d.hostedFirstTagDeadline);
    s.answerGap = c(this.answerGap, 0, 0.6, d.answerGap);
    s.nightVoiceFactor = Number.isFinite(this.nightVoiceFactor) ? Math.min(Math.max(this.nightVoiceFactor, 0), 1) : d.nightVoiceFactor;
    return s;
  }

  copy(): ReplyBabbleSettings { return new ReplyBabbleSettings(this); }

  equals(o: ReplyBabbleSettings): boolean {
    return this.sentenceCap === o.sentenceCap && this.replyCap === o.replyCap && this.tagDeadline === o.tagDeadline &&
      this.hostedFirstTagDeadline === o.hostedFirstTagDeadline && this.answerGap === o.answerGap &&
      this.nightVoiceFactor === o.nightVoiceFactor;
  }
}

/// One chunk of reply text to voice in Yanni's voice.
export interface ReplyChunk {
  text: string;
  /// The chunk's sentence index in the reply (0 = the first clause).
  index: number;
  isLast: boolean;
  /// Its Pass B tag (`EmotionLayer.sentenceTag(for:)`), or null when it missed its deadline: the current mood.
  tag: SentenceTag | null;
  /// Babble seed; null derives it from the reply's seed (`beginReply`) and `index`.
  seed: bigint | null;
}
export const makeReplyChunk = (o: Pick<ReplyChunk, 'text' | 'index'> & Partial<ReplyChunk>): ReplyChunk =>
  ({ isLast: false, tag: null, seed: null, ...o });

/// What the director scheduled for one chunk. Host times are audible times (host seconds, display-link base).
export interface VoicedReplyChunk {
  index: number;
  plan: BabblePlan;
  phrases: ScheduledPhrase[];
  /// When the chunk starts for the listener: the nod's start when it opens with an answer (the emotion layer starts
  /// the nod here: `sentenceAudioStarted(hostTime:)`), else its first note's onset.
  startHostTime: number;
  /// Its first note's audible onset.
  firstNoteHostTime: number;
  /// The end of its last note's release.
  endHostTime: number;
  /// `startHostTime` in the reply's own timeline (s; `sentenceStart {offsetMs}`).
  offset: number;
  /// The reply's length so far, through this chunk (s; `replyEnd {audioMs}` after the last one).
  replyDuration: number;
  affect: VoiceAffect;
  /// No tag PAD: voiced with the current mood.
  usedMood: boolean;
  /// The answer one-shot its chirp opens with (null: none, or the reply already had its one).
  answer: OneShotKind | null;
  /// Nothing voiced (empty text, or the reply cap was already reached).
  dropped: boolean;
  /// The reply cap cut sentences from it.
  capped: boolean;
}

const M64 = (1n << 64n) - 1n;

/// Stable babble seeds from string ids (FNV-1a; Swift's `Hasher` is randomly seeded per process).
export const BabbleSeed = {
  make(id: string, index = 0): bigint {
    let h = 0xcbf29ce484222325n;
    for (const b of new TextEncoder().encode(id)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & M64;
    return BabbleSeed.mix(h, index);
  },

  mix(seed: bigint, index: number): bigint {
    let z = (seed + BigInt.asUintN(64, BigInt(index)) * 0x9e3779b97f4a7c15n) & M64;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
    return z ^ (z >> 31n);
  },
};

/// The reply being babbled: its timeline origin, where the next chunk may start, its one answer.
export class ReplyState {
  seed = 0n;
  active = false;
  count = 0;
  /// Audible start of chunk 0 (the reply's timeline origin).
  origin: number | null = null;
  /// Audible end of the last scheduled note (the next chunk's gap counts from here).
  lastNoteEnd: number | null = null;
  end: number | null = null;
  nextGap = 0.3;
  /// The reply already opened a chunk with an answer (at most one per reply).
  answered = false;
  /// Until when the reply may be audible, + the 150 ms tail.
  audibleUntil = 0;

  begin(seed: bigint): void {
    const count = this.count + 1, audibleUntil = this.audibleUntil;
    Object.assign(this, new ReplyState());
    this.seed = seed; this.active = true; this.count = count; this.audibleUntil = audibleUntil;
  }

  cancel(now: number, tail: number): void {
    this.active = false;
    this.origin = null; this.lastNoteEnd = null; this.end = null; this.answered = false;
    this.audibleUntil = Math.min(this.audibleUntil, now + tail);
  }
}
