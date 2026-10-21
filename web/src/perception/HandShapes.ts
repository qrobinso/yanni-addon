// Port of FacePerception/HandShapes.swift.
import type { V2 } from '../core/vec';
import { GestureParams } from './Gestures';
import {
  HandJointName, clamp, handJoint, radToDeg, vdot2, vlength2, vnormalize2, type HandDetection, type NRect,
} from './PerceptionTypes';

/// What one hand's joints look like on one frame (rules on the joint geometry; design §6.3 "rules first").
export interface HandShape {
  /// Bit i set: finger i extended (0 thumb out, 1 index, 2 middle, 3 ring, 4 little).
  extendedMask: number;
  /// Bit i set: finger i curled (0 thumb tucked).
  curledMask: number;
  thumbsUp: boolean;
  thumbsDown: boolean;
  openPalm: boolean;
  palmFacing: boolean;
  peace: boolean;
  /// All four fingers curled, thumb tucked: a strong "none-like" hard negative (never reacted to).
  fist: boolean;
  /// Index direction when pointing (unit, viewer frame).
  pointDirection: V2 | null;
  /// Palm width in normalised image units (index MCP ↔ little MCP).
  palmWidth: number;
  wrist: V2;
  /// Thumb and index tips (viewer frame, normalised): the two-hand heart rule reads them.
  thumbTip: V2;
  indexTip: V2;
  /// The hand's joint bounding box (normalised): the high-five's approach reads its growth.
  box: NRect;
}

const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
const d = (a: V2, b: V2): number => vlength2(sub(a, b));
const angle = (a: V2, b: V2): number => Math.acos(clamp(vdot2(vnormalize2(a), vnormalize2(b)), -1, 1)) * radToDeg;

export const HandShape = {
  extended: (s: HandShape, i: number): boolean => (s.extendedMask & (1 << i)) !== 0,
  curled: (s: HandShape, i: number): boolean => (s.curledMask & (1 << i)) !== 0,

  /// Classifies a hand. Null when the key joints are missing. `imageSize` makes the normalised coordinates isotropic.
  classify(h: HandDetection, k: GestureParams = new GestureParams(), imageSize: V2 = { x: 1, y: 1 }): HandShape | null {
    const mc = k.minJointConfidence;
    const sy = imageSize.y / Math.max(imageSize.x, 1);
    const iso = (n: HandJointName): V2 | null => { const p = handJoint(h, n, mc); return p === null ? null : { x: p.x, y: p.y * sy }; };
    const rawWrist = handJoint(h, 'wrist', mc), wrist = iso('wrist');
    const iMCP = iso('indexMCP'), mMCP = iso('middleMCP'), rMCP = iso('ringMCP'), lMCP = iso('littleMCP');
    const iTip = iso('indexTip'), mTip = iso('middleTip'), rTip = iso('ringTip'), lTip = iso('littleTip');
    const tTip = iso('thumbTip');
    if (rawWrist === null || wrist === null || iMCP === null || mMCP === null || rMCP === null || lMCP === null ||
      iTip === null || mTip === null || rTip === null || lTip === null || tTip === null) return null;
    const tIP = iso('thumbIP'), tMP = iso('thumbMP');
    const ext = (mcp: V2, tip: V2): boolean => d(tip, wrist) > k.extendRatio * d(mcp, wrist);
    const curl = (mcp: V2, tip: V2): boolean => d(tip, wrist) <= k.curlRatio * d(mcp, wrist);
    const e1 = ext(iMCP, iTip), e2 = ext(mMCP, mTip), e3 = ext(rMCP, rTip), e4 = ext(lMCP, lTip);
    const c1 = curl(iMCP, iTip), c2 = curl(mMCP, mTip), c3 = curl(rMCP, rTip), c4 = curl(lMCP, lTip);
    const palmLen = d(iMCP, wrist);
    const thumbOut = d(tTip, iMCP) > 0.6 * palmLen;
    const allCurled = c1 && c2 && c3 && c4;

    // Thumbs up / down: the thumb's joints ordered along the image vertical, within the angle of it; fingers curled.
    let thumbsUp = false, thumbsDown = false;
    if (tIP !== null && tMP !== null && thumbOut && allCurled) {
      const ip = tIP, mp = tMP;
      const dir = vnormalize2(sub(tTip, mp));
      if (tTip.y < ip.y && ip.y < mp.y) {
        thumbsUp = Math.acos(clamp(vdot2(dir, { x: 0, y: -1 }), -1, 1)) * radToDeg <= k.thumbMaxAngleDegrees;
      } else if (tTip.y > ip.y && ip.y > mp.y) {
        thumbsDown = Math.acos(clamp(vdot2(dir, { x: 0, y: 1 }), -1, 1)) * radToDeg <= k.thumbMaxAngleDegrees;
      }
    }

    // Palm toward the camera: the cross product of wrist→middle-MCP and index-MCP→little-MCP, by chirality
    // (the viewer frame is mirror-like: a right palm held up toward the screen has its thumb on the inside).
    const up = sub(mMCP, wrist), across = sub(lMCP, iMCP);
    const cross = up.x * across.y - up.y * across.x;
    const palmFacing = h.chirality === 'right' ? cross > 0 : h.chirality === 'left' ? cross < 0 : true;

    // Open palm: all five extended and fanned, toward the camera.
    const thumbDir = sub(tTip, tMP ?? wrist);
    const fan = angle(sub(iTip, iMCP), sub(lTip, lMCP));
    const thumbSpread = angle(thumbDir, sub(iTip, iMCP));
    const openPalm = e1 && e2 && e3 && e4 && thumbOut && thumbSpread >= k.spreadDegrees && fan >= k.spreadDegrees && palmFacing;

    // Peace: index and middle extended and apart (a V), ring and little curled.
    const peace = e1 && e2 && c3 && c4 && angle(sub(iTip, iMCP), sub(mTip, mMCP)) >= k.peaceSpreadDegrees;

    // Point: index extended, the other three curled (thumb free).
    const point = e1 && c2 && c3 && c4 ? vnormalize2(sub(iTip, iMCP)) : null;

    let lx = rawWrist.x, ly = rawWrist.y, hx = rawWrist.x, hy = rawWrist.y;
    for (const n of HandJointName.allCases) {
      const p = handJoint(h, n, mc);
      if (p !== null) { lx = Math.min(lx, p.x); ly = Math.min(ly, p.y); hx = Math.max(hx, p.x); hy = Math.max(hy, p.y); }
    }
    const ext5 = (thumbOut ? 1 : 0) | (e1 ? 2 : 0) | (e2 ? 4 : 0) | (e3 ? 8 : 0) | (e4 ? 16 : 0);
    const curl5 = (thumbOut ? 0 : 1) | (c1 ? 2 : 0) | (c2 ? 4 : 0) | (c3 ? 8 : 0) | (c4 ? 16 : 0);
    return {
      extendedMask: ext5, curledMask: curl5, thumbsUp, thumbsDown, openPalm, palmFacing, peace: peace && !openPalm,
      fist: allCurled && !thumbOut, pointDirection: point, palmWidth: d(iMCP, lMCP), wrist: rawWrist,
      thumbTip: handJoint(h, 'thumbTip', mc) ?? rawWrist, indexTip: handJoint(h, 'indexTip', mc) ?? rawWrist,
      box: { x: lx, y: ly, w: hx - lx, h: hy - ly },
    };
  },

  /// Two-hand heart (design §6.2): both thumb tips within `tipMetres` and both index tips too, mirror-posed (index
  /// tips above the thumb tips, the wrists on either side). `mx` / `my`: metres per normalised unit at the distance.
  heart(a: HandShape, b: HandShape, mx: number, my: number, tipMetres: number): boolean {
    const m = (v: V2): number => vlength2({ x: v.x * mx, y: v.y * my });
    if (!(m(sub(a.thumbTip, b.thumbTip)) <= tipMetres) || !(m(sub(a.indexTip, b.indexTip)) <= tipMetres)) return false;
    const tipsX = (a.indexTip.x + b.indexTip.x + a.thumbTip.x + b.thumbTip.x) / 4;
    const mirrored = (a.wrist.x - tipsX) * (b.wrist.x - tipsX) < 0;
    const upright = a.indexTip.y < a.thumbTip.y && b.indexTip.y < b.thumbTip.y;
    return mirrored && upright;
  },
} as const;
