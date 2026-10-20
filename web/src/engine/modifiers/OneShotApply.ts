// Port of FaceEngine/Modifiers/OneShotApply.swift.
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';

/// Motion-phase half of the one-shot system: folds `s.oneShot` (sampled by OneShotSampler) into the frame
/// accumulators. The gaze override is read directly by Attention from `s.oneShot.gaze`.
export class OneShotApply implements Modifier {
  readonly name = 'OneShotApply';
  readonly phase = Phase.motion;
  isEnabled = true;

  update(s: FaceState): void {
    const o = s.oneShot;
    s.delta.addInPlace(o.delta);
    s.stageOffset = { x: s.stageOffset.x + o.stageOffset.x, y: s.stageOffset.y + o.stageOffset.y };
    const e = s.eyeStageOffset, oe = o.eyeStageOffset;
    s.eyeStageOffset = { x: e.x + oe.x, y: e.y + oe.y, z: e.z + oe.z, w: e.w + oe.w };
    s.faceScaleMul = { x: s.faceScaleMul.x * o.faceScaleMul.x, y: s.faceScaleMul.y * o.faceScaleMul.y };
    const m = s.eyeScaleMul, om = o.eyeScaleMul;
    s.eyeScaleMul = { x: m.x * om.x, y: m.y * om.y, z: m.z * om.z, w: m.w * om.w };
    const l = s.lidCoverage, ol = o.lidCoverage;
    s.lidCoverage = { x: l.x + ol.x, y: l.y + ol.y, z: l.z + ol.z, w: l.w + ol.w };
    s.blink = o.blink >= s.blink ? o.blink : s.blink; // Swift max(s.blink, o.blink)
    s.lidClose = o.lidClose >= s.lidClose ? o.lidClose : s.lidClose;
    s.brightness *= o.brightnessMul;
    s.pupilSizeMul = { x: s.pupilSizeMul.x * o.pupilSizeMul.x, y: s.pupilSizeMul.y * o.pupilSizeMul.y };
    // Brow tracks are channel-free (summed); the brow intensity scales their amplitude.
    const bi = Number.isFinite(s.browIntensity) ? Math.min(Math.max(s.browIntensity, 0), 2) : 1;
    const bd = s.browDelta.raw, ob = o.browDelta.raw;
    for (let i = 0; i < bd.length; i++) bd[i] += ob[i] * bi;
    // The silhouette is owned outright (never combined).
    s.pupilShape = { ...o.pupilShape };
    s.pupilMorph = { ...o.pupilMorph };
    s.pupilShapeScale = { ...o.pupilShapeScale };
  }
}
