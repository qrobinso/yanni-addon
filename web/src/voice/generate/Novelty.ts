// Port of FaceVoice/Generate/Novelty.swift.
import { NoteBuffer, type Note, type Phrase, type VoiceReaction } from '../model/VoiceModel';

/// An 8-wide signature (SIMD8<Float>).
export type Signature = number[];

/// Phrase signatures and the "never the same twice" check (review M6).
export const Novelty = {
  /// Typical spread of each signature feature; features are divided by it before comparing.
  /// [note count, mean pitch, pitch span, mean duration, total duration, mean glide, mean cutoff, first interval]
  spread: [1, 2, 2, 0.03, 0.15, 1.5, 0.08, 2] as readonly number[],
  /// Minimum normalised distance to each of the last 3 phrases of the same kind.
  threshold: 0.35,
  historyLength: 3,

  signature(p: Phrase): Signature { return Novelty.signatureOf(p.notes); },

  signatureOf(notes: readonly Note[]): Signature {
    if (notes.length === 0) return [0, 0, 0, 0, 0, 0, 0, 0];
    const n = notes.length;
    let pitchSum = 0, lo = Infinity, hi = -Infinity;
    let durSum = 0, glideSum = 0, cutSum = 0, end = 0;
    for (const x of notes) {
      pitchSum += (x.contour.start + x.contour.end) / 2;
      lo = Math.min(lo, x.contour.start, x.contour.end); hi = Math.max(hi, x.contour.start, x.contour.end);
      durSum += x.duration;
      glideSum += x.contour.end - x.contour.start;
      cutSum += x.timbre.cutoff;
      end = Math.max(end, x.start + x.duration);
    }
    const first = notes.length > 1 ? notes[1].contour.start - notes[0].contour.start
      : notes[0].contour.end - notes[0].contour.start;
    return [n, pitchSum / n, hi - lo, durSum / n, end, glideSum / n, cutSum / n, first];
  },

  distance(a: Signature, b: Signature): number {
    let s = 0;
    for (let i = 0; i < 8; i++) { const d = (a[i] - b[i]) / Novelty.spread[i]; s += d * d; }
    return Math.sqrt(s);
  },
};

/// Per-kind history of recent signatures plus the last phrase (for the exact-repeat guard).
export class NoveltyTracker {
  private recent = new Map<VoiceReaction, Signature[]>();
  private lastNotes: Note[] = [];

  /// Minimum distance to the recent same-kind signatures (∞ with no history; 0 if identical to the last phrase).
  score(notes: readonly Note[], kind: VoiceReaction): number {
    if (NoteBuffer.equals(notes, this.lastNotes)) return 0;
    const s = Novelty.signatureOf(notes);
    let best = Infinity;
    for (const h of this.recent.get(kind) ?? []) best = Math.min(best, Novelty.distance(s, h));
    return best;
  }

  copy(): NoveltyTracker {
    const t = new NoveltyTracker();
    for (const [k, v] of this.recent) t.recent.set(k, v.map((x) => [...x]));
    t.lastNotes = this.lastNotes.map((n) => n.copy());
    return t;
  }

  record(notes: readonly Note[], kind: VoiceReaction): void {
    const list = [...(this.recent.get(kind) ?? [])];
    list.push(Novelty.signatureOf(notes));
    if (list.length > Novelty.historyLength) list.splice(0, list.length - Novelty.historyLength);
    this.recent.set(kind, list);
    this.lastNotes = notes.map((n) => n.copy());
  }
}
