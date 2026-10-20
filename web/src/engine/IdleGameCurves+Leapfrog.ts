// Port of FaceEngine/IdleGameCurves+Leapfrog.swift.
//
// Leapfrog (idle game 5). The leading eye (left, or right when `p.side` < 0) looks over at the other, crouches
// (squashes, leaning back) while the other braces flat as a pancake; it springs up stretched, arcs over (tucking round
// at the top, stretching again on the way down, tilting along the arc, its brow trailing behind) while the pancake
// scoots underneath, and lands in the other eye's place with a squash and a wobble; the pancake boings back up in the
// vacated place. A beat, a "my turn" glance, and the other eye hops back over the same way, so both end in their own
// places. A little "ta-da" hop together to finish.
//
// Travel from the screen (`resolve`): `t3`, `t4` the left eye's offset to the right eye's place; `near` / `far` the hop
// heights (left jumping, right jumping) above the straight line between the places, fitted to clear the pancake;
// `lead` how flat the pancake goes; `zeta` how much the whole face sinks for headroom; `omega1` / `omega2` and
// `t1` / `t2` the left and right half sizes (y, x) for anchoring the squashes.
// Module-level code uses plain math only (see IdleGameCurves.ts).
import { v2 } from '../core/vec';
import { ParamLayout, type EdgeGeometry, type Side } from '../model';
import { makeGazeOverride } from './Commands';
import { Ease } from './Easing';
import {
  addLids, brow, glide, hump, setEyeStage, springStep, window,
  type EdgeAnticParams,
} from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { kick, setEyeScale } from './IdleGameCurves';
import type { OneShotParams } from './OneShots';

const takeoffs: readonly number[] = [0.66, 2.3];
const flight = 0.54;

export const Leapfrog = {
  duration: 4.8,
  /// Take-off of each hop (base seconds) and the flight time.
  takeoffs,
  flight,
  /// The crouch before a take-off (seconds) and its depth (eye scale y).
  crouchTime: 0.4,
  crouchY: 0.7,
  /// Landing squash (eye scale y at the peak) and the shape at the top of the arc (a round tuck).
  landSquash: 0.3,
  tuckY: 0.86,
  airStretch: 0.24,
  /// The joint "ta-da" hop.
  tada: 3.45,
  /// The deepest crouch (the launch) and the landing squash's peak, per hop.
  accents: takeoffs.flatMap((x) => [x - 0.03, x + flight + 0.07]) as readonly number[],

  resolve(g: EdgeGeometry, e: EdgeAnticParams): void {
    const cl = g.center('left'), cr = g.center('right'), hl = g.halfSize('left'), hr = g.halfSize('right');
    e.t3 = cr.x - cl.x; e.t4 = cr.y - cl.y;
    const gap = 1.5;
    const top = g.visibleHalfExtent.y;
    const midY = 0.5 * (cl.y + cr.y);
    // Bottoms are anchored, so the jumper's bottom rides the arc: clear the pancake's top by `gap`.
    let flat = 0.38;
    const height = (hj: number, hb: number): number => Math.max(hj - hb * (1 - 2 * flat) + gap, 8);
    // Headroom: the tucked jumper's top at the apex, against the screen top (y down).
    const apexTop = (hj: number, hb: number): number => midY - height(hj, hb) + hj - 2 * hj * Leapfrog.tuckY;
    let over = Math.max(-top + 1 - apexTop(hl.y, hr.y), -top + 1 - apexTop(hr.y, hl.y));
    if (over > 0) flat = Math.max(0.3, flat - over / (2 * Math.max(hl.y, hr.y)));
    over = Math.max(-top + 1 - apexTop(hl.y, hr.y), -top + 1 - apexTop(hr.y, hl.y));
    // Then sink the whole face, as far as the bottom edge allows (any rest is clipped at the top).
    const bottomRoom = top - 3 - Math.max(cl.y + hl.y, cr.y + hr.y);
    e.zeta = Math.min(Math.max(over, 0), Math.max(bottomRoom, 0));
    e.lead = flat;
    e.near = height(hl.y, hr.y);
    e.far = height(hr.y, hl.y);
    e.omega1 = hl.y; e.t1 = hl.x;
    e.omega2 = hr.y; e.t2 = hr.x;
    e.hide = 1;
  },
};

export function leapfrog(t: number, p: OneShotParams, o: OneShotOutput): void {
  const L = Leapfrog;
  const k = p.edge.intensity;
  const dir = p.side > 0 ? 1 : -1; // the hops travel this way (screen x)
  const first: Side = p.side > 0 ? 'left' : 'right';
  const T = L.flight;
  const flat = p.edge.lead;
  const Dx = p.edge.t3, Dy = p.edge.t4;

  // The whole face sinks a little for headroom while the hops play.
  o.stageOffset.y = p.edge.zeta * window(t, 0.15, 0.6, L.tada - 0.2, L.tada + 0.3);

  // Pupils lead: both look over toward the hop, follow it, then back to the person for the ta-da.
  const lookOver = window(t, 0.05, 0.25, L.tada - 0.25, L.tada) * dir;
  if (t < L.duration - 0.4) o.gaze = makeGazeOverride(v2(0.35 * lookOver, -0.1), 'saccade');

  for (const e of ParamLayout.Side.allCases) {
    const hy = e === 'left' ? p.edge.omega1 : p.edge.omega2;
    const hx = e === 'left' ? p.edge.t1 : p.edge.t2;
    const tSign = e === 'left' ? 1 : -1; // this eye's offset to the other place: ±D
    // Toward the other eye from this eye's home place (screen x); flips once the eye has swapped.
    const towardOther = e === 'left' ? 1 : -1;
    let posX = 0, posY = 0, swapped = 0;
    let sy = 1, sx = 1, angle = 0;
    let shiftX = 0; // keeps one side still while the width changes
    let browY = 0, browCurve = 0, browInner = 0;
    let upper = 0, lower = 0;
    let pupilX = 0, pupilY = 0;

    for (let i = 0; i < L.takeoffs.length; i++) {
      const tk = L.takeoffs[i];
      const jumper = (i === 0) === (e === first);
      const from = swapped; // 0 at home, 1 at the other place
      const tl = tk + T;
      const away = from === 0 ? towardOther : -towardOther; // toward where this eye is heading (screen x)
      if (jumper) {
        const H = e === 'left' ? p.edge.near : p.edge.far;
        // Anticipation: crouch (eased in), lean back; released into the take-off.
        const crouch = glide(t, tk - L.crouchTime, L.crouchTime - 0.06) * (1 - glide(t, tk - 0.03, 0.06));
        // Flight: constant-ish horizontal speed, a parabola up and over.
        const u = Math.min(Math.max((t - tk) / T, 0), 1);
        const w = 0.75 * u + 0.25 * Ease.smoothstep(u);
        const air = t > tk && t < tl ? 1 : 0;
        const arc = 4 * u * (1 - u);
        const vUp = air * (1 - 2 * u); // vertical speed, +1 up at take-off, −1 landing
        // Shape: stretch with speed, a round tuck at the top; squash on landing with a wobble.
        const airY = L.tuckY + L.airStretch * Math.abs(vUp);
        const airBlend = window(t, tk - 0.04, tk + 0.03, tl - 0.03, tl + 0.01);
        const land = kick(t - tl, 17, 0.45);
        const groundY = 1 - (1 - L.crouchY) * k * crouch - L.landSquash * k * land;
        const shape = groundY + (airY - groundY) * airBlend;
        const wide = 1 / Math.sqrt(Math.max(shape, 0.3));
        sy *= shape;
        sx *= wide;
        // The crouch widens backward (its front edge stays put: a pull back); the landing squash widens
        // forward, away from the pancake popping up behind it.
        shiftX += -away * hx * (wide - 1) * crouch + away * hx * (wide - 1) * glide(t, tl - 0.03, 0.05);
        posY += -H * arc;
        swapped = from + (from === 0 ? 1 : -1) * w;
        // Tilt: lean back in the crouch, along the arc in the air, a wobble on landing.
        angle += away * (-6 * k * crouch + 9 * k * vUp * airBlend + 7 * k * kick(t - tl, 15, 0.35));
        // Brow: trails the vertical motion (pressed down going up, floating up coming down), a gleeful
        // arch at the top and a dip at the landing.
        browY += -0.12 * k * vUp * airBlend - 0.08 * k * kick(t - tl - 0.02, 14, 0.4) - 0.05 * crouch;
        browCurve += 0.2 * arc * air;
        browInner += -0.06 * crouch;
        upper += 0.18 * crouch;
        lower += 0.12 * k * land;
        // Its pupil looks down at the pancake while over it.
        pupilY += 0.55 * hump(t, tk + 0.5 * T, T * 1.1);
        pupilX += away * 0.35 * (crouch + air);
      } else {
        // The pancake: braces flat (bottom on the floor) as the jumper crouches, scoots under the arc,
        // boings back up once the jumper has passed over.
        const down = glide(t, tk - L.crouchTime + 0.12, L.crouchTime - 0.16);
        const up = springStep(t - (tl - 0.02), 15, 0.52);
        const squash = down - up;
        sy *= 1 - (1 - flat) * squash;
        sx *= 1 + 0.32 * squash;
        const slide = glide(t, tk - 0.06, T + 0.12);
        swapped = from + (from === 0 ? 1 : -1) * slide;
        // It widens away from the jumper (the edge facing it stays put).
        shiftX += -away * hx * 0.32 * squash;
        // A squint while it braces; popping open at the boing.
        const brace = window(t, tk - 0.2, tk, tk + 0.6 * T, tk + 0.85 * T);
        upper += 0.1 * brace - 0.15 * window(t, tl - 0.02, tl + 0.06, tl + 0.15, tl + 0.4);
        browInner += -0.1 * brace;
        browY += -0.04 * brace + 0.06 * kick(t - (tl - 0.02), 12, 0.4);
        // Its pupil looks up at the jumper going over.
        pupilY += -0.6 * window(t, tk - 0.1, tk + 0.1, tl - 0.1, tl + 0.1);
        angle += away * -4 * k * kick(t - (tl - 0.02), 12, 0.4);
      }
      if (t < tl + 0.4) break; // later hops haven't started
    }

    // The "my turn" glance before the second hop: the next jumper's brow lifts, a quick lid flick.
    const second: Side = first === 'left' ? 'right' : 'left';
    if (e === second) {
      const t1 = L.takeoffs[1];
      const myTurn = window(t, t1 - 0.75, t1 - 0.6, t1 - 0.45, t1 - 0.3);
      browY += 0.1 * myTurn;
      browCurve += 0.15 * myTurn;
    }

    // Ta-da: a little joint hop with a happy squint.
    const tadaCrouch = window(t, L.tada - 0.18, L.tada - 0.04, L.tada - 0.02, L.tada + 0.06);
    const tadaHop = kick(t - L.tada, 11, 0.45);
    const happy = window(t, L.tada - 0.05, L.tada + 0.15, L.duration - 0.8, L.duration - 0.3);
    sy *= 1 - 0.12 * k * tadaCrouch + 0.06 * k * Math.max(tadaHop, 0);
    sx *= 1 + 0.08 * k * tadaCrouch;
    posY += -6 * k * tadaHop;
    lower += 0.32 * happy;
    browY += 0.07 * k * happy;
    browCurve += 0.18 * happy;

    posX += tSign * Dx * swapped;
    posY += tSign * Dy * swapped;
    // Keep the bottom on the floor and the anchored side still while the shape changes.
    posY += hy * (1 - sy);
    posX += shiftX;
    setEyeStage(o, e, v2(posX, posY));
    setEyeScale(o, e, v2(sx, sy));
    // Screen-space tilt (+ = top to the right); the right eye's lane is mirrored.
    o.delta.setEye(e, 'angle', e === 'left' ? angle : -angle);
    addLids(o, e, upper, lower);
    brow(o, e, { y: browY, curvature: browCurve, inner: browInner });
    o.delta.setEye(e, 'x', pupilX);
    o.delta.setEye(e, 'y', pupilY);
  }
}
