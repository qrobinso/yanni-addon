// Port of FaceVoice/Generate/PentatonicSnap.swift.
import { vClamp01 } from './VoiceRNG';

/// Pulls intervals toward the pentatonic scale (major for P ≥ 0, minor for P < 0) so runs sound musical but
/// not mechanical: `amount` 0 leaves pitches alone, 1 lands exactly on scale degrees.
export const PentatonicSnap = {
  major: [0, 2, 4, 7, 9] as readonly number[],
  minor: [0, 3, 5, 7, 10] as readonly number[],

  /// Nearest scale degree (any octave) to `interval` semitones above the reference.
  nearest(interval: number, isMinor: boolean): number {
    const scale = isMinor ? PentatonicSnap.minor : PentatonicSnap.major;
    const octave = Math.floor(interval / 12);
    const r = interval - 12 * octave;
    let best = 0, bestD = Infinity;
    for (const deg of [...scale, 12]) {
      const d = Math.abs(r - deg);
      if (d < bestD) { bestD = d; best = deg; }
    }
    return 12 * octave + best;
  },

  /// Moves `interval` toward its nearest degree by `amount` (0…1).
  snap(interval: number, amount: number, isMinor: boolean): number {
    const q = PentatonicSnap.nearest(interval, isMinor);
    return interval + vClamp01(amount) * (q - interval);
  },

  /// Degree `index` steps up the scale (negative steps down), in semitones.
  degree(index: number, isMinor: boolean): number {
    const scale = isMinor ? PentatonicSnap.minor : PentatonicSnap.major;
    const n = scale.length;
    const oct = Math.floor(index / n);
    const i = index - oct * n;
    return oct * 12 + scale[i];
  },
};
