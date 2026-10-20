// Port of FaceEngine/PowerCare.swift.
import { Brightness } from './modifiers/Brightness';

/// OLED and power care knobs for `Brightness` (hardening design §4.3, §6.4). The defaults reproduce `Brightness`'s
/// original constants with no ceiling. A class standing in for a Swift struct: `copy()` where the Swift copies.
export class PowerCare {
  /// Idle with nobody in view for `idleDimDelay` seconds lowers the brightness target to at most this.
  idleDimLevel: number;
  /// Seconds of idle-and-empty before the dim.
  idleDimDelay: number;
  /// Upper bound on the brightness target as a fraction of it (1 = none).
  brightnessScale: number;

  constructor(idleDimLevel: number = Brightness.idleDimLevel,
    idleDimDelay: number = Brightness.idleDimDelay, brightnessScale = 1) {
    this.idleDimLevel = idleDimLevel;
    this.idleDimDelay = idleDimDelay;
    this.brightnessScale = brightnessScale;
  }

  copy(): PowerCare { return new PowerCare(this.idleDimLevel, this.idleDimDelay, this.brightnessScale); }
  equals(o: PowerCare): boolean {
    return this.idleDimLevel === o.idleDimLevel && this.idleDimDelay === o.idleDimDelay && this.brightnessScale === o.brightnessScale;
  }

  /// Ranges clamped, non-finite values back to the defaults.
  validated(): PowerCare {
    const d = new PowerCare();
    return new PowerCare(
      Number.isFinite(this.idleDimLevel) ? Math.min(Math.max(this.idleDimLevel, 0.05), 1) : d.idleDimLevel,
      Number.isFinite(this.idleDimDelay) ? Math.min(Math.max(this.idleDimDelay, 1), 3600) : d.idleDimDelay,
      Number.isFinite(this.brightnessScale) ? Math.min(Math.max(this.brightnessScale, 0.3), 1) : 1,
    );
  }
}
