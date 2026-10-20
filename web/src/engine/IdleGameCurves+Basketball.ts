// Port of FaceEngine/IdleGameCurves+Basketball.swift.
//
// Basketball (idle game 2). The ball eye (the right one, or the left when `p.side` < 0) pops into a small round ball
// with no pupil and dribbles three times: pushed down, squashing on the floor, springing back up into the "hand". The
// other eye watches it, nodding with each bounce. Gather: a crouch, the watcher narrows its eye and glances at the hoop
// (the top corner). The shot: the face springs up and the ball arcs up and off that top corner. A held breath. Then:
// - Swish (`p.v1` < `swishChance`): the ball drops back in from the top, lands with a bounce and turns back into an
//   eye; both pupils pop into stars, a delighted squint and a hop.
// - Miss: the ball bonks back in off the corner on a wobbly spring (the watcher flinches), wobbles back into an eye
//   with a dazed little pupil circle, then a slow "aw" blink with sad brows.
//
// Travel from the screen (`resolve`): `near` floor drop, `far` / `hide` the corner exit (x out, y up).
// Module-level code uses plain math only (see IdleGameCurves.ts).
import { v2, v4 } from '../core/vec';
import { PupilShape, type EdgeGeometry, type Side } from '../model';
import { makeGazeOverride } from './Commands';
import { Composer } from './Composer';
import { Ease } from './Easing';
import {
  addLids, blinkPulse, brow, brows, glide, hump, mul, setEyeStage, setLids, springStep, stretchScale, window,
  type EdgeAnticParams,
} from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { kick, setEyeScale, setPupilScale } from './IdleGameCurves';
import type { OneShotParams } from './OneShots';

/// Dribble: the first push, the bounce period, three bounces.
const dribble = 0.55;
const period = 0.46;
const bounces = 3;
const shot = 2.62;
const outcome = 3.6;
const floorContacts: readonly number[] = Array.from({ length: bounces }, (_, i) => dribble + period * (0.5 + i));

export const Basketball = {
  duration: 6.0,
  swishChance: 0.6,
  dribble,
  period,
  bounces,
  shot,
  flight: 0.5,
  outcome,
  stars: 3.95,
  hand: -4,
  floorContacts,
  accents: [...floorContacts, shot, outcome] as readonly number[],

  resolve(g: EdgeGeometry, e: EdgeAnticParams): void {
    const ball: Side = 'right';
    const h = g.halfSize(ball), c = g.center(ball);
    const r = 0.62 * Math.min(h.x, h.y);
    e.lead = r;
    e.near = Math.min(Math.max(g.visibleHalfExtent.y - (c.y + r) - 5, 8), 30);
    e.far = g.visibleHalfExtent.x - Math.abs(c.x) + r + 4;
    e.hide = g.visibleHalfExtent.y + c.y + r + 4;
    // Ball scale (round), stored in the spare spring fields.
    e.omega1 = r / h.x;
    e.omega2 = r / h.y;
  },
};

export function basketball(t: number, p: OneShotParams, o: OneShotOutput): void {
  const B = Basketball;
  const k = p.edge.intensity, s = p.side;
  const ballEye: Side = s > 0 ? 'right' : 'left';
  const watcher: Side = s > 0 ? 'left' : 'right';
  const swish = p.v1 < B.swishChance;
  const F = p.edge.near, xe = p.edge.far, ye = -p.edge.hide;
  const top = B.hand, out = B.outcome;

  if (t < B.duration - 0.7) o.gaze = makeGazeOverride(v2(s * 0.08, 0.02), 'saccade');

  // MARK: Ball position (canvas, relative to the ball eye's rest; x toward the outside)
  const toHand = springStep(t - 0.15, 12, 0.6);
  let bx = 6 * toHand, by = top * toHand;
  let vy = 0;
  const dEnd = B.dribble + B.period * B.bounces;
  if (t >= B.dribble && t < dEnd) {
    const ph = (t - B.dribble) % B.period, half = B.period / 2;
    if (ph < half) {
      const u = ph / half;
      by = top + (F - top) * u * u;
      vy = 2 * (F - top) * u / half;
    } else {
      const u = (ph - half) / half;
      by = F - (F - top) * (1 - (1 - u) * (1 - u));
      vy = -2 * (F - top) * (1 - u) / half;
    }
  }
  // Gather: the ball rides the crouch; the shot arcs up and off the corner (gravity: decelerating upward).
  const crouch = glide(t, dEnd + 0.02, B.shot - dEnd - 0.02) - springStep(t - B.shot, 16, 0.42);
  const u = Math.min(Math.max((t - B.shot) / B.flight, 0), 1);
  if (t >= B.shot) {
    bx = 6 + (xe - 6) * u;
    by = top + (ye - top) * (1 - (1 - u) * (1 - u));
  }
  let ballScale = v2(1);
  if (t >= out - 0.02) {
    if (swish) {
      // Drops in through the "hoop" from straight above its place, lands with a bounce.
      bx = xe * (1 - glide(t, out - 0.02, 0.02));
      by = ye * (1 - springStep(t - out, 8, 0.42));
    } else {
      // Bonks off the corner: straight back on a wobbly spring.
      const back = springStep(t - out, 8, 0.5);
      bx = xe * (1 - back);
      by = ye * (1 - back);
      const w = 0.16 * k * kick(t - out - 0.32, 15, 0.22);
      ballScale = v2(1 + w, 1 - w);
    }
  }
  const flyX = s > 0 ? 1 : -1;

  // MARK: Ball shape: round, squash on the floor, stretch with speed, back to an eye at the end
  const ballify = springStep(t - 0.08, 14, 0.45) - springStep(t - out - 0.3, 11, 0.4);
  const round = v2(1 + (p.edge.omega1 - 1) * ballify, 1 + (p.edge.omega2 - 1) * ballify);
  let squash = 0;
  for (let i = 0; i < B.floorContacts.length; i++) squash += hump(t, B.floorContacts[i] + 0.012, 0.14);
  const speed = Math.min(Math.abs(vy) / 260, 1) + (t >= B.shot && t < B.shot + B.flight ? 0.6 * (1 - u) : 0);
  const sy = (1 - 0.42 * k * squash) * (1 + 0.2 * k * speed * ballify);
  const sx = (1 + 0.42 * k * squash) / Math.sqrt(1 + 0.2 * k * speed * ballify);
  setEyeScale(o, ballEye, mul(mul(round, v2(sx, sy)), ballScale));
  // Squashing about its centre would lift it off the floor: keep the bottom down.
  setEyeStage(o, ballEye, v2(flyX * bx, by + p.edge.lead * (1 - sy) * ballify));
  addLids(o, ballEye, -0.3 * ballify, -0.3 * ballify);
  const ballPupil = 1 - glide(t, 0.1, 0.16) + glide(t, out + 0.42, 0.14);
  setPupilScale(o, ballEye, v2(Math.max(Math.min(ballPupil, 1), Composer.minPupilShapeScale)));

  // MARK: The watcher: follows the ball with its pupil, nods with each bounce, aims, follows the shot
  const follow = Math.min(Math.max((by - top) / Math.max(F - top, 1), -1), 1);
  const toBall = springStep(t - 0.05, 18, 0.7);
  const aim = springStep(t - (dEnd + 0.18), 16, 0.6) - springStep(t - B.shot, 14, 0.6);
  const shotLook = springStep(t - B.shot, 20, 0.55) - springStep(t - (out + 0.9), 9, 0.8);
  const watchX = flyX * (0.55 * toBall * (1 - aim) * (1 - shotLook) + 0.7 * aim + 0.9 * shotLook);
  const watchY = (0.75 * follow - 0.15) * toBall * (1 - aim) * (1 - shotLook) - 0.75 * aim - 0.85 * shotLook;
  const tremble = 0.035 * Math.sin(2 * Math.PI * 9 * t) * window(t, B.shot + B.flight, B.shot + B.flight + 0.1, out - 0.05, out);
  o.delta.setEye(watcher, 'x', watchX + tremble);
  o.delta.setEye(watcher, 'y', watchY);
  const nod = t >= B.dribble && t < dEnd ? 0.12 * (by - top) : 0;
  const leanX = flyX * 3 * shotLook * k, leanY = -3 * shotLook * k;
  setEyeStage(o, watcher, v2(leanX, nod + leanY));

  // MARK: Face: crouch, spring up with the shot, held breath, then the outcome
  o.stageOffset.y = 4 * k * crouch;
  const up = kick(t - B.shot, 13, 0.35);
  o.faceScaleMul = stretchScale(1 - 0.06 * k * Math.max(crouch, 0) + 0.06 * k * up);
  o.delta.setFace('angle', flyX * -4 * k * shotLook * (1 - glide(t, out, 0.5)));
  const aimLid = window(t, dEnd + 0.15, dEnd + 0.35, B.shot, B.shot + 0.12);
  const breath = window(t, B.shot + 0.1, B.shot + 0.3, out, out + 0.12);
  addLids(o, watcher, 0.26 * aimLid - 0.14 * breath, 0.12 * aimLid);
  brow(o, watcher, { y: -0.05 * aimLid * k + 0.1 * breath * k, inner: -0.08 * aimLid + 0.08 * breath });

  if (swish) {
    // Stars, a delighted squint and a hop.
    const pop = Ease.outBack(Math.min(Math.max((t - B.stars) / 0.18, 0), 1), 2.2);
    const gone = glide(t, B.stars + 0.95, 0.2);
    const morph = Math.min(Math.max((t - B.stars) / 0.1, 0), 1) * (1 - gone);
    const starScale = t < B.stars ? 1 : (0.6 + 0.3 * pop) + (1 - (0.6 + 0.3 * pop)) * gone;
    if (morph > 0) {
      o.pupilShape = v2(PupilShape.star);
      o.pupilMorph = v2(morph);
      o.pupilShapeScale = v4(starScale);
    }
    const happy = window(t, B.stars - 0.05, B.stars + 0.15, B.duration - 1.0, B.duration - 0.4);
    setLids(o, 0.05 * happy, 0.36 * happy);
    o.stageOffset.y += -4.5 * k * kick(t - B.stars, 11, 0.4);
    brows(o, { y: 0.08 * k * happy, curvature: 0.22 * happy });
  } else {
    // Flinch at the bonk, a dazed pupil circle, then a slow "aw" blink with sad brows and a droop.
    const flinch = window(t, out + 0.25, out + 0.33, out + 0.45, out + 0.75);
    addLids(o, watcher, 0.3 * flinch, 0.2 * flinch);
    const daze = window(t, out + 0.5, out + 0.6, out + 1.1, out + 1.3);
    const a = 2 * Math.PI * 2.6 * (t - out);
    o.delta.setEye(ballEye, 'x', 0.35 * daze * Math.cos(a));
    o.delta.setEye(ballEye, 'y', 0.35 * daze * Math.sin(a));
    const sad = window(t, out + 0.9, out + 1.15, B.duration - 0.7, B.duration - 0.2);
    o.blink = blinkPulse(t, out + 1.05, 0.14, 0.12, 0.24);
    brows(o, { y: -0.03 * sad, inner: 0.13 * sad });
    o.stageOffset.y += 2.5 * k * sad;
    setLids(o, 0.12 * sad, 0);
  }
}
