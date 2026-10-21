// Port of FacePerception/CaptureClock.swift.
//
// port-note: the Swift converts CMTime stamps from the capture session's clock to the host clock. In the browser
// the host clock is `performance.now()` (the base of requestAnimationFrame and requestVideoFrameCallback times), so a
// capture stamp only needs its clock's offset from that base.

/// Capture timestamps → host-clock seconds (the display loop's time base), so a snapshot's age, a cue's `hostTime`
/// and the engine's clock all agree.
export const CaptureClock = {
  /// A capture stamp (seconds on its own clock) shifted by that clock's offset to the host clock. Null for an invalid
  /// (null or non-finite) stamp.
  hostSeconds(pts: number | null, clockOffsetSeconds = 0): number | null {
    if (pts === null || !Number.isFinite(pts)) return null;
    const s = pts + clockOffsetSeconds;
    return Number.isFinite(s) ? s : null;
  },

  /// Host-clock seconds now (same base as requestAnimationFrame and the display loop).
  nowSeconds: (): number => performance.now() / 1000,
} as const;
