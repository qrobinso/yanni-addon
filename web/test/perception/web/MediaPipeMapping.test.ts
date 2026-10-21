import { describe, expect, test } from 'vitest';
import { CameraGeometry } from '../../../src/perception/CameraGeometry';
import { EyeContact, type M3 } from '../../../src/perception/EyeContact';
import { CameraIntrinsics, CameraStatus, HandJointName } from '../../../src/perception/PerceptionTypes';
import {
  FaceMesh, blendshapeGaze, body, eulerAngles, eyes, faceBox, hand, headPose, headRotation, lumaGrid, torsoHistogram,
  type Landmark,
} from '../../../src/perception/web/MediaPipeMapping';
import { cameraErrorStatus, defaultCameraOffset, interfaceOrientation } from '../../../src/perception/web/startPerception';

const deg = Math.PI / 180;
const k = CameraIntrinsics.fromFieldOfView(1280, 960, 80);

/** A row-major MediaPipe-camera rotation (x right on the unmirrored image, y up, z toward the viewer) → its 4×4
 *  column-major `data`, as `facialTransformationMatrixes` holds it (translation 40 cm in front). */
function mpMatrix(r: M3): number[] {
  const d = new Array(16).fill(0);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) d[col * 4 + row] = r[row * 3 + col];
  d[14] = -40; d[15] = 1;
  return d;
}
const mpRy = (a: number): M3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const mpRx = (a: number): M3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const mpRz = (a: number): M3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

describe('head pose from the transformation matrix', () => {
  test('identity is a frontal face', () => {
    const p = eulerAngles(headRotation(mpMatrix([1, 0, 0, 0, 1, 0, 0, 0, 1]), true));
    expect(p.yaw).toBeCloseTo(0); expect(p.pitch).toBeCloseTo(0); expect(p.roll).toBeCloseTo(0);
  });

  test('turning to the person\'s own right is yaw + on the mirrored front camera, − unmirrored', () => {
    // On the unmirrored image the person's right is image left: the face's +z turns toward −x.
    const m = mpMatrix(mpRy(-20 * deg));
    expect(eulerAngles(headRotation(m, true)).yaw).toBeCloseTo(20 * deg);
    expect(eulerAngles(headRotation(m, false)).yaw).toBeCloseTo(-20 * deg);
  });

  test('tipping the head down is pitch +', () => {
    expect(eulerAngles(headRotation(mpMatrix(mpRx(15 * deg)), true)).pitch).toBeCloseTo(15 * deg);
  });

  test('a clockwise tilt in the viewer frame is roll +', () => {
    // The head's top moves toward the person's own right (image left unmirrored, viewer right mirrored).
    expect(eulerAngles(headRotation(mpMatrix(mpRz(10 * deg)), true)).roll).toBeCloseTo(10 * deg);
  });

  test('round trip through EyeContact.rotation', () => {
    const want = { yaw: 0.3, pitch: -0.2, roll: 0.1 };
    const p = eulerAngles(EyeContact.rotation(want));
    expect(p.yaw).toBeCloseTo(want.yaw); expect(p.pitch).toBeCloseTo(want.pitch); expect(p.roll).toBeCloseTo(want.roll);
  });

  test('composed: a face at the image edge looking into the lens reads 0; camera-relative reads the ray angle', () => {
    const centre = { x: 0.85, y: 0.3 };
    // The facing direction is −ray: yaw/pitch of the direction toward the camera.
    const r = new CameraGeometry(k).ray(centre);
    const a = EyeContact.angles({ x: -r.x, y: -r.y, z: -r.z });
    const ours = EyeContact.rotation({ yaw: a.x, pitch: a.y, roll: 0 });
    // Back into MediaPipe's frame (S·R·S, mirrored).
    const s = [-1, -1, -1];
    const mp: M3 = ours.map((v, i) => s[Math.trunc(i / 3)] * s[i % 3] * v);
    const composed = headPose(mpMatrix(mp), centre, k, true, 'composed');
    expect(composed.yaw).toBeCloseTo(0, 5); expect(composed.pitch).toBeCloseTo(0, 5);
    const cam = headPose(mpMatrix(mp), centre, k, true, 'cameraRelative');
    expect(cam.yaw).toBeCloseTo(a.x, 5);
    expect(Math.abs(cam.yaw)).toBeGreaterThan(20 * deg);
  });
});

/** A 478-point face: each eye a 20×10 px box (on 1280×960) with the iris shifted by `iris` half-widths. */
function faceLandmarks(iris: { x: number; y: number }): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const eye = (idx: readonly number[], irisAt: number, cx: number, cy: number) => {
    idx.forEach((i, n) => { lm[i] = { x: (cx + (n % 2 ? 10 : -10)) / 1280, y: (cy + (n % 4 < 2 ? 5 : -5)) / 960 }; });
    lm[irisAt] = { x: (cx + iris.x * 10) / 1280, y: (cy + iris.y * 5) / 960 };
  };
  eye(FaceMesh.rightEye, FaceMesh.rightIris, 600, 400);   // image left (person's right eye)
  eye(FaceMesh.leftEye, FaceMesh.leftIris, 680, 400);
  lm[10] = { x: 0.45, y: 0.3 }; lm[152] = { x: 0.55, y: 0.6 };
  return lm;
}

describe('eyes from the iris landmarks', () => {
  test('pupil offset, width, openness, interocular; the mirror flips x', () => {
    const lm = faceLandmarks({ x: 0.5, y: -0.4 });
    const m = eyes(lm, k.imageSize, true)!;
    expect(m.eyes.pupilOffset.x).toBeCloseTo(-0.5);
    expect(m.eyes.pupilOffset.y).toBeCloseTo(-0.4);
    expect(m.eyes.eyeWidthPx).toBeCloseTo(20);
    expect(m.eyes.openness).toBeCloseTo(0.5);
    expect(m.interocularPx).toBeCloseTo(80);
    expect(eyes(lm, k.imageSize, false)!.eyes.pupilOffset.x).toBeCloseTo(0.5);
  });

  test('no iris refinement → no eyes', () => {
    expect(eyes(faceLandmarks({ x: 0, y: 0 }).slice(0, 468), k.imageSize, true)).toBeNull();
  });

  test('face box is the landmark extent, mirrored', () => {
    const b = faceBox([{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.5 }], true);
    expect(b.x).toBeCloseTo(0.7); expect(b.y).toBeCloseTo(0.2); expect(b.w).toBeCloseTo(0.2); expect(b.h).toBeCloseTo(0.3);
  });

  test('blendshape gaze: looking to the person\'s own right is yaw + (mirrored), looking down pitch +', () => {
    const cats = (o: Record<string, number>) => ['eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookInRight', 'eyeLookOutRight',
      'eyeLookUpLeft', 'eyeLookDownLeft', 'eyeLookUpRight', 'eyeLookDownRight', 'eyeBlinkLeft', 'eyeBlinkRight']
      .map((categoryName) => ({ categoryName, score: o[categoryName] ?? 0 }));
    const g = blendshapeGaze(cats({ eyeLookInLeft: 0.6, eyeLookOutRight: 0.6, eyeLookDownLeft: 0.5, eyeLookDownRight: 0.5 }), true)!;
    expect(g.yaw).toBeCloseTo(0.6 * 30 * deg);
    expect(g.pitch).toBeCloseTo(0.5 * 20 * deg);
    expect(g.source).toBe('mediaPipe');
    expect(blendshapeGaze([], true)).toBeNull();
  });
});

describe('hands', () => {
  const lm: Landmark[] = Array.from({ length: 21 }, (_, i) => ({ x: 0.2 + i * 0.01, y: 0.5 }));
  test('21 joints in Vision order, mirrored, and the handedness label is the other hand', () => {
    const h = hand(lm, [{ categoryName: 'Left', score: 0.97 }], true);
    expect(Object.keys(h.joints)).toEqual([...HandJointName.allCases]);
    expect(h.joints.wrist!.p.x).toBeCloseTo(0.8);
    expect(h.joints.thumbMP!.p.x).toBeCloseTo(1 - 0.22);
    expect(h.joints.littleTip!.p.x).toBeCloseTo(1 - 0.4);
    expect(h.chirality).toBe('right');
    expect(h.confidence).toBeCloseTo(0.97);
    expect(hand(lm, [{ categoryName: 'Right', score: 0.9 }], true).chirality).toBe('left');
    expect(hand(lm, [], true).chirality).toBeNull();
  });
  test('off-image joints get a low confidence', () => {
    const off = lm.map((l, i) => i === 8 ? { ...l, x: 1.1 } : l);
    expect(hand(off, [], true).joints.indexTip!.c).toBeLessThan(0.3);
  });
});

describe('bodies from pose landmarks', () => {
  const pose = (): Landmark[] => {
    const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.9, visibility: 0.1 }));
    lm[0] = { x: 0.5, y: 0.3, visibility: 0.99 };
    lm[11] = { x: 0.6, y: 0.5, visibility: 0.9 };   // person's left shoulder: image right (unmirrored)
    lm[12] = { x: 0.4, y: 0.5, visibility: 0.8 };
    lm[23] = { x: 0.57, y: 0.8, visibility: 0.7 };
    lm[24] = { x: 0.43, y: 0.8, visibility: 0.6 };
    return lm;
  };
  test('neck and root are midpoints; sides stay the person\'s own; visibility is confidence; mirrored', () => {
    const b = body(pose(), true, true)!;
    expect(b.joints.leftShoulder!.p.x).toBeCloseTo(0.4);
    expect(b.joints.neck!.p.x).toBeCloseTo(0.5); expect(b.joints.neck!.p.y).toBeCloseTo(0.5);
    expect(b.joints.neck!.c).toBeCloseTo(0.8);
    expect(b.joints.root!.p.y).toBeCloseTo(0.8); expect(b.joints.root!.c).toBeCloseTo(0.6);
    expect(b.joints.leftWrist!.c).toBeCloseTo(0.1);
    expect(Object.keys(b.joints).sort()).toEqual(['leftElbow', 'leftHip', 'leftShoulder', 'leftWrist', 'neck', 'nose',
      'rightElbow', 'rightHip', 'rightShoulder', 'rightWrist', 'root']);
  });
  test('the box spans the visible upper body, grown and raised above the nose', () => {
    const b = body(pose(), true, false)!;
    expect(b.joints).toEqual({});
    expect(b.box.y).toBeLessThan(0.3 - 0.1);
    expect(b.box.x).toBeLessThan(0.4); expect(b.box.x + b.box.w).toBeGreaterThan(0.6);
    expect(b.box.y + b.box.h).toBeGreaterThan(0.8);
  });
  test('too little visible → no body', () => {
    const lm = pose().map((l) => ({ ...l, visibility: 0.2 }));
    expect(body(lm, true, true)).toBeNull();
  });
});

describe('pixels', () => {
  // 8×4 RGBA: left half black, right half white (the camera's own view).
  const w = 8, h = 4, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x < w / 2 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * w + x) * 4);
  test('luma grid in the viewer frame (mirrored: the white half is on the left)', () => {
    const g = lumaGrid({ data, width: w, height: h }, true, 4, 2);
    expect(g.luma.slice(0, 4).map((v) => Math.round(v))).toEqual([1, 1, 0, 0]);
    expect(lumaGrid({ data, width: w, height: h }, false, 4, 2).luma[0]).toBeCloseTo(0);
  });
  test('torso histogram: grey-scale pixels land in the dark / light bins', () => {
    const hist = torsoHistogram({ data, width: w, height: h }, { x: 0, y: 0, w: 1, h: 1 }, true)!;
    expect(hist.reduce((s, v) => s + v, 0)).toBeCloseTo(1);
    expect(hist[6] + hist[7]).toBeCloseTo(1);
  });
});

describe('camera', () => {
  test('getUserMedia errors map to camera statuses', () => {
    const err = (name: string) => Object.assign(new Error('x'), { name });
    expect(cameraErrorStatus(err('NotAllowedError'))).toEqual(CameraStatus.denied);
    expect(cameraErrorStatus(err('NotReadableError'))).toEqual(CameraStatus.unavailable('in use by another app'));
    expect(cameraErrorStatus(err('OverconstrainedError'))).toEqual(CameraStatus.unavailable('no camera'));
    expect(cameraErrorStatus(err('NotFoundError')).kind).toBe('unavailable');
    expect(cameraErrorStatus(err('AbortError')).kind).toBe('interrupted');
  });
  test('default offset: the camera above the screen centre in landscape-primary, rotated with the orientation', () => {
    // An 11-inch iPad (1194 × 834 pt): 834 / 132 in ≈ 0.160 m short side → 9.0 cm above the centre.
    const o = defaultCameraOffset(1194, 834, interfaceOrientation('landscape-primary'));
    expect(o.x).toBeCloseTo(0); expect(o.y).toBeCloseTo(-(834 / (132 / 0.0254) / 2 + 0.01));
    const flipped = defaultCameraOffset(1194, 834, interfaceOrientation('landscape-secondary'));
    expect(flipped.y).toBeCloseTo(-o.y);
    expect(Math.abs(defaultCameraOffset(834, 1194, interfaceOrientation('portrait-primary')).x)).toBeCloseTo(-o.y);
  });
});
