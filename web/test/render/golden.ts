// PyCozmo golden harness (Swift GoldenTests statics): the CPU reference of the shader geometry against PyCozmo's own
// 128 × 64 rasters. Harness conventions (all on the test side):
// - PyCozmo params verbatim (Neutral at PyCozmo's 0.8 eye scale) with `eyeScale = 1`.
// - PyCozmo treats "inner" as the eye's right side for both eyes; the right eye's inner/outer radii are swapped.
// - PIL draws inclusive of end pixels: a pixel is "on" when the 4 × 4 supersampled SDF is < 0.5 for ≥ half the samples.
// - PyCozmo truncates eye offsets to whole pixels; the harness snaps eye centre offsets the same way.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { v2 } from '../../src/core/vec';
import { makeFaceFrame, Units } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { ParamLayout, type EyeParam } from '../../src/model/ParamLayout';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { EyeSDF } from '../../src/render/EyeSDF';
import { RenderStyle } from '../../src/render/RenderStyle';
import { Viewport } from '../../src/render/Viewport';

export interface GoldenEntry { name: string; params: number[]; rows: string[] }

/// Generated from PyCozmoGolden.swift by `node scripts/pycozmo-golden.mjs`.
export const goldenEntries: GoldenEntry[] = JSON.parse(readFileSync(fileURLToPath(new URL('./pycozmo-golden.json',
  import.meta.url)), 'utf8')).entries;

export const minimumIoU = 0.85;

export function goldenPose(params: number[]): FacePose {
  const p = FacePose.zero;
  params.forEach((v, i) => p.set(i, v)); // the 43 PyCozmo params; pupil lanes stay 0 (sclera coverage only)
  const pairs: [EyeParam, EyeParam][] = [
    ['upperInnerRadiusX', 'upperOuterRadiusX'], ['upperInnerRadiusY', 'upperOuterRadiusY'],
    ['lowerInnerRadiusX', 'lowerOuterRadiusX'], ['lowerInnerRadiusY', 'lowerOuterRadiusY'],
  ];
  for (const [a, b] of pairs) {
    const t = p.eye('right', a); p.setEye('right', a, p.eye('right', b)); p.setEye('right', b, t);
  }
  for (const side of ParamLayout.Side.allCases) {
    p.setEye(side, 'centerX', Units.poseX(Math.trunc(Units.canvasX(p.eye(side, 'centerX')))));
    p.setEye(side, 'centerY', Units.poseY(Math.trunc(Units.canvasY(p.eye(side, 'centerY')))));
  }
  return p;
}

export function raster(pose: FacePose): boolean[] {
  const style = { ...RenderStyle.neutralGeometry, eyeScale: 1, roundness: 1, ovalness: 0 };
  const vp = new Viewport(v2(128, 64), 1, v2(0));
  const u = EyeGeometry.uniforms(makeFaceFrame(pose), vp, style);
  const out = new Array<boolean>(128 * 64).fill(false);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = v2(x + (sx + 0.5) / 4 - 0.5, y + (sy + 0.5) / 4 - 0.5);
          for (const e of [u.left, u.right]) {
            if (EyeSDF.visible(e, EyeSDF.local(e, u, px)).dVis < 0.5) { hits += 1; break; }
          }
        }
      }
      out[y * 128 + x] = hits >= 8;
    }
  }
  return out;
}

export const golden = (rows: string[]): boolean[] =>
  rows.flatMap((row) => [...row].flatMap((ch) => { const v = parseInt(ch, 16); return [3, 2, 1, 0].map((b) => ((v >> b) & 1) === 1); }));

export function iou(a: boolean[], b: boolean[]): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter += 1;
    if (a[i] || b[i]) uni += 1;
  }
  return uni === 0 ? 1 : inter / uni;
}
