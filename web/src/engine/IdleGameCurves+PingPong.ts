// Port of FaceEngine/IdleGameCurves+PingPong.swift.
//
// Ping pong (idle game 1). Both eyes squash into tall, narrow paddles, spread apart and tilt inward; their pupils hide
// except one, the ball. The server winds up and whacks it: the ball slides to the server's inner edge and vanishes,
// crosses the gap unseen, appears at the receiver's inner edge, sinks into the paddle and goes back. Each paddle rises
// or dips to meet the ball. The rally speeds up until the receiver swings and whiffs: the ball runs straight through
// and out of its outer side. Snap: the paddles spring back into eyes, both pupils pop back at that side, the whiffer
// goes wide; a beat; then a sheepish squint and a glance down.
//
// `p.side` picks the server (+1 left). `p.edge.near` is the spread (canvas units each way, fitted to the screen).
// Module-level code uses plain math only (see IdleGameCurves.ts).
import { v2 } from '../core/vec';
import { ParamLayout, type EdgeGeometry, type Side } from '../model';
import { makeGazeOverride } from './Commands';
import { Composer } from './Composer';
import { Ease } from './Easing';
import {
  addLids, blinkPulse, brow, brows, glide, setEyeStage, setLids, springStep, stretchScale, window,
  type EdgeAnticParams,
} from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { kick, setEyeScale, setPupilScale } from './IdleGameCurves';
import type { OneShotParams } from './OneShots';

const serve = 0.8;
const legs: readonly number[] = [0.64, 0.58, 0.52, 0.46, 0.41, 0.37, 0.33];
const outFrac = 0.3, gapFrac = 0.33, inFrac = 0.37;
const depth = 0.55;
const contacts: readonly number[] = (() => {
  const h = [serve];
  for (const l of legs.slice(0, -1)) h.push(h[h.length - 1] + l);
  return h;
})();
const whiffIn = contacts[contacts.length - 1] + legs[legs.length - 1] * (outFrac + gapFrac);
const whiffOut = whiffIn + 2 / (1.5 * depth / (inFrac * legs[legs.length - 1]));
const snap = whiffOut + 0.06;

export const PingPong = {
  duration: 6.2,
  /// First contact (the serve).
  serve,
  /// Leg lengths (contact to contact), shortening: the rally speeds up. The last leg is the whiff.
  legs,
  /// Fractions of a leg: leaving the hitter, crossing the gap, sinking into the receiver.
  outFrac, gapFrac, inFrac,
  /// How deep the ball sinks into a paddle (pupil travel units from the inner edge).
  depth,
  /// Contacts (base seconds), the ball's arrival in the whiffer, its exit through the far side, the snap.
  contacts,
  whiffIn,
  /// The whiffed ball crosses the whole paddle (2 units) at 1.5× the rally speed.
  whiffOut,
  snap,
  sheepish: snap + 0.62,
  accents: [...contacts, snap] as readonly number[],
  paddleNarrow: 0.6,

  /// Ball heights per contact (−1 up … 1 down), varied by `v2`.
  height(k: number, v2: number): number { return 0.55 * Math.sin(k * 2.1 + v2 * 6.283); },

  resolve(g: EdgeGeometry, e: EdgeAnticParams): void {
    // Outer edge of the narrowed paddle stays `margin` inside the screen.
    const margin = 5;
    const room = (side: Side): number =>
      g.visibleHalfExtent.x - margin - (Math.abs(g.center(side).x) + g.halfSize(side).x * (1 - PingPong.paddleNarrow));
    e.near = Math.min(Math.max(Math.min(room('left'), room('right')), 0), 13);
    e.hide = 1;
  },
};

const inward = (e: Side): number => (e === 'left' ? 1 : -1);

export function pingPong(t: number, p: OneShotParams, o: OneShotOutput): void {
  const P = PingPong;
  const k = p.edge.intensity, s = p.side;
  const server: Side = s > 0 ? 'left' : 'right';
  const receiver: Side = s > 0 ? 'right' : 'left';
  const snap = P.snap;

  // Pupils lead: the gaze settles straight ahead for the rally; at the snap the pupils dart to where the ball went.
  if (t < snap) o.gaze = makeGazeOverride(v2(0, 0.02), 'saccade');
  else if (t < P.sheepish) o.gaze = makeGazeOverride(v2(-inward(receiver) * 0.92, 0.12), 'saccade', true);
  else if (t < P.duration - 0.35) o.gaze = makeGazeOverride(v2(inward(receiver) * 0.12, 0.42), 'smooth');

  // Paddles: anticipation squash (wider, shorter), then narrow and tall with a springy overshoot; spread apart and
  // tilt inward a beat later; everything springs back at the snap.
  const antic = Ease.bump(t / 0.2) * (t < 0.2 ? 1 : 0);
  const paddle = springStep(t - 0.12, 15, 0.42) - springStep(t - snap, 13, 0.38);
  const spread = springStep(t - 0.2, 10, 0.55) - springStep(t - snap - 0.02, 9, 0.5);
  const sx = (1 + 0.08 * k * antic) * (1 - P.paddleNarrow * paddle);
  const sy = (1 - 0.08 * k * antic) * (1 + 0.1 * paddle);
  const wide = springStep(t - snap, 18, 0.4) - springStep(t - P.sheepish, 8, 0.8);

  for (const e of ParamLayout.Side.allCases) {
    const dIn = inward(e);
    let x = -dIn * p.edge.near * spread;
    let y = 0;
    let angle = dIn * 7 * k * spread;
    let squash = 0;
    // Every contact this paddle makes (even k: the server), plus the whiff swing for the receiver.
    for (let i = 0; i < P.contacts.length; i++) {
      if ((i % 2 === 0) !== (e === server)) continue;
      const h = P.contacts[i];
      const wind = glide(t, h - 0.13, 0.13);
      // Wind-up out and back, then the jab toward the ball and a wobble.
      x += dIn * (-2.2 * k * wind + (2.2 * k + 3) * springStep(t - h, 32, 0.4) - 3 * springStep(t - h - 0.1, 16, 0.6));
      angle += dIn * (-9 * k * wind + 9 * k * springStep(t - h, 30, 0.32)) + dIn * 7 * k * kick(t - h, 24, 0.3);
      squash += 0.12 * k * kick(t - h, 34, 0.45);
      // Rise or dip to meet the ball: start moving as it leaves the other paddle.
      const prev = i >= 2 ? P.height(i - 2, p.v2) : 0;
      const lead = i === 0 ? 0.4 : P.legs[i - 1] * 0.9;
      y += 7 * (P.height(i, p.v2) - prev) * springStep(t - (h - lead), 10, 0.7);
    }
    if (e === receiver) {
      // The whiff: a big, too-late swing as the ball goes through, then the paddle recovers.
      // Swung early: the paddle whacks at nothing as the ball sails past behind it.
      const h = P.whiffIn - 0.02;
      const wind = glide(t, h - 0.14, 0.14);
      angle += dIn * (-16 * k * wind + 30 * k * springStep(t - h, 20, 0.35) - 14 * k * springStep(t - snap, 12, 0.5));
      x += dIn * (-3 * k * wind + 3 * k * springStep(t - h, 20, 0.45));
      const last = P.height(P.contacts.length - 2, p.v2);
      y += 7 * (P.height(P.contacts.length, p.v2) - last) * springStep(t - (P.whiffIn - 0.3), 10, 0.7);
    }
    // Heights home with the snap.
    const n = P.contacts.length;
    const lastK = e === server ? n - 1 - ((n - 1) % 2) : n;
    y -= 7 * P.height(lastK, p.v2) * springStep(t - snap, 9, 0.6);
    setEyeStage(o, e, v2(x, y));
    // The eye angle is mirrored for the right eye: the same sign tilts both tops inward.
    o.delta.setEye(e, 'angle', e === 'left' ? angle : -angle);
    const whiffer = e === receiver ? 1 : 0.35;
    const pop = 1 + 0.08 * k * whiffer * wide;
    setEyeScale(o, e, v2(sx * (1 - squash) * pop, sy * (1 + 0.5 * squash) * pop));
    addLids(o, e, -0.22 * whiffer * wide, -0.1 * whiffer * wide);
  }

  // The ball: one pupil at a time, inner-edge coordinate u (1 = the paddle's inner edge, smaller = deeper).
  let ballEye: Side | null = null;
  let u = 1, by = 0;
  const c = P.contacts;
  if (t < c[0] + P.legs[0] * P.outFrac) {
    ballEye = server;
    const hold = 1 - P.depth;
    // Settles to the serve spot, sinks with the wind-up, then leaves.
    u = t < c[0] ? hold * springStep(t - 0.25, 9, 0.75) : 1 - P.depth * (1 - (t - c[0]) / (P.legs[0] * P.outFrac));
    by = P.height(0, p.v2);
  } else if (t < P.whiffIn) {
    for (let i = 1; i < c.length; i++) {
      const inT = P.legs[i - 1] * P.inFrac, outT = P.legs[i] * P.outFrac;
      if (t >= c[i] - inT && t < c[i] + outT) {
        ballEye = i % 2 === 0 ? server : receiver;
        u = t < c[i] ? 1 - P.depth * (t - (c[i] - inT)) / inT : 1 - P.depth * (1 - (t - c[i]) / outT);
        // The height glides from the entry height to the contact height.
        by = P.height(i, p.v2) + (P.height(i - 1, p.v2) - P.height(i, p.v2)) * Math.max(1 - (t - (c[i] - inT)) / inT, 0);
        break;
      }
    }
  } else if (t < P.whiffOut) {
    ballEye = receiver;
    u = 1 - 2 * (t - P.whiffIn) / (P.whiffOut - P.whiffIn);
    by = P.height(c.length, p.v2);
  }
  const back = springStep(t - snap, 20, 0.45); // both pupils pop back at the snap
  const hiding = glide(t, 0.25, 0.2); // the receiver's pupil hides as the paddles form
  for (const e of ParamLayout.Side.allCases) {
    let scale: number;
    if (t >= snap) {
      scale = back;
      // "Where did it go?": both pupils pressed to the side the ball went, a beat, then let go.
      const look = springStep(t - snap, 22, 0.5) - springStep(t - P.sheepish, 9, 0.8);
      o.delta.setEye(e, 'x', -inward(receiver) * 0.9 * look);
    } else if (e === ballEye) {
      o.delta.setEye(e, 'x', inward(e) * u);
      o.delta.setEye(e, 'y', 0.45 * by);
      o.pupilSizeMul = v2(1.25); // the ball reads bigger in a narrow paddle
      // Vanish into the inner edge (and, on the whiff, out of the outer one).
      const edgeOut = t >= P.whiffIn ? Ease.smoothstep((u + 1) / 0.22) : 1;
      scale = t < c[0] ? 1 : Ease.smoothstep((1 - u) / 0.22) * edgeOut;
    } else {
      scale = e === receiver ? 1 - hiding : 0;
    }
    setPupilScale(o, e, v2(Math.max(Math.min(scale, 1), Composer.minPupilShapeScale)));
  }

  // Game face: focused lids and a determined brow; up in surprise at the whiff; then sheepish.
  const focus = window(t, 0.15, 0.5, snap - 0.05, snap + 0.1);
  const shy = window(t, P.sheepish, P.sheepish + 0.25, P.duration - 0.6, P.duration - 0.15);
  setLids(o, 0.06 * focus, 0.16 * focus + 0.3 * shy);
  brows(o, { y: -0.04 * focus * k + 0.12 * k * wide * (1 - shy), curvature: 0.15 * wide * (1 - shy), inner: -0.07 * focus + 0.1 * shy });
  brow(o, receiver, { y: 0.06 * k * wide });
  o.faceScaleMul = stretchScale(1 - 0.03 * k * shy);
  o.delta.setFace('angle', inward(receiver) * 4 * k * shy);
  o.blink = blinkPulse(t, P.sheepish + 0.05, 0.07, 0.03, 0.14);
}
