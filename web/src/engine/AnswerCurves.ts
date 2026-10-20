// Port of FaceEngine/AnswerCurves.swift.
//
// The answers: yes, absolutely yes, no, absolutely not. Whole-face nods and shakes with overlapping action: the pupils
// lead the head, the angle lags it, the brows trail it, the lids and brows carry the meaning (a happy squint for yes,
// flattened lids and knit brows for no). Authored in base seconds and canvas units like the other one-shots. Module-level
// code stays free of OneShots.ts exports (the two modules import each other).
import { v2, v4 } from '../core/vec';
import type { Side } from '../model';
import { Track } from './Easing';
import { blinkPulse, brow, hump, px, py, setLids, stretchScale, window } from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import type { OneShotParams } from './OneShots';

/// Accent offsets (base seconds) of the four answers, measured from the curves. The voice lands its chirps here.
export const AnswerAccents = {
  nodYes: [0.19, 0.46] as readonly number[],
  nodYesBig: [0.22, 0.47, 0.71, 0.875] as readonly number[],
  shakeNo: [0.205, 0.435, 0.64] as readonly number[],
  shakeNoBig: [0.195, 0.42, 0.645, 0.90] as readonly number[],
} as const;

/// Reduce Motion keeps this fraction of the answers' movement (head travel, tilt, turn, pupil lead).
export const answerReducedMotion = 0.4;

/// Movement scale for an answer: per-trigger amplitude × request intensity × Reduce Motion.
function answerMotion(p: OneShotParams): number {
  return p.amp * p.intensity * (p.reduceMotion ? answerReducedMotion : 1);
}

/// Head-turn foreshortening for a yaw `u` (−1 … 1, + toward the viewer's right): the far eye narrows, the near eye
/// widens a touch. Additive `scaleX` deltas (left, right).
function yaw(o: OneShotOutput, u: number, far: number, near: number): void {
  o.delta.setEye('right', 'scaleX', -far * Math.max(u, 0) + near * Math.max(-u, 0));
  o.delta.setEye('left', 'scaleX', -far * Math.max(-u, 0) + near * Math.max(u, 0));
}

function pupils(o: OneShotOutput, x = 0, y = 0): void {
  o.delta.setEye('left', 'x', x); o.delta.setEye('right', 'x', x);
  o.delta.setEye('left', 'y', y); o.delta.setEye('right', 'y', y);
}

// MARK: - nodYes (0.75 s): a small lift, then two down-up bobs (3.8, then 2.7 canvas units) with a little overshoot
// settle. The pupils dip ~40 ms ahead of the head, the eyes squash slightly at each bottom, a soft happy lower-lid
// squint, a slight tilt, and the brows lift a little and trail the bobs.

const yesY = new Track([[0, 0], [0.06, -0.55], [0.19, 3.8], [0.33, -0.9], [0.46, 2.7], [0.59, -0.55], [0.67, 0.14], [0.75, 0]]);

export function nodYes(t: number, p: OneShotParams, o: OneShotOutput): void {
  const m = answerMotion(p);
  const y = yesY.value(t);
  o.delta.setFace('centerY', py(y * m));
  o.faceScaleMul = stretchScale(1 - 0.012 * y * m * (p.reduceMotion ? 0 : 1));
  const happy = window(t, 0.04, 0.2, 0.55, 0.74);
  o.delta.setFace('angle', p.side * (1.0 * happy + 0.8 * yesY.value(Math.max(t - 0.03, 0)) / 3.8) * m);
  pupils(o, 0, 0.2 * yesY.value(t + 0.04) / 3.8 * m);
  // Happy squint, a touch uneven between the eyes; the upper lids follow the head down a little.
  const lower = 0.24 * happy, asym = 0.03 * (p.v1 - 0.5) * 2 * happy;
  const upper = 0.04 * happy + 0.05 * Math.max(y, 0) / 3.8;
  o.lidCoverage = v4(upper, lower + asym, upper, lower - asym);
  // Brows: up a little into soft arches, trailing each bob (they lag the head, so they ride high on the way down).
  const trail = 0.05 * (y - yesY.value(Math.max(t - 0.06, 0))) / 3.8;
  brow(o, 'left', { y: 0.045 * happy + trail, curvature: 0.12 * happy });
  brow(o, 'right', { y: 0.055 * happy + trail, curvature: 0.1 * happy });
}

// MARK: - nodYesBig (1.05 s): a lift-and-stretch anticipation, three big, quick bobs (4.6, 4.0, 3.2) squashing at each
// bottom, then a little upward bounce with a stretch (the "yes!"), a blink of delight and a settle. Delighted squint
// and dilated pupils, the brows pop up and bounce, a lively tilt.

const bigYesY = new Track([[0, 0], [0.08, -1.0], [0.22, 4.6], [0.345, -1.0], [0.47, 4.0], [0.59, -0.9], [0.71, 3.2],
  [0.87, -2.2], [0.98, 0.45], [1.05, -0.08], [1.1, 0]]);
const bigYesSY = new Track([[0, 0], [0.08, 0.03], [0.15, 0.01], [0.23, -0.045], [0.33, 0.02], [0.48, -0.04],
  [0.58, 0.02], [0.72, -0.035], [0.85, 0.07], [0.95, -0.03], [1.03, 0.008], [1.1, 0]]);

export function nodYesBig(t: number, p: OneShotParams, o: OneShotOutput): void {
  const m = answerMotion(p);
  const y = bigYesY.value(t);
  o.delta.setFace('centerY', py(y * m));
  o.faceScaleMul = stretchScale(1 + bigYesSY.value(t) * m * (p.reduceMotion ? 0 : 1));
  const delight = window(t, 0.04, 0.18, 0.9, 1.08);
  o.delta.setFace('angle', p.side * (1.5 * delight + 1.2 * bigYesY.value(Math.max(t - 0.03, 0)) / 4.6) * m);
  pupils(o, 0, 0.22 * bigYesY.value(t + 0.035) / 4.6 * m);
  o.pupilSizeMul = v2(1 + 0.12 * window(t, 0.05, 0.25, 0.88, 1.07));
  const lower = 0.42 * delight, asym = 0.04 * (p.v1 - 0.5) * 2 * delight;
  const upper = 0.08 * delight + 0.04 * Math.max(y, 0) / 4.6;
  o.lidCoverage = v4(upper, lower + asym, upper, lower - asym);
  // A quick happy blink just after the pop.
  o.blink = blinkPulse(t, 0.9 + 0.02 * p.v2, 0.05, 0.015, 0.09);
  // Brows: up into high arches, trailing the bobs, with an extra pop on the final bounce.
  const trail = 0.05 * (y - bigYesY.value(Math.max(t - 0.05, 0))) / 4.6;
  const pop = 0.07 * hump(t, 0.87, 0.26);
  brow(o, 'left', { y: 0.08 * delight + pop + trail, curvature: 0.2 * delight, peak: -0.05 * delight });
  brow(o, 'right', { y: 0.09 * delight + pop * 1.1 + trail, curvature: 0.18 * delight, peak: -0.05 * delight });
}

// MARK: - shakeNo (0.85 s): a small opposite lean, then three easing swings (3.8, 3.5, 2.0 canvas units) and a settle.
// The pupils lead each swing by ~50 ms, the head roll lags it, the far eye foreshortens as the face turns, the head
// dips a touch, the lids flatten slightly and the brows knit a little. Gentle, not cross.

const noX = new Track([[0, 0], [0.07, -0.6], [0.21, 3.8], [0.43, -3.5], [0.63, 2.0], [0.74, -0.4], [0.80, 0.06], [0.86, 0]]);

export function shakeNo(t: number, p: OneShotParams, o: OneShotOutput): void {
  const m = answerMotion(p);
  const x = noX.value(t) * p.side;
  o.delta.setFace('centerX', px(x * m));
  o.delta.setFace('angle', 1.6 * noX.value(Math.max(t - 0.05, 0)) / 3.8 * p.side * m);
  yaw(o, noX.value(Math.max(t - 0.02, 0)) / 3.8 * p.side * m, 0.12, 0.04);
  pupils(o, 0.4 * noX.value(t + 0.05) / 3.8 * p.side * m);
  const flat = window(t, 0.03, 0.18, 0.64, 0.84);
  o.delta.setFace('centerY', py(0.5 * flat * m));
  setLids(o, 0.12 * flat, 0.05 * flat);
  // Brows a little knit (inner ends down, flatter), one a touch more than the other.
  const knitL = p.v2 < 0.5 ? 1.15 : 0.9, knitR = 2.05 - knitL;
  brow(o, 'left', { y: -0.02 * flat, rotation: -3 * flat * knitL, curvature: -0.06 * flat, inner: -0.05 * flat * knitL });
  brow(o, 'right', { y: -0.02 * flat, rotation: -3 * flat * knitR, curvature: -0.06 * flat, inner: -0.05 * flat * knitR });
}

// MARK: - shakeNoBig (1.05 s): an opposite lean, three wide, quick swings (4.7, 4.7, 4.3) and a short check back, then a
// brief firm hold with a small decisive dip ("nuh-UH") and a settle. Brows pulled down into a mock-annoyed V (with an
// extra pinch on the dip), flat lowered upper lids angled like mock offense, stronger turn and roll.

const bigNoX = new Track([[0, 0], [0.07, -0.9], [0.2, 4.7], [0.42, -4.7], [0.64, 4.3], [0.79, -1.5], [0.88, 0.2],
  [0.96, 0], [1.1, 0]]);
const bigNoY = new Track([[0, 0], [0.1, 0.25], [0.65, 0.45], [0.8, 0.2], [0.9, 1.8], [0.98, -0.3], [1.04, 0.05], [1.1, 0]]);
const bigNoSY = new Track([[0, 0], [0.8, 0], [0.9, -0.04], [0.98, 0.012], [1.04, 0], [1.1, 0]]);

export function shakeNoBig(t: number, p: OneShotParams, o: OneShotOutput): void {
  const m = answerMotion(p);
  const x = bigNoX.value(t) * p.side;
  o.delta.setFace('centerX', px(x * m));
  o.delta.setFace('centerY', py(bigNoY.value(t) * m));
  o.faceScaleMul = stretchScale(1 + bigNoSY.value(t) * m * (p.reduceMotion ? 0 : 1));
  o.delta.setFace('angle', 2.2 * bigNoX.value(Math.max(t - 0.045, 0)) / 4.7 * p.side * m);
  yaw(o, bigNoX.value(Math.max(t - 0.02, 0)) / 4.7 * p.side * m, 0.15, 0.05);
  pupils(o, 0.45 * bigNoX.value(t + 0.045) / 4.7 * p.side * m, 0.08 * window(t, 0.05, 0.2, 0.95, 1.08));
  // Stern: flat, lowered upper lids with the inner ends down (as in mock offense, softer).
  const stern = window(t, 0.03, 0.16, 0.95, 1.08);
  const pinch = hump(t, 0.92, 0.18);
  setLids(o, 0.28 * stern + 0.04 * pinch, 0.08 * stern);
  const a = 5 * stern;
  o.delta.setEye('left', 'upperLidAngle', -a);
  o.delta.setEye('right', 'upperLidAngle', a);
  // Brows: the mock-annoyed V, one a hair lower, an extra pinch on the decisive dip.
  const low: Side = p.v2 < 0.5 ? 'left' : 'right';
  const high: Side = low === 'left' ? 'right' : 'left';
  brow(o, low, { y: -0.035 * stern, rotation: -11 * stern, curvature: 0.08 * stern, inner: -0.09 * stern - 0.04 * pinch,
    outer: 0.05 * stern, peak: 0.18 * stern });
  brow(o, high, { y: -0.02 * stern, rotation: -10 * stern, curvature: 0.08 * stern, inner: -0.085 * stern - 0.035 * pinch,
    outer: 0.05 * stern, peak: 0.18 * stern });
}
