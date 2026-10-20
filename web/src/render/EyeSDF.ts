// Port of FaceRendering/EyeSDF.swift.
import { v2, v3, v4, type V2, type V3, type V4 } from '../core/vec';
import { pupilShapeHasMoodAccent, pupilShapeMorphs, PupilShape } from '../model/PupilShape';
import { EyeGeometry } from './EyeGeometry';
import { PupilGlyph } from './PupilGlyphs';
import type { BrowUniforms, EyeUniforms, FrameUniforms } from './RenderUniforms';

/// CPU reference of the eye shader (`EyeShader.wgsl`). Same maths, line for line, so tests can check geometry
/// without a GPU. Not used in the draw path (apart from `egg`, `lidField` and `smax` in the geometry).
/// Sign convention: SDF values are negative inside. Lid SDFs are negative inside the *lid* region.

const saturate = (x: number): number => Math.min(Math.max(x, 0), 1);
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mix3 = (a: V3, b: V3, t: number): V3 => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
const rgb = (c: V4): V3 => v3(c.x, c.y, c.z);

/// Gradient-normalised ellipse distance (M2).
function ellipse(q: V2, r: V2): number {
  const ax = q.x / r.x, ay = q.y / r.y;
  const k0 = Math.sqrt(ax * ax + ay * ay);
  const bx = q.x / (r.x * r.x), by = q.y / (r.y * r.y);
  const k1 = Math.sqrt(bx * bx + by * by);
  const rLocal = k0 / Math.max(k1, 1e-9);
  const rMin = Math.min(r.x, r.y);
  const radius = k0 < 1 ? rMin + (rLocal - rMin) * k0 : rLocal;
  return (k0 - 1) * radius;
}

/// Exact signed distance to an ellipse for `q ≥ 0`, with the closest point's parameter t.
function ellipseExactT(q: V2, r: V2): { d: number; t: number } {
  const hp = Math.PI / 2;
  const d2 = (t: number) => {
    const dx = r.x * Math.cos(t) - q.x, dy = r.y * Math.sin(t) - q.y;
    return dx * dx + dy * dy;
  };
  let t = Math.atan2(q.y * r.x, q.x * r.y);
  let best = d2(t);
  const tx = Math.acos(Math.min(q.x / r.x, 1));
  const dx = d2(tx);
  if (dx < best) { best = dx; t = tx; }
  const ty = Math.asin(Math.min(q.y / r.y, 1));
  const dy = d2(ty);
  if (dy < best) { best = dy; t = ty; }
  const k = r.y * r.y - r.x * r.x;
  // Where the distance isn't convex in t, Newton would stall on the tip's local maximum; step downhill instead.
  let bestT = t;
  for (let i = 0; i < 4; i++) {
    const c = Math.cos(t), s = Math.sin(t);
    const g = k * s * c + q.x * r.x * s - q.y * r.y * c;
    const h = k * (c * c - s * s) + q.x * r.x * c + q.y * r.y * s;
    const dt = h > 1e-6 ? g / h : (g > 0 ? 0.3 : -0.3);
    t = Math.min(Math.max(t - dt, 0), hp);
    const dt2 = d2(t);
    if (dt2 < best) { best = dt2; bestT = t; }
  }
  const d = Math.sqrt(best);
  const nx = q.x / r.x, ny = q.y / r.y;
  return { d: nx * nx + ny * ny < 1 ? -d : d, t: bestT };
}

const ellipseExact = (q: V2, r: V2): number => ellipseExactT(q, r).d;

const quadrant = (p: V2, top: V4, bottom: V4): V2 =>
  p.y < 0 ? (p.x < 0 ? v2(top.x, top.y) : v2(top.z, top.w)) : (p.x < 0 ? v2(bottom.x, bottom.y) : v2(bottom.z, bottom.w));

/// Rounded box with per-quadrant elliptical corners.
function shape(p: V2, b: V2, top: V4, bottom: V4): number {
  const r = quadrant(p, top, bottom);
  const ax = Math.abs(p.x), ay = Math.abs(p.y);
  const cx = b.x - r.x, cy = b.y - r.y;
  if (ax > cx && ay > cy) return ellipseExact(v2(ax - cx, ay - cy), r);
  return Math.max(ax - b.x, ay - b.y);
}

/// `shape`, also returning the outward unit normal of the closest boundary point (written into `n`).
function shapeNormal(p: V2, b: V2, top: V4, bottom: V4, n: V2): number {
  const r = quadrant(p, top, bottom);
  const sgx = p.x < 0 ? -1 : 1, sgy = p.y < 0 ? -1 : 1;
  const ax = Math.abs(p.x), ay = Math.abs(p.y);
  const cx = b.x - r.x, cy = b.y - r.y;
  if (ax > cx && ay > cy) {
    const e = ellipseExactT(v2(ax - cx, ay - cy), r);
    const gx = Math.cos(e.t) / r.x, gy = Math.sin(e.t) / r.y;
    const gl = Math.max(Math.sqrt(gx * gx + gy * gy), 1e-9);
    n.x = gx / gl * sgx; n.y = gy / gl * sgy;
    return e.d;
  }
  const wx = ax - b.x, wy = ay - b.y;
  if (wx > wy) { n.x = sgx; n.y = 0; } else { n.x = 0; n.y = sgy; }
  return Math.max(wx, wy);
}

/// Egg warp x scale s(y) and its y derivative.
function eggScale(y: number, hy: number, taper: number, dir: number): V2 {
  const u = y / Math.max(hy, 1e-6);
  if (Math.abs(u) >= 1) return v2(1 + 0.5 * taper * dir * (u < 0 ? -1 : 1), 0);
  return v2(1 + 0.5 * taper * dir * u, 0.5 * taper * dir / Math.max(hy, 1e-6));
}

/// The sclera shape warped into an egg, first-order Euclidean. Exactly `shape` when `taper` is 0.
function egg(p: V2, b: V2, top: V4, bottom: V4, taper: number, dir = 1): number {
  if (taper <= 0) return shape(p, b, top, bottom);
  const sc = eggScale(p.y, b.y, taper, dir);
  const n = v2(0, 0);
  const d = shapeNormal(v2(p.x / sc.x, p.y), b, top, bottom, n);
  const gx = n.x / sc.x, gy = n.y - n.x * p.x * sc.y / (sc.x * sc.x);
  return d / Math.max(Math.sqrt(gx * gx + gy * gy), 0.25);
}

/// Nearest point of the rounded box for a point outside it (approximate for elliptical corners).
function boxPoint(p: V2, b: V2, top: V4, bottom: V4): V2 {
  const r = quadrant(p, top, bottom);
  const cx = b.x - r.x, cy = b.y - r.y;
  const ccx = Math.min(Math.max(p.x, -cx), cx), ccy = Math.min(Math.max(p.y, -cy), cy);
  const nx = (p.x - ccx) / r.x, ny = (p.y - ccy) / r.y;
  const l = Math.sqrt(nx * nx + ny * ny);
  return l > 1e-6 ? v2(ccx + r.x * (nx / l), ccy + r.y * (ny / l)) : p;
}

/// Nearest boundary point of the egg for a point outside it.
function eggBoxPoint(p: V2, b: V2, top: V4, bottom: V4, taper: number): V2 {
  if (taper <= 0) return boxPoint(p, b, top, bottom);
  const q = boxPoint(v2(p.x / eggScale(p.y, b.y, taper, 1).x, p.y), b, top, bottom);
  return v2(q.x * eggScale(q.y, b.y, taper, 1).x, q.y);
}

/// Distance from `p` (relative to the bend ellipse centre) to the arc `(a cos ψ, b sin ψ)`, ψ ∈ [psi.x, psi.y].
function arcDistance(p: V2, ab: V2, psi: V2): number {
  const a = ab.x, b = ab.y;
  const dist2 = (t: number) => {
    const qx = a * Math.cos(t) - p.x, qy = b * Math.sin(t) - p.y;
    return qx * qx + qy * qy;
  };
  let t = psi.x;
  let best = dist2(t);
  for (let i = 1; i <= 5; i++) {
    const ti = psi.x + (psi.y - psi.x) * i * 0.2;
    const di = dist2(ti);
    if (di < best) { best = di; t = ti; }
  }
  // The arc point straight above/below p: near-optimal for flat arcs.
  const tx = Math.min(Math.max(Math.acos(Math.min(Math.max(p.x / a, -1), 1)), psi.x), psi.y);
  const dx = dist2(tx);
  if (dx < best) { best = dx; t = tx; }
  const k = b * b - a * a;
  const halfStep = (psi.y - psi.x) * 0.1;
  for (let i = 0; i < 3; i++) {
    const c = Math.cos(t), s = Math.sin(t);
    const g = k * s * c + p.x * a * s - p.y * b * c;
    const h = k * (c * c - s * s) + p.x * a * c + p.y * b * s;
    const dt = h > 1e-6 ? g / h : (g > 0 ? halfStep : -halfStep);
    t = Math.min(Math.max(t - dt, psi.x), psi.y);
    best = Math.min(best, dist2(t));
  }
  return Math.sqrt(best);
}

/// Lid region SDF (negative inside the lid): half-plane `q.y < L` ∪ ellipse at (0, L) in the lid frame.
function lid(p: V2, l: V4, bend: V4, clip: V4): number {
  const qx = p.x, qy = p.y - l.x;
  const c = l.y, s = l.z;
  const rx = qx * c - qy * s, ry = qx * s + qy * c;
  const y = ry - l.w;
  if (bend.y <= 1e-3) return y;
  const ab = v2(bend.x, bend.y);
  const e = ellipse(v2(rx, y), ab);
  if (y >= 0 && e >= 0) return Math.min(y, e); // outside the lid
  const pl = v2(rx, y);
  let depth = arcDistance(pl, ab, v2(bend.z, bend.w));
  if (clip.y > clip.x) {
    const dx = pl.x - Math.min(Math.max(pl.x, clip.x), clip.y);
    depth = Math.min(depth, Math.sqrt(dx * dx + y * y));
  }
  if (clip.w > clip.z) {
    const dx = pl.x - Math.min(Math.max(pl.x, -clip.w), -clip.z);
    depth = Math.min(depth, Math.sqrt(dx * dx + y * y));
  }
  return -depth;
}

/// Offset-shape lid (negative inside the lid), in the lid frame.
function shapeLid(p: V2, l: V4, b: V2, r: V4, taper = 0, dir = 1): number {
  const q0x = p.x, q0y = p.y - l.x;
  const c = l.y, s = l.z;
  const rrx = q0x * c - q0y * s, rry = q0x * s + q0y * c;
  const q = v2(rrx, rry - l.w - b.y);
  // The egg warp is 1 at mid-height, so the flared sides still join the warped half continuously.
  const d = q.y < 0 ? egg(q, b, r, r, taper, dir) : Math.abs(q.x) - b.x - q.y;
  return -d;
}

/// The lid field the renderer uses (negative inside the lid), and the straight lid's own field.
function lidFieldS(p: V2, e: EyeUniforms, upper: boolean): { field: number; straight: number } {
  const w = upper ? e.lidBlend.x : e.lidBlend.y;
  const l = upper ? e.upperLid : e.lowerLid;
  const straight = upper ? lid(p, e.upperLid, e.upperBend, e.upperClip) : lid(p, e.lowerLid, e.lowerBend, e.lowerClip);
  if (w >= 1) return { field: straight, straight };
  const rb = e.radiiBottom;
  const r0 = upper ? e.radiiTop : v4(rb.z, rb.w, rb.x, rb.y);
  const k = 1 - w;
  const r = v4(Math.max(r0.x * k, 1e-3), Math.max(r0.y * k, 1e-3), Math.max(r0.z * k, 1e-3), Math.max(r0.w * k, 1e-3));
  const sh = shapeLid(p, l, v2(e.box.x, e.box.y), r, e.accent.x, upper ? 1 : -1);
  const t = upper ? e.lidBlend.z : e.lidBlend.w;
  return { field: t > 0 ? sh + (straight - sh) * t : sh, straight };
}

const lidField = (p: V2, e: EyeUniforms, upper: boolean): number => lidFieldS(p, e, upper).field;

/// Polynomial smooth maximum.
function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}
const smaxK = (a: number, b: number, k: number): number => (k > 1e-3 ? smax(a, b, k) : Math.max(a, b));

/// Eye-local point (canvas units) for a pixel position.
function local(e: EyeUniforms, f: FrameUniforms, pixel: V2): V2 {
  const dx = pixel.x - e.placement.x, dy = pixel.y - e.placement.y;
  const c = e.placement.z, s = e.placement.w;
  return v2((dx * c - dy * s) * f.viewport.w, (dx * s + dy * c) * f.viewport.w);
}

/// Geometry at one eye-local point.
export interface Visible {
  /// Visible-shape SDF with sharp (exact `max`) junctions (canvas units).
  dVis: number;
  dShape: number;
  /// `max` of both lids' "openness" SDFs (negative where no lid covers the point).
  dOpen: number;
  boxPoint: V2;
  /// Direction pointing deeper into the dominant lid.
  lidDir: V2;
  openUpper: number;
  openLower: number;
  /// The straight upper lid's openness (what the soft lid shadow follows).
  shadeUpper: number;
}

/// Lids are evaluated at the nearest point of the eye box (the point itself inside).
function visible(e: EyeUniforms, p: V2): Visible {
  const half = v2(e.box.x, e.box.y);
  const dShape = egg(p, half, e.radiiTop, e.radiiBottom, e.accent.x);
  const b = dShape > 0 ? eggBoxPoint(p, half, e.radiiTop, e.radiiBottom, e.accent.x) : p;
  const u = lidFieldS(b, e, true), l = lidFieldS(b, e, false);
  const oU = -(u.field + e.box.z);
  const oL = -(l.field + e.box.z);
  const dOpen = Math.max(oU, oL);
  const dir = oU >= oL ? v2(-e.upperLid.z, -e.upperLid.y) : v2(-e.lowerLid.z, -e.lowerLid.y);
  return { dVis: Math.max(dShape, dOpen), dShape, dOpen, boxPoint: b, lidDir: dir, openUpper: oU, openLower: oL,
    shadeUpper: -(u.straight + e.box.z) };
}

/// The visible-sclera SDF the renderer draws: per-lid smooth-max junctions.
const visibleDistance = (e: EyeUniforms, v: Visible): number =>
  Math.max(smaxK(v.dShape, v.openUpper, e.outline.y), smaxK(v.dShape, v.openLower, e.outline.z));

export interface Sample {
  dVisible: number;
  coverage: number;
  color: V3;
  pupil: number;
  notch: number;
  crescent: number;
  accent: number;
  pupilDistance: number;
}

/// The pupil's signed distance field at one eye-local offset `q` from the pupil centre. Mirrors `pupilField`.
export class PupilField {
  d: number;
  dIn: number;
  prs: V2;
  rIn: V2;
  shape: PupilShape;
  morph: number;
  k: V2;
  kmin: number;
  glyph: boolean;

  constructor(e: EyeUniforms, q: V2) {
    const pr = v2(e.pupil.z, e.pupil.w);
    const ssx = e.shape.z, ssy = e.shape.w;
    this.shape = e.pupilShape;
    this.morph = e.shape.y;
    const plain = this.morph <= 0 && ssx >= 1 && ssy >= 1;
    this.prs = plain ? pr : v2(Math.max(pr.x * ssx, 1e-3), Math.max(pr.y * ssy, 1e-3));
    this.rIn = v2(Math.max(this.prs.x - e.accent.y, 1e-3), Math.max(this.prs.y - e.accent.y, 1e-3));
    this.glyph = this.shape !== PupilShape.ellipse && this.morph > 0;
    const cy = Math.max(e.accent.z, 1e-3);
    const u = Math.min(pr.x, pr.y / cy / PupilGlyph.aspect);
    this.k = v2(Math.max(u * ssx, 1e-4), Math.max(u * cy * ssy, 1e-4));
    this.kmin = Math.min(this.k.x, this.k.y);
    const dE = ellipse(q, this.prs), dEIn = ellipse(q, this.rIn);
    this.d = dE;
    this.dIn = dEIn;
    if (this.glyph) {
      const g = PupilGlyph.distance(this.shape, v2(q.x / this.k.x, q.y / this.k.y)) * this.kmin;
      if (pupilShapeMorphs(this.shape)) {
        this.d = dE + (g - dE) * this.morph;
        this.dIn = dEIn + (g + e.accent.y - dEIn) * this.morph;
      } else {
        this.d = g;
        this.dIn = g + e.accent.y;
      }
    }
  }

  /// The (morphed) pupil field at another offset.
  field(q: V2): number {
    const dE = ellipse(q, this.prs);
    if (!this.glyph) return dE;
    const g = PupilGlyph.distance(this.shape, v2(q.x / this.k.x, q.y / this.k.y)) * this.kmin;
    return pupilShapeMorphs(this.shape) ? dE + (g - dE) * this.morph : g;
  }

  /// The (morphed) ink-inset field at another offset (the mood accent's shifted copy).
  fieldIn(q: V2, ink: number): number {
    const dE = ellipse(q, this.rIn);
    if (!this.glyph) return dE;
    const g = PupilGlyph.distance(this.shape, v2(q.x / this.k.x, q.y / this.k.y)) * this.kmin + ink;
    return pupilShapeMorphs(this.shape) ? dE + (g - dE) * this.morph : g;
  }
}

/// Oklab → linear sRGB (inlined for the mirror).
function oklabToLinear(lab: V3): V3 {
  const l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  const m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  const s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return v3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

/// One eye at one pixel: rim → ink → flat fill; the pupil with its ink edge, crescent and notch.
function sample(e: EyeUniforms, f: FrameUniforms, pixel: V2): Sample {
  const empty = (d: number): Sample => ({ dVisible: d, coverage: 0, color: v3(0), pupil: 0, notch: 0, crescent: 0,
    accent: 0, pupilDistance: Infinity });
  const ddx = pixel.x - e.placement.x, ddy = pixel.y - e.placement.y;
  if (ddx * ddx + ddy * ddy > e.box.w * e.box.w) return empty(Infinity);
  const p = local(e, f, pixel);
  const v = visible(e, p);
  const dVis = visibleDistance(e, v);
  const ppu = f.viewport.z;
  const cov = saturate(0.5 - dVis * ppu);
  if (cov <= 0) return empty(dVis);
  const rimW = e.outline.w, band = e.outline.w + e.outline.x;
  const inInk = saturate(0.5 - (dVis + rimW) * ppu);
  const inner = saturate(0.5 - (dVis + band) * ppu);

  // Sclera fill: flat by default; optional gradient and a shadow under the (straight) upper lid line.
  const t = saturate(0.5 + p.y / (2 * e.box.y));
  const shadow = f.shading.y * (1 - smoothstep(0, f.shading.z, -v.shadeUpper - band));
  const sk = (1 - f.shading.x * t) * (1 - shadow);
  const sclera = v3(f.sclera.x * sk, f.sclera.y * sk, f.sclera.z * sk);
  let col = mix3(rgb(f.rim), rgb(f.ink), inInk);
  col = mix3(col, sclera, inner);

  // Pupil.
  const q = v2(p.x - e.pupil.x, p.y - e.pupil.y);
  const pr = v2(e.pupil.z, e.pupil.w);
  // Visibility erodes the pupil (flat colours, no translucent grey) until it is gone.
  const erode = (1 - e.accent.w) * (Math.max(pr.x, pr.y) + 1);
  const f2 = new PupilField(e, q);
  const pm = saturate(0.5 - (f2.d + erode) * ppu) * inner;
  let notchCov = 0, crescentCov = 0, accentCov = 0;
  if (pm > 0) {
    const morph = f2.morph;
    const qnx = q.x / f2.prs.x, qny = q.y / f2.prs.y;
    const rho = Math.sqrt(qnx * qnx + qny * qny);
    const ring = smoothstep(0.45, 0.8, rho) * (1 - smoothstep(0.9, 1, rho)) * (1 - morph);
    const lab = mix3(rgb(f.pupilLab), rgb(f.irisLab), f.misc.z * ring);
    const lin = oklabToLinear(lab);
    let pc = v3(Math.max(lin.x, 0) * f.pupilLab.w, Math.max(lin.y, 0) * f.pupilLab.w, Math.max(lin.z, 0) * f.pupilLab.w);
    // Ink edge: the pupil fill, crescent and notch live inside the ink-inset field.
    const rIn = f2.rIn;
    const dIn = f2.dIn;
    pc = mix3(rgb(f.ink), pc, saturate(0.5 - dIn * ppu));
    const crescent = rgb(f.crescent);
    if (f.misc.w > 0) {
      const disc = f.crescentDisc;
      const cl = Math.sqrt(disc.x * disc.x + disc.y * disc.y);
      const dirC = cl > 1e-5 ? v2(-disc.x / cl, -disc.y / cl) : v2(0, 0);
      // Retraction: the cut-out disc slides toward the crescent until it covers it (width → 0).
      const w = cl - (disc.z - 1);
      const dc2x = disc.x + dirC.x * ((w + 0.03) * morph), dc2y = disc.y + dirC.y * ((w + 0.03) * morph);
      const dD = ellipse(v2(q.x - dc2x * rIn.x, q.y - dc2y * rIn.y), v2(rIn.x * disc.z, rIn.y * disc.z));
      const cm = saturate(0.5 - Math.max(dIn, -dD) * ppu) * f.misc.w;
      pc = mix3(pc, crescent, cm);
      crescentCov = cm;
      if (f2.glyph && pupilShapeHasMoodAccent(f2.shape) && f.misc.x > 0.5) {
        // Mood accent: the part of the shape outside a copy of itself shifted away from the crescent side.
        const off = PupilGlyph.accentOffset * f2.kmin * morph;
        const dO = f2.fieldIn(v2(q.x + dirC.x * off, q.y + dirC.y * off), e.accent.y) -
          PupilGlyph.accentTrim * f2.kmin * morph;
        const am = saturate(0.5 - Math.max(dIn, -dO) * ppu) * f.misc.w;
        pc = mix3(pc, crescent, am);
        accentCov = am;
      }
    }
    if (f.misc.y > 0.5) {
      const qix = q.x / rIn.x, qiy = q.y / rIn.y;
      const n1 = f.notchLine1, n2 = f.notchLine2;
      const g1x = n1.x / rIn.x, g1y = n1.y / rIn.y, g2x = n2.x / rIn.x, g2y = n2.y / rIn.y;
      const c1 = n1.z + morph * n1.w, c2 = n2.z + morph * n2.w;
      const d1 = (n1.x * qix + n1.y * qiy - c1) / Math.max(Math.sqrt(g1x * g1x + g1y * g1y), 1e-6);
      const d2 = (n2.x * qix + n2.y * qiy - c2) / Math.max(Math.sqrt(g2x * g2x + g2y * g2y), 1e-6);
      const nm = saturate(0.5 - Math.max(dIn, Math.max(d1, d2)) * ppu);
      pc = mix3(pc, rgb(f.notch), nm);
      notchCov = nm;
      crescentCov *= 1 - nm;
      accentCov *= 1 - nm;
    }
    col = mix3(col, pc, pm);
  }
  return { dVisible: dVis, coverage: cov, color: col, pupil: pm, notch: notchCov * pm, crescent: crescentCov * pm,
    accent: accentCov * pm, pupilDistance: f2.d };
}

/// Background at a pixel: the final background colour times the vignette.
function background(f: FrameUniforms, pixel: V2): V3 {
  const hx = f.viewport.x * 0.5, hy = f.viewport.y * 0.5;
  const dx = pixel.x - hx, dy = pixel.y - hy;
  const r = Math.sqrt((dx * dx + dy * dy) / (hx * hx + hy * hy));
  const k = 1 - f.background.w * smoothstep(f.vignette.x, f.vignette.y, r);
  return v3(f.background.x * k, f.background.y * k, f.background.z * k);
}

/// The listening glow over `c` at a pixel (the shader's `listeningGlow`).
function glow(f: FrameUniforms, pixel: V2, c: V3): V3 {
  if (!(f.glow.x > 0)) return c;
  const v = f.viewport.y - pixel.y, h = f.glow.y;
  if (v >= 2.4 * h) return c;
  const tau = 6.2831853;
  const u = pixel.x / f.viewport.x;
  const ph = f.glowPhase, m = f.glow.z, rp = f.glow.w;
  let wave = 1, lobe = 1, warp = 0;
  if (m > 0) {
    const s1 = Math.sin(tau * 1.3 * u + ph.y), s2 = Math.sin(tau * 2.1 * u + ph.z), s3 = Math.sin(tau * 3.4 * u + ph.w);
    // The voice raises the crests and runs a finer ripple along them (integer phase multiples: no wrap jump).
    wave += m * (1 + 0.4 * rp) * (0.18 * s1 + 0.12 * s2 + 0.07 * s3);
    wave += rp * (0.045 * Math.sin(tau * 5 * u - 3 * ph.w) + 0.03 * Math.sin(tau * 7 * u + 2 * ph.z));
    lobe += m * 0.22 * (0.6 * s2 + 0.4 * s1);
    warp = 0.8 * s2;
  }
  const hh = Math.max(h * wave, 1);
  const t = v / hh;
  if (t >= 1.7) return c;
  const tc = t * 3.3333333;
  const body = Math.min(Math.exp(-1.9 * t * t) + 0.3 * Math.exp(-2.6 * tc * tc), 1) * (1 - smoothstep(1.1, 1.7, t)) * lobe;
  const band = 0.5 + 0.5 * Math.sin(tau * 0.9 * u + ph.x + warp);
  return mix3(c, mix3(rgb(f.glowColorA), rgb(f.glowColorB), band), saturate(f.glow.x * body));
}

/// Final linear colour (before sRGB encoding and dither).
function linearColor(f: FrameUniforms, pixel: V2): V3 {
  const l = sample(f.left, f, pixel);
  const r = sample(f.right, f, pixel);
  let c = mix3(mix3(glow(f, pixel, background(f, pixel)), l.color, l.coverage), r.color, r.coverage);
  const bl = browSample(f.browLeft, f, pixel);
  c = mix3(c, bl.color, bl.coverage);
  const br = browSample(f.browRight, f, pixel);
  return mix3(c, br.color, br.coverage);
}

/// Signed distance to an uneven capsule from `a` (radius `ra`) to `b` (radius `rb`); also the projection parameter.
function taperedSegment(p: V2, a: V2, b: V2, ra: number, rb: number): { d: number; t: number } {
  const bax = b.x - a.x, bay = b.y - a.y;
  const l2 = bax * bax + bay * bay;
  const pax = p.x - a.x, pay = p.y - a.y;
  const t = l2 > 1e-12 ? saturate((pax * bax + pay * bay) / l2) : 0;
  const l = Math.sqrt(l2);
  if (l < 1e-5) return { d: Math.sqrt(pax * pax + pay * pay) - Math.max(ra, rb), t };
  const dx = bax / l, dy = bay / l;
  const qx = Math.abs(pax * -dy + pay * dx), qy = pax * dx + pay * dy;
  const k0 = (ra - rb) / l;
  if (Math.abs(k0) >= 1) {
    const pbx = p.x - b.x, pby = p.y - b.y;
    return { d: Math.min(Math.sqrt(pax * pax + pay * pay) - ra, Math.sqrt(pbx * pbx + pby * pby) - rb), t };
  }
  const k1 = Math.sqrt(1 - k0 * k0);
  const k = qx * -k0 + qy * k1;
  if (k < 0) return { d: Math.sqrt(qx * qx + qy * qy) - ra, t };
  if (k > k1 * l) return { d: Math.sqrt(qx * qx + (qy - l) * (qy - l)) - rb, t };
  return { d: qx * k1 + qy * k0 - ra, t };
}

export interface BrowSampleResult {
  distance: number;
  radius: number;
  coverage: number;
  color: V3;
  rim: number;
  ink: number;
}

/// The brow stroke's field at a pixel: the union of the tapered capsules along the spine.
function browField(b: BrowUniforms, f: FrameUniforms, pixel: V2): { d: number; r: number } {
  const p = v2((pixel.x - b.placement.x) * f.viewport.w, (pixel.y - b.placement.y) * f.viewport.w);
  let best = Number.MAX_VALUE, rLoc = 0;
  for (let i = 0; i < 12; i++) {
    const a = b.points[i], c = b.points[i + 1];
    const s = taperedSegment(p, v2(a.x, a.y), v2(c.x, c.y), a.z, c.z);
    if (s.d < best) { best = s.d; rLoc = a.z + (c.z - a.z) * s.t; }
  }
  return { d: best, r: rLoc };
}

/// One brow at one pixel: rim → ink → fill, the bands thinned on narrow stretches.
function browSample(b: BrowUniforms, f: FrameUniforms, pixel: V2): BrowSampleResult {
  const none: BrowSampleResult = { distance: Infinity, radius: 0, coverage: 0, color: v3(0), rim: 0, ink: 0 };
  if (!b.isVisible) return none;
  const dx = pixel.x - b.placement.x, dy = pixel.y - b.placement.y;
  if (dx * dx + dy * dy > b.placement.z * b.placement.z) return none;
  const { d, r } = browField(b, f, pixel);
  const ppu = f.viewport.z;
  const cov = saturate(0.5 - d * ppu);
  if (cov <= 0) return { distance: d, radius: r, coverage: 0, color: v3(0), rim: 0, ink: 0 };
  const bands = EyeGeometry.bands(b.bands.x, b.bands.y, 2 * r);
  const inInk = saturate(0.5 - (d + bands.rim) * ppu);
  const inner = saturate(0.5 - (d + bands.rim + bands.ink) * ppu);
  const ink = rgb(f.ink);
  const fill = mix3(rgb(f.sclera), ink, saturate(b.bands.z));
  let col = mix3(rgb(f.rim), ink, inInk);
  col = mix3(col, fill, inner);
  return { distance: d, radius: r, coverage: cov, color: col, rim: bands.rim, ink: bands.ink };
}

/// sRGB transfer function.
const srgbEncode = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export const EyeSDF = {
  ellipse, ellipseExact, ellipseExactT, shape, shapeNormal, eggScale, egg, eggBoxPoint, boxPoint, arcDistance, lid,
  shapeLid, lidField, lidFieldS, smax, smaxK, saturate, smoothstep, local, visible, visibleDistance, sample,
  background, glow, linearColor, taperedSegment, browField, browSample, srgbEncode,
  PupilField,
} as const;
