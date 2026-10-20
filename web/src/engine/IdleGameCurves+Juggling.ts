// Port of FaceEngine/IdleGameCurves+Juggling.swift.
//
// Juggling (idle game 3). Each pupil is a ball and its eye the hand. Both pupils drop into the bottom of their eyes;
// the eyes cock (a little squash), then juggle, one eye after the other: a pupil is tossed from the inner bottom up in
// a parabola and falls to the outer bottom, where the eye catches it (a squash and a dip, the whole face bobbing on the
// beat), scoops it back along the bottom and tosses it again. The beat speeds up and the arcs flatten. The fumble: both
// eyes throw too soon, the balls fly inward and the pupils end up crossed at the nose; both eyes jolt wide, a startled
// blink, then the pupils drift home with a sheepish squint.
//
// `p.side` picks the eye that starts (+1 left). No screen travel.
// Module-level code uses plain math only (see IdleGameCurves.ts).
import { v2, type V2 } from '../core/vec';
import { ParamLayout, type Side } from '../model';
import { makeGazeOverride } from './Commands';
import { Ease } from './Easing';
import { blinkPulse, brows, hump, setEyeStage, setLids, springStep, window } from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { kick, setEyeScale } from './IdleGameCurves';
import type { OneShotParams } from './OneShots';

const start = 0.62;
const gaps: readonly number[] = [0.42, 0.4, 0.37, 0.34, 0.31, 0.29, 0.27, 0.25, 0.24, 0.23];
const beats: readonly number[] = (() => {
  const b = [start];
  for (const g of gaps) b.push(b[b.length - 1] + g);
  return b;
})();
const cross = beats[beats.length - 1] + 0.32;

export const Juggling = {
  duration: 5.5,
  /// The first beat (the leading eye's first toss follows its dwell).
  start,
  /// Beat to beat (alternating eyes), shortening: the juggling speeds up.
  gaps,
  /// Time a pupil spends in the hand after a catch, as a fraction of the next gap.
  dwellFrac: 0.42,
  /// Beat times: beat k belongs to eye k % 2 (0 = the leading eye); from beat 2 on, each is a catch.
  beats,
  /// The last two tosses (from the last two beats) are the fumble: the second is rushed.
  rushedDwell: 0.05,
  /// The crossed pupils meet at the nose.
  cross,
  blink: cross + 0.2,
  home: cross + 0.62,
  accents: [...beats.slice(2), cross] as readonly number[],

  /// Hand spots (pupil units, x inward): the toss from the inner bottom, the catch at the outer bottom.
  throwX: 0.5, catchX: -0.55, handY: 0.74,
  /// Apex of the first arcs (pupil units above the hand) and of the last; heights shrink as the beat speeds up.
  apexHigh: 1.7, apexLow: 1.35,
  crossSpot: { x: 1, y: -0.1 } as Readonly<V2>,

  dwell(k: number): number {
    const J = Juggling;
    if (k === J.beats.length - 1) return J.rushedDwell;
    return J.dwellFrac * J.gaps[Math.min(k, J.gaps.length - 1)];
  },

  /// The ball (pupil) of eye `j` (0 = leading) at time t: x inward, y down.
  ball(t: number, j: number): V2 {
    const J = Juggling;
    const b = J.beats, last = b.length - 1;
    const hx = J.throwX, hy = J.handY;
    const s0 = springStep(t - 0.1, 13, 0.72);
    if (t < b[j]) return v2(hx * s0, hy * s0);
    let k = j;
    while (k + 2 <= last && b[k + 2] <= t) k += 2;
    const toss = b[k] + J.dwell(k);
    const carry = (t: number): V2 => {
      if (k < 2) { const s = springStep(t - 0.1, 13, 0.72); return v2(hx * s, hy * s); }
      const u = Math.min(Math.max((t - b[k]) / (toss - b[k]), 0), 1);
      // Scooped back along the bottom: the hand dips as it carries.
      return v2(J.catchX + (J.throwX - J.catchX) * Ease.smoothstep(u), J.handY + 0.16 * Math.sin(Math.PI * u));
    };
    if (t < toss) return carry(t);
    const from = carry(toss);
    const fumble = k >= last - 1;
    const land = fumble ? J.cross : b[k + 2];
    const to = fumble ? J.crossSpot : v2(J.catchX, J.handY);
    if (t >= land) return v2(to.x, to.y); // the cross (the return is added by the curve)
    const u = (t - toss) / (land - toss);
    const speed = k / last;
    const apex = fumble ? 0.75 : J.apexHigh + (J.apexLow - J.apexHigh) * speed;
    // Ballistic: linear across, a parabola up and down.
    const px = from.x + (to.x - from.x) * u, py = from.y + (to.y - from.y) * u;
    return v2(px, py - 4 * apex * u * (1 - u));
  },
};

const inward = (e: Side): number => (e === 'left' ? 1 : -1);

export function juggling(t: number, p: OneShotParams, o: OneShotOutput): void {
  const J = Juggling;
  const k = p.edge.intensity;
  const lead: Side = p.side > 0 ? 'left' : 'right';
  const b = J.beats, last = b.length - 1;

  if (t < J.duration - 0.35) o.gaze = makeGazeOverride(v2(0, -0.02), 'saccade');

  // Startle: both eyes jolt wide and up at the cross, settle back.
  const jolt = kick(t - J.cross, 22, 0.4);
  const wide = springStep(t - J.cross, 20, 0.5) - springStep(t - J.home, 8, 0.8);
  const back = springStep(t - J.home, 8, 0.75);
  const tremble = 0.04 * Math.sin(2 * Math.PI * 11 * t) * window(t, J.cross, J.cross + 0.04, J.blink - 0.04, J.blink);
  // Cocking before the first toss: a little squash, released into the juggling.
  const cock = hump(t, J.start - 0.12, 0.36);

  for (const e of ParamLayout.Side.allCases) {
    const j = e === lead ? 0 : 1;
    const dIn = inward(e);
    let ball = J.ball(t, j);
    if (t >= J.cross) ball = v2(J.crossSpot.x * (1 - back) + tremble, J.crossSpot.y * (1 - back));
    o.delta.setEye(e, 'x', dIn * ball.x);
    o.delta.setEye(e, 'y', ball.y);

    // Every catch: a squash and a dip that give with the ball; every toss: a small upward pop.
    let squash = 0, pop = 0;
    for (let kb = j; kb <= last; kb += 2) {
      if (kb >= 2) squash += kick(t - b[kb], 30, 0.42);
      pop += kick(t - (b[kb] + J.dwell(kb)), 26, 0.5);
    }
    const q = 0.16 * k * squash + 0.06 * k * cock;
    const sy = (1 - q) * (1 + 0.05 * k * pop) * (1 + 0.06 * k * wide);
    const sx = (1 + 0.6 * q) * (1 + 0.04 * k * wide);
    setEyeScale(o, e, v2(sx, sy));
    setEyeStage(o, e, v2(0, 2.2 * k * squash - 1.4 * k * pop - 3 * k * jolt));
  }
  // The whole face bobs on each catch (the beat).
  let bob = 0;
  for (let i = 2; i <= last; i++) bob += hump(t, b[i], 0.16);
  o.stageOffset.y = 1.1 * k * bob;

  // Pupils read as small balls while juggling; they shrink with the startle.
  const juggle = window(t, 0.1, 0.4, J.cross, J.cross + 0.1);
  o.pupilSizeMul = v2((1 - 0.28 * juggle) * (1 - 0.3 * wide));

  // Face: concentration (lids in, brows knit), startled wide at the cross, then a sheepish squint.
  const focus = window(t, 0.15, 0.5, J.cross - 0.05, J.cross + 0.05);
  const shy = window(t, J.home - 0.1, J.home + 0.2, J.duration - 0.55, J.duration - 0.12);
  setLids(o, 0.1 * focus - 0.16 * wide, 0.08 * focus - 0.08 * wide + 0.28 * shy);
  brows(o, { y: -0.04 * focus * k + 0.14 * k * wide, curvature: 0.18 * wide, inner: -0.08 * focus + 0.1 * shy });
  o.delta.setFace('angle', -inward(lead) * 3.5 * k * shy);
  o.blink = blinkPulse(t, J.blink, 0.06, 0.05, 0.13);
}
