// Port of FaceRendering/BrowGeometry.swift (an `EyeGeometry` extension in Swift; re-exported from EyeGeometry).
import { v2, v3, type V2, type V3 } from '../core/vec';
import { BrowLayout, type BrowLane } from '../model/BrowPose';
import { Canvas, FaceFrame } from '../model/FaceFrame';
import type { Side } from '../model/ParamLayout';
import { EyeGeometry } from './EyeGeometry';
import { EyeSDF } from './EyeSDF';
import { RenderStyle } from './RenderStyle';
import { BrowUniforms, type EyeUniforms, type FrameUniforms } from './RenderUniforms';
import type { Viewport } from './Viewport';

/// The eyebrows' geometry (eyebrows design §3): a pure function of the frame, the style and its eye. Each brow
/// hangs on its own eye's pre-closure sclera top plus the follow-through offset; its axes turn with the face angle
/// and the pair tilt only. Lengths across the brow are in units of the eye's pre-closure width W, heights of H.

/// Arch profile 0…1 along t with its apex at `peak`.
export function arch(t: number, peak: number): number {
  const pk = Math.min(Math.max(peak, 0.05), 0.95);
  if (t <= pk) { const a = (pk - t) / pk; return 1 - a * a; }
  const a = (t - pk) / (1 - pk);
  return 1 - a * a;
}

/// The comma-shaped thickness profile (radius / peak radius) along t.
export function browProfile(t: number, thickestAt: number, inner: number, outer: number): number {
  const p = Math.min(Math.max(thickestAt, 0.05), 0.95);
  if (t <= p) {
    const a = 1 - t / p;
    return inner + (1 - inner) * (1 - a * a);
  }
  const a = (t - p) / (1 - p);
  return outer + (1 - outer) * (1 - a * a);
}

/// The brows keep this far (canvas units) below the drawable's top edge, eased in over `browCeilingKnee`.
export const browCeilingMargin = 1.5;
export const browCeilingKnee = 2.5;
/// Collision passes (each removes at least half of any remaining shortfall).
export const browLiftPasses = 5;
/// Smooth-max knee for the per-end lifts (canvas units).
export const browLiftKnee = 0.4;

/// Smooth max (never below the plain max) for the collision lifts.
export const smaxLift = (a: number, b: number): number => EyeSDF.smax(a, b, browLiftKnee);

const resetBrow = (out: BrowUniforms): BrowUniforms => {
  out.placement.x = out.placement.y = out.placement.z = out.placement.w = 0;
  out.bands.x = out.bands.y = out.bands.z = out.bands.w = 0;
  for (const p of out.points) p.x = p.y = p.z = p.w = 0;
  return out;
};

/// One brow's uniforms (written into `out`), or an invisible brow when the style has brows off, the frame's
/// presence is 0 or the brow would be under a pixel. `e` is that eye's uniforms for this frame.
export function brow(side: Side, frame: FaceFrame, e: EyeUniforms, viewport: Viewport, style: RenderStyle,
  out = new BrowUniforms()): BrowUniforms {
  resetBrow(out);
  if (!style.browsEnabled) return out;
  const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  const ppu = Math.max(viewport.pixelsPerUnit, 1e-4);
  const pose = frame.pose;
  const cs = EyeGeometry.closure(frame.closureScale);

  // Pre-closure eye size (the same scale chain as `eye`).
  const fsx = pose.face('scaleX'), fsy = pose.face('scaleY');
  const ratio = Number.isFinite(style.eyeAsymmetry) ? Math.min(Math.max(style.eyeAsymmetry, 0.5), 2) : 1;
  const asym = side === 'left' ? Math.sqrt(ratio) : 1 / Math.sqrt(ratio);
  const sx = Math.max(pose.eye(side, 'scaleX') * fsx * style.eyeScale * asym, 1e-3) / cs.x;
  const sy = Math.max(pose.eye(side, 'scaleY') * fsy * style.eyeScale * asym, 1e-3) / cs.y;
  const W = Canvas.eyeWidth * sx, H = Canvas.eyeHeight * sy;
  const pre = EyeGeometry.sclera(side, pose, style, sx, sy);

  // Eye placement in canvas units, and the brow's axes (face angle + pair tilt only).
  const eyeC = viewport.canvas(e.center);
  const ce = e.placement.z, se = e.placement.w;
  const fa = EyeGeometry.radians(finite(pose.face('angle'), 0) + (Number.isFinite(style.pairTilt) ? style.pairTilt : 0));
  const cf = Math.cos(fa), sf = Math.sin(fa);
  const up = EyeGeometry.rotate(v2(0, -1), cf, sf);
  const outward = EyeGeometry.rotate(v2(side === 'left' ? -1 : 1, 0), cf, sf);
  const ar = EyeGeometry.rotate(v2(0, -pre.half.y), ce, se);
  const bo = FaceFrame.browOffset(frame, side);
  const anchor = v2(eyeC.x + ar.x + bo.x, eyeC.y + ar.y + bo.y);

  // Lanes (sanitised; the composer has already clamped them for engine frames).
  const b = frame.brows;
  const lane = (l: BrowLane) => {
    const r = BrowLayout.Lane.range(l);
    return Math.min(Math.max(finite(b.lane(side, l), BrowLayout.Lane.defaultValue(l)), r.lowerBound), r.upperBound);
  };
  const L = Math.max(finite(style.browLength, 0.8), 0.1) * W * lane('width');
  // Thickness from the eye's rest width (not the expression's eye scale): brows don't fatten when the eyes pop wide.
  const wRest = Canvas.eyeWidth * Math.max(fsx * style.eyeScale * asym, 1e-3);
  const rMax = 0.5 * Math.max(finite(style.browThickness, 0.22), 0.01) * wRest * lane('thickness');
  const rot = EyeGeometry.radians(lane('rotation'));
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const curvature = lane('curvature'), peak = lane('peak');
  const inner = lane('inner') * H, outer = lane('outer') * H;
  const u0 = lane('x') * W;
  const v0 = Math.max(finite(style.browGap, 0), 0) * H + rMax + lane('y') * H;
  const tipFloor = Math.max(Math.max(finite(style.rimWidth, 0), 0) + Math.max(finite(style.inkWidth, 0), 0),
    RenderStyle.browMinTipPixels / ppu);
  const tipIn = Math.max(finite(style.browInnerTip, 0.5), 0), tipOut = Math.max(finite(style.browOuterTip, 0.12), 0);
  const thickestAt = finite(style.browThickestAt, 0.32);

  // Spine in brow space (u outward, v up), radii.
  const n = BrowUniforms.segmentCount;
  const pts: V3[] = [];
  const spine = (t: number): V2 => {
    const u = (t - 0.5) * L;
    return v2(u * cr + u0, -u * sr + (1 - t) * inner + t * outer + curvature * 0.5 * L * arch(t, peak) + v0);
  };
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = Math.max(rMax * browProfile(t, thickestAt, tipIn, tipOut), tipFloor);
    const s = spine(t);
    pts.push(v3(s.x, s.y, r));
  }

  // Presence: shrink toward the arch peak (flat colour, no translucency); gone below a pixel.
  const presence = Math.min(Math.max(finite(frame.browPresence, 1), 0), 1);
  if (presence < 1) {
    const pk = spine(peak);
    for (const q of pts) {
      q.x = pk.x + (q.x - pk.x) * presence;
      q.y = pk.y + (q.y - pk.y) * presence;
      q.z *= presence;
    }
  }
  if (presence <= 0 || rMax * presence * ppu < 0.5) return out;

  // Screen ceiling: an extreme brow is eased down so it stays on screen, with a soft knee. Off while the eye is
  // carried by stage offsets.
  const st = FaceFrame.stage(frame, side);
  const stageLen = Math.sqrt(st.x * st.x + st.y * st.y);
  const ceilingWeight = 1 - EyeGeometry.smoothstep(0.5, 3, stageLen);
  if (ceilingWeight > 0) {
    const ceiling = viewport.canvas(v2(0, 0)).y + browCeilingMargin;
    let top = Number.MAX_VALUE;
    for (const q of pts) top = Math.min(top, anchor.y + outward.y * q.x + up.y * q.y - q.z);
    const ex = ceiling - top, k = browCeilingKnee;
    const push = ex <= -k ? 0 : (ex < k ? (ex + k) * (ex + k) / (4 * k) : ex);
    if (push > 0) {
      const down = push * ceilingWeight / Math.max(-up.y, 0.5);
      for (const q of pts) q.y -= down;
    }
  }

  // Collision lift against the pre-closure egg, in eye-local coordinates.
  const minGap = Math.max(finite(style.browMinGap, 0.05), 0) * H;
  const clearance = (q: V3): number => {
    const cx = anchor.x + outward.x * q.x + up.x * q.y - eyeC.x, cy = anchor.y + outward.y * q.x + up.y * q.y - eyeC.y;
    const local = v2(cx * ce - cy * se, cx * se + cy * ce);
    return EyeSDF.egg(local, pre.half, pre.top, pre.bottom, pre.taper) - q.z;
  };
  for (let pass = 0; pass < browLiftPasses; pass++) {
    let li = 0, lo = 0;
    for (let i = 0; i <= n; i++) {
      const short = minGap - clearance(pts[i]);
      if (!(short > 0)) continue;
      const t = i / n;
      li = smaxLift(li, short * (1 - t));
      lo = smaxLift(lo, short * t);
    }
    if (li <= 0 && lo <= 0) break;
    // Normalise so a shortfall at t gets at least its own size.
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts[i].y += (1 - t) * li + t * lo;
    }
  }

  // To screen-aligned canvas units around the centre.
  let lox = Number.MAX_VALUE, loy = Number.MAX_VALUE, hix = -Number.MAX_VALUE, hiy = -Number.MAX_VALUE;
  const canvasPts: V3[] = [];
  for (const q of pts) {
    const c = v3(anchor.x + outward.x * q.x + up.x * q.y, anchor.y + outward.y * q.x + up.y * q.y, q.z);
    canvasPts.push(c);
    lox = Math.min(lox, c.x - q.z); loy = Math.min(loy, c.y - q.z);
    hix = Math.max(hix, c.x + q.z); hiy = Math.max(hiy, c.y + q.z);
  }
  const center = v2((lox + hix) / 2, (loy + hiy) / 2);
  let reach = 0;
  for (let i = 0; i <= n; i++) {
    const q = canvasPts[i];
    const dx = q.x - center.x, dy = q.y - center.y;
    reach = Math.max(reach, Math.sqrt(dx * dx + dy * dy) + q.z);
    const p = out.points[i];
    p.x = q.x - center.x; p.y = q.y - center.y; p.z = q.z; p.w = 0;
  }
  if (!(Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(reach))) return resetBrow(out);
  const px = viewport.pixel(center);
  out.placement.x = px.x; out.placement.y = px.y; out.placement.z = reach * ppu + 2; out.placement.w = 1;
  out.bands.x = Math.max(finite(style.rimWidth, 0), 0);
  out.bands.y = Math.max(finite(style.inkWidth, 0), 0);
  out.bands.z = style.browInk ? 1 : 0;
  out.bands.w = 0;
  return out;
}

/// The eye-local clearance (canvas units) between a brow and its eye's pre-closure sclera (tests: the minimum gap).
export function browClearance(side: Side, frame: FaceFrame, u: FrameUniforms, viewport: Viewport,
  style: RenderStyle): number {
  const b = side === 'left' ? u.browLeft : u.browRight;
  const e = side === 'left' ? u.left : u.right;
  if (!b.isVisible) return Infinity;
  const pose = frame.pose;
  const cs = EyeGeometry.closure(frame.closureScale);
  const ratio = Number.isFinite(style.eyeAsymmetry) ? Math.min(Math.max(style.eyeAsymmetry, 0.5), 2) : 1;
  const asym = side === 'left' ? Math.sqrt(ratio) : 1 / Math.sqrt(ratio);
  const sx = Math.max(pose.eye(side, 'scaleX') * pose.face('scaleX') * style.eyeScale * asym, 1e-3) / cs.x;
  const sy = Math.max(pose.eye(side, 'scaleY') * pose.face('scaleY') * style.eyeScale * asym, 1e-3) / cs.y;
  const pre = EyeGeometry.sclera(side, pose, style, sx, sy);
  const ce = e.placement.z, se = e.placement.w;
  const eyeC = viewport.canvas(e.center), bc = viewport.canvas(b.center);
  let best = Number.MAX_VALUE;
  for (const q of b.points) {
    const cx = bc.x + q.x - eyeC.x, cy = bc.y + q.y - eyeC.y;
    best = Math.min(best, EyeSDF.egg(v2(cx * ce - cy * se, cx * se + cy * ce), pre.half, pre.top, pre.bottom, pre.taper) - q.z);
  }
  return best;
}
