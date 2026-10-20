// Port of FaceEngine/IdleGameCurves+DanceBreak.swift.
//
// Dance break (idle game 9). The pupils coin-flip into notes and the face dips into a ready crouch. Then eight beats:
// the eyes bob in alternation, each hitting the beat with a crisp dip and a squash while the other springs up, the face
// tilting side to side toward the eye that's down (a snap through the middle, a hold at each side) and the notes
// swaying with it. From the fifth beat the face steps side to side as well. The finale: a crouch, one big bounce with
// a stretch, a squash on landing and a brow wiggle, a happy squint, and the notes flip back.
//
// The beat is `beat` (0.5 s, the `danceBeat` chirp period) at playback speed, so mood picks the tempo.
// `p.side` picks the eye that dips first.
// Module-level code uses plain math only (see IdleGameCurves.ts).
import { v2, v4 } from '../core/vec';
import { ParamLayout, PupilShape, type Side } from '../model';
import { makeGazeOverride } from './Commands';
import { Ease } from './Easing';
import { brow, brows, glide, hump, setEyeStage, setLids, springStep, stretchScale, window } from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { kick, setEyeScale } from './IdleGameCurves';
import type { OneShotParams } from './OneShots';
import { flipHold, flipIn, flipOut, flipX, shapeRest, sliver } from './PupilShapeCurves';

/// Beat period (base seconds) = `ReactionTemplates.danceBeatPeriod`, so the chirps land on the beats.
const beat = 0.5;
/// The first beat, and how many.
const first = 0.6;
const beats = 8;
/// The finale bounce: take-off (on the beat after the last), landing.
const takeOff = first + beat * beats;
const land = takeOff + 0.46;
const beatTimes: readonly number[] = Array.from({ length: beats }, (_, i) => first + beat * i);

export const DanceBreak = {
  duration: 6.0,
  beat,
  first,
  beats,
  /// The face starts stepping side to side on this beat.
  stepFrom: 4,
  takeOff,
  land,
  /// The notes flip in and back.
  noteIn: 0.16,
  noteOut: land + 0.62,
  beatTimes,
  accents: [...beatTimes, land] as readonly number[],
};

export function danceBreak(t: number, p: OneShotParams, o: OneShotOutput): void {
  const D = DanceBreak;
  const k = p.edge.intensity, s = p.side;
  const lead: Side = s > 0 ? 'left' : 'right';
  const tEndBeats = D.first + D.beat * (D.beats - 0.5);

  if (t < D.duration - 0.4) o.gaze = makeGazeOverride(v2(0, 0.02), 'saccade');

  // MARK: Beat phase: ph = 0 on the first beat, an integer on every beat.
  const ph = (t - D.first) / D.beat;
  // In over the count-in, out by the half beat after the last.
  const groove = window(t, D.first - 0.35, D.first + 0.1, tEndBeats - 0.05, tEndBeats + 0.2);
  // Bigger once the steps start.
  const big = 1 + 0.25 * glide(t, D.first + D.beat * (D.stepFrom - 0.5), 0.3);

  // Tilt: toward the eye that's down, snapping through the middle and holding at each side.
  const c = Math.cos(Math.PI * ph);
  const tilt = c * (1.5 - 0.5 * c * c) * groove;

  // Side steps from `stepFrom`: one side, the other, home before the finale (each step lands on its beat).
  let stepX = 0;
  const st = D.beatTimes[D.stepFrom];
  const stepW = 5 * k;
  stepX += stepW * springStep(t - (st - 0.14), 16, 0.5);
  stepX -= 2 * stepW * springStep(t - (st + 2 * D.beat - 0.14), 16, 0.5);
  stepX += stepW * springStep(t - (st + 4 * D.beat - 0.3), 12, 0.6);
  o.stageOffset.x = s * stepX;

  // MARK: The eyes: alternate dips, crisp on the beat (a cusp), springing up between.
  for (const e of ParamLayout.Side.allCases) {
    // Distance (in beats) from this eye's own beats (every other beat).
    const off = e === lead ? 0 : 1;
    let u = (ph - off) % 2;
    if (u < 0) u += 2;
    const d = Math.min(u, 2 - u); // 0 on its beat … 1 on the other eye's
    const dip = (1 - d) * (1 - d) * (1 - d); // a cusp on the beat: the hit
    const squash = Math.pow(1 - d, 6);
    const up = d * d; // up while the other eye hits
    const y = (4.2 * dip - 2.6 * up) * k * big * groove;
    setEyeStage(o, e, v2(0, y));
    const sq = 0.13 * k * squash * groove;
    const stretch = 0.05 * k * up * groove;
    setEyeScale(o, e, v2((1 + sq) / Math.sqrt(1 + stretch), (1 - sq) * (1 + stretch)));
    // Each eye leans with the tilt a little more than the face.
    const a = 4 * k * tilt * (e === lead ? 1 : -1) * s;
    o.delta.setEye(e, 'angle', e === 'left' ? a : -a);
    // The notes bob a beat behind their eye and sway with the tilt.
    o.delta.setEye(e, 'y', (0.22 * up - 0.12 * dip) * groove);
    o.delta.setEye(e, 'x', -0.28 * tilt * s * (e === lead ? 1 : -1) * groove);
    // Brows bob with their eye.
    brow(o, e, { y: -0.035 * dip * groove });
  }
  o.delta.setFace('angle', 7 * k * big * tilt * s);

  // MARK: Count-in crouch and the finale bounce
  const ready = window(t, 0.12, 0.45, D.first - 0.05, D.first + 0.2);
  const crouch = glide(t, D.takeOff - 0.3, 0.26) * (1 - springStep(t - D.takeOff, 30, 0.7));
  // Ballistic: up decelerating, down accelerating.
  const air = Math.min(Math.max((t - D.takeOff) / (D.land - D.takeOff), 0), 1);
  const jump = t > D.takeOff && t < D.land ? 4 * air * (1 - air) : 0;
  const landing = kick(t - D.land, 16, 0.3);
  o.stageOffset.y = (3 * ready + 7 * crouch - 15 * jump + 5 * landing) * k;
  // Speed stretch: tall leaving the ground and coming back to it, round at the top.
  const speed = t > D.takeOff && t < D.land ? Math.abs(1 - 2 * air) * Ease.smoothstep(Math.min(air, 1 - air) / 0.15) : 0;
  const sy = 1 - 0.05 * ready * k - 0.14 * crouch * k + 0.16 * speed * k - 0.18 * Math.max(landing, 0) * k;
  o.faceScaleMul = stretchScale(sy);

  // Brow wiggle: alternating, fast, from the top of the bounce through the landing.
  const wiggle = window(t, D.takeOff + 0.12, D.takeOff + 0.2, D.land + 0.35, D.land + 0.5);
  const w = Math.sin(2 * Math.PI * 7 * (t - D.takeOff - 0.12)) * wiggle;
  brow(o, 'left', { y: 0.09 * k * w });
  brow(o, 'right', { y: -0.09 * k * w });

  // Happy face throughout, a squint after the landing.
  const happy = window(t, 0.1, 0.4, D.duration - 0.7, D.duration - 0.2);
  const squint = window(t, D.land - 0.05, D.land + 0.1, D.duration - 0.8, D.duration - 0.3);
  setLids(o, 0.03 * happy, 0.1 * happy + 0.12 * squint);
  brows(o, { y: 0.05 * happy * k, curvature: 0.14 * happy + 0.06 * squint });

  // MARK: Notes: a coin flip in, a pop at the top of the bounce, a coin flip back
  const rest = shapeRest;
  const shown = t >= D.noteIn && t < D.noteOut;
  let sx: number, syN: number;
  if (t < D.noteOut - flipIn) {
    sx = (shown ? rest : 1) * flipX(t, D.noteIn, true);
    syN = 1 + (rest - 1) * Ease.smoothstep((t - (D.noteIn - flipIn)) / (flipIn + flipOut));
    const pop = 0.14 * k * hump(t, D.takeOff + 0.25, 0.4);
    sx *= 1 + pop;
    syN *= 1 + pop;
  } else {
    sx = (shown ? rest : 1) * flipX(t, D.noteOut, false);
    syN = rest + (1 - rest) * Ease.smoothstep((t - D.noteOut) / (flipIn + flipOut));
  }
  if (shown) {
    o.pupilShape = v2(PupilShape.note);
    o.pupilMorph = v2(1);
  }
  o.pupilShapeScale = v4(sx, syN, sx, syN);
  o.pupilSizeMul = v2(1 + 0.08 * happy);
}
