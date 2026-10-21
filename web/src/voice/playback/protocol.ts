// Messages between the main thread (`VoiceRendererPort`) and the voice AudioWorklet (`voiceWorklet.ts`).
import { VocalContour } from '../../model';
import { Note, Phrase, type VoiceAffect, type VoiceReaction } from '../model/VoiceModel';

/// Which renderer a message is for: the chirps, or Yanni's babble reply (never muted by Sounds off).
export type RendererId = 'chirp' | 'reply';

/// A phrase as plain data (structured clone drops class prototypes).
export interface PhraseData { notes: Note[]; reaction: VoiceReaction; affect: VoiceAffect; id: number }

export type ToWorklet =
  | { t: 'enqueue'; r: RendererId; phrase: PhraseData; start: number; stretch: number }
  | { t: 'cancelAll'; r: RendererId }
  | { t: 'setVolume'; r: RendererId; v: number }
  | { t: 'setMuted'; r: RendererId; v: boolean }
  | { t: 'setGain'; r: RendererId; v: number }
  | { t: 'setFingerprint'; r: RendererId; basePitchHz: number; maxPitchHz: number; loudness: number }
  /// Buffer host time = AudioWorklet `currentTime` + offset (host seconds, before the output latency).
  | { t: 'hostOffset'; offset: number };

export type FromWorklet =
  | { t: 'started'; r: RendererId; id: number; hostTime: number }
  | { t: 'sounding'; r: RendererId; v: boolean };

export function phraseToData(p: Phrase): PhraseData {
  return { notes: p.notes.map((n) => n.copy()), reaction: p.reaction, affect: { ...p.affect }, id: p.id };
}

export function phraseFromData(d: PhraseData): Phrase {
  const p = new Phrase();
  p.notes = d.notes.map((n) => new Note({ ...n, contour: new VocalContour(n.contour), timbre: { ...n.timbre },
    envelope: { ...n.envelope }, modulation: { ...n.modulation } }));
  p.reaction = d.reaction; p.affect = { ...d.affect }; p.id = d.id;
  return p;
}
