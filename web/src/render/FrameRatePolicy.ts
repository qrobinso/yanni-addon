// Port of FaceRendering/FrameRatePolicy.swift.
import type { FaceFrame } from '../model/FaceFrame';

/// Display rate tier (raw value = fps).
export type FrameRateTier = 30 | 60 | 120;
export const FrameRateTier = {
  low: 30 as FrameRateTier,
  normal: 60 as FrameRateTier,
  high: 120 as FrameRateTier,
  /// (minimum, maximum, preferred) frames per second.
  range(t: FrameRateTier): { min: number; max: number; preferred: number } {
    switch (t) {
      case 30: return { min: 15, max: 30, preferred: 30 };
      case 60: return { min: 48, max: 60, preferred: 60 };
      case 120: return { min: 80, max: 120, preferred: 120 };
    }
  },
} as const;

/// Adaptive display rate (M10): 60 fps by default, 120 while the face moves fast, 30 while asleep, and 30 while calm
/// unless the face moves fast. Speeding up is immediate; slowing down waits `holdDown` seconds of lower demand.
/// `ceiling` caps the burst only (never below `.normal`).
export class FrameRatePolicy {
  static readonly holdDown = 0.5;

  private _tier: FrameRateTier = 60;
  private _ceiling: FrameRateTier = 120;
  /// Drowsy, or the room empty while awake: 30 while still, 60 while moving fast, never 120.
  calm = false;
  private lowerSince: number | undefined;

  get tier(): FrameRateTier { return this._tier; }
  /// Highest tier allowed (`.high` = no cap). Clamped to at least `.normal`.
  get ceiling(): FrameRateTier { return this._ceiling; }
  set ceiling(t: FrameRateTier) { this._ceiling = t < 60 ? 60 : t; }

  static desired(frame: FaceFrame): FrameRateTier {
    return frame.isAsleep ? 30 : (frame.wantsHighFrameRate ? 120 : 60);
  }

  /// The desired tier under a ceiling (never below `.normal` while awake; asleep stays `.low`), and when calm.
  static desiredUnder(frame: FaceFrame, ceiling: FrameRateTier, calm = false): FrameRateTier {
    if (calm && !frame.isAsleep) return frame.wantsHighFrameRate ? 60 : 30;
    return Math.min(FrameRatePolicy.desired(frame), Math.max(ceiling, 60)) as FrameRateTier;
  }

  /// Feeds one frame. Returns the new tier when it changes, undefined otherwise.
  update(frame: FaceFrame, time: number): FrameRateTier | undefined {
    const want = FrameRatePolicy.desiredUnder(frame, this._ceiling, this.calm);
    if (want > this._tier) {
      this._tier = want;
      this.lowerSince = undefined;
      return this._tier;
    }
    if (want === this._tier) {
      this.lowerSince = undefined;
      return undefined;
    }
    if (this.lowerSince === undefined) {
      this.lowerSince = time;
      return undefined;
    }
    if (!(time - this.lowerSince >= FrameRatePolicy.holdDown)) return undefined;
    this._tier = want;
    this.lowerSince = undefined;
    return this._tier;
  }

  copy(): FrameRatePolicy {
    const p = new FrameRatePolicy();
    p._tier = this._tier; p._ceiling = this._ceiling; p.calm = this.calm; p.lowerSince = this.lowerSince;
    return p;
  }
}
