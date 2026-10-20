// Port of FaceEngine/IdleGameCurves+HideAndSeek.swift.
//
// Hide-and-seek (idle game 7). "Eyes shut, counting": the pupils glance down, the eyes squeeze shut and scrunch, the
// face tucks down and nods once per count (3–5 counts, `p.v2`, always over the same span), the last nod bigger.
// "Ready or not": a harder squeeze, then the eyes pop open tall and wide with a hop and the brows shoot up. The search:
// four darting looks (the eyes lean after each, a peering squint on every hold, one brow up). Then:
// - Found you (someone in frame at trigger, `p.edge.near` > 0, their gaze point in `p.gazeA`): the last look goes the
//   wrong way, a beat, then a whip to the person; both pupils coin-flip into exclamation marks with a tall stretch,
//   a hop and the brows high; held, flipped back, then a delighted squint and a giggle bounce.
// - Nobody (an empty room): the gaze drifts back to the middle, the face shrugs up with a tilt, puzzled brows and
//   heavy lids, drops back with a little bounce and a blink.
// Module-level code uses plain math only (see IdleGameCurves.ts).
import { v2, v4, type V2 } from '../core/vec';
import { ParamLayout, PupilShape, type Side } from '../model';
import { makeGazeOverride } from './Commands';
import { Ease } from './Easing';
import {
  blinkPulse, brow, brows, hump, setEyeStage, setLids, springStep, stretchScale, window, type EdgeAnticParams,
} from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { kick } from './IdleGameCurves';
import type { OneShotParams } from './OneShots';
import { flipHold, flipIn, flipOut, flipX, sliver } from './PupilShapeCurves';

/// The counts: first and last nod (the count number only changes the spacing).
const firstCount = 0.62;
const lastCount = 2.02;
/// The eyes pop open (the end of the closed hold).
const pop = 2.44;
/// The ending: the whip to the person or the shrug.
const end = 4.2;
const flip = end + 0.24;
const referenceCounts = 4;

const countTime = (i: number, n: number): number => firstCount + (lastCount - firstCount) * i / Math.max(n - 1, 1);
const countTimes = (n: number): number[] => Array.from({ length: n }, (_, i) => countTime(i, n));

export const HideAndSeek = {
  duration: 6.6,
  firstCount,
  lastCount,
  shut: 0.3,
  pop,
  /// The search looks (base seconds after the pop).
  looks: [0.26, 0.62, 0.98, 1.36] as readonly number[],
  end,
  flip,
  flipBack: flip + 1.0,
  referenceCounts,
  accents: [...countTimes(referenceCounts), pop] as readonly number[],

  countCount(v2: number): number { return 3 + Math.min(Math.max(Math.trunc(v2 * 3), 0), 2); },
  countTime,
  countTimes,

  /// Search look points (gaze units, x toward `p.side`), rotated by `v1`.
  points: [v2(-0.72, -0.22), v2(0.62, 0.24), v2(-0.4, 0.38), v2(0.78, -0.3), v2(0.1, -0.42)] as readonly V2[],

  /// Someone in frame: "found you" at their (calibrated) gaze point.
  resolve(person: V2 | null, p: OneShotParams, e: EdgeAnticParams): void {
    e.hide = 1;
    const q = person;
    if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) return;
    e.near = 1;
    p.gazeA = v2(Math.min(Math.max(q.x, -0.9), 0.9), Math.min(Math.max(q.y, -0.6), 0.6));
  },
};

export function hideAndSeek(t: number, p: OneShotParams, o: OneShotOutput): void {
  const H = HideAndSeek;
  const k = p.edge.intensity, s = p.side;
  const found = p.edge.near > 0;
  const n = H.countCount(p.v2);
  const pop = H.pop, end = H.end;

  // MARK: Gaze: down while counting, the search darts, then the person (or back to the middle)
  const start = Math.trunc(p.v1 * H.points.length) % H.points.length;
  let lookX = 0, lookY = 0.35;
  let lookIndex = -1;
  let leanX = 0, leanY = 0, prevX = 0, prevY = 0; // the eyes' lean, springing from look to look
  if (t >= pop) {
    lookX = 0; lookY = 0;
    for (let i = 0; i < H.looks.length; i++) {
      const d = H.looks[i];
      if (!(t >= pop + d)) continue;
      const pt = H.points[(start + i) % H.points.length];
      let qx = pt.x * s, qy = pt.y;
      // Found: the last look goes the wrong way, so the whip to the person reads.
      if (found && i === H.looks.length - 1) { qx = p.gazeA.x > 0 ? -0.7 : 0.7; qy = -0.15; }
      lookX = qx; lookY = qy;
      lookIndex = i;
      const sp = springStep(t - (pop + d), 16, 0.5);
      leanX += (qx - prevX) * sp;
      leanY += (qy - prevY) * sp;
      prevX = qx; prevY = qy;
    }
  }
  if (t < end) {
    o.gaze = makeGazeOverride(v2(lookX, lookY), 'saccade');
  } else if (found) {
    if (t < H.duration - 0.35) o.gaze = makeGazeOverride(v2(p.gazeA.x, p.gazeA.y), 'saccade');
  } else if (t < H.duration - 0.35) {
    // "Where?": a glance one way, the other, then back to the middle.
    const x = t < end + 0.45 ? 0.45 : (t < end + 0.95 ? -0.45 : 0.1);
    o.gaze = makeGazeOverride(v2(s * x, -0.12), t < end + 0.95 ? 'saccade' : 'smooth');
  }

  // MARK: Counting: shut, scrunched, tucked down, a nod per count (the last one bigger)
  const closedHold = H.shut + 0.12;
  o.blink = blinkPulse(t, H.shut, 0.12, pop - closedHold, 0.07);
  const scrunch = window(t, H.shut, H.shut + 0.14, pop - 0.03, pop + 0.08);
  const squeeze = window(t, pop - 0.24, pop - 0.08, pop - 0.03, pop + 0.08); // "ready or not": harder
  let nod = 0;
  for (let i = 0; i < n; i++) {
    const c = H.countTime(i, n);
    nod += (i === n - 1 ? 1.45 : 1) * hump(t, c, 0.26);
  }
  const tuck = window(t, H.shut, H.shut + 0.25, pop - 0.2, pop);
  // The pop: a tall stretch with a springy overshoot, wide lids, a hop.
  const popUp = kick(t - pop, 14, 0.38);
  const wide = window(t, pop, pop + 0.06, pop + 0.5, pop + 0.9);
  const sy = (1 - 0.08 * k * scrunch - 0.08 * k * squeeze) * (1 + 0.12 * k * popUp);
  const sx = (1 + 0.05 * k * scrunch + 0.06 * k * squeeze) / Math.sqrt(1 + 0.12 * k * popUp);
  o.faceScaleMul = v2(sx * (1 + 0.02 * k * nod), sy * (1 - 0.035 * k * nod));
  o.stageOffset.y = k * (2.5 * tuck + 2.6 * nod + 1.6 * squeeze - 4.5 * popUp);
  setLids(o, -0.18 * wide, -0.08 * wide);
  brows(o, {
    y: k * (-0.06 * scrunch - 0.05 * squeeze - 0.03 * nod + 0.16 * wide),
    inner: -0.08 * scrunch - 0.06 * squeeze, peak: 0.1 * wide,
  });

  // MARK: Searching: the eyes lean after each look, a peering squint on every hold, one brow up
  const searching = window(t, pop + 0.15, pop + 0.3, end - 0.05, end + 0.15);
  if (lookIndex >= 0) {
    const since = t - (pop + H.looks[lookIndex]);
    for (const e of ParamLayout.Side.allCases) {
      setEyeStage(o, e, v2(3.2 * leanX * searching * k, 2.2 * leanY * searching * k));
    }
    const peer = window(since, 0.12, 0.2, 0.3, 0.36) * searching;
    setLids(o, 0.16 * peer, 0.2 * peer);
    o.delta.setFace('angle', -s * 3 * k * leanX * searching);
  }
  const up: Side = s > 0 ? 'right' : 'left';
  brow(o, up, { y: 0.09 * k * searching, curvature: 0.16 * searching });

  if (found) {
    // MARK: Found you: the whip, exclamation pupils, a hop and high brows; then a delighted giggle
    const toward = p.gazeA.x >= 0 ? 1 : -1;
    const shown = t >= H.flip && t < H.flipBack + flipIn;
    const fx = t < H.flipBack ? flipX(t, H.flip, true) : flipX(t - H.flipBack, flipIn, false);
    if (t >= H.flip - flipIn && t < H.flipBack + flipIn + flipOut) {
      const rest = 0.95;
      const sxp = (shown ? rest : 1) * fx;
      o.pupilShape = v2(shown ? PupilShape.exclaim : PupilShape.ellipse);
      o.pupilMorph = v2(shown ? 1 : 0);
      const syp = rest + (1 - rest) * hump(t, H.flip + 0.06, 0.12);
      o.pupilShapeScale = v4(sxp, syp, sxp, syp);
    }
    const hm = window(t, end - 0.02, end + 0.06, H.flip - 0.06, H.flip); // "hm?" squint before the whip
    const aha = kick(t - H.flip, 12, 0.36);
    const high = window(t, H.flip - 0.02, H.flip + 0.06, H.flipBack, H.flipBack + 0.25);
    o.stageOffset.y += k * (-5 * aha);
    o.stageOffset.x += toward * 3 * k * high;
    const ss = stretchScale(1 + 0.1 * k * aha);
    o.faceScaleMul = v2(o.faceScaleMul.x * ss.x, o.faceScaleMul.y * ss.y);
    o.delta.setFace('angle', o.delta.face('angle') + toward * -3 * k * high);
    setLids(o, 0.18 * hm - 0.2 * high, 0.12 * hm - 0.06 * high);
    brows(o, { y: k * (-0.04 * hm + 0.17 * high), curvature: 0.2 * high });
    // Delighted: the squint and two giggle bounces.
    const happy = window(t, H.flipBack + 0.05, H.flipBack + 0.2, H.duration - 0.6, H.duration - 0.2);
    setLids(o, 0.04 * happy, 0.38 * happy);
    brows(o, { y: 0.06 * k * happy, curvature: 0.24 * happy });
    o.stageOffset.y += k * (-2.2 * hump(t, H.flipBack + 0.32, 0.24) - 1.8 * hump(t, H.flipBack + 0.6, 0.22));
  } else {
    // MARK: Nobody: a shrug (up with a tilt, puzzled brows, heavy lids), a drop with a bounce, a blink
    const shrug = springStep(t - (end + 0.1), 11, 0.55) - springStep(t - (end + 1.1), 9, 0.4);
    o.stageOffset.y += -3.6 * k * shrug;
    o.faceScaleMul = v2(o.faceScaleMul.x * (1 + 0.03 * k * shrug), o.faceScaleMul.y * (1 - 0.02 * k * shrug));
    o.delta.setFace('angle', o.delta.face('angle') + s * 10 * k * shrug);
    const meh = window(t, end + 0.15, end + 0.4, H.duration - 0.8, H.duration - 0.3);
    setLids(o, 0.22 * meh, 0.06 * meh);
    brows(o, { y: 0.08 * k * shrug, inner: 0.14 * meh, outer: -0.04 * meh });
    o.blink = Math.max(o.blink, blinkPulse(t, end + 1.45, 0.08, 0.04, 0.16));
  }
}
