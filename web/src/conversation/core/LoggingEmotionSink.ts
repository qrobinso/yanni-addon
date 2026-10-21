// Port of ConversationCore/LoggingEmotionSink.swift.
import type { DecisionWireMessage, EmotionSink, GateEvent } from './Ports';

/** Stand-in for the emotion layer (review H1: "build those pieces with a logging sink"). Gate events are handed
 *  straight back (the face must still show not-for-me / confused); decisions and sentence starts are only counted and
 *  logged. No scheduling here: that's the emotion layer's job. */
export class LoggingEmotionSink implements EmotionSink {
  onGate: ((g: GateEvent) => void) | null = null;
  /** Log lines (never transcripts; decisions are summarised by pass and top feel). */
  onLog: ((line: string) => void) | null = null;
  decisions = 0;
  cancelledTurns: string[] = [];
  sentenceStarts: { turnId: string; index: number; hostTime: number }[] = [];

  receive(message: DecisionWireMessage): void {
    switch (message.kind) {
      case 'decision': {
        const d = message.payload;
        this.decisions += 1;
        // Swift `max { $0.value < $1.value }`: the first maximal entry.
        let top = '-';
        let best = -Infinity;
        for (const [k, v] of Object.entries(d.answers['feel'] ?? {})) if (v > best) { best = v; top = k; }
        this.onLog?.(`decision ${d.pass}${d.sentenceIndex !== null ? ` #${d.sentenceIndex}` : ''} feel ${top}`);
        break;
      }
      case 'notForMe':
        this.onLog?.('gate: not for me');
        this.onGate?.({ kind: 'notForMe', turnId: message.payload.turnId });
        break;
      case 'didNotUnderstand':
        this.onLog?.(`gate: did not understand (${message.payload.reason})`);
        this.onGate?.({ kind: 'didNotUnderstand', turnId: message.payload.turnId });
        break;
      case 'decisionModelUnavailable':
        this.onLog?.(`decision model unavailable (${message.payload.reason})`);
        break;
    }
  }

  cancelTurn(turnId: string): void {
    this.cancelledTurns.push(turnId);
    this.onLog?.('cancel turn');
  }

  sentenceAudioStarted(turnId: string, index: number, hostTime: number): void {
    this.sentenceStarts.push({ turnId, index, hostTime });
    if (this.sentenceStarts.length > 64) this.sentenceStarts.splice(0, this.sentenceStarts.length - 64);
  }
}
