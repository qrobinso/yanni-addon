// MediaPipe Tasks Vision outputs → the FrameDetections contract (the TS stand-in for the Swift app's VisionDetector
// conversions). Pure functions, no MediaPipe import: landmarks come in as plain {x, y, z, visibility} arrays in
// MediaPipe's normalised image space (origin top-left, the camera's own unmirrored view) and leave in the viewer frame
// (upright, mirrored for the front camera). See MAPPING.md for every field and its caveats.
import type { V2 } from '../../core/vec';
import { CameraGeometry } from '../CameraGeometry';
import { EyeContact, m3mul, m3transpose, type M3 } from '../EyeContact';
import type { HeadPoseFrame } from '../EyeContact';
import {
  BodyJointName, HandJointName, NRect, type BodyDetection, type CameraIntrinsics, type Chirality, type EyeGazeEstimate,
  type EyeObservation, type HandDetection, type HeadPose, type Joint, type MotionGrid, makeBodyDetection,
} from '../PerceptionTypes';

/** The shape of a MediaPipe NormalizedLandmark we read. */
export interface Landmark { x: number; y: number; z?: number; visibility?: number }
/** MediaPipe Category (blendshapes, handedness). */
export interface Category { categoryName: string; score: number }

const vx = (x: number, mirrored: boolean): number => mirrored ? 1 - x : x;
const viewerPoint = (l: Landmark, mirrored: boolean): V2 => ({ x: vx(l.x, mirrored), y: l.y });

// MARK: - Face

/** Face mesh indices (subject's right eye = image left on the unmirrored frame). */
export const FaceMesh = {
  rightEye: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  leftEye: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  rightIris: 468,
  leftIris: 473,
} as const;

/** The face box (viewer frame): the landmarks' extent (forehead to chin, cheek to cheek). */
export function faceBox(lm: readonly Landmark[], mirrored: boolean): NRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of lm) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  return NRect.make(mirrored ? 1 - x1 : x0, y0, x1 - x0, y1 - y0);
}

/// MediaPipe's facial transformation matrix (4×4, column-major, OpenGL camera: x right on the unmirrored image, y up,
/// z toward the viewer; the canonical face looks along +z) → the camera-relative head rotation in the viewer-frame
/// camera space (x viewer's right, y down, z toward the room; a face looks along −z). Row-major 3×3.
export function headRotation(matrix: readonly number[], mirrored: boolean): M3 {
  // S = diag(sx, −1, −1) maps both the camera axes and the face model's axes; R' = S·R·S stays a proper rotation.
  const s = [mirrored ? -1 : 1, -1, -1];
  const r: M3 = new Array(9);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) r[row * 3 + col] = s[row] * s[col] * matrix[col * 4 + row];
  return r;
}

/// The `EyeContact.rotation` Euler angles (R = Ry(yaw)·Rx(pitch)·Rz(roll)) of a row-major rotation.
export function eulerAngles(m: M3): HeadPose {
  return { yaw: Math.atan2(-m[2], m[8]), pitch: Math.asin(Math.min(Math.max(-m[5], -1), 1)), roll: Math.atan2(m[3], m[4]) };
}

/// Head pose in the configured frame. `cameraRelative` is MediaPipe's own; `composed` (Vision's, the default) removes
/// the rotation of the line from the face to the lens: R_composed = rayFrame(head)ᵀ · R_camera.
export function headPose(matrix: readonly number[], faceCentre: V2, k: CameraIntrinsics, mirrored: boolean,
  frame: HeadPoseFrame): HeadPose {
  let r = headRotation(matrix, mirrored);
  if (frame === 'composed') r = m3mul(m3transpose(EyeContact.rayFrame(new CameraGeometry(k).ray(faceCentre))), r);
  return eulerAngles(r);
}

function eyeStats(lm: readonly Landmark[], idx: readonly number[], iris: number, w: number, h: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of idx) {
    const x = lm[i].x * w, y = lm[i].y * h;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const px = lm[iris].x * w, py = lm[iris].y * h;
  const hx = Math.max((x1 - x0) / 2, 1), hy = Math.max((y1 - y0) / 2, 1);
  return { off: { x: (px - (x0 + x1) / 2) / hx, y: (py - (y0 + y1) / 2) / hy }, w: x1 - x0,
    open: (y1 - y0) / Math.max(x1 - x0, 1), pupil: { x: px, y: py } };
}

/// Pupil-in-eye offset (both eyes averaged), eye width, openness and the interocular distance, as `VisionDetector.eyes`
/// computes them (upright image pixels, then the mirror on x). The iris centres (468, 473) are the pupils.
export function eyes(lm: readonly Landmark[], imageSize: V2, mirrored: boolean): { eyes: EyeObservation; interocularPx: number } | null {
  if (lm.length < 478) return null;   // no iris refinement
  const a = eyeStats(lm, FaceMesh.leftEye, FaceMesh.leftIris, imageSize.x, imageSize.y);
  const b = eyeStats(lm, FaceMesh.rightEye, FaceMesh.rightIris, imageSize.x, imageSize.y);
  const off = { x: (a.off.x + b.off.x) / 2, y: (a.off.y + b.off.y) / 2 };
  if (mirrored) off.x = -off.x;
  // shortcut: no per-point precision from MediaPipe; Vision's own fallback (0.8). Upgrade if a landmark score appears.
  return {
    eyes: { pupilOffset: off, eyeWidthPx: (a.w + b.w) / 2, confidence: 0.8, openness: (a.open + b.open) / 2 },
    interocularPx: Math.hypot(a.pupil.x - b.pupil.x, a.pupil.y - b.pupil.y),
  };
}

/// Eye-in-head angles from the eyeLook* blendshapes (the Swift `EyeGazeEstimating` seam's recipe: yaw ≈ 30° × (out − in)
/// per eye with its sign, pitch ≈ 20° × (down − up)). Blendshapes are the subject's own sides on an unmirrored image.
// port-note: the seam's doc writes pitch as (lookUp − lookDown); pitch + is down here, so it is (down − up).
export function blendshapeGaze(cats: readonly Category[], mirrored: boolean): EyeGazeEstimate | null {
  const b: Record<string, number> = {};
  for (const c of cats) b[c.categoryName] = c.score;
  if (b.eyeLookInLeft === undefined) return null;
  // Toward the subject's own right: the left eye looks in, the right eye looks out.
  const right = ((b.eyeLookInLeft - b.eyeLookOutLeft) + (b.eyeLookOutRight - b.eyeLookInRight)) / 2;
  const down = ((b.eyeLookDownLeft - b.eyeLookUpLeft) + (b.eyeLookDownRight - b.eyeLookUpRight)) / 2;
  const blink = Math.max(b.eyeBlinkLeft ?? 0, b.eyeBlinkRight ?? 0);
  return { yaw: (mirrored ? 1 : -1) * right * 30 * Math.PI / 180, pitch: down * 20 * Math.PI / 180,
    confidence: Math.max(0, 1 - blink), source: 'mediaPipe' };
}

// MARK: - Hands

const inFrame = (l: Landmark): boolean => l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1;

/// MediaPipe's 21 hand landmarks are Vision's 21 joints in the same order (thumb MCP = Vision's thumbMP). MediaPipe
/// labels handedness as if the image were mirrored (a selfie view); we feed the camera's own view, so the label is the
/// other hand: "Left" is the person's right hand.
export function hand(lm: readonly Landmark[], handedness: readonly Category[], mirrored: boolean): HandDetection {
  const joints: Partial<Record<HandJointName, Joint>> = {};
  // shortcut: hand landmarks carry no per-joint score; off-image (extrapolated) joints get 0.2, the rest 0.9.
  HandJointName.allCases.forEach((n, i) => { const l = lm[i]; if (l) joints[n] = { p: viewerPoint(l, mirrored), c: inFrame(l) ? 0.9 : 0.2 }; });
  const top = handedness[0];
  const chirality: Chirality | null = top ? (top.categoryName === 'Left' ? 'right' : 'left') : null;
  return { joints, chirality, confidence: top?.score ?? 0.5 };
}

// MARK: - Body

/** BlazePose landmark indices (the person's own left / right). */
const POSE: Partial<Record<BodyJointName, number>> = {
  nose: 0, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
};
const UPPER_BODY = Array.from({ length: 25 }, (_, i) => i);   // face, arms, hands, hips (knees and ankles excluded)

const mid = (a: Joint, b: Joint): Joint => ({ p: { x: (a.p.x + b.p.x) / 2, y: (a.p.y + b.p.y) / 2 }, c: Math.min(a.c, b.c) });

/// One pose → an upper-body box (Vision's `upperBodyOnly` rectangle has no MediaPipe equivalent: it is the extent of
/// the visible upper-body landmarks, grown 10 % and raised to the top of the head) and, when `withJoints`, the 11
/// joints (neck = shoulder midpoint, root = hip midpoint, visibility as confidence). Null when too little is visible.
export function body(lm: readonly Landmark[], mirrored: boolean, withJoints: boolean, minVisibility = 0.5): BodyDetection | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sum = 0, n = 0;
  for (const i of UPPER_BODY) {
    const l = lm[i];
    if (!l || (l.visibility ?? 0) < minVisibility) continue;
    const x = vx(l.x, mirrored);
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (l.y < y0) y0 = l.y; if (l.y > y1) y1 = l.y;
    sum += l.visibility ?? 0; n++;
  }
  if (n < 3) return null;
  const nose = lm[0], ls = lm[11], rs = lm[12];
  // The head's top sits about half a shoulder-to-nose height above the nose.
  if (nose && ls && rs) y0 = Math.min(y0, nose.y - 0.6 * Math.max((ls.y + rs.y) / 2 - nose.y, 0));
  const padX = (x1 - x0) * 0.1, padY = (y1 - y0) * 0.1;
  const bx0 = Math.max(0, x0 - padX), by0 = Math.max(0, y0 - padY);
  const box = NRect.make(bx0, by0, Math.min(1, x1 + padX) - bx0, Math.min(1, y1 + padY) - by0);
  const joints: Partial<Record<BodyJointName, Joint>> = {};
  if (withJoints) {
    for (const [name, i] of Object.entries(POSE) as [BodyJointName, number][]) {
      const l = lm[i];
      if (l) joints[name] = { p: viewerPoint(l, mirrored), c: l.visibility ?? 0 };
    }
    if (joints.leftShoulder && joints.rightShoulder) joints.neck = mid(joints.leftShoulder, joints.rightShoulder);
    if (joints.leftHip && joints.rightHip) joints.root = mid(joints.leftHip, joints.rightHip);
  }
  return makeBodyDetection(box, { confidence: sum / n, joints });
}

// MARK: - Pixels (motion map, torso colour), from a small RGBA copy of the frame

/** A downscaled RGBA frame (the camera's own unmirrored, upright view). */
export interface SmallFrame { data: Uint8ClampedArray | Uint8Array; width: number; height: number }

const luma = (d: SmallFrame['data'], i: number): number => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
function pixel(f: SmallFrame, p: V2, mirrored: boolean): number {
  const u = mirrored ? 1 - p.x : p.x;
  const px = Math.min(Math.max(Math.trunc(u * f.width), 0), f.width - 1), py = Math.min(Math.max(Math.trunc(p.y * f.height), 0), f.height - 1);
  return (py * f.width + px) * 4;
}

/// `LumaReader.grid`: mean luma per cell (0…1), row-major, sampled 3×3 per cell, in the viewer frame.
export function lumaGrid(f: SmallFrame, mirrored: boolean, cols = 32, rows = 24, exposureChanged = false): MotionGrid {
  const out = new Array<number>(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          sum += luma(f.data, pixel(f, { x: (c + (sx + 0.5) / 3) / cols, y: (r + (sy + 0.5) / 3) / rows }, mirrored));
        }
      }
      out[r * cols + c] = sum / 9 / 255;
    }
  }
  return { cols, rows, luma: out, exposureChanged };
}

/// `LumaReader.histogram`: a coarse torso colour histogram (6 hue sectors on Cb/Cr + dark + light), normalised.
/// Cb/Cr come from RGB (BT.601 full range, what the 420f planes hold).
export function torsoHistogram(f: SmallFrame, box: NRect, mirrored: boolean): number[] | null {
  const t = NRect.make(box.x + box.w * 0.25, box.y + box.h * 0.45, box.w * 0.5, box.h * 0.4);
  const bins = new Array<number>(8).fill(0);
  for (let sy = 0; sy < 8; sy++) {
    for (let sx = 0; sx < 8; sx++) {
      const p = { x: t.x + t.w * (sx + 0.5) / 8, y: t.y + t.h * (sy + 0.5) / 8 };
      if (!(p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1)) continue;
      const i = pixel(f, p, mirrored), d = f.data;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const y = (0.299 * R + 0.587 * G + 0.114 * B) / 255;
      const cb = -0.168736 * R - 0.331264 * G + 0.5 * B, cr = 0.5 * R - 0.418688 * G - 0.081312 * B;
      if (Math.sqrt(cb * cb + cr * cr) < 12) { bins[y < 0.4 ? 6 : 7] += 1; continue; }
      const a = Math.atan2(cr, cb) + Math.PI;
      bins[Math.min(Math.trunc(a / (2 * Math.PI) * 6), 5)] += 1;
    }
  }
  const total = bins.reduce((s, v) => s + v, 0);
  return total > 0 ? bins.map((v) => v / total) : null;
}
