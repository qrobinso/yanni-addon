// Port of the Swift app's CalibrationState (yanni/Perception/PerceptionModel.swift): the preview's calibration flow —
// estimator bias (1 m and 2 m, looking at the eyes), the 3-position head-pose frame check (looking into the lens) and
// labelled eye-contact samples for the threshold. Web addition: the camera's field of view, measured from the
// interpupillary distance at a taped distance (the browser can't read the lens).
import { DistanceEstimator } from './Distance';
import {
  BiasSolver, EyeContact, HeadPoseFrameCheck,
  type BiasResult, type BiasSample, type HeadPoseFrameCheckResult, type HeadPoseFrameCheckSample,
} from './EyeContact';
import type { PerceptionSettings } from './PerceptionSettings';
import { GazeSource, degToRad, radToDeg, type FrameDetections, type PerceptionSnapshot } from './PerceptionTypes';

export type CalibrationCapture =
  | { kind: 'none' } | { kind: 'biasNear' } | { kind: 'biasFar' } | { kind: 'frame'; index: number }
  | { kind: 'looking' } | { kind: 'notLooking' } | { kind: 'fov'; distance: number };

const f1 = (v: number): string => v.toFixed(1);

export class CalibrationState {
  capturing: CalibrationCapture = { kind: 'none' };
  captureUntil = 0;
  biasSamples: BiasSample[] = [];
  biasNearCount = 0;
  biasResult: BiasResult | null = null;
  frameSamples = new Map<number, HeadPoseFrameCheckSample>();
  frameResult: HeadPoseFrameCheckResult | null = null;
  lookingExcess: number[] = [];
  notLookingExcess: number[] = [];
  /// Web: horizontal field-of-view estimates (degrees), one per frame of the capture.
  fovSamples: number[] = [];
  fovResult: number | null = null;
  message = '';
  /// Live read-out of the primary person.
  live = '';

  constructor(readonly clock: () => number) {}

  start(c: CalibrationCapture, seconds: number): void {
    this.capturing = c;
    this.captureUntil = this.clock() + seconds;
    if (c.kind === 'fov') this.fovSamples = [];
    this.message = 'capturing…';
  }

  /// One frame's output (and, for the field of view, its raw detections).
  observe(snap: PerceptionSnapshot, settings: PerceptionSettings, det: FrameDetections | null = null): void {
    const p = snap.people.find((q) => q.id === snap.primaryID);
    if (!p) { this.live = 'nobody in view'; return; }
    this.live = `θ ${p.gazeErrorDegrees !== null ? `${f1(p.gazeErrorDegrees)}°` : '—'} / max ${p.toleranceDegrees !== null ? `${f1(p.toleranceDegrees)}°` : '—'}`
      + ` · looking ${p.lookingAtMe.toFixed(2)} · ${GazeSource.label(p.gazeSource)} · ${p.distance.toFixed(2)} m (${p.distanceSource})`
      + ` · dwell ${f1(p.dwell)}/${f1(p.dwellNeeded)} s · facing ${p.facing.toFixed(2)}`;
    const c = this.capturing;
    if (c.kind === 'none') return;
    const bias = { x: settings.estimatorBiasDegrees.x * degToRad, y: settings.estimatorBiasDegrees.y * degToRad };
    switch (c.kind) {
      case 'biasNear': case 'biasFar':
        if (p.gazeVector !== null && p.requiredVector !== null) {
          // Undo the bias already applied so the solve sees the raw estimator.
          const a = EyeContact.angles(p.gazeVector);
          this.biasSamples.push({ gaze: EyeContact.direction(a.x + bias.x, a.y + bias.y), required: p.requiredVector });
          if (c.kind === 'biasNear') this.biasNearCount += 1;
        }
        break;
      case 'frame':
        if (p.headPose !== null) this.frameSamples.set(c.index, { head: p.positionMetres, pose: p.headPose });
        break;
      case 'looking': case 'notLooking':
        if (p.gazeErrorDegrees !== null) {
          const excess = p.gazeErrorDegrees - Math.atan(settings.faceRadius / Math.max(p.distance, 0.1)) * radToDeg;
          (c.kind === 'looking' ? this.lookingExcess : this.notLookingExcess).push(excess);
        }
        break;
      case 'fov': {
        const f = det ? CalibrationState.fovFrom(det, c.distance) : null;
        if (f !== null) this.fovSamples.push(f);
        break;
      }
    }
    if (this.clock() >= this.captureUntil) this.finish();
  }

  private finish(): void {
    const c = this.capturing;
    switch (c.kind) {
      case 'biasFar': {
        const r = this.biasResult = BiasSolver.solve(this.biasSamples);
        this.message = r ? `bias yaw ${f1(r.bias.x * radToDeg)}°, pitch ${f1(r.bias.y * radToDeg)}° · residual ${f1(r.residualDegrees)}° (${r.samples} samples)`
          : 'not enough samples — stay in view and look at the eyes';
        break;
      }
      case 'biasNear': this.message = `${this.biasNearCount} samples at 1 m — now step back to about 2 m`; break;
      case 'frame':
        if (this.frameSamples.size === 3) {
          this.frameResult = HeadPoseFrameCheck.evaluate([...this.frameSamples.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s));
          const r = this.frameResult.recommended;
          this.message = r ? `${r.frame} frame, yaw sign ${r.yawSign > 0 ? '+1' : '-1'}, pitch sign ${r.pitchSign > 0 ? '+1' : '-1'} (mean error ${f1(r.meanErrorDegrees)}°)`
            : this.frameResult.spreadOK ? 'inconclusive — keep the composed default' : 'positions too close together — stand farther to each side';
        } else {
          this.message = `${this.frameSamples.size}/3 positions captured`;
        }
        break;
      case 'fov': {
        const s = [...this.fovSamples].sort((a, b) => a - b);
        this.fovResult = s.length >= 5 ? s[Math.floor(s.length / 2)] : null;
        this.message = this.fovResult !== null ? `field of view ${f1(this.fovResult)}° (${s.length} samples)`
          : 'not enough samples — face the screen at the mark, eyes open';
        break;
      }
      default: this.message = `${this.lookingExcess.length} looking / ${this.notLookingExcess.length} not-looking samples`;
    }
    this.capturing = { kind: 'none' };
  }

  /// One frame's horizontal field of view from the widest face's pupil distance at a known `distance` (metres): the
  /// focal length is ipd px × distance / 63 mm. shortcut: assumes the 63 mm adult mean (people range 54–74 mm, so
  /// ±15 %); upgrade by letting the owner enter their own IPD.
  static fovFrom(det: FrameDetections, distance: number): number | null {
    const face = det.faces.filter((f) => f.interocularPx !== null && f.interocularPx > 2).sort((a, b) => b.box.w - a.box.w)[0];
    if (!face || !(distance > 0)) return null;
    const yaw = face.headPose?.yaw ?? 0;
    const ipd = face.interocularPx! / Math.max(Math.cos(yaw), 0.5);
    const focal = ipd * distance / DistanceEstimator.interpupillaryMetres;
    return 2 * Math.atan(det.intrinsics.imageSize.x / 2 / focal) * radToDeg;
  }

  /// σ at the 1 %-false-positive point of the not-looking samples (contact ≈ excess ≤ 1.05 σ).
  get suggestedSigma(): number | null {
    if (this.notLookingExcess.length < 20) return null;
    const s = [...this.notLookingExcess].sort((a, b) => a - b);
    const p1 = s[Math.max(Math.trunc(s.length * 0.01) - 1, 0)];
    return Math.max(3, Math.min(25, p1 / 1.05));
  }

  /// Precision and recall of a σ on the labelled samples.
  precisionRecall(sigma: number): { precision: number; recall: number } | null {
    if (this.lookingExcess.length === 0 || this.notLookingExcess.length === 0) return null;
    const tp = this.lookingExcess.filter((e) => e <= 1.05 * sigma).length;
    const fp = this.notLookingExcess.filter((e) => e <= 1.05 * sigma).length;
    return { precision: tp + fp > 0 ? tp / (tp + fp) : 0, recall: tp / this.lookingExcess.length };
  }

  // MARK: Apply (Swift PerceptionModel.applyBias / applyFrameCheck / applySigma)

  /// The settings with this calibration's result applied, or null when there is none.
  applied(kind: 'bias' | 'frame' | 'sigma' | 'fov', s: PerceptionSettings): PerceptionSettings | null {
    switch (kind) {
      case 'bias': {
        const r = this.biasResult;
        return r ? s.with({ estimatorBiasDegrees: { x: r.bias.x * radToDeg, y: r.bias.y * radToDeg } }) : null;
      }
      case 'frame': {
        const c = this.frameResult?.recommended;
        return c ? s.with({ headPoseFrame: c.frame, headYawSign: c.yawSign, headPitchSign: c.pitchSign }) : null;
      }
      case 'sigma': { const v = this.suggestedSigma; return v !== null ? s.with({ eyeContactSigmaEyes: v }) : null; }
      case 'fov': return this.fovResult !== null ? s.with({ horizontalFovDegrees: this.fovResult }) : null;
    }
  }
}
