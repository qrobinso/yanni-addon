// Port of FacePerception/CameraGeometry.swift.
import type { V2, V3 } from '../core/vec';
import { Attention } from '../engine/modifiers/Attention';
import { CameraIntrinsics, NRect, clamp, radToDeg, vlength3 } from './PerceptionTypes';
import type { ExitEdge } from './PerceptionTypes';

/// Interface orientation (the way the screen is held), for rotating the camera offset.
/// landscapeLeft: UIKit's `.landscapeLeft` (the device's top edge on the right); landscapeRight: top edge on the left.
export type InterfaceOrientation = 'portrait' | 'portraitUpsideDown' | 'landscapeLeft' | 'landscapeRight';
export const InterfaceOrientation = {
  allCases: ['portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight'] as readonly InterfaceOrientation[],
} as const;

/// The one place that knows about the camera: pixel → ray → gaze space, the viewer-frame mirror, and the camera's
/// position relative to the drawn face.
export class CameraGeometry {
  intrinsics: CameraIntrinsics;
  /// Camera position relative to the **drawn face centre** in metres (x + toward the viewer's right, y + down). The
  /// same value goes to `FaceEngine.setCameraOffset` so eye contact and Attention agree.
  cameraOffset: V2;

  constructor(intrinsics: CameraIntrinsics = CameraIntrinsics.typicalLandscape, cameraOffset: V2 = { x: 0, y: 0 }) {
    this.intrinsics = intrinsics; this.cameraOffset = cameraOffset;
  }

  copy(): CameraGeometry {
    const k = this.intrinsics;
    return new CameraGeometry({ imageSize: { ...k.imageSize }, focal: { ...k.focal }, principal: { ...k.principal } },
      { ...this.cameraOffset });
  }

  equals(o: CameraGeometry): boolean {
    return CameraIntrinsics.equals(this.intrinsics, o.intrinsics) &&
      this.cameraOffset.x === o.cameraOffset.x && this.cameraOffset.y === o.cameraOffset.y;
  }

  // MARK: Viewer frame

  /// Vision's normalised coordinates (origin lower-left) → the viewer frame (origin top-left, y down; mirrored for a
  /// front camera).
  static viewerPoint(p: V2, mirrored: boolean): V2 { return { x: mirrored ? 1 - p.x : p.x, y: 1 - p.y }; }

  /// Vision bounding box (origin lower-left) → viewer frame.
  static viewerRect(x: number, y: number, w: number, h: number, mirrored: boolean): NRect {
    return { x: mirrored ? 1 - x - w : x, y: 1 - y - h, w, h };
  }

  // MARK: Rays and angles

  /// Unit-depth ray (z = 1) through a normalised viewer-frame point.
  ray(p: V2): V3 {
    const k = this.intrinsics;
    const px = p.x * k.imageSize.x, py = p.y * k.imageSize.y;
    return { x: (px - k.principal.x) / Math.max(k.focal.x, 1), y: (py - k.principal.y) / Math.max(k.focal.y, 1), z: 1 };
  }

  /// Camera-relative gaze-space position of a viewer-frame point (true angles through the intrinsics), clamped ±1.
  gazePosition(p: V2): V2 {
    const r = this.ray(p);
    const gx = Math.atan(r.x) * radToDeg / Attention.gazeUnitDegrees.x;
    const gy = Math.atan(r.y) * radToDeg / Attention.gazeUnitDegrees.y;
    return { x: clamp(gx, -1, 1), y: clamp(gy, -1, 1) };
  }

  /// Gaze-space position of a camera-space point (Swift: static `gazePosition(ofCameraPoint:)`).
  static gazePosition(p: V3): V2 {
    const z = Math.max(p.z, 0.05);
    const gx = Math.atan(p.x / z) * radToDeg / Attention.gazeUnitDegrees.x;
    const gy = Math.atan(p.y / z) * radToDeg / Attention.gazeUnitDegrees.y;
    return { x: clamp(gx, -1, 1), y: clamp(gy, -1, 1) };
  }

  static gazePositionOfCameraPoint(p: V3): V2 { return CameraGeometry.gazePosition(p); }

  /// Head centre in camera space for a viewer-frame face centre at `distance` metres.
  cameraPoint(p: V2, distance: number): V3 {
    const r = this.ray(p);
    const l = vlength3(r);
    const s = Math.max(distance, 0.1) / l;
    return { x: r.x * s, y: r.y * s, z: r.z * s };
  }

  /// Where Yanni's eyes are drawn, in camera space (metres): the face centre is `−cameraOffset` from the lens.
  get faceTarget(): V3 { return { x: -this.cameraOffset.x, y: -this.cameraOffset.y, z: 0 }; }

  /// Metres per normalised horizontal / vertical image unit at `distance` (for gesture sizes).
  metresPerUnitX(distance: number): number { return distance * this.intrinsics.imageSize.x / Math.max(this.intrinsics.focal.x, 1); }
  metresPerUnitY(distance: number): number { return distance * this.intrinsics.imageSize.y / Math.max(this.intrinsics.focal.y, 1); }

  /// A camera-relative gaze point converted to the screen-relative point the face commands expect, with the engine's
  /// own correction.
  screenRelative(p: V2, distance: number): V2 {
    const c = Attention.cameraCorrection(this.cameraOffset, distance);
    return { x: clamp(p.x + c.x, -1, 1), y: clamp(p.y + c.y, -1, 1) };
  }

  /// The edge a viewer-frame point is near (within `margin`), if any.
  static edge(p: V2, margin = 0.1): ExitEdge | null {
    const d: [ExitEdge, number][] = [['left', p.x], ['right', 1 - p.x], ['top', p.y], ['bottom', 1 - p.y]];
    let best = d[0];
    for (const e of d) if (e[1] < best[1]) best = e;   // first of ties, like Swift `min(by:)`
    return best[1] <= margin ? best[0] : null;
  }
}

// MARK: - Camera offset table

export type CameraOffsetEdge = 'longEdge' | 'shortEdge' | 'display';

export interface CameraOffsetEntry {
  family: string;
  machines: string[];
  edge: CameraOffsetEdge;
  portraitOffset: V2;
}

const entry = (family: string, machines: string[], edge: CameraOffsetEdge, x: number, y: number): CameraOffsetEntry =>
  ({ family, machines, edge, portraitOffset: { x, y } });

/// Where the front camera sits, per iPad model (metres from the screen centre in the portrait device frame, home
/// indicator down, x + right, y + down). Estimates: measure each owned device and use the manual override.
export const CameraOffsetTable = {
  entries: [
    entry('iPad Pro 11-inch (M4, M5)', ['iPad16,3', 'iPad16,4', 'iPad17,1', 'iPad17,2'], 'longEdge', -0.087, 0),
    entry('iPad Pro 13-inch (M4, M5)', ['iPad16,5', 'iPad16,6', 'iPad17,3', 'iPad17,4'], 'longEdge', -0.106, 0),
    entry('iPad Air 11-inch (M2, M3)', ['iPad14,8', 'iPad14,9', 'iPad15,3', 'iPad15,4'], 'longEdge', -0.088, 0),
    entry('iPad Air 13-inch (M2, M3)', ['iPad14,10', 'iPad14,11', 'iPad15,5', 'iPad15,6'], 'longEdge', -0.108, 0),
    entry('iPad (10th gen, A16)', ['iPad13,18', 'iPad13,19', 'iPad15,7', 'iPad15,8'], 'longEdge', -0.089, 0),
    entry('iPad mini (A17 Pro)', ['iPad16,1', 'iPad16,2'], 'shortEdge', 0, -0.096),
    entry('iPad Pro 11-inch (2018–2022)', ['iPad8,1', 'iPad8,2', 'iPad8,3', 'iPad8,4', 'iPad8,9', 'iPad8,10', 'iPad13,4',
      'iPad13,5', 'iPad13,6', 'iPad13,7', 'iPad14,3', 'iPad14,4'], 'shortEdge', 0, -0.122),
  ] as readonly CameraOffsetEntry[],

  /// The table entry for a `hw.machine` identifier.
  entry: (machine: string): CameraOffsetEntry | null =>
    CameraOffsetTable.entries.find((e) => e.machines.includes(machine)) ?? null,

  /// Fallback for an unknown iPad: camera centred on the portrait top edge plus a 1 cm bezel. Flagged uncalibrated.
  unknownIPadOffset: (portraitHeightMetres: number): V2 => ({ x: 0, y: -(portraitHeightMetres / 2 + 0.01) }),

  /// A Mac's built-in camera, above a display `displayHeightMetres` tall (screen-centre frame).
  macOffset: (displayHeightMetres: number): V2 => ({ x: 0, y: -(displayHeightMetres / 2 + 0.01) }),

  /// The portrait-frame offset rotated into the current interface orientation.
  offset(o: V2, orientation: InterfaceOrientation): V2 {
    switch (orientation) {
      case 'portrait': return { x: o.x, y: o.y };
      case 'portraitUpsideDown': return { x: -o.x, y: -o.y };
      case 'landscapeLeft': return { x: -o.y, y: o.x };     // device top on the right: a quarter turn clockwise
      case 'landscapeRight': return { x: o.y, y: -o.x };    // device top on the left
    }
  },
} as const;

/// Where the camera offset came from (status page).
export type CameraOffsetSource = 'table' | 'manual' | 'uncalibrated' | 'mac' | 'none';
