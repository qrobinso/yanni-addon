// Port of FaceModel/EdgeGeometry.swift.
import { v2, type V2 } from '../core/vec';
import { FaceFrame, Units } from './FaceFrame';
import { minOf } from './NoAllocMinMax';
import type { Side } from './ParamLayout';

export interface EdgeGeometryInit {
  visibleHalfExtent: V2;
  leftEyeCenter: V2;
  rightEyeCenter: V2;
  leftEyeHalfSize: V2;
  rightEyeHalfSize: V2;
  leftBrowCenter?: V2;
  leftBrowHalfSize?: V2;
  rightBrowCenter?: V2;
  rightBrowHalfSize?: V2;
}

const axisFraction = (c: number, h: number, e: number): number => {
  const lo = Math.max(c - h, -e), hi = Math.min(c + h, e);
  return Math.max(hi - lo, 0) / Math.max(2 * h, 1e-4);
};

/// Where the screen edges are, seen from the face (screen-edge antics design §2).
///
/// All values are canvas units relative to the canvas centre (the face's rest centre), +y down. Computed by
/// `EdgeGeometry.fitting` in the renderer on every layout change; undefined means "no screen" (headless, tests) and
/// turns the screen-edge antics off. The eye boxes are axis-aligned bounds of each eye's rest shape.
export class EdgeGeometry {
  /// Half the visible drawable, in canvas units: the screen edges sit at ±visibleHalfExtent.
  visibleHalfExtent: V2;
  /// Rest centre of each eye (left eye = viewer's left).
  leftEyeCenter: V2;
  rightEyeCenter: V2;
  /// Half size of each eye's axis-aligned bounding box at rest, outline included.
  leftEyeHalfSize: V2;
  rightEyeHalfSize: V2;
  /// Each brow's box (centre and half size) when brows are drawn. Zero half size = no brows.
  leftBrowCenter: V2;
  leftBrowHalfSize: V2;
  rightBrowCenter: V2;
  rightBrowHalfSize: V2;

  constructor(o: EdgeGeometryInit) {
    this.visibleHalfExtent = { ...o.visibleHalfExtent };
    this.leftEyeCenter = { ...o.leftEyeCenter };
    this.rightEyeCenter = { ...o.rightEyeCenter };
    this.leftEyeHalfSize = { ...o.leftEyeHalfSize };
    this.rightEyeHalfSize = { ...o.rightEyeHalfSize };
    this.leftBrowCenter = o.leftBrowCenter ? { ...o.leftBrowCenter } : v2(0);
    this.leftBrowHalfSize = o.leftBrowHalfSize ? { ...o.leftBrowHalfSize } : v2(0);
    this.rightBrowCenter = o.rightBrowCenter ? { ...o.rightBrowCenter } : v2(0);
    this.rightBrowHalfSize = o.rightBrowHalfSize ? { ...o.rightBrowHalfSize } : v2(0);
  }

  copy(): EdgeGeometry { return new EdgeGeometry(this); }

  equals(o: EdgeGeometry): boolean {
    const k = ['visibleHalfExtent', 'leftEyeCenter', 'rightEyeCenter', 'leftEyeHalfSize', 'rightEyeHalfSize',
      'leftBrowCenter', 'leftBrowHalfSize', 'rightBrowCenter', 'rightBrowHalfSize'] as const;
    return k.every((n) => this[n].x === o[n].x && this[n].y === o[n].y);
  }

  /// True when the geometry includes brow boxes.
  get hasBrows(): boolean {
    return minOf(this.leftBrowHalfSize.x, this.leftBrowHalfSize.y, this.rightBrowHalfSize.x, this.rightBrowHalfSize.y) > 0;
  }

  /// One brow's box (zero size without brows).
  browCenter(side: Side): V2 { return side === 'left' ? this.leftBrowCenter : this.rightBrowCenter; }
  browHalfSize(side: Side): V2 { return side === 'left' ? this.leftBrowHalfSize : this.rightBrowHalfSize; }
  center(side: Side): V2 { return side === 'left' ? this.leftEyeCenter : this.rightEyeCenter; }
  halfSize(side: Side): V2 { return side === 'left' ? this.leftEyeHalfSize : this.rightEyeHalfSize; }

  /// The box around everything drawn for one eye: the eye, plus its brow when brows are on.
  extent(side: Side): { center: V2; half: V2 } {
    const c = this.center(side), h = this.halfSize(side);
    const bh = this.browHalfSize(side);
    if (!(bh.x > 0 && bh.y > 0)) return { center: { ...c }, half: { ...h } };
    const bc = this.browCenter(side);
    const loX = Math.min(c.x - h.x, bc.x - bh.x), loY = Math.min(c.y - h.y, bc.y - bh.y);
    const hiX = Math.max(c.x + h.x, bc.x + bh.x), hiY = Math.max(c.y + h.y, bc.y + bh.y);
    return { center: v2((loX + hiX) / 2, (loY + hiY) / 2), half: v2((hiX - loX) / 2, (hiY - loY) / 2) };
  }

  /// The default style on an 11″ iPad in landscape (1194 × 834 pt), as `EdgeGeometry.fitting` computes it. Used
  /// for nominal timings and accent times, and by tests that need a screen without the renderer. Fresh each access.
  static get reference(): EdgeGeometry {
    return new EdgeGeometry({
      visibleHalfExtent: v2(56.25, 39.290),
      leftEyeCenter: v2(-21.134, -2.221), rightEyeCenter: v2(21.134, 2.221),
      leftEyeHalfSize: v2(24.669, 28.212), rightEyeHalfSize: v2(22.431, 25.652),
    });
  }

  /// Finite, positive sizes and a non-degenerate screen.
  get isValid(): boolean {
    const all = [this.visibleHalfExtent, this.leftEyeCenter, this.rightEyeCenter, this.leftEyeHalfSize,
      this.rightEyeHalfSize, this.leftBrowCenter, this.leftBrowHalfSize, this.rightBrowCenter, this.rightBrowHalfSize];
    return all.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y))
      && this.visibleHalfExtent.x > 1 && this.visibleHalfExtent.y > 1
      && minOf(this.leftBrowHalfSize.x, this.leftBrowHalfSize.y, this.rightBrowHalfSize.x, this.rightBrowHalfSize.y) >= 0
      && this.leftEyeHalfSize.x > 0.1 && this.leftEyeHalfSize.y > 0.1
      && this.rightEyeHalfSize.x > 0.1 && this.rightEyeHalfSize.y > 0.1;
  }

  /// How far the pair reaches from the face centre horizontally (outer edge of the outer eye, brows included).
  get pairHalfWidth(): number {
    const l = this.extent('left'), r = this.extent('right');
    return Math.max(Math.abs(l.center.x) + l.half.x, Math.abs(r.center.x) + r.half.x);
  }

  /// How far the pair reaches from the face centre vertically (brows included).
  get pairHalfHeight(): number {
    const l = this.extent('left'), r = this.extent('right');
    return Math.max(Math.abs(l.center.y) + l.half.y, Math.abs(r.center.y) + r.half.y);
  }

  /// Fraction (0…1) of everything drawn for one eye (the eye and its brow's box) inside the screen when moved by
  /// `offset`: 0 only once the brow is off screen too. The edge antics' watchdog counts "hidden" with it.
  extentVisibleFraction(side: Side, offset: V2): number {
    const eye = this.visibleFraction(side, offset);
    const bh = this.browHalfSize(side);
    if (!(bh.x > 0 && bh.y > 0)) return eye;
    const bc = this.browCenter(side), e = this.visibleHalfExtent;
    return Math.max(eye, axisFraction(bc.x + offset.x, bh.x, e.x) * axisFraction(bc.y + offset.y, bh.y, e.y));
  }

  /// Fraction (0…1) of an eye's bounding box inside the screen when the eye is moved by `offset` from rest.
  visibleFraction(side: Side, offset: V2): number {
    const c = this.center(side), h = this.halfSize(side), e = this.visibleHalfExtent;
    return axisFraction(c.x + offset.x, h.x, e.x) * axisFraction(c.y + offset.y, h.y, e.y);
  }

  /// Horizontal offset that leaves `fraction` of the eye's width (with its brow, when brows are on) visible at the
  /// side edge `side` (+1 right, −1 left), starting from an eye already displaced by `from`. 0 puts it just beyond
  /// the edge, brow included.
  offsetX(eye: Side, fraction: number, side: number, from: V2 = v2(0)): number {
    const ext = this.extent(eye);
    const c = ext.center.x + from.x, h = ext.half.x, s = side >= 0 ? 1 : -1;
    return s * (this.visibleHalfExtent.x - s * c + h - 2 * h * fraction);
  }

  /// Downward offset that leaves `fraction` of the eye's height visible above the bottom edge.
  offsetDown(eye: Side, fraction: number, from: V2 = v2(0)): number {
    const c = this.center(eye).y + from.y, h = this.halfSize(eye).y;
    return this.visibleHalfExtent.y - c + h - 2 * h * fraction;
  }

  /// An eye's displacement from its rest centre in a composed frame: face centre and eye centre (canvas units;
  /// face scale and rotation ignored, which only move it a little) plus its total stage offset.
  static eyeOffset(side: Side, frame: FaceFrame): V2 {
    const p = frame.pose, st = FaceFrame.stage(frame, side);
    return v2(Units.canvasX(p.face('centerX') + p.eye(side, 'centerX')) + st.x,
      Units.canvasY(p.face('centerY') + p.eye(side, 'centerY')) + st.y);
  }

  /// Fraction (0…1) of an eye's bounding box on screen in a composed frame (Swift `visibleFraction(_:in:)`).
  visibleFractionIn(side: Side, frame: FaceFrame): number {
    return this.visibleFraction(side, EdgeGeometry.eyeOffset(side, frame));
  }

  /// Fraction (0…1) of an eye and its brow on screen in a composed frame (Swift `extentVisibleFraction(_:in:)`).
  extentVisibleFractionIn(side: Side, frame: FaceFrame): number {
    return this.extentVisibleFraction(side, EdgeGeometry.eyeOffset(side, frame));
  }
}
