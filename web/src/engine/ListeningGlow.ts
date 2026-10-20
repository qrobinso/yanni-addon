// Port of FaceEngine/ListeningGlow.swift: only ListeningGlowConfig so far (FaceState needs it).
// TODO(WP7): rest of ListeningGlow.swift (the ListeningGlow value type MoodColor steps).

/// The listening glow's settings (listening glow design §6): the owner's switch, Reduce Motion, and the resource
/// governor's motion budget. A class standing in for a Swift struct: `copy()` where the Swift copies.
export class ListeningGlowConfig {
  /// The owner's "Listening glow" switch. Off: the mic target is ignored and a glow already showing fades.
  enabled = true;
  /// Reduce Motion: a soft fade in place, no rise, undulation, drift or pulse.
  reduceMotion = false;
  /// The governor's motion budget, 0…1: 1 full undulation, 0.5 half (slower), 0 a static glow.
  motion = 1;

  copy(): ListeningGlowConfig { return Object.assign(new ListeningGlowConfig(), this); }
  equals(o: ListeningGlowConfig): boolean {
    return this.enabled === o.enabled && this.reduceMotion === o.reduceMotion && this.motion === o.motion;
  }

  validated(): ListeningGlowConfig {
    const c = this.copy();
    c.motion = Number.isFinite(this.motion) ? Math.min(Math.max(this.motion, 0), 1) : 1;
    return c;
  }
}
