// Port of yanni/Conversation/VoiceAdapters.swift: Yanni's own reply voice for the orchestrator (babble), its reply
// clock, and the `conversation_context` publisher. port-note: the Swift `BridgeContextPublisher` publishes over MQTT;
// here the add-on owns MQTT, so the snapshot goes into the display's state report (`conversation_context`).
import {
  ReplyVoicingError, sensorState, type ChunkVoicing, type ConversationContextPublishing, type ConversationContextSnapshot,
  type ReplyTextChunk, type ReplyVoicing, type ReplyVoicingSession,
} from '../../conversation/agent/Ports';
import { makePlayoutSnapshot, type PlayoutSnapshot, type ReplyClock } from '../../conversation/core/Ports';
import { roundHalfAway } from '../../conversation/turn/TurnTunables';
import type { EmotionLayer } from '../../emotion/EmotionLayer';
import { makeReplyChunk } from '../../voice/bridge/ReplyBabble';
import type { VoiceDirector } from '../../voice/bridge/VoiceDirector';
import { HostClock } from '../../voice/host/VoiceOutput';
import { EmotionLayerSink } from './EmotionLayerSink';

/** Each chunk waits for its Pass B tag up to the director's deadline (150 ms for chunk 0 with hosted Jev), the emotion
 *  layer turns the tag into the chunk's feel and claims its stance, and the director babbles it on the reply renderer,
 *  back to back. Offsets are in the babble reply's own timeline, which `BabbleReplyClock` plays out. */
export class BabbleReplyVoicer implements ReplyVoicing {
  constructor(readonly director: VoiceDirector, readonly emotion: EmotionLayer, readonly hostedJev: () => boolean) {}

  async beginReply(turnId: string, _proactive: boolean): Promise<ReplyVoicingSession> {
    this.director.beginReplyTurn(turnId);
    return new BabbleReplySession(this);
  }
}

class BabbleReplySession implements ReplyVoicingSession {
  private cancelled = false;
  private totalMs = 0;

  constructor(private readonly voicer: BabbleReplyVoicer) {}

  async voice(chunk: ReplyTextChunk, willStart: (offsetMs: number) => void): Promise<ChunkVoicing> {
    const v = this.voicer;
    const deadline = v.director.replySettings.tagDeadlineFor(chunk.index, v.hostedJev());
    const decision = await chunk.tag.wait(deadline);
    if (this.cancelled) throw ReplyVoicingError.cancelled();
    const tag = decision ? v.emotion.sentenceTag(EmotionLayerSink.decision(decision)) : null;
    const voiced = v.director.voiceReplyChunk(makeReplyChunk({ text: chunk.text, index: chunk.index, isLast: chunk.isFinal, tag }));
    if (voiced.dropped && voiced.capped) throw ReplyVoicingError.capReached();
    const offsetMs = roundHalfAway(voiced.offset * 1000);
    this.totalMs = roundHalfAway(voiced.replyDuration * 1000);
    willStart(offsetMs);
    return { offsetMs, durationMs: Math.max(roundHalfAway((voiced.endHostTime - voiced.startHostTime) * 1000), 0) };
  }

  async totalAudioMs(): Promise<number> { return this.totalMs; }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.voicer.director.cancelReply();
  }
}

/** The reply clock in Yanni's voice: the babble reply's timeline at 1 kHz on the host clock. "Heard" is the audible
 *  onset of the reply's first chunk (the director's scheduled host time), never a playout level. */
export class BabbleReplyClock implements ReplyClock {
  private epoch = 0;
  private armedAt = -Infinity;

  constructor(readonly director: VoiceDirector, private readonly now: () => number = HostClock.nowSeconds) {}

  armReplyStart(epoch: number): void {
    this.epoch = epoch;
    this.armedAt = this.now();
  }

  playoutSnapshot(): PlayoutSnapshot {
    const now = this.now();
    const frame = Math.floor(now * 1000);
    const s = makePlayoutSnapshot({ sampleRate: 1000, framesPlayed: frame, lastBufferFrame: frame, lastBufferHostTime: frame / 1000 });
    // Only a reply that started after this epoch was armed, once it is audible.
    const origin = this.director.replyStartHostTime;
    if (origin !== null && origin > this.armedAt && now >= origin) {
      s.replyStart = { epoch: this.epoch, frame: Math.floor(origin * 1000), hostTime: origin };
    }
    return s;
  }
}

/** The `conversation_context` sensor: the orchestrator's fixed-vocabulary snapshot, kept for the state report. "none"
 *  while the mood note is off; the people count only while presence is shared (HomeAssistantBridge's rules). */
export class StateContextPublisher implements ConversationContextPublishing {
  latest: ConversationContextSnapshot | null = null;

  publish(c: ConversationContextSnapshot): void { this.latest = { ...c }; }

  sensor(sendMoodNote: boolean, sharePresence: boolean): string {
    const c = this.latest;
    if (!c || !sendMoodNote) return 'none';
    return sensorState(sharePresence ? c : { ...c, peopleCount: 0 }) || 'none';
  }
}
