// Port of yanni/Preview/ReplyBabblePanel.swift: type a reply, pick its feel (PAD and strength, or "missed its
// deadline" = the current mood) and stance, and hear Yanni say it in its own voice, chunk by chunk as a conversation
// would. The caps move `VoiceDirector.replySettings` live; nothing here is persisted.
import type { OneShotKind } from '../engine/Commands';
import { makeSentenceTag } from '../engine/SentenceTag';
import { makeReplyChunk } from '../voice/bridge/ReplyBabble';
import type { VoiceDirector } from '../voice/bridge/VoiceDirector';
import { BabbleText } from '../voice/generate/SyllableCounter';
import { buttons, note, readout, section, select, slider, textField, toggle, type Build } from './ui';

export type Stance = 'none' | 'yes' | 'strongYes' | 'no' | 'strongNo';
const STANCES: readonly (readonly [Stance, string, OneShotKind | null])[] = [
  ['none', 'None', null], ['yes', 'Yes (mm-hm)', 'nodYes'], ['strongYes', 'Absolutely (mm-HM)', 'nodYesBig'],
  ['no', 'No (uh-uh)', 'shakeNo'], ['strongNo', 'Absolutely not (nuh-uh)', 'shakeNoBig'],
];

export class ReplyBabblePreview {
  text = 'Sure, I turned on the kitchen lights. Want me to dim them a little?';
  useMood = false;
  pleasure = 0.5;
  arousal = 0.4;
  dominance = 0.2;
  strength = 1;
  stance: Stance = 'none';
  withFace = true;
  lines: string[] = [];

  constructor(readonly director: VoiceDirector) {}

  play(): void {
    const d = this.director;
    d.cancel();
    // Preview-only seed (never engine logic).
    d.beginReply(BigInt(1 + Math.floor(Math.random() * 2 ** 52)));
    const chunks = BabbleText.sentenceStrings(this.text);
    const answer = STANCES.find((s) => s[0] === this.stance)![2];
    const lines: string[] = [];
    chunks.forEach((text, i) => {
      const tag = this.useMood ? null
        : makeSentenceTag({ x: this.pleasure, y: this.arousal, z: this.dominance }, this.strength, i === 0 ? answer : null);
      const v = d.voiceReplyChunk(makeReplyChunk({ text, index: i, isLast: i === chunks.length - 1, tag }), this.withFace);
      if (v.dropped) { lines.push(`#${i} dropped (reply cap)`); return; }
      lines.push(`#${i} +${(v.offset * 1000).toFixed(0).padStart(4)} ms · ${((v.endHostTime - v.startHostTime) * 1000).toFixed(0)} ms · `
        + `${v.plan.syllables} syl → ${v.plan.items.filter((it) => it.sentence >= 0).length} phrases`
        + (v.answer ? ` · ${v.answer}` : '') + (v.plan.compressed ? ' · compressed' : '') + (v.usedMood ? ' · mood' : ''));
    });
    lines.push(`reply ${(d.replyDuration * 1000).toFixed(0)} ms`);
    this.lines = lines;
  }
}

export function replyBabbleSection(rp: ReplyBabblePreview, b: Build): HTMLElement {
  const d = rp.director;
  const cap = (label: string, k: 'sentenceCap' | 'replyCap' | 'answerGap', range: readonly [number, number], dec: number) =>
    slider(label, () => d.replySettings[k], (v) => { d.replySettings[k] = v; }, range, (v) => `${v.toFixed(dec)} s`);
  return section('Reply babble',
    textField('Reply text', () => rp.text, (v) => { rp.text = v; }, true),
    toggle('Tag missed its deadline (use the mood)', () => rp.useMood, (v) => { rp.useMood = v; }),
    slider('Pleasure', () => rp.pleasure, (v) => { rp.pleasure = v; }, [-1, 1]),
    slider('Arousal', () => rp.arousal, (v) => { rp.arousal = v; }, [-1, 1]),
    slider('Dominance', () => rp.dominance, (v) => { rp.dominance = v; }, [-1, 1]),
    slider('Tag strength', () => rp.strength, (v) => { rp.strength = v; }, [0, 1]),
    select('Stance (first chunk)', STANCES.map(([s, t]) => [s, t] as const), () => rp.stance, (v) => { rp.stance = v; }),
    toggle('Play the nod / shake', () => rp.withFace, (v) => { rp.withFace = v; }),
    buttons(['Play', () => rp.play()], ['Stop', () => d.cancel()]),
    cap('Sentence cap', 'sentenceCap', [0.4, 4], 2),
    cap('Reply cap', 'replyCap', [0.5, 15], 1),
    cap('Answer gap', 'answerGap', [0, 0.5], 2),
    slider('Night factor', () => d.replySettings.nightVoiceFactor, (v) => { d.replySettings.nightVoiceFactor = v; }, [0, 1]),
    readout(b, () => rp.lines.join('\n')),
    note('Plays on the reply voice: heard with Sounds off and in quiet mode, like a spoken reply.'));
}
