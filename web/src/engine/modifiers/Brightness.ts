// Port of FaceEngine/Modifiers/Brightness.swift: only the constants PowerCare (WP4) needs so far.
// TODO(WP7): rest of Brightness.swift — make this the Brightness modifier (name "Brightness", phase output), keep these
// two statics, and register it in modifiers/index.ts.

export class Brightness {
  /// OLED care: idle with nobody in view for `idleDimDelay` seconds lowers the target to at most `idleDimLevel`.
  static readonly idleDimDelay = 20;
  static readonly idleDimLevel = 0.6;
}
