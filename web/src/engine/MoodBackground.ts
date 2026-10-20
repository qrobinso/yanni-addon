// Port of FaceEngine/MoodBackground.swift: only MoodBackgroundConfig so far (FaceState needs it).
// TODO(WP7): rest of MoodBackground.swift (the MoodBackground value type MoodColor steps).
import { v3, type V3 } from '../core/vec';

export type MoodBackgroundMode = 'black' | 'mood' | 'fixed';

/// The mood background's settings (mood background design §5). The device profile and Accessibility set the last two.
/// A class standing in for a Swift struct: `copy()` where the Swift copies.
export class MoodBackgroundConfig {
  static readonly modes: readonly MoodBackgroundMode[] = ['black', 'mood', 'fixed'];
  mode: MoodBackgroundMode = 'black';
  /// How far the background mixes from the theme background (black) toward the colour, 0…1.
  strength = 1;
  /// The fixed colour (linear RGB).
  fixedColor: V3 = v3(0.02, 0.05, 0.12);
  /// Colour transition speed multiplier, 0.25…2 (1 = ≈ 3 s to settle).
  speed = 1;
  /// Keep the colour at bedtime (also during a night wake). Off: black all bedtime.
  colourAtBedtime = false;
  /// Smallest Oklab lightness gap between the sclera and the background (0.12; Increase Contrast 0.18).
  readabilityGap = 0.12;
  /// Oklab L of the sclera fill the gap is measured against (the ivory #FBF4E4).
  scleraLightness = 0.968;
  /// Reduce Motion: colour transitions at half speed; colour bursts softer, longer and lower.
  reduceMotion = false;
  /// One-shot colour bursts over the mood colour (mood mode only).
  colourBursts = true;
  /// Colour burst strength multiplier, 0…1.
  burstStrength = 1;

  copy(): MoodBackgroundConfig { const c = Object.assign(new MoodBackgroundConfig(), this); c.fixedColor = { ...this.fixedColor }; return c; }

  equals(o: MoodBackgroundConfig): boolean {
    return this.mode === o.mode && this.strength === o.strength && this.fixedColor.x === o.fixedColor.x &&
      this.fixedColor.y === o.fixedColor.y && this.fixedColor.z === o.fixedColor.z && this.speed === o.speed &&
      this.colourAtBedtime === o.colourAtBedtime && this.readabilityGap === o.readabilityGap &&
      this.scleraLightness === o.scleraLightness && this.reduceMotion === o.reduceMotion &&
      this.colourBursts === o.colourBursts && this.burstStrength === o.burstStrength;
  }

  validated(): MoodBackgroundConfig {
    const c = this.copy();
    const fin = Number.isFinite;
    c.strength = fin(this.strength) ? Math.min(Math.max(this.strength, 0), 1) : 1;
    c.speed = fin(this.speed) ? Math.min(Math.max(this.speed, 0.25), 2) : 1;
    c.readabilityGap = fin(this.readabilityGap) ? Math.min(Math.max(this.readabilityGap, 0), 0.4) : 0.12;
    c.burstStrength = fin(this.burstStrength) ? Math.min(Math.max(this.burstStrength, 0), 1) : 1;
    c.scleraLightness = fin(this.scleraLightness) ? Math.min(Math.max(this.scleraLightness, 0.5), 1) : 0.968;
    const f = this.fixedColor;
    const cl = (v: number): number => Math.min(Math.max(v, 0), 1);
    c.fixedColor = fin(f.x) && fin(f.y) && fin(f.z) ? v3(cl(f.x), cl(f.y), cl(f.z)) : new MoodBackgroundConfig().fixedColor;
    return c;
  }

  /// Highest background lightness the readability rule allows.
  get maxLightness(): number { return this.scleraLightness - this.readabilityGap; }
}
