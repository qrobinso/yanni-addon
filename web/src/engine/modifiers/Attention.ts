// Port of FaceEngine/Modifiers/Attention.swift: only the camera calibration statics so far (OneShotSampler needs them).
// TODO(WP5): rest of Attention.swift — the Attention modifier (name "Attention", phase attention); keep these statics
// and register it in modifiers/index.ts.
import type { V2 } from '../../core/vec';

export class Attention {
  /// Degrees of visual angle per normalised gaze unit (x, y).
  static readonly gazeUnitDegrees: Readonly<V2> = Object.freeze({ x: 35, y: 25 });

  /// The gaze-space correction for a camera `offset` metres from the screen centre (x + toward the viewer's right,
  /// y + down): `atan(offset / distance)` per axis, in degrees ÷ `gazeUnitDegrees`.
  static cameraCorrection(offset: V2, distance: number): V2 {
    if (!(Number.isFinite(offset.x) && Number.isFinite(offset.y)) || (offset.x === 0 && offset.y === 0)) return { x: 0, y: 0 };
    const d = Number.isFinite(distance) ? Math.max(distance, 0.2) : 1.5;
    const k = 180 / Math.PI;
    return {
      x: Math.atan(offset.x / d) * k / Attention.gazeUnitDegrees.x,
      y: Math.atan(offset.y / d) * k / Attention.gazeUnitDegrees.y,
    };
  }
}
