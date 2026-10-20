// Port of FaceEngine/Modifiers/VocalSync.swift: only HostClockEstimator so far (OneShotSampler needs it).
// TODO(WP7): rest of VocalSync.swift — VocalSyncReadout and the VocalSync modifier (name "VocalSync", phase motion);
// register it in modifiers/index.ts.

/// Tracks the presentation host clock across frames: the engine's effective time scale (engine dt per host second) and
/// the display's frame period. A frame whose dt hit the engine's clamp (a hiccup) keeps the previous time-scale
/// estimate, so a long frame never reads as slow motion. Allocation-free.
export class HostClockEstimator {
  /// Same value as `FaceEngine.maxDt`.
  static readonly maxDt = 0.05;
  /// Engine seconds per host second (FaceEngine.timeScale), 0.01…1. 1 until measured.
  private _timeScale = 1;
  /// Last unclamped host frame period (seconds).
  private _framePeriod = 1.0 / 60.0;
  private lastHost: number | null = null;

  get timeScale(): number { return this._timeScale; }
  get framePeriod(): number { return this._framePeriod; }

  update(hostTime: number | null, dt: number): void {
    if (hostTime === null || !Number.isFinite(hostTime)) { this.lastHost = null; return; }
    const h = hostTime;
    if (this.lastHost !== null) {
      const hd = h - this.lastHost;
      if (hd > 1e-5 && dt > 0 && dt < HostClockEstimator.maxDt * 0.999) {
        this._timeScale = Math.min(Math.max(dt / hd, 0.01), 1);
        if (hd < HostClockEstimator.maxDt) this._framePeriod = hd;
      }
    }
    this.lastHost = h;
  }
}
