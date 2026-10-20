// Port of FaceRendering/RenderUniforms.swift, plus the packing into the GPU buffer.
import { v2, v4, type V2, type V4 } from '../core/vec';
import { pupilShapeClamping, type PupilShape } from '../model/PupilShape';

/// GPU uniform blocks. Every field is a vec4<f32>, so the TS packing and the WGSL layout are identical (16-byte
/// aligned, no implicit padding). `EyeShader.wgsl` declares the same structs.
///
/// All eye geometry is in **eye-local canvas units**: origin at the eye centre, x right, y down, in the *scaled* eye
/// box (half extents already include eye, face, style and closure scale).

/// Per-eye render parameters.
export class EyeUniforms {
  /// (centre x px, centre y px, cos φ, sin φ). φ = total eye rotation, positive counter-clockwise on screen.
  placement = v4(0);
  /// (half width, half height, lid erosion, cull radius px).
  box = v4(0);
  /// Upper corner radii: (upper-left rx, ry, upper-right rx, ry).
  radiiTop = v4(0);
  /// Lower corner radii: (lower-left rx, ry, lower-right rx, ry).
  radiiBottom = v4(0);
  /// Upper lid: (pivot y, cos φ_lid, sin φ_lid, edge offset L).
  upperLid = v4(0);
  /// Upper lid bend ellipse: (half width a, depth b, ψ right tip, ψ left tip).
  upperBend = v4(0);
  /// Upper lid chord segments inside the eye box: (+start, +end, −start, −end).
  upperClip = v4(0);
  lowerLid = v4(0);
  lowerBend = v4(0);
  lowerClip = v4(0);
  /// Pupil ellipse after containment and closure: (centre x, y, radius x, y).
  pupil = v4(0);
  /// (egg taper, effective pupil ink width, closure y scale, pupil visibility 0...1).
  accent = v4(0, 0, 1, 0);
  /// (effective ink width, upper lid junction k, lower lid junction k, effective rim width).
  outline = v4(0);
  /// Lid edge blend: (upper w, lower w, upper t, lower t).
  lidBlend = v4(1, 1, 1, 1);
  /// Pupil transformation: (shape id, morph 0…1, scale x, scale y).
  shape = v4(0, 0, 1, 1);

  static readonly fields = ['placement', 'box', 'radiiTop', 'radiiBottom', 'upperLid', 'upperBend', 'upperClip',
    'lowerLid', 'lowerBend', 'lowerClip', 'pupil', 'accent', 'outline', 'lidBlend', 'shape'] as const;

  get center(): V2 { return v2(this.placement.x, this.placement.y); }
  get halfExtents(): V2 { return v2(this.box.x, this.box.y); }
  get erosion(): number { return this.box.z; }
  get cullRadius(): number { return this.box.w; }
  get pupilCenter(): V2 { return v2(this.pupil.x, this.pupil.y); }
  get pupilRadii(): V2 { return v2(this.pupil.z, this.pupil.w); }
  get eggTaper(): number { return this.accent.x; }
  get pupilInkWidth(): number { return this.accent.y; }
  get pupilVisibility(): number { return this.accent.w; }
  get closureY(): number { return this.accent.z; }
  get pupilShape(): PupilShape { return pupilShapeClamping(Math.min(Math.max(Math.round(this.shape.x), 0), 255)); }
  get pupilMorph(): number { return this.shape.y; }
  get pupilShapeScale(): V2 { return v2(this.shape.z, this.shape.w); }
  get inkWidth(): number { return this.outline.x; }
  get rimWidth(): number { return this.outline.w; }
  /// Rim + ink: depth of the ink's inner edge below the visible edge.
  get bandWidth(): number { return this.outline.x + this.outline.w; }
  get outlineWidth(): number { return this.bandWidth; }
}

/// Per-brow render parameters: a chain of `segmentCount` tapered capsules along the brow's spine.
export class BrowUniforms {
  static readonly segmentCount = 12;
  static readonly pointCount = 13;
  /// (centre x px, centre y px, cull radius px, visible 0/1).
  placement = v4(0);
  /// (rim width, ink width, fill ink amount 0 ivory … 1 ink, 0).
  bands = v4(0);
  /// Spine points inner → outer: (x, y relative to the centre, radius, 0), canvas units.
  points: V4[] = Array.from({ length: BrowUniforms.pointCount }, () => v4(0));

  get isVisible(): boolean { return this.placement.w > 0.5; }
  get center(): V2 { return v2(this.placement.x, this.placement.y); }
  get cullRadius(): number { return this.placement.z; }
}

/// Per-frame render parameters.
export class FrameUniforms {
  /// (drawable width px, height px, pixels per canvas unit, canvas units per pixel).
  viewport = v4(0);
  /// (linear r, g, b, vignette 0…1): the final background colour.
  background = v4(0);
  /// (sclera gradient, lid shadow strength, lid shadow width units, dither amplitude in output code values).
  shading = v4(0);
  /// (mood accent on stars and hearts 0/1, notch enabled 0/1, iris tint amount, crescent strength).
  misc = v4(0);
  sclera = v4(0);
  ink = v4(0);
  rim = v4(0);
  /// Pupil fill in Oklab (L, a, b, brightness multiplier applied after converting back to linear).
  pupilLab = v4(0);
  /// Iris ring colour in Oklab; w unused.
  irisLab = v4(0);
  notch = v4(0);
  crescent = v4(0);
  /// Notch wedge sides in pupil-normalised coordinates: (n.x, n.y, c, retract).
  notchLine1 = v4(0);
  notchLine2 = v4(0);
  /// Crescent cut-out disc in pupil-normalised coordinates: (centre x, centre y, radius, 0).
  crescentDisc = v4(0);
  /// Vignette ramp: (inner r, outer r, 0, 0).
  vignette = v4(0.1, 0.95, 0, 0);
  /// Listening glow: (opacity, crest height px, edge motion, voice ripple).
  glow = v4(0);
  /// Glow phases, radians: (band drift, wave 1, wave 2, wave 3).
  glowPhase = v4(0);
  glowColorA = v4(0);
  glowColorB = v4(0);
  left = new EyeUniforms();
  right = new EyeUniforms();
  browLeft = new BrowUniforms();
  browRight = new BrowUniforms();

  static readonly fields = ['viewport', 'background', 'shading', 'misc', 'sclera', 'ink', 'rim', 'pupilLab', 'irisLab',
    'notch', 'crescent', 'notchLine1', 'notchLine2', 'crescentDisc', 'vignette', 'glow', 'glowPhase', 'glowColorA',
    'glowColorB'] as const;

  get pixelsPerUnit(): number { return this.viewport.z; }
  get unitsPerPixel(): number { return this.viewport.w; }
}

/// Floats in one packed `FrameU` (19 frame vec4s + 2 × 15 eye vec4s + 2 × 15 brow vec4s = 79 vec4s, 1264 bytes).
export const eyeVec4s = EyeUniforms.fields.length;
export const browVec4s = 2 + BrowUniforms.pointCount;
export const frameVec4s = FrameUniforms.fields.length + 2 * eyeVec4s + 2 * browVec4s;
export const frameUniformFloats = frameVec4s * 4;
export const frameUniformBytes = frameUniformFloats * 4;

/// Float offsets of every named member in the packed layout (the layout test checks them against the WGSL).
export function uniformOffsets(): Record<string, number> {
  const o: Record<string, number> = {};
  let i = 0;
  for (const k of FrameUniforms.fields) { o[k] = i; i += 4; }
  for (const side of ['left', 'right']) for (const k of EyeUniforms.fields) { o[`${side}.${k}`] = i; i += 4; }
  for (const side of ['browLeft', 'browRight']) {
    o[`${side}.placement`] = i; i += 4;
    o[`${side}.bands`] = i; i += 4;
    o[`${side}.points`] = i; i += 4 * BrowUniforms.pointCount;
  }
  return o;
}

const put = (out: Float32Array, i: number, v: V4): number => {
  out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z; out[i + 3] = v.w;
  return i + 4;
};

const putEye = (out: Float32Array, i: number, e: EyeUniforms): number => {
  for (const k of EyeUniforms.fields) i = put(out, i, e[k]);
  return i;
};

const putBrow = (out: Float32Array, i: number, b: BrowUniforms): number => {
  i = put(out, i, b.placement);
  i = put(out, i, b.bands);
  for (const p of b.points) i = put(out, i, p);
  return i;
};

/// Writes `u` into `out` in the WGSL `FrameU` layout. No allocation.
export function packFrameUniforms<T extends Float32Array>(u: FrameUniforms, out: T): T {
  let i = 0;
  for (const k of FrameUniforms.fields) i = put(out, i, u[k]);
  i = putEye(out, i, u.left);
  i = putEye(out, i, u.right);
  i = putBrow(out, i, u.browLeft);
  putBrow(out, i, u.browRight);
  return out;
}
