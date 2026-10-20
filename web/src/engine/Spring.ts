// Port of FaceEngine/Spring.swift.
import type { V2 } from '../core/vec';
import { FacePose } from '../model';

export interface SpringCoefficients { a: number; b: number; c: number; d: number }

/// Exact closed-form step of a damped harmonic oscillator toward a target.
///
/// Works for any `dt`, so motion is identical at 60 and 120 fps. `omega` is angular frequency
/// (rad/s; higher = faster), `zeta` the damping ratio (<1 overshoots, 1 critical, >1 sluggish).
export class SpringParams {
  constructor(public omega: number, public zeta: number) {}

  copy(): SpringParams { return new SpringParams(this.omega, this.zeta); }
  equals(o: SpringParams): boolean { return this.omega === o.omega && this.zeta === o.zeta; }

  /// Coefficients so that x' = x*a + v*b + target*(1-a), v' = x*c + v*d - target*c.
  coefficients(dt: number): SpringCoefficients {
    return springCoefficients(this.omega, this.zeta, dt);
  }
}

export function springCoefficients(omega: number, zeta: number, dt: number): SpringCoefficients {
  const w = Math.max(omega, 1e-4), z = Math.max(zeta, 0), t = Math.max(dt, 0);
  if (t === 0) return { a: 1, b: 0, c: 0, d: 1 };
  if (z < 0.9999) {
    // Underdamped.
    const wd = w * Math.sqrt(1 - z * z);
    const e = Math.exp(-z * w * t);
    const cs = Math.cos(wd * t), sn = Math.sin(wd * t);
    return {
      a: e * (cs + (z * w / wd) * sn),
      b: e * (sn / wd),
      c: -e * (w * w / wd) * sn,
      d: e * (cs - (z * w / wd) * sn),
    };
  } else if (z <= 1.0001) {
    // Critically damped.
    const e = Math.exp(-w * t);
    return { a: e * (1 + w * t), b: e * t, c: -e * w * w * t, d: e * (1 - w * t) };
  } else {
    // Overdamped.
    const s = w * Math.sqrt(z * z - 1);
    const r1 = -z * w + s, r2 = -z * w - s;
    const e1 = Math.exp(r1 * t), e2 = Math.exp(r2 * t);
    const inv = 1 / (r1 - r2);
    return {
      a: (r1 * e2 - r2 * e1) * inv,
      b: (e1 - e2) * inv,
      c: r1 * r2 * (e2 - e1) * inv,
      d: (r1 * e1 - r2 * e2) * inv,
    };
  }
}

export class Spring1 {
  velocity = 0;
  constructor(public value: number) {}

  copy(): Spring1 { const s = new Spring1(this.value); s.velocity = this.velocity; return s; }

  step(target: number, p: SpringParams, dt: number): void {
    const { a, b, c, d } = p.coefficients(dt);
    const x = this.value - target;
    this.value = target + x * a + this.velocity * b;
    this.velocity = x * c + this.velocity * d;
  }
}

export class Spring2 {
  value: V2;
  velocity: V2 = { x: 0, y: 0 };
  constructor(value: V2) { this.value = { ...value }; }

  copy(): Spring2 { const s = new Spring2(this.value); s.velocity = { ...this.velocity }; return s; }

  step(target: V2, p: SpringParams, dt: number): void {
    const { a, b, c, d } = p.coefficients(dt);
    const xx = this.value.x - target.x, xy = this.value.y - target.y;
    const vx = this.velocity.x, vy = this.velocity.y;
    this.value = { x: target.x + xx * a + vx * b, y: target.y + xy * a + vy * b };
    this.velocity = { x: xx * c + vx * d, y: xy * c + vy * d };
  }
}

/// Spring over a whole pose (all 51 params at once, one shared omega/zeta).
export class PoseSpring {
  value: FacePose;
  velocity: FacePose = FacePose.zero;
  constructor(value: FacePose) { this.value = value.copy(); }

  copy(): PoseSpring { const s = new PoseSpring(this.value); s.velocity = this.velocity.copy(); return s; }

  step(target: FacePose, p: SpringParams, dt: number): void {
    const { a, b, c, d } = p.coefficients(dt);
    const v = this.value.raw, vel = this.velocity.raw, t = target.raw;
    for (let i = 0; i < v.length; i++) {
      const x = v[i] - t[i];
      v[i] = t[i] + x * a + vel[i] * b;
      vel[i] = x * c + vel[i] * d;
    }
  }
}
