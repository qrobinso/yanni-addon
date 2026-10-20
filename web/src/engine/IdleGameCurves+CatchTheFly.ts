// Port of FaceEngine/IdleGameCurves+CatchTheFly.swift.
//
// Catch the fly (idle game 8). A fly only Yanni can see. A little start (the eyes perk, a brow up), then the pupils
// chase it: saccades from hop to hop with short, uneven pauses, the eyes leaning after each, a focused squint and a
// furrowed brow. It lands right in front: the pupils creep cross-eyed onto it. Wind-up: the eyes pull apart and stretch
// tall, lids wide. The clap: they slam into each other and snap shut, squashed against each other at the middle, the
// face jolting. Held shut with a squeezed tremble, then they ease apart and peek open slowly to a slit. Then:
// - Caught (`p.v1` ≥ `escapeChance`): open, a look at the catch, a proud squint and a hop.
// - Escaped: the pupils snap away mid-peek, the eyes pop wide, chase it up and off toward the edge in three darts,
//   then a deflated sigh.
//
// The saccades stay modest (it also plays under Reduce Motion). Travel from the screen (`resolve`): `near` the wind-up
// spread, `lead` / `far` the eye half widths (the squash keeps the inner edges pinned at the middle).
// Module-level code uses plain math only (see IdleGameCurves.ts).
import { v2, type V2 } from '../core/vec';
import { ParamLayout, type EdgeGeometry, type Side } from '../model';
import { makeGazeOverride } from './Commands';
import { Ease } from './Easing';
import {
  brow, brows, glide, glideVelocity, setEyeStage, setLids, springStep, window, type EdgeAnticParams,
} from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { kick, setEyeScale } from './IdleGameCurves';
import type { OneShotParams } from './OneShots';

const clap = 3.36;
const outcome = 4.72;
/// The eyes are fully shut (the voice's accent).
const shut = clap + 0.085;

export const CatchTheFly = {
  duration: 6.4,
  escapeChance: 0.5,
  /// The fly's hops (base seconds) and spots (gaze units, x toward `p.side`).
  hops: [0.04, 0.44, 0.68, 0.82, 1.2, 1.42, 1.57, 1.94, 2.2] as readonly number[],
  spots: [v2(0.45, -0.25), v2(-0.3, -0.4), v2(0.15, -0.1), v2(0.5, 0.1), v2(-0.5, -0.2), v2(-0.2, 0.15),
    v2(0.35, -0.35), v2(-0.1, -0.3), v2(0.05, 0)] as readonly V2[],
  /// It lands right in front; the pupils creep cross-eyed.
  land: 2.5,
  windUp: 2.95,
  clap,
  shut,
  peek: 4.1,
  outcome,
  /// Escape darts (base seconds) and spots.
  darts: [outcome, outcome + 0.24, outcome + 0.46] as readonly number[],
  escapeSpots: [v2(0.55, -0.4), v2(0.8, -0.58), v2(0.95, -0.72)] as readonly V2[],
  accents: [shut] as readonly number[],

  resolve(g: EdgeGeometry, e: EdgeAnticParams): void {
    const room = (side: Side): number => g.visibleHalfExtent.x - (Math.abs(g.center(side).x) + g.halfSize(side).x) - 3;
    e.near = Math.min(Math.max(Math.min(room('left'), room('right')), 0), 7);
    e.lead = g.halfSize('left').x;
    e.far = g.halfSize('right').x;
    e.hide = 1;
  },
};

const inward = (e: Side): number => (e === 'left' ? 1 : -1);

export function catchTheFly(t: number, p: OneShotParams, o: OneShotOutput): void {
  const C = CatchTheFly;
  const k = p.edge.intensity, s = p.side;
  const caught = p.v1 >= C.escapeChance;

  // MARK: Gaze: the fly's hops, in front, down at the hands, then the catch or the escape
  let flyX = 0, flyY = 0, leanX = 0, leanY = 0; // the eyes' lean springs from hop to hop
  for (let i = 0; i < C.hops.length; i++) {
    const h = C.hops[i];
    if (!(t >= h)) continue;
    const prevX = flyX, prevY = flyY;
    flyX = C.spots[i].x * s;
    flyY = C.spots[i].y + (p.v2 - 0.5) * 0.2;
    const sp = springStep(t - h, 18, 0.55);
    leanX += (flyX - prevX) * sp;
    leanY += (flyY - prevY) * sp;
  }
  if (t >= C.land) { flyX = 0; flyY = 0.06; }
  let dart = -1;
  if (t >= C.peek - 0.15) { flyX = 0; flyY = 0.32; }
  if (!caught) {
    for (let i = 0; i < C.darts.length; i++) {
      if (t >= C.darts[i]) { flyX = C.escapeSpots[i].x * s; flyY = C.escapeSpots[i].y * 1; dart = i; }
    }
  }
  const sigh = C.outcome + 0.85;
  if (t < C.duration - 0.35) {
    if (caught && t >= C.outcome + 0.4) o.gaze = makeGazeOverride(v2(s * 0.15, -0.05), 'smooth');
    else if (!caught && t >= sigh) o.gaze = makeGazeOverride(v2(s * 0.2, 0.3), 'smooth');
    else o.gaze = makeGazeOverride(v2(flyX, flyY), 'saccade');
  }

  // MARK: Chase: a start, the eyes lean after each hop, a focused squint and a furrowed brow
  const start = kick(t - 0.04, 16, 0.4);
  const chase = window(t, 0.2, 0.45, C.windUp, C.windUp + 0.15);
  leanX *= chase;
  leanY *= chase;
  // Cross-eyed onto the fly in front, held through the wind-up.
  const cross = glide(t, C.land + 0.05, 0.45) * (1 - glide(t, C.clap, 0.06));

  // MARK: Wind-up, clap, squeezed hold, peek
  const spread = p.edge.near * k;
  const wind = glide(t, C.windUp, C.clap - C.windUp - 0.1);
  // The slam: a fast spring that first reaches home at the clap (rise time 0.08 s), overshooting into the press.
  const slam = springStep(t - (C.clap - 0.08), 30, 0.5);
  const contact = springStep(t - C.clap, 34, 0.5);
  const apart = glide(t, C.peek, 0.75);
  const press = contact * (1 - apart);
  const tall = wind * (1 - slam);
  const impact = kick(t - C.clap, 26, 0.3);
  const rush = Math.min(glideVelocity(t, C.clap - 0.09, 0.09) * 0.09, 1) * (1 - contact); // stretched along the slam
  const tremble = Math.sin(2 * Math.PI * 13 * t) * window(t, C.clap + 0.12, C.clap + 0.2, C.peek - 0.1, C.peek + 0.05);
  for (const e of ParamLayout.Side.allCases) {
    const dIn = inward(e);
    const half = e === 'left' ? p.edge.lead : p.edge.far;
    const squash = 0.3 * k * press + 0.06 * k * impact;
    const x = -dIn * spread * tall + dIn * (half * squash + 1.2 * k * press + 0.35 * k * tremble);
    setEyeStage(o, e, v2(x + 2.4 * k * leanX, 1.6 * k * leanY));
    setEyeScale(o, e, v2((1 - 0.06 * k * tall) * (1 - squash) * (1 + 0.12 * k * rush),
      (1 + 0.09 * k * tall) * (1 + 0.08 * k * press + 0.05 * k * start) / (1 + 0.12 * k * rush)));
    o.delta.setEye(e, 'x', dIn * 0.75 * cross);
  }
  o.stageOffset.y = k * (-1.6 * tall + 2.4 * impact);
  o.faceScaleMul = v2(1 + 0.04 * k * impact, 1 - 0.04 * k * impact);

  // Shut at the clap, held, then a slow peek to a slit.
  let b = 0;
  if (t >= C.clap + 0.015) {
    b = Ease.inQuad((t - (C.clap + 0.015)) / 0.07); // the squashed contact shows for a frame or two
    if (t >= C.peek) b = 1 - 0.45 * Ease.smoothstep((t - C.peek) / 0.5);
    if (t >= C.outcome - 0.02) b = 0.55 * (1 - Ease.outQuad((t - (C.outcome - 0.02)) / (caught ? 0.16 : 0.05)));
  }
  o.blink = b;

  const focus = window(t, 0.3, 0.5, C.windUp, C.windUp + 0.1) + window(t, C.land, C.land + 0.2, C.clap - 0.05, C.clap);
  const wide = window(t, C.windUp, C.windUp + 0.2, C.clap - 0.04, C.clap);
  setLids(o, 0.12 * focus - 0.14 * wide, 0.16 * focus - 0.05 * wide);
  const up: Side = s > 0 ? 'right' : 'left';
  brow(o, up, { y: 0.1 * k * window(t, 0, 0.08, 0.35, 0.6), curvature: 0.12 * window(t, 0, 0.08, 0.35, 0.6) });
  brows(o, { y: k * (-0.04 * focus + 0.1 * wide - 0.05 * press), inner: -0.08 * focus - 0.06 * press });

  if (caught) {
    // A look at the catch, then a proud squint and a hop.
    const proud = window(t, C.outcome + 0.35, C.outcome + 0.55, C.duration - 0.6, C.duration - 0.2);
    setLids(o, 0.08 * proud, 0.36 * proud);
    brows(o, { y: 0.08 * k * proud, curvature: 0.22 * proud });
    o.stageOffset.y += -2.8 * k * kick(t - (C.outcome + 0.4), 11, 0.4);
    o.delta.setFace('angle', s * 5 * k * proud);
  } else {
    // It got away: wide eyes chase it off, then a deflated sigh.
    const pop = kick(t - C.outcome, 15, 0.38);
    const chaseOff = window(t, C.outcome, C.outcome + 0.06, sigh - 0.1, sigh + 0.1);
    for (const e of ParamLayout.Side.allCases) {
      setEyeScale(o, e, v2(1 / Math.sqrt(1 + 0.1 * k * pop), 1 + 0.1 * k * pop));
    }
    if (dart >= 0) {
      const d = springStep(t - C.darts[dart], 18, 0.55) * chaseOff;
      o.stageOffset.x = 3 * k * flyX * d;
      o.stageOffset.y += 2 * k * flyY * d;
    }
    setLids(o, -0.16 * chaseOff, -0.06 * chaseOff);
    brows(o, { y: 0.14 * k * chaseOff });
    const deflate = window(t, sigh, sigh + 0.3, C.duration - 0.55, C.duration - 0.15);
    setLids(o, 0.26 * deflate, 0.04 * deflate);
    brows(o, { y: -0.03 * k * deflate, inner: 0.12 * deflate });
    o.stageOffset.y += 2.2 * k * deflate;
    o.faceScaleMul = v2(o.faceScaleMul.x * (1 + 0.02 * k * deflate), o.faceScaleMul.y * (1 - 0.03 * k * deflate));
  }
}
