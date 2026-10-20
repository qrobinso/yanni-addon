// Port of FaceEngine/EdgeAnticCurves.swift. Module-level code stays free of OneShots.ts exports (the two modules import
// each other): the shared OneShotLibrary helpers are reached through the lazy wrappers below, which the idle game
// curves use too.
import { SplitMix64 } from '../core/random';
import { v2, type V2 } from '../core/vec';
import { EdgeGeometry, Units, type Side } from '../model';
import { makeGazeOverride, type OneShotKind } from './Commands';
import { Ease } from './Easing';
import { EdgeAnticSettings } from './EdgeAnticSettings';
import type { OneShotOutput } from './FaceState';
import { IdleGameSettings } from './IdleGameSettings';
import { GazeTracking } from './modifiers/GazeTracking';
import { OneShotLibrary, OneShotParams, OneShotSpec, type BrowTrack, type OneShotChannels } from './OneShots';
import { SpringParams } from './Spring';

/// What an edge antic needs at trigger time (OneShotSampler fills it from `FaceState`).
export class EdgeAnticContext {
  /// The screen; null uses `EdgeGeometry.reference`.
  geometry: EdgeGeometry | null;
  settings: EdgeAnticSettings;
  /// +1 right, −1 left, 0 random.
  sideHint: number;
  /// The face's current centre offset from rest (canvas units, from last frame's pose).
  faceOffset: V2;
  /// Neutral trigger (no jitter, side +1, mid holds): nominal timings and accent times.
  neutral: boolean;
  /// Idle game tunables for a game trigger (the sampler copies `FaceState.idleGameSettings`).
  gameSettings = new IdleGameSettings();
  /// The primary person's screen-relative gaze point at a game trigger, null when no one is in frame.
  person: V2 | null = null;

  constructor(o: { geometry?: EdgeGeometry | null; settings?: EdgeAnticSettings; sideHint?: number; faceOffset?: V2;
    neutral?: boolean } = {}) {
    this.geometry = o.geometry ?? null;
    this.settings = o.settings ?? new EdgeAnticSettings();
    this.sideHint = o.sideHint ?? 0;
    this.faceOffset = o.faceOffset ? { ...o.faceOffset } : { x: 0, y: 0 };
    this.neutral = o.neutral ?? false;
  }
}

/// One edge antic trigger's timeline and travel, in base seconds and canvas units. Resolved once at trigger from the
/// screen geometry and settings. The meaning of the travel fields depends on the antic (see each curve).
export class EdgeAnticParams {
  /// Base duration; 0 = not an edge antic trigger.
  baseDuration = 0;
  /// The accent the voice lands on (base seconds).
  accent = 0;
  /// Return keyframe: the end of the hidden / held segment, where the face starts coming back.
  returnAt = 0;
  /// Squash / stretch / tilt / overshoot multiplier.
  intensity = 1;
  /// Main travel magnitudes (canvas units, ≥ 0, measured toward the side edge or down).
  hide = 0;
  near = 0;
  far = 0;
  /// Eye-shape lead (canvas units): the eye centres move this much before the face follows.
  lead = 0;
  /// Spring frequencies of the big moves, lowered per trigger so stage speed stays under the bound.
  omega1 = 0;
  omega2 = 0;
  omega3 = 0;
  /// Damping of the pop-up's spring up.
  zeta = 0;
  /// Timeline marks (base seconds).
  t1 = 0;
  t2 = 0;
  t3 = 0;
  t4 = 0;
  /// Delay before a peeking eye becomes visible again (base seconds).
  reveal = 0;

  copy(): EdgeAnticParams { return Object.assign(new EdgeAnticParams(), this); }
  equals(o: EdgeAnticParams): boolean {
    return (Object.keys(this) as (keyof EdgeAnticParams)[]).every((k) => this[k] === o[k]);
  }
}

// MARK: - Shared OneShotLibrary helpers (lazy: OneShots.ts is only read at call time)

export const px = (canvas: number): number => Units.poseX(canvas);
export const py = (canvas: number): number => Units.poseY(canvas);
export const stretchScale = (sy: number): V2 => OneShotLibrary.stretchScale(sy);
export const window = (t: number, a: number, b: number, c: number, d: number): number => OneShotLibrary.window(t, a, b, c, d);
export const blinkPulse = (t: number, start: number, close: number, hold: number, open: number): number =>
  OneShotLibrary.blinkPulse(t, start, close, hold, open);
export const hump = (t: number, c: number, w: number): number => OneShotLibrary.hump(t, c, w);
export const setLids = (o: OneShotOutput, upper: number, lower: number): void => OneShotLibrary.setLids(o, upper, lower);
export const brow = (o: OneShotOutput, side: Side, b: BrowTrack): void => OneShotLibrary.brow(o, side, b);
export const brows = (o: OneShotOutput, b: BrowTrack): void => OneShotLibrary.brows(o, b);
/// Component-wise product of two scales.
export const mul = (a: V2, b: V2): V2 => v2(a.x * b.x, a.y * b.y);
export const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');

// MARK: - Tuning

/// Stage speed bound (canvas units per second) for authored antic motion at any allowed timing scale and speed.
export const edgeStageSpeedLimit = 450;
/// Beyond "just off screen", hidden targets go this much further (covers gaze, drift and squash).
export const edgeHideMargin = 12;
/// Eye-shape lead (canvas units) and the staging delays: pupils at 0, eye shapes at `edgeEyeDelay`, the whole face
/// at `edgeFaceDelay` (base seconds).
export const edgeLead = 2.5;
export const edgeEyeDelay = 0.08;
export const edgeFaceDelay = 0.18;
/// Playback-speed clamp for the screen-edge antics (mood can't stretch hidden moments or rush big moves).
export const edgeSpeedRange: readonly [number, number] = [0.85, 1.25];
/// Per-trigger timing jitter (the only jitter source) and partial-travel jitter.
export const edgeTimeJitter: readonly [number, number] = [0.92, 1.08];
export const edgeTravelJitter: readonly [number, number] = [0.9, 1.1];
/// Hidden holds are fitted to this fraction of `maxHiddenSeconds`.
export const edgeHiddenBudget = 0.8;
/// Sleepy sink: base seconds at which the sink has settled into the sleep pose (the life cycle commits asleep here),
/// and its depth as a fraction of eye height.
export const sleepySinkSettle = 2.35;
export const sleepySinkDepth = 0.35;
/// OLED care: while an eye is held against the screen edge the face dims by this fraction (eased in and out).
export const edgeHoldDim = 0.08;

export const edgeLeadSpring = new SpringParams(14, 0.8);

export function edgeSpec(kind: OneShotKind, channels: OneShotChannels, priority: number): OneShotSpec {
  const p = referenceParams(kind);
  const sleepy = kind === 'sleepySink';
  return new OneShotSpec({
    kind, duration: p.edge.baseDuration, channels, cooldown: Math.ceil(p.edge.baseDuration + 0.5), stateScoped: true,
    priority, accentTimes: [p.edge.accent], releaseStyle: 'spring',
    allowedStates: sleepy ? ['drowsy', 'asleep'] : ['idle', 'noticing'],
    speedRange: sleepy ? [1, 1] : edgeSpeedRange,
  });
}

let referenceTable: OneShotParams[] | null = null;

/// The neutral trigger of an edge antic on the reference screen with default settings.
export function referenceParams(kind: OneShotKind): OneShotParams {
  if (!referenceTable) {
    const rng = new SplitMix64(1);
    referenceTable = (['shyPeek', 'popUp', 'curiousLean', 'pretendExit', 'sleepySink'] as const)
      .map((k) => makeEdgeParams(k, rng, new EdgeAnticContext({ neutral: true })));
  }
  switch (kind) {
    case 'shyPeek': return referenceTable[0];
    case 'popUp': return referenceTable[1];
    case 'curiousLean': return referenceTable[2];
    case 'pretendExit': return referenceTable[3];
    default: return referenceTable[4];
  }
}

// MARK: - Spring and glide primitives (closed form, frame-rate independent)

/// Unit step response of a spring released at t = 0 (0 before, zero slope at 0, → 1). ζ ≥ 1 is critical.
export function springStep(t: number, w: number, z: number): number {
  if (!(t > 0)) return 0;
  if (z >= 0.999) {
    const x = w * t;
    return 1 - (1 + x) * Math.exp(-x);
  }
  const wd = w * Math.sqrt(1 - z * z);
  const e = Math.exp(-z * w * t);
  return 1 - e * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
}

/// d/dt of `springStep`.
export function springStepVelocity(t: number, w: number, z: number): number {
  if (!(t > 0)) return 0;
  if (z >= 0.999) return w * w * t * Math.exp(-w * t);
  const wd = w * Math.sqrt(1 - z * z);
  return (w * w / wd) * Math.exp(-z * w * t) * Math.sin(wd * t);
}

/// Peak velocity of `springStep` per unit step and unit ω.
export function springPeakVelocityFactor(z: number): number {
  if (z >= 0.999) return Math.exp(-1);
  const r = Math.sqrt(1 - z * z);
  return Math.exp(-z * Math.acos(z) / r);
}

/// Smootherstep 0 → 1 over [t0, t0 + d] (zero velocity and acceleration at both ends).
export function glide(t: number, t0: number, d: number): number {
  return Ease.smootherstep((t - t0) / Math.max(d, 1e-4));
}

export function glideVelocity(t: number, t0: number, d: number): number {
  const x = (t - t0) / Math.max(d, 1e-4);
  if (!(x > 0 && x < 1)) return 0;
  return 30 * x * x * (1 - x) * (1 - x) / Math.max(d, 1e-4);
}

/// First time (≥ 0) the unit step response reaches `level` (bisection; trigger time only).
export function springReachTime(level: number, w: number, z: number): number {
  const target = Math.min(Math.max(level, 0), 0.999);
  let lo = 0, hi = 8 / Math.max(w, 0.1);
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (springStep(mid, w, z) >= target) hi = mid; else lo = mid;
  }
  return hi;
}

/// Time of a spring step's first overshoot peak (underdamped) or ~98 % arrival (critical).
export function springPeakTime(w: number, z: number): number {
  if (z >= 0.999) return 4 / Math.max(w, 0.1);
  return Math.PI / (w * Math.sqrt(1 - z * z));
}

/// Velocity-limited spring frequency: at most `nominal`, and low enough that a step of `travel` canvas units stays
/// under `vmax` at its peak.
export function limitedOmega(nominal: number, travel: number, zeta: number, vmax: number): number {
  const k = springPeakVelocityFactor(zeta) * Math.max(Math.abs(travel), 1e-3);
  return Math.min(nominal, Math.max(vmax / k, 1.5));
}

// MARK: - Trigger

/// Resolves an edge antic trigger: side, jitter, travel targets from the screen geometry, velocity-limited springs,
/// the hidden hold fitted to `maxHiddenSeconds`, and the timeline.
export function makeEdgeParams(kind: OneShotKind, rng: SplitMix64, c: EdgeAnticContext): OneShotParams {
  const st = c.settings.validated();
  const g = c.geometry?.isValid ? c.geometry : EdgeGeometry.reference;
  const p = new OneShotParams();
  const neutral = c.neutral;
  p.amp = 1;
  const jitter = neutral ? 1 : rng.uniform(edgeTimeJitter[0], edgeTimeJitter[1]);
  p.timeMul = jitter * st.timingScale;
  const randomSide = neutral ? 1 : (rng.chance(0.5) ? 1 : -1);
  p.side = c.sideHint > 0 ? 1 : (c.sideHint < 0 ? -1 : randomSide);
  p.v1 = neutral ? 0.5 : rng.unit();
  p.v2 = neutral ? 0.5 : rng.unit();
  const travelJ = neutral ? 1 : rng.uniform(edgeTravelJitter[0], edgeTravelJitter[1]);
  const travel = st.travel * travelJ;
  const s = p.side;
  const off = Number.isFinite(c.faceOffset.x) && Number.isFinite(c.faceOffset.y) ? c.faceOffset : v2(0);
  const inner: Side = s > 0 ? 'left' : 'right'; // the eye nearer the screen centre
  const outer: Side = s > 0 ? 'right' : 'left'; // the eye nearer the edge

  const e = new EdgeAnticParams();
  e.intensity = st.intensity;
  e.lead = edgeLead;
  const speedMax = kind === 'sleepySink' ? 1 : edgeSpeedRange[1];
  const speedMin = kind === 'sleepySink' ? 1 : edgeSpeedRange[0];
  // Authored speeds are base-time speeds; playback runs at speed / timeMul.
  const vmax = edgeStageSpeedLimit * 0.92 * p.timeMul / speedMax;

  switch (kind) {
    case 'shyPeek': {
      e.hide = s * g.offsetX(inner, 0, s, off) + edgeHideMargin;
      const vInner = Math.min(Math.max(0.55 * travel, 0.3), 0.85);
      const vOuter = Math.min(Math.max(0.6 * travel, 0.3), 0.85);
      e.near = Math.min(s * g.offsetX(inner, vInner, s, off), e.hide - 4);
      e.far = Math.max(s * g.offsetX(outer, vOuter, s, off), 0);
      e.omega1 = limitedOmega(7, e.hide, 1, vmax);
      e.omega2 = limitedOmega(9, e.hide - e.near, 0.65, vmax);
      e.omega3 = limitedOmega(6.5, Math.max(e.far, Math.abs(e.near - e.far), e.hide - e.far), 0.6, vmax);
      e.t1 = edgeFaceDelay + 0.02; // slide out starts
      // Hidden once the face has covered all but the margin of the slide.
      const reach = springReachTime((e.hide - e.lead - edgeHideMargin) / Math.max(e.hide - e.lead, 1), e.omega1, 1);
      // The inner eye is visible again once its peek has covered the margin.
      e.reveal = springReachTime(edgeHideMargin / Math.max(e.hide - e.near, 1), e.omega2, 0.65);
      const budget = edgeHiddenBudget * st.maxHiddenSeconds * speedMin / p.timeMul;
      const authoredHold = neutral ? 0.5 : rng.uniform(0.4, 0.65);
      const safety = 0.08;
      const hold = Math.min(authoredHold, Math.max(budget - e.reveal - safety, 0));
      e.t2 = e.t1 + reach + hold; // the inner eye peeks back
      e.returnAt = e.t2;
      e.t3 = e.t2 + Math.max(e.reveal + 0.5, springPeakTime(e.omega2, 0.65) + 0.15); // the second eye follows
      e.t4 = e.t3 + 0.6; // both settle, curious tilt
      e.accent = e.t2 + springPeakTime(e.omega2, 0.65);
      e.baseDuration = e.t4 + 2.1;
      break;
    }
    case 'popUp': {
      const higher: Side = g.center('left').y - g.halfSize('left').y <= g.center('right').y - g.halfSize('right').y
        ? 'left' : 'right';
      const vShow = Math.min(Math.max(1 - 0.7 * travel, 0.18), 0.65);
      e.near = Math.max(g.offsetDown(higher, vShow, off), 8); // crouch depth
      e.far = 3 * Math.min(st.intensity, 1.5); // overshoot above rest (canvas)
      e.omega1 = limitedOmega(7, e.near, 1, vmax);
      const os = Math.max(e.far, 0.3);
      const l = Math.log(Math.min(os / Math.max(e.near, 1), 0.5));
      e.zeta = Math.min(Math.max(-l / Math.sqrt(Math.PI * Math.PI + l * l), 0.45), 0.9);
      e.omega2 = limitedOmega(9, e.near, e.zeta, vmax);
      e.t1 = edgeFaceDelay + 0.2; // crouch starts after the lift
      const land = e.t1 + 4.2 / e.omega1;
      const pause = neutral ? 0.5 : rng.uniform(0.42, 0.6);
      e.t2 = land; // landed (squash)
      e.t3 = land + pause; // spring up
      e.returnAt = e.t3;
      e.accent = e.t3 + springPeakTime(e.omega2, e.zeta);
      e.baseDuration = e.t3 + 1.7;
      break;
    }
    case 'curiousLean': {
      const near: Side = outer;
      const vLean = Math.min(Math.max(1 - 0.38 * travel, 0.45), 0.9);
      // The glance itself carries the head and eye shapes part of the way (three-layer gaze).
      const gazeCarry = 0.9 * (GazeTracking.K.headTravel.x + GazeTracking.K.eyeTravel.x);
      e.near = Math.max(s * g.offsetX(near, vLean, s, off) - gazeCarry, 4);
      e.omega1 = limitedOmega(5.5, e.near, 0.8, vmax);
      e.omega2 = limitedOmega(6, e.near, 0.6, vmax);
      e.t1 = 0.26; // tilt starts
      const hold = neutral ? 1 : rng.uniform(0.8, 1.2);
      e.t2 = edgeFaceDelay + springReachTime(0.97, e.omega1, 0.8) + hold; // ease back
      e.returnAt = e.t2;
      e.accent = e.t1 + springPeakTime(6, 0.55);
      e.baseDuration = e.t2 + 1.6;
      break;
    }
    case 'pretendExit': {
      const vTrail = Math.min(Math.max(1 - 0.5 * travel, 0.3), 0.8);
      e.near = Math.max(s * g.offsetX(inner, vTrail, s, off), 4); // exit distance
      const outerHidden = s * g.offsetX(outer, 0, s, off) + 4;
      e.far = Math.max(outerHidden - e.near, 0); // extra push for the leading eye
      const slide = Math.max(1.6, 1.875 * e.near / Math.max(vmax, 1));
      e.t1 = edgeFaceDelay; // slide starts
      e.t2 = slide; // slide duration
      const lag = 0.25;
      const arrive = e.t1 + slide + lag;
      e.t3 = arrive; // linger + wink
      e.t4 = arrive + 0.8; // return
      e.returnAt = e.t4;
      e.omega1 = limitedOmega(6.5, e.near + e.far, 0.55, vmax);
      e.omega2 = limitedOmega(10, e.far + e.lead, 0.8, vmax);
      e.accent = e.t4 + springPeakTime(e.omega1, 0.55);
      e.baseDuration = e.t4 + 1.7;
      break;
    }
    default: { // sleepySink
      const lower: Side = g.center('left').y + g.halfSize('left').y >= g.center('right').y + g.halfSize('right').y
        ? 'left' : 'right';
      const room = g.visibleHalfExtent.y - (g.center(lower).y + g.halfSize(lower).y + Math.max(off.y, 0)) - 2;
      const eyeHeight = 2 * g.halfSize(lower).y;
      e.near = Math.max(Math.min(sleepySinkDepth * eyeHeight * st.travel, room), 2);
      e.lead = Math.min(1.5, e.near * 0.2);
      e.t1 = 1.9; // catch
      e.t2 = sleepySinkSettle; // settled (life cycle commits asleep)
      e.accent = e.t1 + springPeakTime(12, 0.5);
      e.returnAt = e.t1;
      e.baseDuration = 3.9;
      break;
    }
  }
  p.edge = e;
  return p;
}

// MARK: - Shared shaping

/// Volume-preserving horizontal stretch for a horizontal stage speed (canvas/s): a little wider while moving.
export function horizontalStretch(v: number, intensity: number): V2 {
  const a = 0.05 * intensity * Math.min(Math.abs(v) / 250, 1);
  return v2(1 + a, 1 / Math.sqrt(1 + a));
}

export function setEyeStage(o: OneShotOutput, side: Side, v: V2): void {
  if (side === 'left') { o.eyeStageOffset.x = v.x; o.eyeStageOffset.y = v.y; } else { o.eyeStageOffset.z = v.x; o.eyeStageOffset.w = v.y; }
}

export function addLids(o: OneShotOutput, side: Side, upper: number, lower: number): void {
  if (side === 'left') { o.lidCoverage.x += upper; o.lidCoverage.y += lower; } else { o.lidCoverage.z += upper; o.lidCoverage.w += lower; }
}

// MARK: - shyPeek: pupils dart to the edge, the eye shapes and then the face slip out of view; a beat hidden; the eye
// nearer the screen centre peeks back first with a blink, then the second follows; both come home with a curious tilt
// that overshoots. Face stage F and eye stages E are sums of spring steps (a retargeted spring): nothing snaps.

export function shyPeek(t: number, p: OneShotParams, o: OneShotOutput): void {
  const e = p.edge, s = p.side, k = e.intensity;
  const inner: Side = s > 0 ? 'left' : 'right';
  const outer: Side = s > 0 ? 'right' : 'left';
  const L = e.lead, H = e.hide, Pi = e.near, Po = e.far;
  const z2 = 0.65, z3 = 0.6;

  // Pupils lead: dart to the edge; back toward the viewer once peeking; released when settling.
  if (t < e.t2) o.gaze = makeGazeOverride(v2(s * 0.85, 0.06), 'saccade');
  else if (t < e.t4) o.gaze = makeGazeOverride(v2(-s * 0.45, 0), 'saccade');

  // Eye shapes lead the face.
  const lead = springStep(t - edgeEyeDelay, edgeLeadSpring.omega, edgeLeadSpring.zeta);
  const r1 = springStep(t - e.t1, e.omega1, 1);
  const r2 = springStep(t - e.t2, e.omega2, z2);
  const r3 = springStep(t - e.t3, e.omega3, z3);
  const r4 = springStep(t - e.t4, e.omega3, z3);
  const f = (H - L) * r1 + (Po - (H - L)) * r3 - Po * r4;
  const eIn = L * lead + (Pi - H) * r2 - (Pi - H + L) * r3;
  const eOut = L * lead - L * r3;
  o.stageOffset.x = s * f;
  setEyeStage(o, inner, v2(s * eIn, 0));
  setEyeStage(o, outer, v2(s * eOut, 0));

  // Anticipation: a small squash and a lean away from the edge, then horizontal stretch while moving.
  const antic = Ease.bump(t / 0.22) * (t < 0.22 ? 1 : 0);
  const vF = (H - L) * springStepVelocity(t - e.t1, e.omega1, 1)
    + (Po - (H - L)) * springStepVelocity(t - e.t3, e.omega3, z3) - Po * springStepVelocity(t - e.t4, e.omega3, z3);
  o.faceScaleMul = mul(stretchScale(1 - 0.05 * k * antic), horizontalStretch(vF, k));

  // Curious tilt as they settle (overshoots), then relax.
  const tilt = springStep(t - e.t4, 7, 0.45) - springStep(t - e.t4 - 0.9, 5, 0.8);
  o.delta.setFace('angle', -s * 3 * k * antic + s * 8 * k * tilt);
  const wide = -0.08 * Math.max(tilt, 0);
  addLids(o, inner, wide, 0);
  // Brows: a worried pinch while slipping away, the peeking eye's brow raised and curious as they come back.
  const peek = window(t, e.t2, e.t2 + 0.25, e.t4 + 0.6, e.t4 + 1.4);
  brows(o, { inner: 0.06 * k * antic });
  brow(o, inner, { y: 0.1 * k * peek + 0.04 * k * Math.max(tilt, 0), curvature: 0.22 * k * peek });
  brow(o, outer, { y: 0.03 * k * peek, curvature: 0.06 * k * peek });

  // One blink as the first eye re-enters.
  o.blink = blinkPulse(t, e.t2 + e.reveal + 0.05, 0.06, 0.02, 0.1);
  o.brightnessMul = 1 - edgeHoldDim * window(t, e.t2, e.t2 + 0.3, e.t4, e.t4 + 0.4);
}

// MARK: - popUp: pupils glance down, a little lift, then crouch below the bottom edge until only the tops of the eyes
// show; land with a squash; pause with the pupils peeking up; spring back up with a stretch, a small overshoot
// (≈ 3 canvas units) and a damped settle.

export function popUp(t: number, p: OneShotParams, o: OneShotOutput): void {
  const e = p.edge, k = e.intensity;
  const L = e.lead, C = e.near, lift = 2.5 * Math.min(k, 1.5);
  if (t < e.t2 - 0.1) o.gaze = makeGazeOverride(v2(0, 0.5), 'saccade');
  else if (t < e.t3 + 0.25) o.gaze = makeGazeOverride(v2(0, -0.75), 'saccade');

  const lead = springStep(t - edgeEyeDelay, edgeLeadSpring.omega, edgeLeadSpring.zeta);
  const rLift = springStep(t - edgeFaceDelay, 16, 0.75);
  const rDown = springStep(t - e.t1, e.omega1, 1);
  const rUp = springStep(t - e.t3, e.omega2, e.zeta);
  o.stageOffset.y = -lift * rLift + (C - L + lift) * rDown - (C - L) * rUp;
  const ey = L * lead - L * rUp;
  o.eyeStageOffset.y = ey;
  o.eyeStageOffset.w = ey;

  // Anticipation stretch, landing squash, stretch on the way up (motion squash-and-stretch adds to these).
  const stretchUp = 0.05 * k * Math.abs(springStepVelocity(t - e.t3, e.omega2, e.zeta))
    / Math.max(springPeakVelocityFactor(e.zeta) * e.omega2, 1e-3);
  const sy = 1 + 0.04 * k * hump(t, 0.24, 0.32) - 0.07 * k * hump(t, e.t2 + 0.05, 0.36)
    + stretchUp - 0.03 * k * hump(t, e.accent + 0.05, 0.3);
  o.faceScaleMul = stretchScale(sy);
  // Eyes open wide on the way up.
  const wide = -0.12 * k * window(t, e.t3 - 0.05, e.t3 + 0.12, e.t3 + 0.5, e.t3 + 0.9);
  setLids(o, wide, wide * 0.4);
  // Brows: pressed down onto the eyes while crouched, then flung up with the spring and a delighted arch at the top.
  const crouched = Math.min(Math.max(rDown - rUp, 0), 1);
  const flung = window(t, e.t3, e.t3 + 0.15, e.t3 + 0.55, e.t3 + 1.1);
  brows(o, { y: (-0.1 * crouched + 0.12 * flung) * Math.min(k, 1.5), curvature: -0.12 * crouched + 0.2 * flung });
  o.brightnessMul = 1 - edgeHoldDim * window(t, e.t1 + 0.2, e.t2, e.t3, e.t3 + 0.3);
}

// MARK: - curiousLean: pupils glance to the edge, the eye shapes and then the face follow until the near eye is partly
// clipped; a small tilt toward the edge; hold, the near eye wide; ease back with a slight overshoot.

export function curiousLean(t: number, p: OneShotParams, o: OneShotOutput): void {
  const e = p.edge, s = p.side, k = e.intensity;
  const near: Side = s > 0 ? 'right' : 'left';
  const L = e.lead, X = e.near;
  if (t < e.t2) o.gaze = makeGazeOverride(v2(s * 0.9, -0.04), 'saccade');

  const lead = springStep(t - edgeEyeDelay, edgeLeadSpring.omega, edgeLeadSpring.zeta);
  const rOut = springStep(t - edgeFaceDelay, e.omega1, 0.8);
  const rBack = springStep(t - e.t2, e.omega2, 0.6);
  o.stageOffset.x = s * (X - L) * (rOut - rBack);
  const ex = s * L * (lead - rBack);
  o.eyeStageOffset.x = ex;
  o.eyeStageOffset.z = ex;
  const vF = (X - L) * (springStepVelocity(t - edgeFaceDelay, e.omega1, 0.8) - springStepVelocity(t - e.t2, e.omega2, 0.6));
  o.faceScaleMul = horizontalStretch(vF, k);

  const tilt = springStep(t - e.t1, 6, 0.55) - springStep(t - e.t2, 5, 0.65);
  o.delta.setFace('angle', -s * 6 * k * tilt);
  const hold = window(t, 0.3, 0.8, e.t2, e.t2 + 0.5);
  addLids(o, near, -0.1 * hold, -0.03 * hold);
  o.brightnessMul = 1 - edgeHoldDim * hold;
  // Brows: the near eye's brow lifts with curiosity, the far one stays lower.
  const far = other(near);
  brow(o, near, { y: 0.1 * k * hold, rotation: -3 * k * hold, curvature: 0.2 * k * hold });
  brow(o, far, { y: -0.02 * k * hold });
}

// MARK: - pretendExit: a slow slide toward the edge keeping eye contact; the leading eye leaves, the trailing eye lags
// and lingers half-clipped for a final glance and a wink; then both come back together with an overshoot.

export function pretendExit(t: number, p: OneShotParams, o: OneShotOutput): void {
  const e = p.edge, s = p.side, k = e.intensity;
  const inner: Side = s > 0 ? 'left' : 'right';
  const outer: Side = s > 0 ? 'right' : 'left';
  const X = e.near, extra = e.far, L = e.lead;
  const lag = 0.25;
  const slide = glide(t, e.t1, e.t2), slideLag = glide(t - lag, e.t1, e.t2);
  const rRet = springStep(t - e.t4, e.omega1, 0.55);
  const lead = springStep(t - edgeEyeDelay, 10, 0.8);
  const rOutRet = springStep(t - e.t4, e.omega2, 0.8);
  const f = X * (slide - rRet);
  o.stageOffset.x = s * f;
  setEyeStage(o, inner, v2(s * X * (slideLag - slide), 0));
  setEyeStage(o, outer, v2(s * (L * lead + extra * slide - (L + extra) * rOutRet), 0));

  // Pupils keep contact: a small lead toward the viewer, growing with the distance travelled (≤ 0.25).
  const bias = Math.min(0.1 * glide(t, 0, 0.2) * (1 - rRet) + 0.15 * Math.min(Math.max(f / Math.max(X, 1), 0), 1), 0.25);
  o.delta.setEye('left', 'x', -s * bias);
  o.delta.setEye('right', 'x', -s * bias);

  const vF = X * (glideVelocity(t, e.t1, e.t2) - springStepVelocity(t - e.t4, e.omega1, 0.55));
  o.faceScaleMul = horizontalStretch(vF, k);
  o.delta.setFace('angle', -s * 3 * k * window(t, e.t1, e.t1 + e.t2 * 0.6, e.t4, e.t4 + 0.6));
  // The lingering eye's final glance: a wink.
  const wink = hump(t, e.t3 + 0.35, 0.36);
  addLids(o, inner, 0.8 * wink, 0.2 * wink);
  // Brows: the winking eye's brow dips, the other lifts with the cheeky glance.
  brow(o, inner, { y: -0.06 * wink, inner: -0.05 * wink });
  brow(o, outer, { y: 0.06 * wink, curvature: 0.12 * wink });
  o.brightnessMul = 1 - edgeHoldDim * window(t, e.t1 + 0.5 * e.t2, e.t3, e.t4, e.t4 + 0.5);
}

// MARK: - sleepySink: pupils drift low, the eyes and face drift lower as the lids droop; at the bottom it catches
// itself with a little bounce and a flick of the lids; then it settles back and the lids close for sleep. Stays fully
// on screen.

export function sleepySink(t: number, p: OneShotParams, o: OneShotOutput): void {
  const e = p.edge, s = p.side, k = e.intensity;
  const D = e.near, L = e.lead;
  const lead = springStep(t - edgeEyeDelay, 10, 0.9);
  const drift = glide(t, edgeFaceDelay, e.t1 - edgeFaceDelay);
  const bounce = springStep(t - e.t1, 12, 0.5);
  const back = glide(t, e.t2 + 0.05, 1.0);
  o.stageOffset.y = (D - L) * drift - 0.45 * D * bounce - (0.55 * D - L) * back;
  const ey = L * (lead - back);
  o.eyeStageOffset.y = ey;
  o.eyeStageOffset.w = ey;

  o.lidClose = 0.6 * glide(t, 0.1, 1.8) - 0.3 * glide(t, e.t1, 0.12) + 0.58 * glide(t, e.t2, 0.6)
    - 0.88 * glide(t, 3.05, 0.75);
  const pupilsLow = 0.3 * glide(t, 0, 0.5) - 0.2 * glide(t, e.t1, 0.15) - 0.1 * glide(t, e.t2, 0.8);
  o.delta.setEye('left', 'y', pupilsLow);
  o.delta.setEye('right', 'y', pupilsLow);
  o.delta.setFace('angle', s * 4 * k * (glide(t, 0.3, 1.6) - springStep(t - e.t1, 10, 0.5)));
  o.faceScaleMul = stretchScale(1 - 0.04 * k * hump(t, e.t1 - 0.05, 0.3) + 0.04 * k * hump(t, e.t1 + 0.15, 0.3));
  // Brows: heavy with the droop, a flick up at the catch (presence fades them out for sleep).
  const droop = Math.min(Math.max(o.lidClose, 0), 1);
  brows(o, { y: -0.05 * droop + 0.08 * k * hump(t, e.t1 + 0.12, 0.35), outer: -0.04 * droop });
}
