// Port of FaceEngine/Modifiers/ThinkingBeatCurves.swift.
import type { V2 } from '../../core/vec';
import { ParamLayout, type Side } from '../../model';
import { Ease, Track } from '../Easing';
import { OneShotLibrary as L } from '../OneShots';
import { OneShotOutput } from '../FaceState';
import type { ThinkingBeat, ThinkingBeatParams } from './ThinkingBeats';

/// One frame of a thinking beat: its one-shot style contribution and its gaze offset.
export class BeatPose {
  o = new OneShotOutput();
  /// Offset added to the gaze target (normalised gaze units).
  gaze: V2 = { x: 0, y: 0 };
  /// True: a continuous path (pursuit). False: piecewise-constant steps (each step is a saccade).
  continuous = false;
  /// Mark the target as eye contact (pupils near centre read as "looking at you").
  contact = false;
}


const f = Math.fround;
/// `OneShotLibrary.blinkPulse` evaluated in Float as Swift does.
// f32: the opening tail `1 − outQuad(u)` rounds to exactly 0 in Float a frame before it does in Double, and
// SquashStretch / Blink gate on `blink > 0` (golden noticing-3min, frame 885: the sigh's blink).
export function blinkPulse32(t: number, start: number, close: number, hold: number, open: number): number {
  const a = f(f(t) - f(start));
  if (a <= 0) return 0;
  const c = f(close), h = f(hold), o = f(open);
  if (a < c) { const x = Math.min(Math.max(f(a / c), 0), 1); return f(x * x); }
  if (a < f(c + h)) return 1;
  const b = f(f(a - c) - h);
  if (b < o) {
    const y = f(1 - Math.min(Math.max(f(b / o), 0), 1));
    return f(1 - f(1 - f(y * y)));
  }
  return 0;
}

const I = {
  angle: ParamLayout.index('angle'), centerY: ParamLayout.index('centerY'),
  lx: ParamLayout.index('left', 'x'), rx: ParamLayout.index('right', 'x'),
};

/// The beat curves (thinking beats design §3). Every curve is zero at t = 0 and at its duration, with zero slope at
/// both ends. Lids as a fraction of the opening, brows in eye-relative units, the angle in degrees, centres in canvas.
export const ThinkingBeatCurves = {
  sample(b: ThinkingBeat, t: number, p: ThinkingBeatParams, base: V2, person: V2, out: BeatPose): void {
    const near: Side = p.side > 0 ? 'right' : 'left';
    const far: Side = p.side > 0 ? 'left' : 'right';
    const toPerson = { x: person.x - base.x, y: person.y - base.y };
    switch (b) {
      case 'ponder': ponder(t, p, near, far, out); break;
      case 'slowBlink': slowBlink(t, p, out); break;
      case 'scan': scan(t, p, out); break;
      case 'browRaise': browRaise(t, p, near, far, out); break;
      case 'chew': chew(t, p, out); break;
      case 'lightbulb': lightbulb(t, p, base, person, out); break;
      case 'drum': drum(t, p, near, far, toPerson, out); break;
      case 'eyeRoll': eyeRoll(t, p, base, out); break;
      case 'crossEyed': crossEyed(t, p, base, out); break;
      case 'question': break; // the pupil transformation plays it
      case 'peek': peek(t, p, toPerson, out); break;
    }
  },

  /// (start time, x, y) of each scan fixation; the eyes return to the thinking point at the last one.
  scanFixations: [
    [0.08, -0.15, 0], [0.3, -0.05, 0], [0.52, 0.05, 0], [0.74, 0.15, 0],
    [1.0, -0.15, 0.08], [1.22, -0.04, 0.08], [1.44, 0.07, 0.08], [1.68, 0, 0],
  ] as readonly (readonly [number, number, number])[],
  raiseShape: new Track([[0, 0], [0.08, -0.1], [0.24, 1.12], [0.36, 0.96], [0.48, 1.02], [1.2, 1], [1.6, 0]]),
  bulbUpper: new Track([[0, 0], [0.1, 0.08], [0.18, -0.32], [0.5, -0.26], [0.75, 0.05], [0.95, 0.15], [1.3, 0.1], [1.7, 0]]),
  bulbScale: new Track([[0, 0], [0.1, -0.02], [0.19, 0.07], [0.3, 0.05], [0.55, 0.05], [0.85, -0.025], [1.2, -0.01], [1.7, 0]]),
  bulbY: new Track([[0, 0], [0.1, 0.3], [0.19, -1.4], [0.32, -1.1], [0.55, -1.0], [0.9, 0.7], [1.25, 0.3], [1.7, 0]]),
  bulbBrow: new Track([[0, 0], [0.1, -0.02], [0.19, 0.13], [0.55, 0.11], [0.9, -0.05], [1.3, -0.02], [1.7, 0]]),
  drumTaps: [0.15, 0.23, 0.31, 0.39, 0.95, 1.03, 1.11, 1.19] as readonly number[],
  rollCentre: { x: 0, y: -0.2 } as Readonly<V2>,
  rollRadii: { x: 0.7, y: 0.6 } as Readonly<V2>,
};
const C = ThinkingBeatCurves;

// ponder (1.3 s): a glance further up and aside, a slight squint, the near brow lifting.
function ponder(t: number, p: ThinkingBeatParams, near: Side, far: Side, out: BeatPose): void {
  const w = L.window(t, 0, 0.2, 0.95, 1.3);
  if (t >= 0.06 && t < 1.0) out.gaze = { x: p.side * 0.16 * p.gazeAmp, y: -0.14 * p.gazeAmp };
  L.setLids(out.o, 0.07 * w, 0.16 * w);
  L.brow(out.o, near, { y: 0.05 * w * p.amp, curvature: 0.1 * w });
  L.brow(out.o, far, { inner: -0.04 * w });
  out.o.delta.raw[I.angle] = -1.5 * p.side * w * p.amp;
}

// slowBlink (0.95 s): a slow, soft blink with a little dip.
function slowBlink(t: number, p: ThinkingBeatParams, out: BeatPose): void {
  const k = blinkPulse32(t, 0.08, 0.24, 0.16, 0.36);
  out.o.blink = k;
  L.brows(out.o, { y: -0.025 * k, inner: 0.03 * k });
  out.o.delta.raw[I.centerY] = L.py(0.5 * k * p.amp);
  L.setLids(out.o, 0, 0.06 * L.window(t, 0, 0.2, 0.7, 0.95));
}

// scan (1.9 s): reading an invisible page, two lines of small saccades.
function scan(t: number, p: ThinkingBeatParams, out: BeatPose): void {
  let gx = 0, gy = 0;
  for (const f of C.scanFixations) if (t >= f[0]) { gx = f[1]; gy = f[2]; }
  out.gaze = { x: gx * p.gazeAmp, y: gy * p.gazeAmp };
  const w = L.window(t, 0, 0.2, 1.6, 1.9);
  L.setLids(out.o, 0.05 * w, 0.1 * w);
  L.brows(out.o, { inner: -0.04 * w });
  out.o.pupilSizeMul = { x: 1 - 0.05 * w, y: 1 - 0.05 * w };
}

// browRaise (1.6 s): a sceptical one-brow raise, a tiny tilt and a look at the person.
function browRaise(t: number, p: ThinkingBeatParams, near: Side, far: Side, out: BeatPose): void {
  const k = C.raiseShape.value(t);
  L.brow(out.o, near, { y: 0.13 * k * p.amp, curvature: 0.22 * k });
  L.brow(out.o, far, { y: -0.04 * k * p.amp, curvature: -0.08 * k, inner: -0.07 * k });
  const wide = -0.08 * Math.max(k, 0), narrow = 0.14 * Math.max(k, 0);
  out.o.lidCoverage = near === 'left'
    ? { x: wide, y: 0.05 * k, z: narrow, w: 0.05 * k } : { x: narrow, y: 0.05 * k, z: wide, w: 0.05 * k };
  out.o.delta.raw[I.angle] = 3 * p.side * k * p.amp;
  if (t >= 0.3 && t < 1.15) out.gaze = { x: -p.side * 0.25 * p.gazeAmp, y: 0.25 * p.gazeAmp };
}

// chew (2.2 s): narrowed, munching lids while the eyes drift in a small circle.
function chew(t: number, p: ThinkingBeatParams, out: BeatPose): void {
  const w = L.window(t, 0, 0.4, 1.75, 2.2);
  const munch = 0.05 * Ease.bump((t * 1.6) % 1) * w;
  L.setLids(out.o, 0.17 * w, 0.13 * w + munch);
  L.brows(out.o, { y: -0.02 * w, inner: -0.05 * w });
  const a = 2 * Math.PI * 1.3 * (t / 2.2) * p.side;
  const k = w * p.gazeAmp;
  out.gaze = { x: 0.1 * Math.sin(a) * k, y: -0.08 * (1 - Math.cos(a)) * k };
  out.continuous = true;
}

// lightbulb (1.7 s): "oh!" a perk with wide eyes, brows up and a hop toward the person… then it fizzles.
function lightbulb(t: number, p: ThinkingBeatParams, base: V2, person: V2, out: BeatPose): void {
  const u = C.bulbUpper.value(t);
  L.setLids(out.o, u, 0.4 * Math.min(u, 0));
  out.o.faceScaleMul = L.stretchScale(1 + C.bulbScale.value(t) * p.amp);
  out.o.delta.raw[I.centerY] = L.py(C.bulbY.value(t) * p.amp);
  const br = C.bulbBrow.value(t);
  const fizz = L.window(t, 0.7, 0.95, 1.2, 1.7);
  L.brows(out.o, { y: br * p.amp, curvature: 0.2 * Math.max(br, 0) / 0.13, inner: 0.05 * fizz });
  const ps = 1 + 0.15 * L.hump(t, 0.4, 0.6);
  out.o.pupilSizeMul = { x: ps, y: ps };
  // The idea: a look most of the way to the person; the fizzle: back to thinking.
  if (t >= 0.14 && t < 0.78) out.gaze = { x: (person.x - base.x) * 0.75, y: (person.y - base.y) * 0.75 };
}

// drum (1.7 s): two rolls of little eye taps, alternating eyes, an impatient glance between them.
function drum(t: number, p: ThinkingBeatParams, near: Side, far: Side, toPerson: V2, out: BeatPose): void {
  let tapNear = 0, tapFar = 0;
  C.drumTaps.forEach((c, i) => {
    const h = L.hump(t, c + 0.04, 0.1);
    if (i % 2 === 0) tapFar += h; else tapNear += h;
  });
  out.o.delta.setEye(far, 'centerY', L.py(3 * tapFar * p.amp));
  out.o.delta.setEye(near, 'centerY', L.py(3 * tapNear * p.amp));
  const sqF = 1 - 0.07 * tapFar * p.amp, sqN = 1 - 0.07 * tapNear * p.amp;
  out.o.eyeScaleMul = far === 'left' ? { x: 1, y: sqF, z: 1, w: sqN } : { x: 1, y: sqN, z: 1, w: sqF };
  const w = L.window(t, 0, 0.15, 1.35, 1.7);
  L.setLids(out.o, 0.13 * w, 0);
  L.brows(out.o, { y: -0.02 * w, curvature: -0.08 * w });
  if (t >= 0.5 && t < 0.85) out.gaze = { x: toPerson.x * 0.6, y: toPerson.y * 0.6 };
}

// eyeRoll (1.7 s): a slow full roll up and around, then a little exasperated dip.
function eyeRoll(t: number, p: ThinkingBeatParams, base: V2, out: BeatPose): void {
  const w = L.window(t, 0, 0.18, 1.45, 1.7);
  const rx = C.rollRadii.x * p.gazeAmp, ry = C.rollRadii.y * p.gazeAmp;
  const qx = (base.x - C.rollCentre.x) / rx, qy = (base.y - C.rollCentre.y) / ry;
  const phi0 = Math.atan2(qy, qx);
  // Up and over first: from the upper-right the angle falls toward −π/2 (+y is down).
  const phi = phi0 - p.side * 2 * Math.PI * Ease.smoothstep((t - 0.1) / 1.35);
  const ax = C.rollCentre.x + rx * Math.cos(phi), ay = C.rollCentre.y + ry * Math.sin(phi);
  out.gaze = { x: (ax - base.x) * w, y: (ay - base.y) * w };
  out.continuous = true;
  L.setLids(out.o, 0.08 * w, 0);
  L.brows(out.o, { y: 0.07 * w * p.amp });
  out.o.delta.raw[I.centerY] = L.py(0.7 * L.hump(t, 1.48, 0.36) * p.amp);
}

// crossEyed (1.15 s): the pupils converge in concentration, then snap back with a blink.
function crossEyed(t: number, p: ThinkingBeatParams, base: V2, out: BeatPose): void {
  const c = (L.stepResponse(t - 0.1, L.crossIn) - L.stepResponse(t - 0.72, L.crossOut)) * L.window(t, 0, 0.05, 0.95, 1.15);
  const inward = 0.5 * c * p.amp;
  // Left eye sits on the viewer's left: inward is +x for it, −x for the right eye.
  out.o.delta.raw[I.lx] = inward;
  out.o.delta.raw[I.rx] = -inward;
  // The eyes come most of the way back to centre so the converging pupils have room to show.
  const k = 0.7 * L.window(t, 0, 0.15, 0.7, 0.9);
  out.gaze = { x: -base.x * k, y: -base.y * k };
  out.continuous = true;
  out.o.blink = blinkPulse32(t, 0.7, 0.05, 0.03, 0.12);
  L.setLids(out.o, 0.1 * Math.max(c, 0), 0.05 * Math.max(c, 0));
  L.brows(out.o, { inner: -0.07 * c });
}

// peek (1.6 s): "still here!" a sheepish look at the person, a smile-squint and a tiny bob.
function peek(t: number, p: ThinkingBeatParams, toPerson: V2, out: BeatPose): void {
  if (t >= 0.1 && t < 1.2) {
    out.gaze = { ...toPerson };
    out.contact = true;
  }
  const w = L.window(t, 0.08, 0.3, 1.1, 1.5);
  L.setLids(out.o, 0.04 * w, (0.22 + 0.12 * p.smile) * w);
  L.brows(out.o, { y: 0.02 * w, inner: 0.07 * w });
  out.o.delta.raw[I.angle] = 2.5 * p.side * w * p.amp;
  out.o.delta.raw[I.centerY] = L.py(-0.8 * L.hump(t, 0.32, 0.3) * p.amp);
}
