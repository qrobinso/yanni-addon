// The analysis loop's body (Swift PerceptionModel.analyse): drain the commands, pick the stage plan (low mode, room
// empty or the tier's), run the MediaPipe front end, then the synchronous PerceptionProcessor. It lives in the
// perception worker; the main thread only hands it frames and commands and gets back the output.
import type { V2 } from '../../core/vec';
import { CameraGeometry } from '../CameraGeometry';
import { PerceptionProcessor, type PerceptionCommand } from '../PerceptionProcessor';
import { PerceptionSettings } from '../PerceptionSettings';
import { CameraIntrinsics, type FrameDetections, type NRect, type PerceptionOutput, type PerceptionTier } from '../PerceptionTypes';
import { LowModeScheduler, StagePlan, VacancyScheduler } from '../TierPolicy';
import { MediaPipeDetector, type Delegate } from './MediaPipeDetector';

export interface PipelineInit {
  base: string;
  delegate: Delegate;
  /** PerceptionSettings fields (structured clone drops the class). */
  settings: unknown;
  cameraOffset: V2;
  tier: PerceptionTier;
  lowMode: boolean;
  mirrored: boolean;
  gazeFromBlendshapes: boolean;
}

export interface FrameRequest { bitmap: ImageBitmap; time: number; index: number; commands: PerceptionCommand[] }

export interface FrameResult {
  out: PerceptionOutput;
  /** What the front end saw (viewer frame): the demo's overlay, a future recorder. */
  detections: FrameDetections;
  /** Stage milliseconds (rects = pose, landmarks = face, hands, body, motion, logic). */
  stages: Record<string, number>;
  totalMs: number;
  /** The plan's analysis rate (the main thread's frame gate) and the capture rate it wants. */
  analysisFPS: number;
  captureFPS: number;
}

/** Commands crossed a structured clone: a settings payload comes back as a PerceptionSettings. */
export const revive = (c: PerceptionCommand): PerceptionCommand =>
  c.kind === 'settings' ? { kind: 'settings', settings: PerceptionSettings.decode(c.settings) } : c;

export class PerceptionPipeline {
  private low = new LowModeScheduler();
  private primaryRegion: NRect | null = null;
  private peopleInView = false;

  private constructor(readonly detector: MediaPipeDetector, private processor: PerceptionProcessor, private readonly init: PipelineInit) {}

  static async create(init: PipelineInit): Promise<PerceptionPipeline> {
    const detector = await MediaPipeDetector.create({ base: init.base, delegate: init.delegate });
    const processor = new PerceptionProcessor(PerceptionSettings.decode(init.settings), new CameraGeometry(undefined, init.cameraOffset), init.tier);
    processor.apply([{ kind: 'lowMode', on: init.lowMode }]);
    return new PerceptionPipeline(detector, processor, init);
  }

  async analyse(r: FrameRequest): Promise<FrameResult> {
    const t0 = performance.now();
    const p = this.processor;
    const pre = p.apply(r.commands.map(revive));
    const vacant = !p.lowMode && p.vacancy.isVacant(r.time);
    const plan = p.lowMode ? this.low.plan(r.time) : vacant ? StagePlan.vacant : StagePlan.plan(p.tier);
    const intrinsics = CameraIntrinsics.fromFieldOfView(r.bitmap.width, r.bitmap.height, p.settings.horizontalFovDegrees);   // measured by calibration (MAPPING.md)
    let det;
    try {
      det = await this.detector.detect(r.bitmap, {
        time: r.time, index: r.index, mirrored: this.init.mirrored, intrinsics, plan, primaryRegion: this.primaryRegion,
        peopleInView: this.peopleInView, headPoseFrame: p.settings.headPoseFrame,
        gazeFromBlendshapes: this.init.gazeFromBlendshapes, exposureChanged: false,
      });
    } finally {
      r.bitmap.close();
    }
    if (p.lowMode && !(det.bodies.length === 0 && det.faces.length === 0)) this.low.noteCandidate(r.time);
    const out = p.process(det);
    out.events = [...pre, ...out.events];
    const primary = out.snapshot.people.find((q) => q.id === out.snapshot.primaryID);
    if (primary) this.primaryRegion = primary.bodyBox ?? primary.faceBox;
    this.peopleInView = out.snapshot.people.length > 0;
    const ms = this.detector.timings;
    const totalMs = performance.now() - t0;
    const stages: Record<string, number> = { ...ms };
    stages.logic = Math.max(totalMs - (ms.rects + ms.landmarks + ms.hands + ms.body + ms.motion), 0);
    return { out, detections: det, stages, totalMs, analysisFPS: plan.analysisFPS,
      captureFPS: p.lowMode ? 10 : vacant ? VacancyScheduler.captureFPS : 30 };
  }
}
