// Port of FaceRendering/PupilGeometry.swift (ScleraShape, PupilSolver).
import { v2, type V2, type V4 } from '../core/vec';
import type { EyeUniforms } from './RenderUniforms';

/// The sclera (eye-local, y down): a convex rounded box with per-quadrant elliptical corners (the *base* shape),
/// optionally warped into an egg by `taper`: a base point (x', y) is drawn at (x' · s(y), y) with
/// s(y) = 1 + taper/2 · clamp(y/hy, −1, 1). Exact Euclidean distance to the (warped) boundary. CPU only.
export class ScleraShape {
  /// Largest egg taper the geometry accepts (keeps the warp gentle and the shape convex).
  static readonly maxTaper = 0.6;
  readonly half: V2;
  readonly top: V4;
  readonly bottom: V4;
  readonly taper: number;

  constructor(half: V2, top: V4, bottom: V4, taper = 0) {
    this.half = { ...half };
    this.top = { ...top };
    this.bottom = { ...bottom };
    this.taper = Number.isFinite(taper) ? Math.min(Math.max(taper, 0), ScleraShape.maxTaper) : 0;
  }

  /// The sclera of a computed eye (actual, post-closure frame).
  static of(e: EyeUniforms): ScleraShape {
    return new ScleraShape(v2(e.box.x, e.box.y), e.radiiTop, e.radiiBottom, e.accent.x);
  }

  equals(o: ScleraShape): boolean {
    const eq = (a: V4, b: V4) => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
    return this.half.x === o.half.x && this.half.y === o.half.y && eq(this.top, o.top) && eq(this.bottom, o.bottom) &&
      this.taper === o.taper;
  }

  /// The same shape with every y length multiplied by `k`.
  scaledY(k: number): ScleraShape {
    const t = this.top, b = this.bottom;
    return new ScleraShape(v2(this.half.x, this.half.y * k), { x: t.x, y: t.y * k, z: t.z, w: t.w * k },
      { x: b.x, y: b.y * k, z: b.z, w: b.w * k }, this.taper);
  }

  /// The same shape without the egg warp.
  get base(): ScleraShape { return new ScleraShape(this.half, this.top, this.bottom); }

  /// Egg warp x scale s(y).
  xScale(y: number): number { return 1 + 0.5 * this.taper * Math.min(Math.max(y / Math.max(this.half.y, 1e-6), -1), 1); }
  toBase(p: V2): V2 { return v2(p.x / this.xScale(p.y), p.y); }
  fromBase(p: V2): V2 { return v2(p.x * this.xScale(p.y), p.y); }

  /// Corner radii of the quadrant that contains `p`.
  radii(p: V2): V2 {
    const t = this.top, b = this.bottom;
    return p.y < 0 ? (p.x < 0 ? v2(t.x, t.y) : v2(t.z, t.w)) : (p.x < 0 ? v2(b.x, b.y) : v2(b.z, b.w));
  }

  /// True when `p` lies inside (or on) the shape.
  contains(p0: V2): boolean {
    const p = this.taper > 0 ? this.toBase(p0) : p0;
    const ax = Math.abs(p.x), ay = Math.abs(p.y);
    if (ax > this.half.x || ay > this.half.y) return false;
    const r = this.radii(p);
    const cx = this.half.x - r.x, cy = this.half.y - r.y;
    if (ax > cx && ay > cy) {
      const nx = (ax - cx) / r.x, ny = (ay - cy) / r.y;
      return nx * nx + ny * ny <= 1;
    }
    return true;
  }

  static quarterEllipseDistance2(q: V2, r: V2): number { return ScleraShape.quarterEllipseClosest(q, r).d2; }

  /// Closest point on the quarter ellipse `(r.x cos t, r.y sin t)`, t ∈ [0, π/2]: squared distance and t.
  static quarterEllipseClosest(q: V2, r: V2): { d2: number; t: number } {
    const hp = Math.PI / 2;
    let bestT = 0;
    const d2 = (t: number) => {
      const dx = r.x * Math.cos(t) - q.x, dy = r.y * Math.sin(t) - q.y;
      return dx * dx + dy * dy;
    };
    let best = Number.MAX_VALUE;
    const k = r.y * r.y - r.x * r.x;
    // Seeds: 0…3 special (normalised angle, straight across in x and in y, end point), then a uniform sweep.
    for (let i = 0; i < 10; i++) {
      let seed: number;
      switch (i) {
        case 0: seed = Math.atan2(Math.max(q.y, 0) * r.x, Math.max(q.x, 0) * r.y); break;
        case 1: seed = Math.acos(Math.min(Math.max(q.x / r.x, 0), 1)); break;
        case 2: seed = Math.asin(Math.min(Math.max(q.y / r.y, 0), 1)); break;
        default: seed = hp * (i - 3) / 6;
      }
      let t = Math.min(Math.max(seed, 0), hp);
      let d = d2(t);
      if (d < best) { best = d; bestT = t; }
      for (let n = 0; n < 5; n++) {
        const c = Math.cos(t), s = Math.sin(t);
        const g = k * s * c + q.x * r.x * s - q.y * r.y * c;
        const h = k * (c * c - s * s) + q.x * r.x * c + q.y * r.y * s;
        if (!(h > 1e-12)) break;
        t = Math.min(Math.max(t - g / h, 0), hp);
        d = d2(t);
        if (d < best) { best = d; bestT = t; }
      }
    }
    return { d2: best, t: bestT };
  }

  /// Exact Euclidean distance from `p` to the shape's boundary.
  boundaryDistance(p: V2): number {
    return this.taper > 0 ? this.warpedBoundaryDistance(p) : this.baseBoundaryDistance(p);
  }

  /// Exact distance to the egg-warped boundary: straight segments in closed form, each warped corner arc sampled at
  /// 13 parameters and refined by golden-section search.
  warpedBoundaryDistance(p: V2): number {
    const hx = this.half.x, hy = this.half.y, tp = this.taper;
    const px = p.x, py = p.y;
    const sc = (y: number) => 1 + 0.5 * tp * Math.min(Math.max(y / Math.max(hy, 1e-9), -1), 1);
    const seg = (x0: number, y0: number, x1: number, y1: number) => {
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(Math.max(((px - x0) * dx + (py - y0) * dy) / len2, 0), 1) : 0;
      const ex = x0 + t * dx - px, ey = y0 + t * dy - py;
      return ex * ex + ey * ey;
    };
    const ul = v2(this.top.x, this.top.y), ur = v2(this.top.z, this.top.w);
    const ll = v2(this.bottom.x, this.bottom.y), lr = v2(this.bottom.z, this.bottom.w);
    let best = Number.MAX_VALUE;
    const st = sc(-hy), sb = sc(hy);
    best = Math.min(best, seg((-hx + ul.x) * st, -hy, (hx - ur.x) * st, -hy));
    best = Math.min(best, seg((-hx + ll.x) * sb, hy, (hx - lr.x) * sb, hy));
    const yl0 = -hy + ul.y, yl1 = hy - ll.y, yr0 = -hy + ur.y, yr1 = hy - lr.y;
    best = Math.min(best, seg(-hx * sc(yl0), yl0, -hx * sc(yl1), yl1));
    best = Math.min(best, seg(hx * sc(yr0), yr0, hx * sc(yr1), yr1));
    const n = 12;
    const hp = Math.PI / 2;
    const g = 0.6180339887498949;
    for (let i = 0; i < 4; i++) {
      const r = i === 0 ? ul : i === 1 ? ur : i === 2 ? ll : lr;
      const sx = i % 2 === 0 ? -1 : 1, sy = i < 2 ? -1 : 1;
      const cx = (hx - r.x) * sx, cy = (hy - r.y) * sy;
      const d2 = (t: number) => {
        const y = cy + r.y * Math.sin(t) * sy;
        const x = (cx + r.x * Math.cos(t) * sx) * sc(y);
        return (x - px) * (x - px) + (y - py) * (y - py);
      };
      let bi = 0, bd = Number.MAX_VALUE;
      for (let k = 0; k <= n; k++) {
        const d = d2(hp * k / n);
        if (d < bd) { bd = d; bi = k; }
      }
      let lo = hp * Math.max(bi - 1, 0) / n, hi = hp * Math.min(bi + 1, n) / n;
      let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
      let f1 = d2(x1), f2 = d2(x2);
      for (let k = 0; k < 26; k++) {
        if (f1 < f2) {
          hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = d2(x1);
        } else {
          lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = d2(x2);
        }
      }
      best = Math.min(best, bd, f1, f2);
    }
    return Math.sqrt(best);
  }

  /// Exact distance to the base (unwarped) boundary.
  baseBoundaryDistance(p: V2): number {
    const hx = this.half.x, hy = this.half.y;
    const px = p.x, py = p.y;
    const ul = v2(this.top.x, this.top.y), ur = v2(this.top.z, this.top.w);
    const ll = v2(this.bottom.x, this.bottom.y), lr = v2(this.bottom.z, this.bottom.w);
    const seg = (x0: number, y0: number, x1: number, y1: number) => {
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(Math.max(((px - x0) * dx + (py - y0) * dy) / len2, 0), 1) : 0;
      const ex = x0 + t * dx - px, ey = y0 + t * dy - py;
      return ex * ex + ey * ey;
    };
    let best = Number.MAX_VALUE;
    best = Math.min(best, seg(-hx + ul.x, -hy, hx - ur.x, -hy)); // top
    best = Math.min(best, seg(-hx + ll.x, hy, hx - lr.x, hy)); // bottom
    best = Math.min(best, seg(-hx, -hy + ul.y, -hx, hy - ll.y)); // left
    best = Math.min(best, seg(hx, -hy + ur.y, hx, hy - lr.y)); // right
    // Corner arcs: mirror into the positive quadrant about each corner's centre.
    for (let i = 0; i < 4; i++) {
      const r = i === 0 ? ul : i === 1 ? ur : i === 2 ? ll : lr;
      const sgx = i % 2 === 0 ? -1 : 1, sgy = i < 2 ? -1 : 1;
      const cx = (hx - r.x) * sgx, cy = (hy - r.y) * sgy;
      best = Math.min(best, ScleraShape.quarterEllipseDistance2(v2((px - cx) * sgx, (py - cy) * sgy), r));
    }
    return Math.sqrt(best);
  }

  /// Signed exact distance: positive inside (depth), negative outside.
  depth(p: V2): number {
    const d = this.boundaryDistance(p);
    return this.contains(p) ? d : -d;
  }

  /// Top and bottom y of the shape along the column `x` (undefined when the column misses the shape).
  verticalExtent(x: number): { top: number; bottom: number } | undefined {
    if (this.taper > 0) return this.warpedVerticalExtent(x);
    if (!(Math.abs(x) <= this.half.x)) return undefined;
    const edge = (rx: number, ry: number) => {
      const cx = this.half.x - rx;
      const ax = Math.abs(x);
      if (ax <= cx) return this.half.y;
      const n = Math.min((ax - cx) / Math.max(rx, 1e-6), 1);
      return this.half.y - ry + ry * Math.sqrt(1 - n * n);
    };
    const t = x < 0 ? edge(this.top.x, this.top.y) : edge(this.top.z, this.top.w);
    const b = x < 0 ? edge(this.bottom.x, this.bottom.y) : edge(this.bottom.z, this.bottom.w);
    return { top: -t, bottom: b };
  }

  /// `verticalExtent` of the egg: finds an inside point by sampling, then bisects each end.
  warpedVerticalExtent(x: number): { top: number; bottom: number } | undefined {
    const hy = this.half.y;
    let inside: number | undefined;
    // Alternate below / above the middle (the egg's widest rows sit at or below it).
    for (let i = 0; i <= 64; i++) {
      // Swift integer division truncates toward zero.
      const y = hy * (i % 2 === 0 ? Math.trunc(i / 2) : -Math.trunc((i + 1) / 2)) / 32;
      if (Math.abs(y) <= hy && this.contains(v2(x, y))) { inside = y; break; }
    }
    if (inside === undefined) return undefined;
    const y0 = inside;
    const end = (out: number) => {
      if (this.contains(v2(x, out))) return out;
      let inn = y0, o = out;
      for (let k = 0; k < 24; k++) {
        const mid = 0.5 * (inn + o);
        if (this.contains(v2(x, mid))) inn = mid; else o = mid;
      }
      return 0.5 * (inn + o);
    };
    return { top: end(-hy), bottom: end(hy) };
  }

  /// Points evenly spread (by parameter) along the boundary, for tests.
  boundaryPoints(n: number): V2[] {
    return this.taper > 0 ? this.base.baseBoundaryPoints(n).map((p) => this.fromBase(p)) : this.baseBoundaryPoints(n);
  }

  baseBoundaryPoints(n: number): V2[] {
    const out: V2[] = [];
    const hx = this.half.x, hy = this.half.y;
    const ul = v2(this.top.x, this.top.y), ur = v2(this.top.z, this.top.w);
    const ll = v2(this.bottom.x, this.bottom.y), lr = v2(this.bottom.z, this.bottom.w);
    const line = (a: V2, b: V2) => {
      for (let i = 0; i <= n; i++) out.push(v2(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n));
    };
    line(v2(-hx + ul.x, -hy), v2(hx - ur.x, -hy));
    line(v2(-hx + ll.x, hy), v2(hx - lr.x, hy));
    line(v2(-hx, -hy + ul.y), v2(-hx, hy - ll.y));
    line(v2(hx, -hy + ur.y), v2(hx, hy - lr.y));
    for (const [r, s] of [[ul, v2(-1, -1)], [ur, v2(1, -1)], [ll, v2(-1, 1)], [lr, v2(1, 1)]] as const) {
      const cx = (hx - r.x) * s.x, cy = (hy - r.y) * s.y;
      for (let i = 0; i <= 4 * n; i++) {
        const t = Math.PI / 2 * i / (4 * n);
        out.push(v2(cx + r.x * Math.cos(t) * s.x, cy + r.y * Math.sin(t) * s.y));
      }
    }
    return out;
  }
}

/// Pupil containment (review C4/C5/M2): the pupil ellipse (radii a, b) lies inside the sclera with at least
/// `clearance` (outline + sclera margin) between its rim and the sclera boundary. See the Swift doc for the method.
export interface Placement {
  /// Pupil centre, eye-local units (unscaled space).
  center: V2;
  /// Pupil radii (a, b) after any shrink.
  radii: V2;
  /// Travel per axis: the centre offset at normalised ±1 along each axis.
  travel: V2;
  /// Required centre depth ρ in the y-scaled space, and the y scale k.
  rho: number;
  k: number;
}

export const PupilSolver = {
  /// Sclera margin between the pupil and the outline (M2): max(0.5, 0.12·a).
  margin: (a: number): number => Math.max(0.5, 0.12 * a),
  /// Bisection iterations for the exact boundary check.
  iterations: 18,

  /// Places a pupil of radii (a, b) at normalised position `v` (each axis −1…1) inside `shape`.
  place(shape: ScleraShape, v: V2, a0: number, b0: number, outline: number): Placement {
    let a = Math.max(a0, 1e-3);
    const k = Math.min(Math.max(a / Math.max(b0, 1e-4), 0.2), 5);
    const kk = Math.max(k, 1);
    const s = shape.scaledY(k);
    const w = Math.max(outline, 0);
    let rho = a + (w + PupilSolver.margin(a)) * kk;
    const d0 = s.boundaryDistance(v2(0));
    const eps = 1e-3;
    if (d0 < rho + eps) {
      // Solve a + (w + max(0.5, 0.12a))·kk = d0 − eps for a (k is fixed by the squash and aspect).
      const target = d0 - eps;
      let na = target - (w + 0.5) * kk;
      if (0.12 * na > 0.5) na = (target - w * kk) / (1 + 0.12 * kk);
      a = Math.max(Math.min(na, a), 0.05);
      rho = a + (w + PupilSolver.margin(a)) * kk;
    }
    const ex = Math.max(s.half.x - rho, 0), ey = Math.max(s.half.y - rho, 0);
    const vx = Math.min(Math.max(Number.isFinite(v.x) ? v.x : 0, -1), 1);
    const vy = Math.min(Math.max(Number.isFinite(v.y) ? v.y : 0, -1), 1);
    let c0 = v2(vx * ex, vy * ey);
    // Corner pull-back onto the eroded corner ellipse (a projection onto a convex set: Lipschitz).
    const r = s.radii(c0);
    const rex = Math.max(r.x - rho, 1e-3), rey = Math.max(r.y - rho, 1e-3);
    const ccx = Math.max(ex - rex, 0), ccy = Math.max(ey - rey, 0);
    const acx = Math.abs(c0.x), acy = Math.abs(c0.y);
    if (acx > ccx && acy > ccy) {
      const nx = (acx - ccx) / rex, ny = (acy - ccy) / rey;
      if (nx * nx + ny * ny > 1) {
        const t = ScleraShape.quarterEllipseClosest(v2(acx - ccx, acy - ccy), v2(rex, rey)).t;
        const px = ccx + rex * Math.cos(t), py = ccy + rey * Math.sin(t);
        c0 = v2(c0.x < 0 ? -px : px, c0.y < 0 ? -py : py);
      }
    }
    // Egg: carry the base-space position through the warp, so travel follows the egg's outline.
    if (s.taper > 0) c0 = s.fromBase(c0);
    const c = PupilSolver.pullInside(s, c0, rho);
    return { center: v2(c.x, c.y / k), radii: v2(a, a / k), travel: v2(ex, ey / k), rho, k };
  },

  /// Largest λ ∈ [0, 1] with depth(λ·c) ≥ ρ in the (already y-scaled) shape `s`, times c.
  pullInside(s: ScleraShape, c: V2, rho: number): V2 {
    if (s.depth(c) >= rho) return c;
    let lo = 0, hi = 1;
    for (let i = 0; i < PupilSolver.iterations; i++) {
      const mid = 0.5 * (lo + hi);
      if (s.depth(v2(c.x * mid, c.y * mid)) >= rho) lo = mid; else hi = mid;
    }
    return v2(c.x * lo, c.y * lo);
  },

  /// Moves an already placed pupil toward the eye centre just enough that its rim clears `clearance`; shrinks it
  /// proportionally if even the centre is too shallow.
  keepInside(shape: ScleraShape, c: V2, radii: V2, clearance: number): { center: V2; radii: V2 } {
    let a = Math.max(radii.x, 1e-3);
    const k = Math.min(Math.max(a / Math.max(radii.y, 1e-4), 0.2), 5);
    const kk = Math.max(k, 1);
    const s = shape.scaledY(k);
    const w = Math.max(clearance, 0);
    let rho = a + w * kk;
    const d0 = s.boundaryDistance(v2(0));
    if (d0 < rho + 1e-3) {
      a = Math.max(Math.min(d0 - 1e-3 - w * kk, a), 0.02);
      rho = a + w * kk;
    }
    const cs = PupilSolver.pullInside(s, v2(c.x, c.y * k), rho);
    return { center: v2(cs.x, cs.y / k), radii: v2(a, a / k) };
  },
} as const;
