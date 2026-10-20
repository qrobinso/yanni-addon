// Port of FaceRendering/PupilGlyphs.swift.
import { v2, type V2 } from '../core/vec';
import { PupilShape } from '../model/PupilShape';
import { EyeSDF } from './EyeSDF';

const len = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/// Distance to the segment a–b (unsigned).
function segment(p: V2, a: V2, b: V2): number {
  const pax = p.x - a.x, pay = p.y - a.y, bax = b.x - a.x, bay = b.y - a.y;
  const h = Math.min(Math.max((pax * bax + pay * bay) / Math.max(bax * bax + bay * bay, 1e-9), 0), 1);
  return len(pax - bax * h, pay - bay * h);
}

/// Distance to the circular arc (centre c, radius r) between angles a.x < a.y (y down); beyond the ends, the
/// distance to the end points.
function arc(p: V2, c: V2, r: number, a: V2): number {
  const vx = p.x - c.x, vy = p.y - c.y;
  const mid = 0.5 * (a.x + a.y), half = 0.5 * (a.y - a.x);
  const cm = Math.cos(mid), sm = Math.sin(mid);
  const wx = vx * cm + vy * sm, wy = -vx * sm + vy * cm;
  if (Math.abs(Math.atan2(wy, wx)) <= half) return Math.abs(len(vx, vy) - r);
  const e0x = c.x + r * Math.cos(a.x), e0y = c.y + r * Math.sin(a.x);
  const e1x = c.x + r * Math.cos(a.y), e1y = c.y + r * Math.sin(a.y);
  return Math.min(len(p.x - e0x, p.y - e0y), len(p.x - e1x, p.y - e1y));
}

/// Vertical capsule with radius r1 at the origin and r2 at distance h along +y (p.x ≥ 0), signed.
function unevenCapsule(p: V2, r1: number, r2: number, h: number): number {
  const b = (r1 - r2) / h;
  const a = Math.sqrt(1 - b * b);
  const k = -b * p.x + a * p.y;
  if (k < 0) return len(p.x, p.y) - r1;
  if (k > a * h) return len(p.x, p.y - h) - r2;
  return a * p.x + b * p.y - r1;
}

/// Signed distance to a simple polygon (negative inside).
function polygon(v: readonly V2[], p: V2): number {
  let d = (p.x - v[0].x) ** 2 + (p.y - v[0].y) ** 2;
  let s = 1;
  let j = v.length - 1;
  for (let i = 0; i < v.length; i++) {
    const ex = v[j].x - v[i].x, ey = v[j].y - v[i].y, wx = p.x - v[i].x, wy = p.y - v[i].y;
    const t = Math.min(Math.max((wx * ex + wy * ey) / Math.max(ex * ex + ey * ey, 1e-12), 0), 1);
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = p.y >= v[i].y, c2 = p.y < v[j].y, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
    j = i;
  }
  return s * Math.sqrt(d);
}

const deg = Math.PI / 180;

/// Signed distance fields of the pupil transformation silhouettes (CPU reference; `EyeShader.wgsl` has the same
/// maths). Negative inside. Glyph frame: isotropic, y down, centred on the pupil, every glyph authored inside the
/// ellipse (1, `aspect`).
export const PupilGlyph = {
  /// Height / width of the box the glyphs are authored for (the default pupil's aspect).
  aspect: 1.24,
  /// Thinnest stroke (glyph units): 12 % of the pupil height.
  minStroke: 0.12 * 2 * 1.24,
  /// Smallest dot radius (glyph units).
  minDot: 0.3,
  /// Mood accent on stars and hearts (glyph units, at morph 1).
  accentOffset: 0.6,
  accentTrim: 0.37,
  // Star (four-point; tips rounded)
  starRound: 0.12,
  starCore: [v2(0.82, 0), v2(0.2546, 0.2546), v2(0, 1.02), v2(-0.2546, 0.2546),
    v2(-0.82, 0), v2(-0.2546, -0.2546), v2(0, -1.02), v2(0.2546, -0.2546)] as readonly V2[],
  // Heart (two lobes and a rounded point)
  heartLobe: v2(0.39, -0.36),
  heartLobeRadius: 0.48,
  heartRound: 0.1,
  heartCore: [v2(0, 0.96), v2(0.7105, -0.1559), v2(0.39, -0.36), v2(-0.39, -0.36), v2(-0.7105, -0.1559)] as readonly V2[],
  // Eighth note (head, stem, flag)
  noteHead: v2(-0.28, 0.66),
  noteHeadRadii: v2(0.40, 0.31),
  noteHeadAxis: v2(0.92718, -0.37461),
  noteStemTop: v2(0.07, -0.9),
  noteStemBottom: v2(0.07, 0.6),
  noteStroke: 0.155,
  noteFlagCentre: v2(-0.12, -0.2),
  noteFlagRadius: 0.7446,
  noteFlagAngles: v2(-75.2 * deg, -5 * deg),
  // Question mark (hook, stem, dot)
  questionCentre: v2(0, -0.42),
  questionRadius: 0.44,
  questionStroke: 0.17,
  questionAngles: v2(165 * deg, 420 * deg),
  questionStemEnd: v2(0, 0.2),
  questionDot: v2(0, 0.88),
  dotRadius: 0.30,
  // Exclamation mark (tapered bar, dot)
  exclaimTop: v2(0, -0.78),
  exclaimTopRadius: 0.27,
  exclaimBarLength: 1.0,
  exclaimBottomRadius: 0.16,
  exclaimDot: v2(0, 0.86),

  /// Signed distance (glyph units, negative inside) to `shape` at glyph-frame point `p`.
  distance(shape: PupilShape, p: V2): number {
    const G = PupilGlyph;
    switch (shape) {
      case PupilShape.star: return polygon(G.starCore, p) - G.starRound;
      case PupilShape.heart: {
        const lobe = len(Math.abs(p.x) - G.heartLobe.x, p.y - G.heartLobe.y) - G.heartLobeRadius;
        return Math.min(lobe, polygon(G.heartCore, p) - G.heartRound);
      }
      case PupilShape.note: {
        const vx = p.x - G.noteHead.x, vy = p.y - G.noteHead.y;
        const ax = G.noteHeadAxis, pe = v2(-ax.y, ax.x);
        const head = EyeSDF.ellipse(v2(vx * ax.x + vy * ax.y, vx * pe.x + vy * pe.y), G.noteHeadRadii);
        const stem = segment(p, G.noteStemTop, G.noteStemBottom) - G.noteStroke;
        const flag = arc(p, G.noteFlagCentre, G.noteFlagRadius, G.noteFlagAngles) - G.noteStroke;
        return Math.min(head, Math.min(stem, flag));
      }
      case PupilShape.question: {
        const hook = arc(p, G.questionCentre, G.questionRadius, G.questionAngles) - G.questionStroke;
        const end = v2(G.questionCentre.x + G.questionRadius * Math.cos(G.questionAngles.y),
          G.questionCentre.y + G.questionRadius * Math.sin(G.questionAngles.y));
        const stem = segment(p, end, G.questionStemEnd) - G.questionStroke;
        const dot = len(p.x - G.questionDot.x, p.y - G.questionDot.y) - G.dotRadius;
        return Math.min(Math.min(hook, stem), dot);
      }
      case PupilShape.exclaim: {
        const bar = unevenCapsule(v2(Math.abs(p.x), p.y - G.exclaimTop.y), G.exclaimTopRadius, G.exclaimBottomRadius,
          G.exclaimBarLength);
        const dot = len(p.x - G.exclaimDot.x, p.y - G.exclaimDot.y) - G.dotRadius;
        return Math.min(bar, dot);
      }
      default: return EyeSDF.ellipse(p, v2(1, G.aspect));
    }
  },

  segment,
  arc,
  unevenCapsule,
  polygon,
} as const;
