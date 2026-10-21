// The MediaPipe front end: one analysed frame → FrameDetections, staged like the Swift app's VisionDetector.
//
// 1. "rectangles": the pose landmarker (lite) gives every person's upper-body box (MediaPipe has no human-rectangle
//    task); the face landmarker gives every face's box and head pose (from its transformation matrix);
// 2. eyes (iris landmarks) only for the nearest `plan.landmarkFaces` faces within `plan.landmarkMaxDistance`, as Vision's
//    landmark pass is limited; hands on even frames and body joints on odd frames, only while someone is in view;
// 3. the torso colour histograms and the motion map from a small RGBA copy of the frame.
// Runs in the perception worker (or on the main thread as a fallback). Nothing keeps a frame past `detect`.
import {
  FaceLandmarker, FilesetResolver, HandLandmarker, PoseLandmarker, type FaceLandmarkerResult, type HandLandmarkerResult,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import { DistanceEstimator } from '../Distance';
import type { HeadPoseFrame } from '../EyeContact';
import {
  NRect, makeFaceDetection, makeFrameDetections, type CameraIntrinsics, type FrameDetections,
} from '../PerceptionTypes';
import type { StagePlan } from '../TierPolicy';
import { blendshapeGaze, body, eyes, faceBox, hand, headPose, lumaGrid, torsoHistogram, type SmallFrame } from './MediaPipeMapping';

export type Delegate = 'GPU' | 'CPU';

export interface DetectorOptions {
  /** Where the tasks-vision wasm files and the .task models are served (same origin), ending in '/'. */
  base: string;
  delegate: Delegate;
  /** Run the blendshape model (only `gazeFromBlendshapes` reads it; off saves it on every face, every frame). */
  blendshapes: boolean;
}

/** One analysed frame's inputs. */
export interface DetectInput {
  /** Capture time, host seconds (the page's performance clock). */
  time: number;
  index: number;
  mirrored: boolean;
  intrinsics: CameraIntrinsics;
  plan: StagePlan;
  primaryRegion: NRect | null;
  peopleInView: boolean;
  headPoseFrame: HeadPoseFrame;
  /** Fill `FaceDetection.gaze` from the eyeLook* blendshapes (off: the iris geometry in `eyes` is the eye signal). */
  gazeFromBlendshapes: boolean;
  exposureChanged: boolean;
}

/** Per-stage milliseconds of the last frame (Swift `StageTimings` keys; `rects` is the pose landmarker). */
export interface StageTimings { rects: number; landmarks: number; hands: number; body: number; motion: number }
export const makeStageTimings = (): StageTimings => ({ rects: 0, landmarks: 0, hands: 0, body: 0, motion: 0 });

const SMALL_W = 160, SMALL_H = 120;

export class MediaPipeDetector {
  timings = makeStageTimings();
  private counts = { faces: 0, hands: 0, poses: 0 };
  private lastTs = 0;
  private small: OffscreenCanvasRenderingContext2D | null = null;

  private constructor(readonly delegate: Delegate, private readonly face: FaceLandmarker,
    private readonly hands: HandLandmarker, private readonly pose: PoseLandmarker) {}

  /** Loads the wasm runtime and the three models; the GPU delegate falls back to the CPU if it can't start. */
  static async create(o: DetectorOptions): Promise<MediaPipeDetector> {
    // A worker loads the ES-module build of the wasm loader (no classic script tags there); the page the classic one.
    const fileset = await FilesetResolver.forVisionTasks(`${o.base}mediapipe`, typeof document === 'undefined');
    const make = async (delegate: Delegate) => {
      const base = (file: string) => ({ modelAssetPath: `${o.base}models/${file}`, delegate });
      const [face, hands, pose] = await Promise.all([
        FaceLandmarker.createFromOptions(fileset, { baseOptions: base('face_landmarker.task'), runningMode: 'VIDEO',
          numFaces: 2, outputFaceBlendshapes: o.blendshapes, outputFacialTransformationMatrixes: true }),
        HandLandmarker.createFromOptions(fileset, { baseOptions: base('hand_landmarker.task'), runningMode: 'VIDEO', numHands: 2 }),
        PoseLandmarker.createFromOptions(fileset, { baseOptions: base('pose_landmarker_lite.task'), runningMode: 'VIDEO', numPoses: 2 }),
      ]);
      return new MediaPipeDetector(delegate, face, hands, pose);
    };
    if (o.delegate === 'CPU') return make('CPU');
    try { return await make('GPU'); } catch (e) {
      console.warn(`perception: GPU delegate failed (${e instanceof Error ? e.message : String(e)}), using the CPU`);
      return make('CPU');
    }
  }

  close(): void { this.face.close(); this.hands.close(); this.pose.close(); }

  /** Model limits follow the tier (only when they change: setOptions rebuilds the graph). */
  private async configure(plan: StagePlan): Promise<void> {
    const want = { faces: plan.maxPeople, hands: Math.max(plan.maxHands, 1), poses: plan.maxPeople };
    if (want.faces !== this.counts.faces) await this.face.setOptions({ numFaces: want.faces });
    if (want.hands !== this.counts.hands) await this.hands.setOptions({ numHands: want.hands });
    if (want.poses !== this.counts.poses) await this.pose.setOptions({ numPoses: want.poses });
    this.counts = want;
  }

  async detect(frame: ImageBitmap, d: DetectInput): Promise<FrameDetections> {
    await this.configure(d.plan);
    const { plan, mirrored, intrinsics: k } = d;
    const det = makeFrameDetections(d.time, { intrinsics: k, handsRan: false, bodyPoseRan: false });
    const ms = makeStageTimings();
    // detectForVideo needs strictly increasing timestamps (ms) per task.
    const ts = this.lastTs = Math.max(Math.round(d.time * 1000), this.lastTs + 1);
    const clock = () => performance.now();

    // Stage 1: people (pose) and faces. Body joints only on odd frames of a body-pose plan (Swift alternation).
    let t0 = clock();
    const poses: PoseLandmarkerResult = this.pose.detectForVideo(frame, ts);
    for (const lm of poses.landmarks) {
      const b = body(lm, mirrored, false);
      if (b) det.bodies.push(b);
    }
    ms.rects = clock() - t0;
    if (plan.rectanglesOnly) { this.finishPixels(frame, d, det, ms); return det; }

    t0 = clock();
    const faces: FaceLandmarkerResult = this.face.detectForVideo(frame, ts);
    const fx = k.focal.x;
    const order = faces.faceLandmarks.map((lm, i) => ({ i, box: faceBox(lm, mirrored) }));
    // Eyes for the nearest faces (largest boxes) within range.
    const withEyes = new Set(order.slice().sort((a, b) => b.box.w - a.box.w).slice(0, plan.landmarkFaces).filter(({ box }) => {
      const wPx = box.w * k.imageSize.x;
      return wPx > 4 && fx * DistanceEstimator.faceWidthMetres / wPx <= plan.landmarkMaxDistance;
    }).map(({ i }) => i));
    for (const { i, box } of order) {
      const lm = faces.faceLandmarks[i];
      // shortcut: the face landmarker reports no per-face score; 0.9 above its 0.5 detection threshold.
      const f = makeFaceDetection(box, { confidence: 0.9 });
      const m = faces.facialTransformationMatrixes[i];
      if (m) f.headPose = headPose(m.data, NRect.center(box), k, mirrored, d.headPoseFrame);
      if (withEyes.has(i)) {
        const e = eyes(lm, k.imageSize, mirrored);
        if (e) { f.eyes = e.eyes; f.interocularPx = e.interocularPx; }
        const bs = faces.faceBlendshapes[i];
        if (d.gazeFromBlendshapes && bs) f.gaze = blendshapeGaze(bs.categories, mirrored);
      }
      det.faces.push(f);
    }
    ms.landmarks = clock() - t0;

    // Hands (even frames) and body joints (odd frames), only while someone is in view.
    const someone = d.peopleInView || det.bodies.length > 0 || det.faces.length > 0;
    const roi = plan.gesturesPrimaryOnly && d.primaryRegion ? NRect.insetBy(d.primaryRegion, 0.25) : null;
    if (someone && plan.handPose && d.index % 2 === 0) {
      t0 = clock();
      const hs: HandLandmarkerResult = this.hands.detectForVideo(frame, ts);
      hs.landmarks.forEach((lm, i) => {
        const h = hand(lm, hs.handedness[i] ?? [], mirrored);
        // No region of interest in the hand landmarker: primary-only plans keep the hands whose wrist is in the region.
        if (h.joints.wrist && roi && !NRect.contains(roi, h.joints.wrist.p)) return;
        if (det.hands.length < plan.maxHands) det.hands.push(h);
      });
      det.handsRan = true;
      ms.hands = clock() - t0;
    } else if (someone && plan.bodyPose && d.index % 2 === 1) {
      t0 = clock();
      det.bodies.length = 0;
      for (const lm of poses.landmarks) {
        const b = body(lm, mirrored, true);
        if (!b) continue;
        if (roi && b.joints.neck && !NRect.contains(roi, b.joints.neck.p)) b.joints = {};
        det.bodies.push(b);
      }
      det.bodyPoseRan = true;
      ms.body = clock() - t0;
    }
    this.finishPixels(frame, d, det, ms);
    return det;
  }

  /** Torso histograms (association) and the motion map, from a 160×120 copy; numbers only. */
  private finishPixels(frame: ImageBitmap, d: DetectInput, det: FrameDetections, ms: StageTimings): void {
    const t0 = performance.now();
    const motion = d.plan.motionEvery > 0 && d.index % d.plan.motionEvery === 0;
    if (motion || det.bodies.length > 0) {
      this.small ??= new OffscreenCanvas(SMALL_W, SMALL_H).getContext('2d', { willReadFrequently: true });
      if (this.small) {
        this.small.drawImage(frame, 0, 0, SMALL_W, SMALL_H);
        const f: SmallFrame = this.small.getImageData(0, 0, SMALL_W, SMALL_H);
        for (const b of det.bodies) b.appearance = torsoHistogram(f, b.box, d.mirrored);
        if (motion) det.motion = lumaGrid(f, d.mirrored, 32, 24, d.exposureChanged);
      }
    }
    ms.motion = performance.now() - t0;
    this.timings = ms;
  }
}
