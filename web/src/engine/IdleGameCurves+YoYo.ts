// Port of FaceEngine/IdleGameCurves+YoYo.swift.
//
// Yo-yo (idle game 4). The yo-yo eye (the left, or the right when `p.side` < 0) cocks up, then is thrown down on an
// imagined string: it falls faster and faster, stretched along the drop, to the bottom of the screen, where it clips a
// little (the string runs out), squashes, and climbs back up past its place on a springy overshoot. The other eye
// watches it, its pupil riding up and down with it. Throw 2 "sleeps" at the bottom (the pupil spins round) before it
// climbs. Throw 3 walks the dog: it lands on the floor and rolls outward along the bottom (tilting as it rolls), then
// the string yanks it home with a stretch, an overshoot and a wobble. A proud squint and a little hop to finish.
//
// Travel from the screen (`resolve`): `near` / `far` the left / right eye's drop (canvas units, down), `lead` /
// `omega1` the left / right eye's walk (canvas units, outward).
// Module-level code uses plain math only (see IdleGameCurves.ts).
import { v2 } from '../core/vec';
import { type EdgeGeometry, type Side } from '../model';
import { makeGazeOverride } from './Commands';
import { Ease } from './Easing';
import {
  addLids, brow, brows, glide, setEyeStage, setLids, springStep, springStepVelocity, window,
  type EdgeAnticParams,
} from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { kick, setEyeScale } from './IdleGameCurves';
import type { OneShotParams } from './OneShots';

const starts: readonly number[] = [0.6, 1.85, 3.25];
const fall = 0.3;
const walk = 0.82;
const yank = starts[2] + fall + 0.08 + walk + 0.12;
const bottoms: readonly number[] = starts.map((s) => s + fall);
const clip = 0.18;

export const YoYo = {
  duration: 6.3,
  /// Throw starts, the fall time, the sleep on throw 2.
  starts,
  fall,
  sleep: 0.32,
  /// Walking the dog: the roll out and the yank home.
  walk,
  yank,
  proud: yank + 0.5,
  bottoms,
  accents: [...bottoms, yank] as readonly number[],
  /// How far past the bottom edge the eye goes (fraction of its height).
  clip,
  /// Cocked height before each throw (canvas units up).
  cock: 4,

  resolve(g: EdgeGeometry, e: EdgeAnticParams): void {
    const drop = (s: Side): number => {
      const c = g.center(s), h = g.halfSize(s);
      return Math.min(Math.max(g.visibleHalfExtent.y - (c.y + h.y) + clip * 2 * h.y, 8), 48);
    };
    const walkOut = (s: Side): number => {
      const c = g.center(s), h = g.halfSize(s);
      return Math.min(Math.max(g.visibleHalfExtent.x - (Math.abs(c.x) + h.x) + 0.3 * h.x, 8), 22);
    };
    e.near = drop('left');
    e.far = drop('right');
    e.lead = walkOut('left');
    e.omega1 = walkOut('right');
    e.hide = 1;
  },
};

export function yoYo(t: number, p: OneShotParams, o: OneShotOutput): void {
  const Y = YoYo;
  const k = p.edge.intensity;
  const yo: Side = p.side > 0 ? 'left' : 'right';
  const watcher: Side = p.side > 0 ? 'right' : 'left';
  const D = yo === 'left' ? p.edge.near : p.edge.far;
  const W = yo === 'left' ? p.edge.lead : p.edge.omega1;
  const out = yo === 'left' ? -1 : 1; // outward, in screen x
  const r = Y.bottoms, th = Y.starts;

  if (t < Y.duration - 0.35) o.gaze = makeGazeOverride(v2(0, 0.04), 'saccade');

  // MARK: The yo-yo's height (canvas, +down) and speed: cock, fall (accelerating), stop at the bottom, climb on
  // an overshooting spring. Each throw is a delta on top of the last.
  let y = 0, v = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = th[i];
    // Cock up just before the throw (the first from rest; the later ones from the settled climb).
    const c = -Y.cock * k * (glide(t, t0 - 0.3, 0.24) - (t >= t0 ? 1 : 0));
    y += c;
    if (t >= t0 && t < r[i]) {
      const u = (t - t0) / Y.fall;
      y += (D + Y.cock * k) * u * u - Y.cock * k;
      v = 2 * (D + Y.cock * k) * u / Y.fall;
    } else if (t >= r[i]) {
      // The string catches: a small recoil bounce at the bottom.
      y -= 1.4 * k * kick(t - r[i], 30, 0.5);
      const rise = i === 1 ? r[i] + Y.sleep : (i === 2 ? Y.yank : r[i]);
      y += D * (1 - springStep(t - rise, i === 2 ? 11 : 9, i === 2 ? 0.38 : 0.42));
      v = -D * springStepVelocity(t - rise, i === 2 ? 11 : 9, i === 2 ? 0.38 : 0.42);
    }
  }
  // Walking the dog: rolls outward along the floor, then is yanked home.
  const roll = glide(t, r[2] + 0.08, Y.walk) - springStep(t - Y.yank, 10, 0.42);
  const x = out * W * roll;
  // A little bump per half turn as it rolls (the floor).
  const bumps = -1.6 * k * Math.abs(Math.sin(Math.PI * 2.2 * Ease.smoothstep((t - r[2] - 0.08) / Y.walk)))
    * window(t, r[2] + 0.1, r[2] + 0.2, Y.yank - 0.1, Y.yank);
  // Rolls: tilts with the distance (top outward), unwinds with the yank.
  const rollDeg = W / 28 * 57.3 * roll;
  o.delta.setEye(yo, 'angle', (yo === 'left' ? -1 : 1) * rollDeg * k);

  // MARK: Shape: stretched along the drop and the climb, squashed at the bottom (the string catches)
  let squash = 0;
  for (let i = 0; i < 3; i++) squash += kick(t - r[i], 26, 0.4);
  const speed = Math.min(Math.abs(v) / 220, 1);
  const sy = (1 + 0.14 * k * speed) * (1 - 0.22 * k * squash);
  const sx = (1 + 0.24 * k * squash) / Math.sqrt(1 + 0.14 * k * speed);
  setEyeScale(o, yo, v2(sx, sy));
  setEyeStage(o, yo, v2(x, y + bumps));

  // The yo-yo's pupil lags behind the motion (up as it falls, down as it climbs); it spins in the sleep and
  // leans into the roll.
  const lag = Math.min(Math.max(v / 300, -1), 1);
  const spin = window(t, r[1] + 0.02, r[1] + 0.08, r[1] + Y.sleep - 0.06, r[1] + Y.sleep);
  const a = 2 * Math.PI * 3.2 * (t - r[1]);
  const lean = window(t, r[2] + 0.05, r[2] + 0.2, Y.yank - 0.05, Y.yank + 0.1);
  o.delta.setEye(yo, 'x', 0.38 * spin * Math.sin(a) + out * 0.45 * lean);
  o.delta.setEye(yo, 'y', -0.55 * lag * (1 - spin) - 0.38 * spin * Math.cos(a) + 0.3 * lean);

  // MARK: The watcher follows the yo-yo with its pupil, nods along, is impressed by the walk and flinches at the yank
  const toYo = springStep(t - 0.05, 16, 0.7);
  const follow = Math.min(Math.max(y / Math.max(D, 1), -0.4), 1);
  const walkLook = W > 0 ? x / W : 0;
  o.delta.setEye(watcher, 'x', out * (0.5 * toYo + 0.35 * Math.abs(walkLook)));
  o.delta.setEye(watcher, 'y', (0.75 * follow + 0.05) * toYo);
  setEyeStage(o, watcher, v2(0, 0.08 * y));
  const impressed = window(t, r[2] + 0.25, r[2] + 0.5, Y.yank, Y.yank + 0.15);
  const flinch = window(t, Y.yank + 0.02, Y.yank + 0.08, Y.yank + 0.16, Y.yank + 0.36);
  addLids(o, watcher, -0.18 * impressed + 0.22 * flinch, 0.06 * flinch);
  brow(o, watcher, { y: 0.12 * k * impressed, curvature: 0.15 * impressed });

  // MARK: Face: focused through the throws; then a proud squint and a hop
  const focus = window(t, 0.2, 0.5, Y.yank - 0.1, Y.yank + 0.1);
  const happy = window(t, Y.proud - 0.05, Y.proud + 0.15, Y.duration - 0.8, Y.duration - 0.25);
  setLids(o, 0.06 * focus + 0.04 * happy, 0.1 * focus + 0.34 * happy);
  brows(o, { y: -0.03 * focus * k + 0.08 * k * happy, curvature: 0.2 * happy });
  o.stageOffset.y = -4 * k * kick(t - Y.proud, 11, 0.4);
  o.delta.setFace('angle', -out * 3 * k * happy);
}
