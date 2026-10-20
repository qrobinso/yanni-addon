// Port of FaceModel/VocalContour.swift.

/// Pitch contour of one vocal note, shared by the voice synthesizer and the face (so the eyes can follow
/// the exact pitch the ear hears). All pitches are semitones relative to the voice fingerprint's base.
export interface VocalContourInit {
  start: number;
  end: number;
  glideOnset?: number;
  glideEase?: number;
  scoop?: number;
  scoopTau?: number;
  wobbleDepth?: number;
  wobbleRate?: number;
  trillDepth?: number;
  trillRate?: number;
  droop?: number;
  droopFraction?: number;
}

export class VocalContour {
  /// Target pitch at the start and end of the glide (semitones).
  start: number;
  end: number;
  /// Fraction of the note (0…1) at which the glide from `start` to `end` begins.
  glideOnset: number;
  /// 0 = linear glide, 1 = strongly eased (smoothstep-like) glide.
  glideEase: number;
  /// Onset scoop: pitch starts `scoop` semitones below the target and approaches it with time constant
  /// `scoopTau` (s). Negative scoop = overshoot above (startle).
  scoop: number;
  scoopTau: number;
  /// Irregular wobble (sum of two sines at `wobbleRate` and 1.52×), depth in semitones.
  wobbleDepth: number;
  wobbleRate: number;
  /// Trill: alternation between 0 and `trillDepth` semitones at `trillRate` Hz (smoothed square).
  trillDepth: number;
  trillRate: number;
  /// Final droop: the last `droopFraction` of the note falls by `droop` semitones (eased). 0 = none.
  droop: number;
  droopFraction: number;

  constructor(o: VocalContourInit) {
    this.start = o.start; this.end = o.end;
    this.glideOnset = o.glideOnset ?? 0; this.glideEase = o.glideEase ?? 0.6;
    this.scoop = o.scoop ?? 0; this.scoopTau = o.scoopTau ?? 0.018;
    this.wobbleDepth = o.wobbleDepth ?? 0; this.wobbleRate = o.wobbleRate ?? 3.5;
    this.trillDepth = o.trillDepth ?? 0; this.trillRate = o.trillRate ?? 12;
    this.droop = o.droop ?? 0; this.droopFraction = o.droopFraction ?? 0.35;
  }

  static flat(pitch: number): VocalContour { return new VocalContour({ start: pitch, end: pitch }); }

  copy(): VocalContour { return new VocalContour(this); }

  equals(o: VocalContour): boolean {
    return this.start === o.start && this.end === o.end && this.glideOnset === o.glideOnset &&
      this.glideEase === o.glideEase && this.scoop === o.scoop && this.scoopTau === o.scoopTau &&
      this.wobbleDepth === o.wobbleDepth && this.wobbleRate === o.wobbleRate && this.trillDepth === o.trillDepth &&
      this.trillRate === o.trillRate && this.droop === o.droop && this.droopFraction === o.droopFraction;
  }

  /// Pitch in semitones at time `t` seconds into a note of length `duration`. Pure and allocation-free.
  /// Vibrato is applied separately by the synth (it is not part of the contour).
  pitch(t: number, duration: number): number {
    const d = Math.max(duration, 1e-4);
    const x = Math.min(Math.max(t / d, 0), 1);
    // Glide.
    const g0 = Math.min(Math.max(this.glideOnset, 0), 0.999);
    let u = Math.min(Math.max((x - g0) / (1 - g0), 0), 1);
    const smooth = u * u * (3 - 2 * u);
    u = u + (smooth - u) * Math.min(Math.max(this.glideEase, 0), 1);
    let p = this.start + (this.end - this.start) * u;
    // Onset scoop / overshoot.
    if (this.scoop !== 0) p -= this.scoop * Math.exp(-Math.max(t, 0) / Math.max(this.scoopTau, 1e-4));
    // Wobble.
    if (this.wobbleDepth !== 0) {
      const w = 2 * Math.PI * this.wobbleRate * t;
      p += this.wobbleDepth * (0.6 * Math.sin(w) + 0.4 * Math.sin(w * 1.52 + 1.3));
    }
    // Trill: smoothed square between 0 and depth.
    if (this.trillDepth !== 0) {
      const s = Math.sin(2 * Math.PI * this.trillRate * t);
      const sq = Math.tanh(4 * s); // soft square, ~8 ms edges at 12 Hz
      p += this.trillDepth * 0.5 * (sq + 1);
    }
    // Final droop.
    if (this.droop !== 0 && this.droopFraction > 0) {
      const start = 1 - Math.min(this.droopFraction, 1);
      const v = Math.min(Math.max((x - start) / Math.max(this.droopFraction, 1e-4), 0), 1);
      p -= this.droop * v * v * (3 - 2 * v);
    }
    return p;
  }
}
