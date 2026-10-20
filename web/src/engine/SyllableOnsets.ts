// Port of FaceEngine/SyllableOnsets.swift.
import { VocalContour } from '../model';
import type { OneShotKind, VocalCue } from './Commands';

export interface SyllableOnset {
  /// Audible host time of the syllable's rise.
  hostTime: number;
  /// 0…1: 0.5 is a typical syllable, more for louder (stressed) ones.
  accent: number;
  /// Seconds since the previous onset (∞ after a long pause).
  gap: number;
}

/// Syllable onsets in the Spoken voice's audio (talking bounce design): turns the playout's speech level envelope
/// (0…1 on a dB scale, one sample per ≈ 5 ms, stamped with its audible host time) into the same `VocalCue`s Yanni's
/// babble notes produce, so both voices bounce the face through one path (`VocalSync`).
///
/// A positive-flux peak picker: the flux is the level's rise over `fluxSpan`; an onset starts when it exceeds an
/// adaptive threshold above the `silence` gate, at least `minInterOnset` after the previous one and only once the flux
/// has fallen back. Its peak level over the next `accentWindow` decides the accent against the recent syllable peaks.
/// Allocation-free.
export class SyllableOnsetDetector {
  /// Level below which nothing starts (0.25 ≈ −40 dBFS).
  static readonly silence = 0.25;
  /// The flux compares the level with this long ago (s).
  static readonly fluxSpan = 0.020;
  static readonly minFlux = 0.13;
  static readonly thresholdGain = 1.6;
  /// Time constant of the flux mean (s).
  static readonly fluxMeanTau = 0.5;
  /// Syllables are at most ≈ 9 per second.
  static readonly minInterOnset = 0.11;
  /// The accent is measured over this long after the onset (the cue goes out then).
  static readonly accentWindow = 0.040;
  /// Accent per unit of level above the recent peak mean (0.1 level = 4 dB → +0.25).
  static readonly accentSlope = 2.5;
  /// How fast the recent syllable-peak mean follows each new peak (per syllable).
  static readonly peakMeanRate = 0.35;
  /// Accent at or above which a syllable is a stressed (accent) cue.
  static readonly accentCue = 0.65;
  /// Gap (s) after which a syllable hops, as the babble's `VoiceDirector.hopInterval`.
  static readonly hopGap = 0.18;
  /// The cue's note length (s): a typical syllable.
  static readonly noteDuration = 0.15;

  /// Levels and times of the last few samples (ring of 8).
  private levels = new Float64Array(8);
  private times = new Float64Array(8).fill(-Infinity);
  private head = 0;
  private fluxMean = 0;
  private armed = true;
  private pendingStart: number | null = null;
  private pendingPeak = 0;
  private peakMean = -1;
  private lastOnset = -Infinity;
  private lastTime = -Infinity;

  /// Forget everything (a new reply, a barge-in).
  reset(): void { Object.assign(this, new SyllableOnsetDetector()); }

  copy(): SyllableOnsetDetector {
    const d = Object.assign(new SyllableOnsetDetector(), this);
    d.levels = this.levels.slice(); d.times = this.times.slice();
    return d;
  }

  /// Feeds one level sample; returns an onset when one completes its accent window.
  push(raw: number, t: number): SyllableOnset | null {
    const C = SyllableOnsetDetector;
    if (!(Number.isFinite(t) && t > this.lastTime)) return null;
    const level = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
    const dtSample = Number.isFinite(this.lastTime) ? t - this.lastTime : 0.005;
    this.lastTime = t;

    // The level `fluxSpan` ago (the newest stored sample at or before it).
    let past = level;
    for (let k = 0; k < 8; k++) {
      const i = (this.head - 1 - k) & 7;
      if (this.times[i] <= t - C.fluxSpan + 1e-6) { past = this.levels[i]; break; }
    }
    this.levels[this.head] = level; this.times[this.head] = t; this.head = (this.head + 1) & 7;
    const flux = Math.max(level - past, 0);
    const threshold = Math.max(C.minFlux, C.thresholdGain * this.fluxMean);
    const k = 1 - Math.exp(-Math.min(Math.max(dtSample, 0), 0.1) / C.fluxMeanTau);
    this.fluxMean += (flux - this.fluxMean) * k;

    let out: SyllableOnset | null = null;
    if (this.pendingStart !== null) {
      const start = this.pendingStart;
      this.pendingPeak = Math.max(this.pendingPeak, level);
      if (t - start >= C.accentWindow) {
        if (this.peakMean < 0) this.peakMean = this.pendingPeak;
        const accent = Math.min(Math.max(0.5 + C.accentSlope * (this.pendingPeak - this.peakMean), 0), 1);
        this.peakMean += (this.pendingPeak - this.peakMean) * C.peakMeanRate;
        out = { hostTime: start, accent, gap: start - this.lastOnset };
        this.lastOnset = start;
        this.pendingStart = null;
      }
    } else if (this.armed && flux > threshold && level > C.silence && t - 0.5 * C.fluxSpan - this.lastOnset >= C.minInterOnset) {
      this.pendingStart = t - 0.5 * C.fluxSpan;
      this.pendingPeak = level;
      this.armed = false;
    }
    if (!this.armed && this.pendingStart === null && flux < 0.5 * threshold) this.armed = true;
    return out;
  }

  /// The face cue for an onset: the shape of a babble note (flat contour; a hop on accents or after a gap of `hopGap`),
  /// its intensity from the accent. `paired` softens the hop while an answer nod or shake plays.
  static cue(o: SyllableOnset, paired?: OneShotKind): VocalCue {
    const C = SyllableOnsetDetector;
    const strong = o.accent >= C.accentCue;
    return {
      hostTime: o.hostTime, duration: C.noteDuration, contour: VocalContour.flat(0),
      intensity: 0.4 + 0.6 * o.accent, articulation: 0.7, valence: 0,
      kind: strong ? 'accent' : 'plain', accent: strong || o.gap >= C.hopGap, pairedOneShot: paired,
    };
  }
}
