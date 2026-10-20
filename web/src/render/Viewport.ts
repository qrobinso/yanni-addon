// Port of FaceRendering/Viewport.swift (Viewport and EdgeGeometry.fitting).
import { v2, type V2 } from '../core/vec';
import { EdgeGeometry } from '../model/EdgeGeometry';
import { Canvas, FaceFrame, makeFaceFrame } from '../model/FaceFrame';
import { FacePose } from '../model/FacePose';
import { BrowPose } from '../model/BrowPose';
import type { Side } from '../model/ParamLayout';
import { EyeGeometry } from './EyeGeometry';
import type { RenderStyle } from './RenderStyle';
import { BrowUniforms } from './RenderUniforms';

/// Maps canvas units (PyCozmo 128 × 64 canvas, +y down) to drawable pixels.
export class Viewport {
  /// The face's everyday motion envelope (canvas units), centred on the canvas centre (M8).
  static readonly envelope = v2(108, 72);
  /// With brows on: the envelope grown upward to hold the brows' expressive range.
  static readonly browEnvelope = v2(108, 94);
  static readonly browEnvelopeCenterY = -11;
  /// Fraction of the drawable the envelope fills.
  static readonly fitFraction = 0.96;
  static readonly canvasCenter = v2(Canvas.width / 2, Canvas.height / 2);

  constructor(
    /// Drawable size in pixels.
    public size: V2,
    /// Pixels per canvas unit.
    public pixelsPerUnit: number,
    /// Pixel position of canvas point (0, 0).
    public canvasOrigin: V2,
  ) {}

  /// Fits the motion envelope into a drawable, centred. `ppu = min(W·f/108, H'·f/72) × portrait × faceScale`, with
  /// `H' = H × (1 − captionInset)`: while a caption shows, the envelope is fitted into the area above the band.
  static fitting(width: number, height: number, style: RenderStyle, captionInset = 0): Viewport {
    const w = Math.max(width, 1), h = Math.max(height, 1);
    const band = Number.isFinite(captionInset) ? Math.min(Math.max(captionInset, 0), FaceFrame.maxCaptionInset) : 0;
    const top = h * (1 - band);
    const env = style.browsEnabled ? Viewport.browEnvelope : Viewport.envelope;
    const exact = Math.min(w / env.x, top / env.y);
    const base = exact * Viewport.fitFraction;
    let mul = 1;
    if (h > w) mul = Math.max(1, Math.min(style.portraitScale, exact / base));
    const ppu = base * mul * Math.max(style.faceScale, 0.01);
    // The envelope's centre sits at the centre of the face's area (brows on: the face rest centre is below it).
    const centre = Viewport.screenCenter(style);
    return new Viewport(v2(w, h), ppu, v2(w / 2 - centre.x * ppu, top / 2 - centre.y * ppu));
  }

  /// The canvas point at the drawable's centre (the canvas centre, or above it when brows are on).
  static screenCenter(style: RenderStyle): V2 {
    const c = Viewport.canvasCenter;
    return style.browsEnabled ? v2(c.x, c.y + Viewport.browEnvelopeCenterY) : v2(c.x, c.y);
  }

  pixel(c: V2): V2 { return v2(this.canvasOrigin.x + c.x * this.pixelsPerUnit, this.canvasOrigin.y + c.y * this.pixelsPerUnit); }
  canvas(p: V2): V2 { return v2((p.x - this.canvasOrigin.x) / this.pixelsPerUnit, (p.y - this.canvasOrigin.y) / this.pixelsPerUnit); }

  equals(o: Viewport): boolean {
    return this.size.x === o.size.x && this.size.y === o.size.y && this.pixelsPerUnit === o.pixelsPerUnit &&
      this.canvasOrigin.x === o.canvasOrigin.x && this.canvasOrigin.y === o.canvasOrigin.y;
  }
}

/// How far above the rest brow the edge geometry's brow box reaches, in eye half-heights (raised brows).
export const browBoxRaise = 0.5;

/// Where the screen edges and the eyes are for a drawable of `width` × `height` and `style`, in canvas units
/// around the face's rest centre (Swift `EdgeGeometry.fitting`). Eye boxes are the axis-aligned bounds of each eye's
/// rest shape plus half a pixel of anti-aliasing; with a caption band the screen is the area above it.
export function edgeGeometryFitting(width: number, height: number, style: RenderStyle, captionInset = 0): EdgeGeometry {
  const vp = Viewport.fitting(width, height, style, captionInset);
  const ppu = Math.max(vp.pixelsPerUnit, 1e-4);
  const band = Number.isFinite(captionInset) ? Math.min(Math.max(captionInset, 0), FaceFrame.maxCaptionInset) : 0;
  const visible = v2(vp.size.x / 2 / ppu, vp.size.y * (1 - band) / 2 / ppu);
  const screen = Viewport.screenCenter(style);
  const box = (side: Side) => {
    const e = EyeGeometry.eye(side, FacePose.defaults, vp, style);
    const c = vp.canvas(e.center);
    const hx = e.box.x * (1 + 0.5 * e.accent.x), hy = e.box.y;
    const co = Math.abs(e.placement.z), si = Math.abs(e.placement.w);
    const aa = 0.5 / ppu;
    return { center: v2(c.x - screen.x, c.y - screen.y), half: v2(co * hx + si * hy + aa, si * hx + co * hy + aa) };
  };
  const l = box('left'), r = box('right');
  if (!style.browsEnabled) {
    return new EdgeGeometry({ visibleHalfExtent: visible, leftEyeCenter: l.center, rightEyeCenter: r.center,
      leftEyeHalfSize: l.half, rightEyeHalfSize: r.half });
  }
  // Brow boxes: each rest brow's bounds, grown to cover its expressive range.
  const frame = makeFaceFrame(FacePose.defaults, { brows: BrowPose.restNeutral });
  const u = EyeGeometry.uniforms(frame, vp, style);
  const browBox = (b: BrowUniforms, eyeHalf: V2) => {
    if (!b.isVisible) return { center: v2(0), half: v2(0) };
    const c = vp.canvas(b.center);
    let lox = Number.MAX_VALUE, loy = Number.MAX_VALUE, hix = -Number.MAX_VALUE, hiy = -Number.MAX_VALUE;
    for (const q of b.points) {
      lox = Math.min(lox, q.x - q.z); loy = Math.min(loy, q.y - q.z);
      hix = Math.max(hix, q.x + q.z); hiy = Math.max(hiy, q.y + q.z);
    }
    const aa = 0.5 / ppu;
    lox -= 0.06 * eyeHalf.x + aa; loy -= browBoxRaise * eyeHalf.y + aa;
    hix += 0.06 * eyeHalf.x + aa; hiy += aa;
    return { center: v2(c.x - screen.x + (lox + hix) / 2, c.y - screen.y + (loy + hiy) / 2),
      half: v2((hix - lox) / 2, (hiy - loy) / 2) };
  };
  const bl = browBox(u.browLeft, l.half), br = browBox(u.browRight, r.half);
  return new EdgeGeometry({ visibleHalfExtent: visible, leftEyeCenter: l.center, rightEyeCenter: r.center,
    leftEyeHalfSize: l.half, rightEyeHalfSize: r.half, leftBrowCenter: bl.center, leftBrowHalfSize: bl.half,
    rightBrowCenter: br.center, rightBrowHalfSize: br.half });
}
