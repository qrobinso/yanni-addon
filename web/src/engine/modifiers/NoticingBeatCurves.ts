// Port of FaceEngine/Modifiers/NoticingBeatCurves.swift.
import type { SplitMix64 } from '../../core/random';
import type { V2 } from '../../core/vec';
import { ParamLayout } from '../../model';
import { Ease } from '../Easing';
import { gazeClampEllipse, gazeLength } from '../GazeSupport';
import { OneShotLibrary as L } from '../OneShots';
import type { NoticingBeat, NoticingParams } from './NoticingAttention';
import { blinkPulse32, type BeatPose } from './ThinkingBeatCurves';

const I = {
  angle: ParamLayout.index('angle'), centerY: ParamLayout.index('centerY'),
  lx: ParamLayout.index('left', 'x'), rx: ParamLayout.index('right', 'x'),
};
const ROOM: Readonly<V2> = Object.freeze({ x: 0.85, y: 0.6 });

/// The distraction beat curves (noticing attention design §3). `BeatPose.gaze` is an absolute gaze point here (the
/// beat starts where the eyes rest, `from`, and its last point becomes the new resting point). Pose, lid, brow and
/// scale tracks are zero with zero slope at both ends, so a beat never pops on or off.
export const NoticingBeatCurves = {
  sample(b: NoticingBeat, t: number, p: NoticingParams, from: V2, fly: readonly V2[], out: BeatPose): void {
    switch (b) {
      case 'lookAround': lookAround(t, p, from, out); break;
      case 'fly': flyChase(t, p, from, fly, out); break;
      case 'sigh': sigh(t, p, from, out); break;
      case 'lookDown': lookDown(t, p, from, out); break;
      case 'hum': hum(t, p, from, out); break;
      case 'pupilPlay': pupilPlay(t, p, from, out); break;
      case 'sleepyDrift': sleepyDrift(t, p, from, out); break;
    }
  },

  flyTimes: [0.08, 0.38, 0.66, 0.9, 1.22, 1.5, 1.84, 2.18] as readonly number[],

  /// Eight fixations: a jittery walk from `from` (steps 0.15–0.3), kept inside the room ellipse.
  fillFlyPath(path: V2[], from: V2, rng: SplitMix64): void {
    let pt = { ...from };
    let heading = rng.uniform(0, 2 * Math.PI);
    for (let i = 0; i < path.length; i++) {
      heading += rng.uniform(-1.3, 1.3);
      const step = rng.uniform(0.15, 0.3);
      let next = { x: pt.x + Math.cos(heading) * step, y: pt.y + Math.sin(heading) * 0.8 * step };
      if (gazeLength({ x: next.x / ROOM.x, y: next.y / ROOM.y }) > 1) {
        heading += Math.PI;
        next = { x: pt.x + Math.cos(heading) * 0.2, y: pt.y + Math.sin(heading) * 0.8 * 0.2 };
      }
      pt = gazeClampEllipse(next, ROOM);
      path[i] = pt;
    }
  },

  /// The silent "oh!" on a snap back (and, smaller, on a check-in): brows up, eyes a little wider, a hop.
  perk(t: number, duration: number, amp: number, out: BeatPose): void {
    const s = duration / 0.55;
    const pop = L.hump(t, 0.2 * s, 0.4 * s);
    const dip = L.hump(t, 0.03 * s, 0.06 * s);
    out.o.delta.raw[I.centerY] = L.py((0.25 * dip - 1.1 * pop) * amp);
    out.o.eyeScaleMul = { x: 1 + 0.02 * pop * amp, y: 1 + 0.07 * pop * amp, z: 1 + 0.02 * pop * amp, w: 1 + 0.07 * pop * amp };
    out.o.faceScaleMul = L.stretchScale(1 + 0.035 * pop * amp);
    L.brows(out.o, { y: 0.07 * L.hump(t, 0.24 * s, 0.5 * s) * amp });
    const ps = 1 + 0.1 * pop * amp;
    out.o.pupilSizeMul = { x: ps, y: ps };
  },
};

// lookAround (3.4 s): slow drifts to an upper corner, then across to a lower one, peering at each.
function lookAround(t: number, p: NoticingParams, from: V2, out: BeatPose): void {
  const a = { x: p.side * (0.6 + 0.2 * p.v.x), y: -0.45 - 0.1 * p.v.y };
  const b = { x: -p.side * (0.15 + 0.35 * p.v.z), y: 0.25 + 0.15 * p.v.w };
  const k1 = Ease.smootherstep((t - 0.1) / 0.9), k2 = Ease.smootherstep((t - 1.75) / 1.0);
  out.gaze = { x: from.x + (a.x - from.x) * k1 + (b.x - a.x) * k2, y: from.y + (a.y - from.y) * k1 + (b.y - a.y) * k2 };
  out.continuous = true;
  // Peering at each corner: narrowed lids, a lean toward it, focused brows.
  const peer = L.hump(t, 1.35, 0.9) + L.hump(t, 3.0, 0.8);
  L.setLids(out.o, 0.06 * peer, 0.14 * peer);
  L.brows(out.o, { inner: -0.03 * peer });
  const lean = L.window(t, 0.2, 0.9, 1.6, 2.4) - L.window(t, 1.9, 2.6, 3.0, 3.4);
  out.o.delta.raw[I.angle] = 2 * p.side * lean * p.amp;
}

// fly (2.9 s): darting saccades after an imaginary fly, close up (the eyes converge), then a blink.
function flyChase(t: number, p: NoticingParams, from: V2, fly: readonly V2[], out: BeatPose): void {
  let g = from;
  NoticingBeatCurves.flyTimes.forEach((ft, i) => { if (t >= ft && i < fly.length) g = fly[i]; });
  out.gaze = { ...g };
  const w = L.window(t, 0, 0.15, 2.3, 2.6);
  L.brows(out.o, { y: 0.035 * w * p.amp });
  out.o.pupilSizeMul = { x: 1 - 0.08 * w, y: 1 - 0.08 * w };
  // A tiny head bob on each dart, then the fly's gone: a blink.
  let bob = 0;
  for (const ft of NoticingBeatCurves.flyTimes) bob += L.hump(t, ft + 0.05, 0.12);
  out.o.delta.raw[I.centerY] = L.py(-0.35 * bob * p.amp);
  out.o.blink = blinkPulse32(t, 2.45, 0.07, 0.04, 0.15);
}

// sigh (2.4 s): a small inhale, then a sink with heavy lids, a slow blink and droopy brows.
function sigh(t: number, p: NoticingParams, from: V2, out: BeatPose): void {
  const inhale = L.hump(t, 0.4, 0.6);
  const sink = L.window(t, 0.55, 1.1, 1.8, 2.4);
  out.gaze = { x: from.x, y: from.y + (0.12 * sink - 0.05 * inhale) };
  out.continuous = true;
  out.o.delta.raw[I.centerY] = L.py((-0.6 * inhale + 1.1 * sink) * p.amp);
  out.o.faceScaleMul = L.stretchScale(1 + (0.02 * inhale - 0.03 * sink) * p.amp);
  L.setLids(out.o, 0.2 * sink, 0.04 * sink);
  L.brows(out.o, { y: (0.03 * inhale - 0.02 * sink) * p.amp, inner: 0.04 * sink });
  out.o.blink = blinkPulse32(t, 1.0, 0.25, 0.15, 0.4);
}

// lookDown (2.8 s): a slow look down at the floor, head tilted, eyes examining a little spot.
function lookDown(t: number, p: NoticingParams, from: V2, out: BeatPose): void {
  const spot = { x: from.x * 0.5 + p.side * 0.12 * p.v.x, y: 0.72 + 0.1 * p.v.y };
  const k = Ease.smootherstep((t - 0.15) / 0.8);
  const w = L.window(t, 0.15, 0.9, 2.2, 2.8);
  const ex = 0.06 * Math.sin(2 * Math.PI * 0.8 * (t - 0.9)) * w;
  out.gaze = { x: from.x + (spot.x - from.x) * k + ex, y: from.y + (spot.y - from.y) * k + 0 * w };
  out.continuous = true;
  out.o.delta.raw[I.angle] = 3 * p.side * w * p.amp;
  L.setLids(out.o, 0.06 * w, 0.06 * w);
  L.brows(out.o, { curvature: 0.04 * w, inner: -0.025 * w });
}

// hum (3.2 s): humming to itself, a content squint, eyes up and aside, the head swaying to the tune.
function hum(t: number, p: NoticingParams, from: V2, out: BeatPose): void {
  const w = L.window(t, 0, 0.45, 2.7, 3.2);
  const up = { x: p.side * 0.12, y: -0.18 - 0.08 * p.v.x };
  const k1 = Ease.smootherstep(t / 0.8), k2 = Ease.smootherstep((t - 2.5) / 0.7) * 0.5;
  out.gaze = { x: from.x + up.x * k1 - up.x * k2, y: from.y + up.y * k1 - up.y * k2 };
  out.continuous = true;
  const phase = 2 * Math.PI * (0.85 + 0.15 * p.v.y) * (t - 0.3);
  out.o.delta.raw[I.angle] = 3 * Math.sin(phase) * w * p.amp;
  out.o.delta.raw[I.centerY] = L.py(-0.4 * Math.abs(Math.sin(phase)) * w * p.amp);
  L.setLids(out.o, 0.08 * w, 0.22 * w);
  L.brows(out.o, { y: 0.02 * w * p.amp, curvature: 0.06 * w });
}

// pupilPlay (1.9 s): a brief cross-eye, a blink to snap back, then a pupil size wobble.
function pupilPlay(t: number, p: NoticingParams, from: V2, out: BeatPose): void {
  const c = (L.stepResponse(t - 0.08, L.crossIn) - L.stepResponse(t - 0.76, L.crossOut)) * L.window(t, 0, 0.05, 0.9, 1.05);
  const inward = 0.65 * c * p.amp;
  out.o.delta.raw[I.lx] = inward;
  out.o.delta.raw[I.rx] = -inward;
  const k = 1 - 0.7 * L.window(t, 0, 0.15, 0.75, 0.95);
  out.gaze = { x: from.x * k, y: from.y * k };
  out.continuous = true;
  out.o.blink = blinkPulse32(t, 0.76, 0.05, 0.03, 0.12);
  L.brows(out.o, { inner: -0.05 * Math.max(c, 0) });
  const wob = L.window(t, 1.05, 1.2, 1.65, 1.9);
  const ps = 1 + 0.16 * Math.sin(2 * Math.PI * 3.2 * (t - 1.05)) * wob * p.amp;
  out.o.pupilSizeMul = { x: ps, y: ps };
}

// sleepyDrift (3.6 s): lids sag and the head sinks, then it catches itself with a blink and a little hop.
function sleepyDrift(t: number, p: NoticingParams, from: V2, out: BeatPose): void {
  const sag = Ease.smoothstep(t / 2.5) * (1 - Ease.smoothstep((t - 2.6) / 0.25));
  const settle = L.window(t, 2.6, 2.8, 3.1, 3.6);
  out.gaze = { x: from.x, y: from.y + 0.25 * sag };
  out.continuous = true;
  L.setLids(out.o, 0.5 * sag, 0.05 * sag);
  out.o.delta.raw[I.centerY] = L.py((1.3 * sag - 0.7 * L.hump(t, 2.85, 0.4)) * p.amp);
  L.brows(out.o, { y: -0.03 * sag + 0.04 * settle * p.amp });
  out.o.blink = blinkPulse32(t, 2.62, 0.06, 0.04, 0.14);
}
