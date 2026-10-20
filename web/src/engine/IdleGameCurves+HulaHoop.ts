// Port of FaceEngine/IdleGameCurves+HulaHoop.swift.
//
// Hula hoop (idle game 10). The pupils dip, then roll in circles in opposite directions (mirror images), speeding up.
// Then the hips: both eyes swing round together in a flat orbit (a hoop seen from the front), tilting with the swing
// and stretching with the speed, the pupils sloshing a beat behind; the orbit speeds up until the hoop drops. Dizzy:
// the pupils drift on uneven, unsynced circles, heavy uneven lids, the face wobbles and sways. Then a quick head shake
// (side to side, squashing at each turn, eyes squeezed shut) and the eyes pop open, clear, with a blink.
//
// `p.side` picks the orbit direction.
// Module-level code uses plain math only (see IdleGameCurves.ts).
import { v2, type V2 } from '../core/vec';
import { ParamLayout, type EdgeGeometry, type Side } from '../model';
import { makeGazeOverride } from './Commands';
import { Ease } from './Easing';
import {
  addLids, blinkPulse, brow, brows, glide, horizontalStretch, setEyeStage, setLids, springStep, window,
  type EdgeAnticParams,
} from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { kick, setEyeScale } from './IdleGameCurves';
import type { OneShotParams } from './OneShots';

const flingOut = 0.25;
const orbitRadius: V2 = { x: 9, y: 3.5 };
const dizzy = 4.6;
const shake = 5.85;
const shakeRate = 6;
const shakeLength = 0.5;
const clear = shake + shakeLength;

export const HulaHoop = {
  duration: 7.0,
  /// Pupil roll: start, ramp, rate (rev/s) from → to over the roll.
  rollStart: 0.38,
  rollEnd: 2.5,
  rollRate: [1.3, 2.2] as readonly [number, number],
  /// Eye orbit: start, the hoop drop, rate (rev/s) from → to.
  orbitStart: 2.05,
  drop: 4.5,
  orbitRate: [1.2, 2.9] as readonly [number, number],
  /// Orbit radius (canvas units, x and y) at most; `resolve` fits x to the screen, y keeps the ratio.
  orbitRadius,
  /// How much wider the orbit flies out at full speed.
  flingOut,

  /// `e.near` = the orbit's x radius: at full fling the outer eye stays `margin` inside the screen.
  resolve(g: EdgeGeometry, e: EdgeAnticParams): void {
    const margin = 3;
    const room = (side: Side): number =>
      g.visibleHalfExtent.x - margin - (Math.abs(g.center(side).x) + g.halfSize(side).x * 1.05);
    e.near = Math.min(Math.max(Math.min(room('left'), room('right')) / (1 + flingOut), 0), orbitRadius.x);
    e.hide = 1;
  },
  /// Dizzy, the head shake (three swings of `shakeRate` Hz), the eyes clearing.
  dizzy,
  shake,
  shakeRate,
  shakeLength,
  clear,
  /// The first dizzy sway peak (the voice line), the first two shake swings, the pop up as the eyes clear.
  accents: [dizzy + 0.3, shake + 1 / (4 * shakeRate), shake + 3 / (4 * shakeRate), clear + 0.09] as readonly number[],

  /// Phase (radians) of a rate that ramps linearly from `r[0]` to `r[1]` rev/s over [a, b], constant after.
  phase(t: number, a: number, b: number, r: readonly [number, number]): number {
    const T = b - a, tau = Math.min(Math.max(t - a, 0), T);
    const ramped = r[0] * tau + (r[1] - r[0]) * tau * tau / (2 * T);
    return 2 * Math.PI * (ramped + r[1] * Math.max(t - b, 0));
  },
};

export function hulaHoop(t: number, p: OneShotParams, o: OneShotOutput): void {
  const H = HulaHoop;
  const k = p.edge.intensity, s = p.side;

  if (t < H.duration - 0.4) o.gaze = makeGazeOverride(v2(0, 0.02), 'saccade');

  // MARK: Pupil roll (mirror circles from the bottom: left one way, right the other)
  const dipIn = springStep(t - 0.05, 16, 0.6);
  const roll = glide(t, H.rollStart - 0.05, 0.3) * (1 - glide(t, H.rollEnd - 0.5, 0.5));
  const phi = H.phase(t, H.rollStart, H.rollEnd, H.rollRate);
  const rr = 0.62;
  // Before the roll the pupils dip to the bottom (the circles start there), anticipation.
  const pre = dipIn * (1 - glide(t, H.rollStart - 0.05, 0.3));
  const circleX = Math.sin(phi) * rr * roll, circleY = Math.cos(phi) * rr * roll;
  // Smaller pupils while they roll, so the circles have room to read.
  o.pupilSizeMul = v2(1 - 0.2 * roll);

  // MARK: Orbit (both eyes together)
  const orbitIn = glide(t, H.orbitStart, 0.5);
  const orbitOut = springStep(t - H.drop, 9, 0.55);
  const env = orbitIn * (1 - orbitOut);
  const th = H.phase(t, H.orbitStart, H.drop, H.orbitRate);
  const rate = H.orbitRate[0] + (H.orbitRate[1] - H.orbitRate[0]) * Math.min(Math.max((t - H.orbitStart) / (H.drop - H.orbitStart), 0), 1);
  const Rx = p.edge.near, Ry = p.edge.near * H.orbitRadius.y / H.orbitRadius.x;
  const orbX = s * Math.cos(th) * Rx * env * k, orbY = Math.sin(th) * Ry * env * k;
  // Velocity (canvas/s) for the stretch and the tilt; the radius grows with the rate a little (it's flying out).
  const vx = -s * Math.sin(th) * Rx * 2 * Math.PI * rate * env * k;
  const fling = 1 + H.flingOut * (rate - H.orbitRate[0]) / (H.orbitRate[1] - H.orbitRate[0]) * env;

  // MARK: Dizzy: uneven drifting pupils, wobble and sway
  const dz = window(t, H.dizzy - 0.05, H.dizzy + 0.3, H.shake - 0.05, H.shake + 0.05);
  const tau = t - H.dizzy;
  const wob = 7 * k * Math.sin(2 * Math.PI * 0.85 * tau) * dz;
  const sway = 3 * k * Math.sin(2 * Math.PI * 0.85 * tau - 0.9) * dz;

  // MARK: Head shake: three fast swings, squash at each turn, then clear
  const sk = t - H.shake;
  const shakeEnv = sk > 0 && sk < H.shakeLength ? Ease.bump(Math.min(sk / H.shakeLength * 0.5 + 0.5, 1)) * Math.min(sk / 0.04, 1) : 0;
  const sw = Math.sin(2 * Math.PI * H.shakeRate * sk);
  const shakeX = 7 * k * sw * shakeEnv;
  const turn = Math.abs(sw) * Math.abs(sw) * shakeEnv;
  const squeeze = window(t, H.shake - 0.12, H.shake + 0.02, H.clear - 0.08, H.clear + 0.04);
  const pop = springStep(t - H.clear, 22, 0.35) - springStep(t - (H.clear + 0.35), 8, 0.9);

  for (const e of ParamLayout.Side.allCases) {
    const m = e === 'left' ? 1 : -1; // mirror for the roll
    // Pupils: the dip, the mirrored roll, the slosh behind the orbit, the dizzy drift, centred in the shake.
    let px = m * circleX;
    let py = 0.55 * pre + circleY;
    const lag = th - 0.9;
    px -= 0.4 * s * Math.cos(lag) * env;
    py -= 0.35 * Math.sin(lag) * env;
    const f = e === 'left' ? 0.75 : 1.2, ph = e === 'left' ? 0 : 2.1, r = e === 'left' ? 0.42 : 0.3;
    px += r * Math.cos(2 * Math.PI * f * tau + ph) * dz;
    py += 0.7 * r * Math.sin(2 * Math.PI * f * tau + ph) * dz + 0.08 * dz;
    const centre = 1 - squeeze;
    o.delta.setEye(e, 'x', px * centre);
    o.delta.setEye(e, 'y', py * centre);

    // Eyes: the orbit, a little follow of the roll, the drop sag; tilt with the swing; stretch with speed.
    const posX = orbX * fling + m * circleX * 1.2 * k;
    let posY = orbY * fling + circleY * 1.2 * k;
    posY += 2 * k * window(t, H.drop, H.drop + 0.2, H.dizzy + 0.3, H.shake);
    // The dizzy eyes drift apart in height, unevenly.
    posY += m * 1.5 * k * Math.sin(2 * Math.PI * 0.6 * tau) * dz;
    setEyeStage(o, e, v2(posX, posY));
    const a = -s * 9 * k * Math.sin(th) * env + 3 * k * m * circleX;
    o.delta.setEye(e, 'angle', e === 'left' ? a : -a);
    const hs = horizontalStretch(vx, 2 * k);
    const open = 1 + 0.07 * k * pop;
    setEyeScale(o, e, v2(hs.x * open, hs.y * open));
    // Lids: heavy and uneven when dizzy, squeezed shut in the shake, wide when clear.
    const heavy = e === 'left' ? 0.32 : 0.14;
    addLids(o, e, heavy * dz + 0.42 * squeeze - 0.2 * pop, 0.12 * dz + 0.28 * squeeze - 0.08 * pop);
    brow(o, e, {
      y: (e === 'left' ? -0.05 : 0.06) * dz * k - 0.05 * squeeze + 0.08 * pop * k,
      inner: (e === 'left' ? 0.05 : -0.02) * dz - 0.06 * squeeze,
    });
  }

  // MARK: Face
  o.delta.setFace('angle', wob + 2.5 * k * s * Math.sin(th) * env);
  o.stageOffset.x = sway + shakeX;
  o.stageOffset.y = 1.5 * k * dz - 2 * k * kick(t - H.clear, 14, 0.4);
  // Squash at each turn of the shake (wider and shorter while it stops and reverses).
  const q = 0.14 * k * turn;
  o.faceScaleMul = v2(1 + q, 1 - 0.6 * q);
  // A little effort in the orbit: focused lower lids, brows up.
  const effort = window(t, H.orbitStart, H.orbitStart + 0.4, H.drop - 0.1, H.drop + 0.2);
  setLids(o, 0, 0.12 * effort);
  brows(o, { y: 0.04 * effort * k, curvature: 0.1 * effort });
  o.blink = blinkPulse(t, H.clear + 0.28, 0.06, 0.03, 0.12);
}
