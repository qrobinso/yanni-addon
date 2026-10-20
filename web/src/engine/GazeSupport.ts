// Port of FaceEngine/GazeSupport.swift. Helpers shared by Attention, GazeTracking and MicroMotion.
import type { V2 } from '../core/vec';
import { Ease } from './Easing';
import { Noise1D } from './Noise';
import { Spring2, type SpringParams } from './Spring';

/// Event-time helpers.
///
/// Scheduled gaze events are quantised onto a 1/60 s grid and fire on the first frame whose time reaches the grid point
/// (with a quarter-frame tolerance at 120 fps), so 60 and 120 fps fire each event on the same frame.
export const GazeClock = {
  gridRate: 60,
  tolerance: 1.0 / 240.0,

  /// Absolute event time `delay` seconds after `now`, rounded up onto the grid.
  at(now: number, delay: number): number {
    const raw = now + Math.max(delay, 0);
    return Math.ceil(raw * GazeClock.gridRate - 1e-6) / GazeClock.gridRate;
  },

  due: (now: number, eventTime: number): boolean => now >= eventTime - GazeClock.tolerance,
} as const;

export const gazeLength = (v: V2): number => Math.sqrt(v.x * v.x + v.y * v.y);

export function gazeClamp(v: V2, limit = 1): V2 {
  if (!(Number.isFinite(v.x) && Number.isFinite(v.y))) return { x: 0, y: 0 };
  return { x: Math.min(Math.max(v.x, -limit), limit), y: Math.min(Math.max(v.y, -limit), limit) };
}

/// Scales `v` back inside the axis-aligned ellipse with semi-axes `radii`.
export function gazeClampEllipse(v: V2, radii: V2): V2 {
  const qx = v.x / radii.x, qy = v.y / radii.y;
  const r2 = qx * qx + qy * qy;
  if (r2 > 1) { const r = Math.sqrt(r2); return { x: v.x / r, y: v.y / r }; }
  return { x: v.x, y: v.y };
}

/// A 2-D spring whose target can be switched at a precise time inside a frame (sub-frame exact),
/// so per-eye lag and head delay are measured in time, not frames.
export class GazeLaggedSpring {
  spring: Spring2;
  private _target: V2;
  private pending: V2 = { x: 0, y: 0 };
  private switchAt = 0;
  private _hasPending = false;

  constructor(value: V2) {
    this.spring = new Spring2(value);
    this._target = { ...value };
  }

  get target(): V2 { return this._target; }
  get hasPending(): boolean { return this._hasPending; }
  get value(): V2 { return this.spring.value; }
  get velocity(): V2 { return this.spring.velocity; }

  copy(): GazeLaggedSpring {
    const g = new GazeLaggedSpring(this.spring.value);
    g.spring = this.spring.copy();
    g._target = { ...this._target }; g.pending = { ...this.pending };
    g.switchAt = this.switchAt; g._hasPending = this._hasPending;
    return g;
  }

  /// Immediately replace the target (cancels a pending switch).
  set(t: V2): void {
    this._target = { ...t };
    this._hasPending = false;
  }

  /// Switch to `t` at absolute time `time` (applies from that instant on).
  retarget(t: V2, time: number): void {
    this.pending = { ...t };
    this.switchAt = time;
    this._hasPending = true;
  }

  /// Advance over the interval (now - dt, now].
  step(now: number, dt: number, p: SpringParams): void {
    if (this._hasPending && this.switchAt <= now) {
      const tPrev = now - dt;
      const d1 = Math.min(Math.max(this.switchAt - tPrev, 0), dt);
      if (d1 > 0) this.spring.step(this._target, p, d1);
      this._target = this.pending;
      this._hasPending = false;
      const d2 = dt - d1;
      if (d2 > 0) this.spring.step(this._target, p, d2);
    } else {
      this.spring.step(this._target, p, dt);
    }
  }
}

/// Smooth 1-D noise driven by a wrapped Double phase (works at any uptime).
///
/// The phase wraps every `period` lattice units; over the last `blend` units the sample cross-fades into the noise at
/// `phase - period`, so the signal stays continuous (C1) across the wrap.
export class GazeLoopNoise {
  static readonly period = 1024;
  static readonly blend = 8;

  readonly noise: Noise1D;
  /// Lattice units per second.
  readonly frequency: number;
  private _phase: number;

  constructor(seed: number, frequency: number, phase = 0) {
    this.noise = new Noise1D(seed);
    this.frequency = frequency;
    this._phase = phase % GazeLoopNoise.period;
  }

  get phase(): number { return this._phase; }

  copy(): GazeLoopNoise {
    const g = new GazeLoopNoise(0, this.frequency, 0);
    (g as { noise: Noise1D }).noise = this.noise;
    g._phase = this._phase;
    return g;
  }

  advance(dt: number): void {
    this._phase += Math.max(dt, 0) * this.frequency;
    if (this._phase >= GazeLoopNoise.period) this._phase = this._phase % GazeLoopNoise.period;
  }

  sample(): number {
    const v = this.noise.value(this._phase);
    const start = GazeLoopNoise.period - GazeLoopNoise.blend;
    if (!(this._phase > start)) return v;
    const w = Ease.smoothstep((this._phase - start) / GazeLoopNoise.blend);
    const v2 = this.noise.value(this._phase - GazeLoopNoise.period);
    return v + (v2 - v) * w;
  }
}
