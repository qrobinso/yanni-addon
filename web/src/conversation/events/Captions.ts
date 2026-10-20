// Port of ConversationEvents/Captions.swift. Captions: the words on screen, held only in memory while shown. Never in
// `AgentEvent`, never logged, stored or sent anywhere. `describe…` never prints the text.

/** Caption text from the transport to the controller. */
export type CaptionText =
  /** What the recogniser heard, for a turn the gate let through. */
  | { kind: 'transcript'; turnId: string; text: string }
  /** One reply piece (the chunker's clause or sentence), emitted just before its `sentence-start`. */
  | { kind: 'sentence'; turnId: string; index: number; text: string }
  /** What the recogniser has heard so far (on-device recogniser only). Display only. */
  | { kind: 'partial'; text: string };

export function describeCaptionText(c: CaptionText): string {
  switch (c.kind) {
    case 'transcript': return `transcript(${c.turnId}, ${c.text.length} chars)`;
    case 'partial': return `partial(${c.text.length} chars)`;
    case 'sentence': return `sentence(${c.turnId}, #${c.index}, ${c.text.length} chars)`;
  }
}

/** What the controller tells the caption bubbles, in order. */
export type Caption =
  /** The "you" bubble shows what's heard so far ("" = speech started, nothing recognised yet). Display only. */
  | { kind: 'transcriptPartial'; text: string }
  /** The person's words (final, past the gate). */
  | { kind: 'transcript'; turnId: string; text: string }
  /** A reply piece, emitted when its audio becomes audible, with its audio's length when known (null: `replyTiming`
   *  follows). */
  | { kind: 'replySentence'; turnId: string; index: number; text: string; audibleAtHostTime: number; audioSeconds: number | null }
  /** The audio length of a reply piece shown without one. */
  | { kind: 'replyTiming'; turnId: string; index: number; audioSeconds: number }
  /** The reply's last audio has played. */
  | { kind: 'replyEnded'; turnId: string }
  /** Take everything down now (barge-in, an error, the conversation ended, captions switched off). */
  | { kind: 'cleared' };

export function describeCaption(c: Caption): string {
  switch (c.kind) {
    case 'transcript': return `transcript(${c.turnId}, ${c.text.length} chars)`;
    case 'transcriptPartial': return `transcriptPartial(${c.text.length} chars)`;
    case 'replySentence':
      return `replySentence(${c.turnId}, #${c.index}, ${c.text.length} chars, at ${c.audibleAtHostTime}, ${
        c.audioSeconds !== null ? `${c.audioSeconds} s` : 'untimed'})`;
    case 'replyTiming': return `replyTiming(${c.turnId}, #${c.index}, ${c.audioSeconds} s)`;
    case 'replyEnded': return `replyEnded(${c.turnId})`;
    case 'cleared': return 'cleared';
  }
}
