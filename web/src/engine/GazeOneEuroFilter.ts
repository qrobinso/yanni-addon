// Port of FaceEngine/GazeOneEuroFilter.swift.
import type { V2 } from '../core/vec';
import { gazeLength } from './GazeSupport';

/// One-Euro filter (Casiez et al. 2012) for noisy perception targets in gaze space, plus a smoothed
/// velocity estimate for pursuit feed-forward.
///
/// Uses exact exponential smoothing factors (`1 − e^(−2π·fc·dt)`) so behaviour is close to frame-rate
/// independent. Between perception updates the input is simply held, which the filter turns into a smooth path.
export class GazeOneEuroFilter {
  /// Minimum cutoff (Hz): jitter suppression when still.
  minCutoff = 1.2;
  /// Speed coefficient: cutoff grows with speed to cut lag when moving.
  beta = 0.8;
  /// Cutoff for the derivative used by the adaptive cutoff (Hz).
  derivativeCutoff = 1.0;
  /// Cutoff for the published velocity (Hz).
  velocityCutoff = 2.5;

  private _value: V2 = { x: 0, y: 0 };
  private _velocity: V2 = { x: 0, y: 0 };
  private dx: V2 = { x: 0, y: 0 };
  private _initialized = false;

  get value(): V2 { return this._value; }
  get velocity(): V2 { return this._velocity; }
  get initialized(): boolean { return this._initialized; }

  copy(): GazeOneEuroFilter {
    const f = new GazeOneEuroFilter();
    f.minCutoff = this.minCutoff; f.beta = this.beta; f.derivativeCutoff = this.derivativeCutoff;
    f.velocityCutoff = this.velocityCutoff;
    f._value = { ...this._value }; f._velocity = { ...this._velocity }; f.dx = { ...this.dx };
    f._initialized = this._initialized;
    return f;
  }

  static alpha(cutoff: number, dt: number): number {
    return 1 - Math.exp(-2 * Math.PI * cutoff * dt);
  }

  reset(v: V2): void {
    this._value = { ...v };
    this._velocity = { x: 0, y: 0 };
    this.dx = { x: 0, y: 0 };
    this._initialized = true;
  }

  step(raw: V2, dt: number): V2 {
    if (!(Number.isFinite(raw.x) && Number.isFinite(raw.y))) return this._value;
    if (!this._initialized) { this.reset(raw); return this._value; }
    if (!(dt > 0)) return this._value;
    const value = this._value;
    const rdx = (raw.x - value.x) / dt, rdy = (raw.y - value.y) / dt;
    const ad = GazeOneEuroFilter.alpha(this.derivativeCutoff, dt);
    this.dx = { x: this.dx.x + (rdx - this.dx.x) * ad, y: this.dx.y + (rdy - this.dx.y) * ad };
    const cutoff = this.minCutoff + this.beta * gazeLength(this.dx);
    const a = GazeOneEuroFilter.alpha(cutoff, dt);
    const next = { x: value.x + (raw.x - value.x) * a, y: value.y + (raw.y - value.y) * a };
    const vx = (next.x - value.x) / dt, vy = (next.y - value.y) / dt;
    const av = GazeOneEuroFilter.alpha(this.velocityCutoff, dt);
    this._velocity = { x: this._velocity.x + (vx - this._velocity.x) * av, y: this._velocity.y + (vy - this._velocity.y) * av };
    this._value = next;
    return next;
  }
}
