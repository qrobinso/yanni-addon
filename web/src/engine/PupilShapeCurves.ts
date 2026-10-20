// Port of FaceEngine/PupilShapeCurves.swift: the pupil transformations (pupil transformations design §2–3). Module-level
// code stays free of OneShots.ts exports (the two modules import each other; use them only inside functions).
import type { SplitMix64 } from '../core/random';
import { v2, v4, type V2, type V4 } from '../core/vec';
import { PupilShape } from '../model';
import { makeGazeOverride, type OneShotKind } from './Commands';
import { Ease } from './Easing';
import { brow, brows, hump, py, setLids, stretchScale, window } from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import {
  OneShotChannels, OneShotParams, OneShotSpec, squintLower, squintScale, squintY, type OneShotRequest,
} from './OneShots';

/// The silhouette part of a pupil transformation for one frame: per-eye shape (raw `PupilShape`), morph and scale.
export class PupilShapeFrame {
  shape: V2;
  morph: V2;
  /// (left x, left y, right x, right y).
  scale: V4;
  constructor(shape: V2 = v2(0), morph: V2 = v2(0), scale: V4 = v4(1)) {
    this.shape = { ...shape }; this.morph = { ...morph }; this.scale = { ...scale };
  }
  /// The default pupils. Fresh each access.
  static get identity(): PupilShapeFrame { return new PupilShapeFrame(); }
  copy(): PupilShapeFrame { return new PupilShapeFrame(this.shape, this.morph, this.scale); }
  equals(o: PupilShapeFrame): boolean {
    return this.shape.x === o.shape.x && this.shape.y === o.shape.y && this.morph.x === o.morph.x &&
      this.morph.y === o.morph.y && this.scale.x === o.scale.x && this.scale.y === o.scale.y &&
      this.scale.z === o.scale.z && this.scale.w === o.scale.w;
  }
  /// True when this is the default pupil on both eyes (ellipse, morph 0, scale 1).
  get isIdentity(): boolean { return this.equals(PupilShapeFrame.identity); }
}

/// Allowed hold lengths (seconds).
export const holdRange: readonly [number, number] = [0.3, 3];
/// Coin flip: ease into the sliver over `flipIn`, swap at the sliver, open out over `flipOut` (170 ms in all).
export const flipIn = 0.07;
export const flipOut = 0.10;
export const flipHold = 0.02;
/// x scale at the coin flip's sliver.
export const sliver = 0.06;
/// Scale a transformed silhouette rests at (the pop peaks at 1.0).
export const shapeRest = 0.9;
/// Below this intensity the bounce, twinkle and pulse are dropped and bobs halve.
export const bounceIntensity = 0.5;
/// A switch back with nothing visible to flip eases the scale home this fast.
export const switchBackEase = 0.12;
/// Length of every switch back.
export const switchBackDuration = flipIn + flipOut;

export function shapeSpec(kind: OneShotKind, acting: number): OneShotSpec {
  return new OneShotSpec({
    kind, duration: shapeDuration(kind, 0), channels: OneShotChannels.pupilShape, cooldown: 0.3, stateScoped: false,
    priority: 10, accentTimes: shapeAccentTimesFor(kind, true), releaseStyle: 'switchBack', speedRange: [1, 1],
    actingChannels: acting,
  });
}

/// Default hold per transformation (seconds).
export function defaultHold(kind: OneShotKind): number {
  switch (kind) {
    case 'starEyes': return 1.0;
    case 'heartEyes': return 1.3;
    case 'noteEyes': return 1.5;
    case 'questionEyes': return 1.0;
    case 'exclaimEyes': return 0.6;
    default: return 0;
  }
}

/// Seconds before the hold starts (anticipation and pop / glance / flips).
export function shapeIntro(kind: OneShotKind): number {
  switch (kind) {
    case 'starEyes': return 0.46;
    case 'heartEyes': return 0.78;
    case 'noteEyes': return 0.24;
    case 'questionEyes': return 0.36;
    case 'exclaimEyes': return 0.3;
    default: return 0;
  }
}

/// Seconds after the hold (the return; for exclamation marks it includes the delighted squint).
export function shapeOutro(kind: OneShotKind): number {
  switch (kind) {
    case 'starEyes': return 0.24;
    case 'heartEyes': return 0.26;
    case 'noteEyes': return 0.2;
    case 'questionEyes': return 0.2;
    case 'exclaimEyes': return 1.1;
    default: return 0;
  }
}

/// Total base duration for a hold (0 = the default hold).
export function shapeDuration(kind: OneShotKind, hold: number): number {
  // f32: compared against the Float playhead on the last frame (see OneShotSampler.advanceShape).
  const f = Math.fround;
  return f(f(f(shapeIntro(kind)) + f(resolvedHold(kind, hold))) + f(shapeOutro(kind)));
}

export function resolvedHold(kind: OneShotKind, hold: number): number {
  const h = hold > 0 && Number.isFinite(hold) ? hold : defaultHold(kind);
  return Math.min(Math.max(h, holdRange[0]), holdRange[1]);
}

/// Swift `shapeAccentTimes(_:bounce:)`.
export function shapeAccentTimesFor(kind: OneShotKind, bounce: boolean): number[] {
  switch (kind) {
    case 'starEyes': return bounce ? [0.24, 0.40] : [0.24];
    case 'heartEyes': return [0.6];
    case 'noteEyes': return [0.11];
    case 'questionEyes': return [0.11, 0.23];
    case 'exclaimEyes': return [0.09];
    default: return [];
  }
}

/// Swift `shapeAccentTimes(_:_:)`.
export function shapeAccentTimes(kind: OneShotKind, p: OneShotParams): number[] {
  return shapeAccentTimesFor(kind, p.bounce);
}

export function makeShapeParams(r: OneShotRequest, rng: SplitMix64, eyeGaze: V2): OneShotParams {
  const p = new OneShotParams();
  // Exact size and timing: the flip time is fixed and the silhouette always rests at `shapeRest`.
  p.amp = 1;
  p.timeMul = 1;
  p.side = rng.chance(0.5) ? 1 : -1;
  p.v1 = rng.unit();
  p.v2 = rng.unit();
  p.hold = resolvedHold(r.kind, r.hold ?? 0);
  const l = r.leadEye;
  if (l !== undefined && Number.isFinite(l) && l !== 0) p.lead = l < 0 ? -1 : 1; else p.lead = rng.chance(0.5) ? 1 : -1;
  const ri = r.intensity;
  const i = ri === undefined ? 1 : Number.isFinite(ri) ? Math.min(Math.max(ri, 0), 1) : 1;
  p.intensity = i;
  p.reduceMotion = r.reduceMotion;
  p.bounce = i >= bounceIntensity && !r.reduceMotion;
  if (r.kind === 'heartEyes') {
    // The shy glance: down and to one side; then back to where the eyes were.
    p.gazeA = v2(p.side * 0.42, 0.38);
    p.gazeB = v2(Math.min(Math.max(eyeGaze.x, -0.9), 0.9), Math.min(Math.max(eyeGaze.y, -0.6), 0.6));
  }
  return p;
}

// MARK: Curves

/// x-scale factor of a coin flip whose sliver is at `flip`: 1 until `flip − flipIn`, eases in to `sliver` at the flip,
/// opens out to 1 over `flipOut` (with a small overshoot when `overshoot`; the rest scale keeps it ≤ 1).
export function flipX(t: number, flip: number, overshoot: boolean): number {
  const a = t - (flip - flipIn);
  if (a <= 0) return 1;
  if (t < flip - flipHold) return 1 - (1 - sliver) * Ease.inQuad(a / (flipIn - flipHold));
  if (t < flip + flipHold) return sliver;
  const u = (t - flip - flipHold) / (flipOut - flipHold);
  if (u >= 1) return 1;
  const e = overshoot ? Ease.outBack(u, 1.6) : Ease.outQuad(u);
  return sliver + (1 - sliver) * e;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/// A soft heartbeat 0…1 (sin⁶ at 1.15 Hz), 0 at τ = 0.
function beat(tau: number): number {
  const ph = tau * 1.15 - Math.floor(tau * 1.15);
  const s = Math.sin(Math.PI * ph);
  const s2 = s * s;
  return s2 * s2 * s2;
}

/// Samples a transformation: the acting into `o` (raw, before the edge window), the silhouette into `shape`.
export function shapeSample(kind: OneShotKind, t: number, p: OneShotParams, o: OneShotOutput, shape: OneShotOutput): void {
  const f = new PupilShapeFrame();
  switch (kind) {
    case 'starEyes': starEyes(t, p, o, f); break;
    case 'heartEyes': heartEyes(t, p, o, f); break;
    case 'noteEyes': noteEyes(t, p, o, f); break;
    case 'questionEyes': questionEyes(t, p, o, f); break;
    case 'exclaimEyes': exclaimEyes(t, p, o, f); break;
    default: break;
  }
  shape.pupilShape = f.shape;
  shape.pupilMorph = f.morph;
  shape.pupilShapeScale = f.scale;
}

function both(f: PupilShapeFrame, s: PupilShape, morph: number, sx: number, sy: number): void {
  const m = Math.min(Math.max(morph, 0), 1);
  const shown = m > 0 ? s : 0;
  f.shape = v2(shown);
  f.morph = v2(shown === 0 ? 0 : m);
  f.scale = v4(sx, sy, sx, sy);
}

// MARK: Stars

function starEyes(t: number, p: OneShotParams, o: OneShotOutput, f: PupilShapeFrame): void {
  const intro = shapeIntro('starEyes'), tEnd = intro + resolvedHold('starEyes', p.hold);
  const rest = shapeRest;
  let morph: number, sx: number, sy: number;
  if (t < tEnd) {
    morph = Ease.smoothstep((t - 0.12) / 0.10);
    if (t < 0.12) {
      const e = Ease.smoothstep(t / 0.12);
      sx = lerp(1, 0.86, e); sy = lerp(1, 0.8, e);
    } else if (t < 0.24) {
      const e = Ease.outQuad((t - 0.12) / 0.12);
      sx = lerp(0.86, 1, e); sy = lerp(0.8, 1, e);
    } else {
      let v: number;
      if (p.bounce) {
        if (t < 0.32) v = lerp(1, 0.86, Ease.smoothstep((t - 0.24) / 0.08));
        else if (t < 0.40) v = lerp(0.86, 0.95, Ease.smoothstep((t - 0.32) / 0.08));
        else v = lerp(0.95, rest, Ease.smoothstep((t - 0.40) / 0.06));
        v += 0.015 * Math.sin(2 * Math.PI * 1.3 * Math.max(t - intro, 0)) * window(t, intro, intro + 0.2, tEnd - 0.2, tEnd);
      } else {
        v = lerp(1, rest, Ease.smoothstep((t - 0.24) / 0.16));
      }
      sx = v; sy = v;
    }
  } else {
    const u = t - tEnd;
    morph = 1 - Ease.smoothstep(u / 0.18);
    sx = sy = lerp(rest, 1, Ease.smoothstep(u / 0.2));
  }
  both(f, PupilShape.star, morph, sx, sy);

  // Acting: an anticipation squash and squint, the pop's stretch and hop, wide happy eyes, dilated pupils.
  const calm = p.reduceMotion ? 0 : 1;
  const antic = hump(t, 0.1, 0.2) * calm;
  const pop = hump(t, 0.25, 0.18) * calm;
  o.faceScaleMul = v2(1 + 0.03 * antic - 0.035 * pop, 1 - 0.05 * antic + 0.06 * pop);
  o.delta.setFace('centerY', py(-1.2 * hump(t, 0.27, 0.26) * calm));
  const squint = 0.12 * window(t, 0.02, 0.1, 0.16, 0.22);
  const happy = window(t, 0.2, 0.32, tEnd, tEnd + 0.2);
  setLids(o, -0.06 * happy, squint + 0.1 * happy);
  o.pupilSizeMul = v2(1 + 0.08 * window(t, 0.15, 0.3, tEnd, tEnd + 0.2));
  // Brows: a dip on the anticipation, a lift on the pop, then delighted arches.
  brows(o, { y: 0.07 * happy + 0.05 * pop - 0.03 * antic, curvature: 0.16 * happy });
}

// MARK: Hearts

function heartEyes(t: number, p: OneShotParams, o: OneShotOutput, f: PupilShapeFrame): void {
  const intro = shapeIntro('heartEyes'), tEnd = intro + resolvedHold('heartEyes', p.hold);
  const rest = shapeRest;
  let morph: number, v: number;
  if (t < tEnd) {
    morph = Ease.smoothstep((t - 0.42) / 0.18);
    if (t < 0.36) v = 1;
    else if (t < 0.42) v = lerp(1, 0.86, Ease.smoothstep((t - 0.36) / 0.06));
    else if (t < 0.62) v = lerp(0.86, 1, Ease.outQuad((t - 0.42) / 0.2));
    else if (t < intro) v = lerp(1, rest, Ease.smoothstep((t - 0.62) / 0.16));
    else {
      const pulse = p.bounce ? beat(t - intro) * window(t, intro, intro + 0.15, tEnd - 0.15, tEnd) : 0;
      v = rest + 0.035 * pulse;
    }
  } else {
    const u = t - tEnd;
    morph = 1 - Ease.smoothstep(u / 0.2);
    v = lerp(rest, 1, Ease.smoothstep(u / 0.22));
  }
  both(f, PupilShape.heart, morph, v, v);

  // Acting: the shy glance (pupils only, lids lowered, a little tilt), then back to the person; a soft happy squint.
  if (t < 0.36) o.gaze = makeGazeOverride(p.gazeA, 'smooth', true);
  else if (t < 0.56) o.gaze = makeGazeOverride(p.gazeB, 'saccade');
  const shy = window(t, 0.02, 0.16, 0.3, 0.46);
  const happy = window(t, 0.5, 0.7, tEnd, tEnd + 0.2);
  setLids(o, 0.16 * shy, 0.1 * happy);
  o.delta.setFace('angle', 3 * p.side * window(t, 0.02, 0.2, 0.3, 0.5) * (p.reduceMotion ? 0 : 1));
  o.pupilSizeMul = v2(1 + 0.1 * window(t, 0.45, 0.65, tEnd, tEnd + 0.2));
  // Brows: a shy dip, then the soft "aww" (inner ends up, a gentle arch).
  brows(o, { y: -0.02 * shy + 0.03 * happy, curvature: 0.08 * happy, inner: 0.08 * happy });
}

// MARK: Notes

function noteEyes(t: number, p: OneShotParams, o: OneShotOutput, f: PupilShapeFrame): void {
  const intro = shapeIntro('noteEyes'), flip = 0.11, tEnd = intro + resolvedHold('noteEyes', p.hold);
  const rest = shapeRest;
  let shown: boolean, sx: number, sy: number;
  if (t < tEnd) {
    shown = t >= flip;
    sx = (shown ? rest : 1) * flipX(t, flip, true);
    sy = lerp(1, rest, Ease.smoothstep((t - (flip - flipIn)) / (flipIn + flipOut)));
  } else {
    const u = t - tEnd;
    shown = u < flipIn;
    sx = shown ? rest * flipX(u, flipIn, false) : flipX(u, flipIn, false);
    sy = lerp(rest, 1, Ease.smoothstep(u / (flipIn + flipOut)));
  }
  both(f, PupilShape.note, shown ? 1 : 0, sx, sy);

  // Acting: the bob, alternating between the eyes (pupils and eyes sway in opposite phase).
  const a = p.reduceMotion ? 0 : (p.bounce ? 1 : 0.5);
  const ramp = window(t, intro, intro + 0.25, tEnd - 0.2, tEnd + 0.02) * a;
  const bob = Math.sin(2 * Math.PI * 1.4 * Math.max(t - intro, 0)) * ramp;
  o.delta.setEye('left', 'y', 0.1 * bob);
  o.delta.setEye('right', 'y', -0.1 * bob);
  o.delta.setEye('left', 'centerY', py(0.6 * bob));
  o.delta.setEye('right', 'centerY', py(-0.6 * bob));
  o.delta.setFace('centerY', py(0.35 * hump(t, 0.06, 0.12) * (p.reduceMotion ? 0 : 1)));
  // Brows: raised and happy, bobbing with their eyes.
  const up = window(t, 0, 0.25, tEnd - 0.1, tEnd + 0.1);
  brow(o, 'left', { y: 0.05 * up - 0.025 * bob, curvature: 0.12 * up });
  brow(o, 'right', { y: 0.05 * up + 0.025 * bob, curvature: 0.12 * up });
}

// MARK: Question marks

function questionEyes(t: number, p: OneShotParams, o: OneShotOutput, f: PupilShapeFrame): void {
  const intro = shapeIntro('questionEyes'), hold = resolvedHold('questionEyes', p.hold), tEnd = intro + hold;
  const rest = shapeRest;
  const leadLeft = p.lead < 0;
  const eye = (flip: number): { shown: boolean; sx: number; sy: number } => {
    if (t < tEnd) {
      const shown = t >= flip;
      return { shown, sx: (shown ? rest : 1) * flipX(t, flip, true),
        sy: lerp(1, rest, Ease.smoothstep((t - (flip - flipIn)) / (flipIn + flipOut))) };
    }
    const u = t - tEnd;
    const shown = u < flipIn;
    const fx = flipX(u, flipIn, false);
    return { shown, sx: shown ? rest * fx : fx, sy: lerp(rest, 1, Ease.smoothstep(u / (flipIn + flipOut))) };
  };
  const l = eye(leadLeft ? 0.11 : 0.23), r = eye(leadLeft ? 0.23 : 0.11);
  const q = PupilShape.question;
  f.shape = v2(l.shown ? q : 0, r.shown ? q : 0);
  f.morph = v2(l.shown ? 1 : 0, r.shown ? 1 : 0);
  f.scale = v4(l.sx, l.sy, r.sx, r.sy);

  // Acting: a small head tilt toward the leading eye with a "hmm?" nudge mid-hold, the leading brow raised.
  const w = window(t, 0, 0.3, tEnd, tEnd + 0.2);
  const nudge = p.bounce ? 2 * hump(t, intro + 0.5 * hold, 0.3) : 0;
  const side = leadLeft ? 1 : -1;
  o.delta.setFace('angle', side * (7 * w + nudge) * (p.reduceMotion ? 0.4 : 1));
  const lead = -0.08 * w, trail = 0.06 * w;
  o.lidCoverage = leadLeft ? v4(lead, 0, trail, 0) : v4(trail, 0, lead, 0);
  // The leading brow arches up ("hm?"), the other lowers a little.
  brow(o, leadLeft ? 'left' : 'right', { y: 0.11 * w + 0.03 * nudge / 2, rotation: -3 * w, curvature: 0.26 * w });
  brow(o, leadLeft ? 'right' : 'left', { y: -0.03 * w, curvature: -0.1 * w });
}

// MARK: Exclamation marks

function exclaimEyes(t: number, p: OneShotParams, o: OneShotOutput, f: PupilShapeFrame): void {
  const intro = shapeIntro('exclaimEyes'), flip = 0.09, tEnd = intro + resolvedHold('exclaimEyes', p.hold);
  const rest = 0.92;
  let shown: boolean, sx: number, sy: number;
  if (t < tEnd) {
    shown = t >= flip;
    sx = (shown ? rest : 1) * flipX(t, flip, true);
    if (t < flip) sy = lerp(1, rest, Ease.smoothstep((t - (flip - flipIn)) / flipIn));
    else sy = rest + (1 - rest) * hump(t, flip + 0.06, 0.12) * (p.reduceMotion ? 0.5 : 1);
  } else {
    const u = t - tEnd;
    shown = u < flipIn;
    const fx = flipX(u, flipIn, false);
    sx = shown ? rest * fx : fx;
    sy = lerp(rest, 1, Ease.smoothstep(u / (flipIn + flipOut)));
  }
  both(f, PupilShape.exclaim, shown ? 1 : 0, sx, sy);

  // Acting: an anticipation squash, the upright pop (vertical stretch, a hop, lids wide); after the flip back a
  // delighted squint (lower lids spring up, a happy hop, dilated pupils), authored here so there is one chirp.
  const calm = p.reduceMotion ? 0 : 1;
  const antic = hump(t, 0.05, 0.1) * calm;
  const pop = hump(t, 0.16, 0.18) * calm;
  let sxFace = 1 + 0.04 * antic - 0.05 * pop;
  let syFace = 1 - 0.06 * antic + 0.08 * pop;
  let y = -1.4 * hump(t, 0.17, 0.24) * calm;
  let upper = -0.15 * window(t, 0.08, 0.16, tEnd, tEnd + 0.1);
  let lower = 0;
  let dilate = 0;
  const tau = t - tEnd - 0.1;
  if (tau > 0) {
    lower = squintLower.value(tau) * (0.9 + 0.2 * p.v1);
    upper += 0.1 * Math.max(lower, 0) / 0.5;
    y += squintY.value(tau) * calm;
    const sq = 1 + squintScale.value(tau) * calm;
    const st = stretchScale(sq);
    sxFace *= st.x;
    syFace *= st.y;
    dilate = 0.15 * window(tau, 0.04, 0.26, 0.65, 0.98);
  }
  o.faceScaleMul = v2(sxFace, syFace);
  o.delta.setFace('centerY', py(y));
  setLids(o, upper, lower);
  o.pupilSizeMul = v2(1 + dilate);
  // Brows fly up with the pop and stay high, then settle into delighted arches with the squint.
  const high = window(t, 0.08, 0.18, tEnd, tEnd + 0.15);
  const glad = tau > 0 ? window(tau, 0.04, 0.2, 0.62, 0.98) : 0;
  brows(o, { y: 0.1 * high + 0.05 * pop - 0.03 * antic + 0.05 * glad, curvature: 0.18 * high + 0.18 * glad });
}

// MARK: Switch back

/// The scripted switch back from `from` (the silhouette when the release happened) at `t` seconds into it. Per eye: a
/// visible shape coin-flips (x squash to the sliver over `flipIn`, swap to the default pupil, open out over `flipOut`);
/// an eye showing nothing yet eases its scale home over `switchBackEase`.
export function switchBack(from: PupilShapeFrame, t: number): PupilShapeFrame {
  const out = new PupilShapeFrame();
  const shapeIn = [from.shape.x, from.shape.y], morphIn = [from.morph.x, from.morph.y];
  const scaleIn = [from.scale.x, from.scale.y, from.scale.z, from.scale.w];
  const shape = [0, 0], morph = [0, 0], scale = [1, 1, 1, 1];
  for (let e = 0; e < 2; e++) {
    const s0x = scaleIn[2 * e], s0y = scaleIn[2 * e + 1];
    const visible = shapeIn[e] !== 0 && morphIn[e] > 0.02;
    let scx = 1, scy = 1;
    if (!visible) {
      const k = Ease.smoothstep(t / switchBackEase);
      scx = s0x + (1 - s0x) * k; scy = s0y + (1 - s0y) * k;
    } else if (t < flipIn) {
      shape[e] = shapeIn[e];
      morph[e] = morphIn[e];
      scx = s0x * (1 - (1 - sliver) * Ease.inQuad(t / (flipIn - flipHold))); scy = s0y;
    } else {
      const u = Math.max(t - flipIn - flipHold, 0) / (flipOut - flipHold);
      const x0 = s0x * sliver;
      scx = x0 + (1 - x0) * Ease.outQuad(u); scy = s0y + (1 - s0y) * Ease.smoothstep(u);
    }
    scale[2 * e] = scx;
    scale[2 * e + 1] = scy;
  }
  out.shape = v2(shape[0], shape[1]);
  out.morph = v2(morph[0], morph[1]);
  out.scale = v4(scale[0], scale[1], scale[2], scale[3]);
  return out;
}
