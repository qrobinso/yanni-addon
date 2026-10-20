// Port of FaceEngine/Modifiers/ExpressionTransition.swift.
import { SplitMix64 } from '../../core/random';
import {
  BrowLayout, BrowPose, ExpressionMix, FacePose, ParamLayout, type ExpressionLibrary, type ExpressionMixEntry,
} from '../../model';
import { BrowSpringCoefficients, BrowSprings } from '../BrowSprings';
import { ExpressionSpringCoefficients, ExpressionSprings } from '../ExpressionSprings';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { Spring1, SpringParams } from '../Spring';

const N = ParamLayout.count;
const NB = 32;

/// Unit-intensity decomposition of a resolved mix.
class Resolved {
  /// `pose(intensity 1) − neutral` on linear lanes (scale lanes unused).
  linear = new Float64Array(N);
  /// `ln(pose_i / neutral_i)` on scale lanes; 0 elsewhere.
  logScale = new Float64Array(N);
  /// The same for the brows.
  browLinear = new Float64Array(NB);
  browLog = new Float64Array(NB);
}

/// Lane groups that can be held back: eye shape (scale lanes), lids, brows.
const Hold = { eyeShape: 0, lids: 1, brows: 2 } as const;

/// Swift `[ExpressionMix.Entry] ==`.
function entriesEqual(a: readonly ExpressionMixEntry[], b: readonly ExpressionMixEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].name !== b[i].name || a[i].weight !== b[i].weight) return false;
  return true;
}
const copyEntries = (e: readonly ExpressionMixEntry[]): ExpressionMixEntry[] => e.map((x) => ({ ...x }));

const FREE = (() => {
  const m = new Float64Array(N);
  for (let i = 0; i < N; i++) m[i] = 1 - ExpressionSprings.scaleMask[i] - ExpressionSprings.lidMask[i];
  return m;
})();
const FREE_LOG = (() => {
  const m = new Float64Array(N);
  for (let i = 0; i < N; i++) m[i] = 1 - ExpressionSprings.scaleMask[i];
  return m;
})();

/// Expression phase: springs `basePose` and `browBase` toward the target expression.
///
/// - Target = `(s.expressionOverride ?? s.targetMix)` at intensity × `s.modulation.intensity`; the brows' deviation
///   from Neutral is further scaled by `s.browIntensity`. The mix is resolved once per change into a cached
///   unit-intensity decomposition (linear deltas + log scale ratios).
/// - Per-group closed-form damped springs (H3): ω × speed, ζ × (1 − 0.25·bounciness). Brows use `BrowSprings`.
/// - Overlapping action: each mix change holds some lane groups on the previous target for a moment (follow: lids
///   `lidLag`, brows 40–80 ms; lead (0.35): eye shape 60–120 ms). The step is split exactly at each switch time.
/// - Emotion expression blended by `emotionWeight × authority` on a spring; reaction overlay lerped on top.
/// - Clamps nothing (Composer clamps).
export class ExpressionTransition implements Modifier {
  readonly name = 'ExpressionTransition';
  readonly phase = Phase.expression;
  isEnabled = true;
  /// Snap to the first target instead of springing from the library's Neutral (app launch while asleep).
  snapOnFirstFrame = true;
  /// Chance that an expression change is led by the brows (the eye shape held back) instead of followed by them.
  leadChance = 0.35;

  /// Lead: how long the eye shape is held back (seconds at speed 1).
  static readonly leadDelay = [0.06, 0.12] as const;
  /// Follow: how long the brows are held back (seconds at speed 1).
  static readonly followBrowDelay = [0.04, 0.08] as const;
  /// Longest a held target may go without a fresh snapshot while changes keep arriving (seconds).
  static readonly snapshotPeriod = 0.05;

  private current = new Resolved();
  private previous = new Resolved();
  private neutral = FacePose.defaults;
  private neutralBrows = BrowPose.restNeutral;
  private cachedEntries: ExpressionMixEntry[] = [];
  private cachedLibraryVersion = -Infinity;
  private cachedIsOverride = false;
  private hasCache = false;
  /// Per hold group: until when it holds, when its held target was last snapshotted, its delay (seconds at speed 1).
  private holdUntil = new Float64Array(3).fill(-Infinity);
  private snapshotAt = new Float64Array(3).fill(-Infinity);
  private delay = new Float64Array(3);
  /// Private dice (never the shared generator, so other modifiers' random streams stay untouched).
  private rng = new SplitMix64(0xB20B5EEDn);

  private velocity = new Float64Array(N);
  private browVelocity = new Float64Array(NB);
  private initialized = false;

  // Reaction overlay cache.
  private overlay = new Resolved();
  private overlayEntries: ExpressionMixEntry[] = [];
  private overlayLibraryVersion = -Infinity;
  private hasOverlayCache = false;
  /// Number of times the reaction overlay mix has been resolved (tests).
  overlayRecomputeCount = 0;

  // Emotion expression (the emotion layer).
  /// Eases the shown emotion weight (critically damped; ≈ 0.6 s to 95 %).
  static readonly emotionWeightSpring = new SpringParams(8, 1);
  /// Emotion intensity × mood intensity never exceeds this.
  static readonly maxEmotionIntensity = 1.1;
  private emotion = new Resolved();
  private emotionEntries: ExpressionMixEntry[] = [];
  private emotionLibraryVersion = -Infinity;
  private hasEmotionCache = false;
  private emotionIntensity = 1;
  private emotionW = new Spring1(0);
  /// Number of times the emotion mix has been resolved (tests).
  emotionRecomputeCount = 0;
  /// The emotion weight shown this frame (after authority and smoothing).
  shownEmotionWeight = 0;

  /// Number of times the target mix has been resolved (tests / perf overlay).
  cacheRecomputeCount = 0;
  /// The target pose of the most recent frame (after intensity modulation).
  readonly currentTarget = FacePose.defaults;
  /// The target brows of the most recent frame (after intensity modulation and brow intensity).
  readonly currentBrowTarget = BrowPose.restNeutral;
  /// Whether the most recent expression change was led by the brows.
  lastChangeLedByBrows = false;
  /// Expression-spring velocity (PyCozmo units/s).
  get basePoseVelocity(): FacePose { return new FacePose(this.velocity); }
  /// Brow-spring velocity (eye-relative units/s).
  get browBaseVelocity(): BrowPose { return new BrowPose(this.browVelocity); }

  // Scratch (no per-frame allocation).
  private readonly kPose = new ExpressionSpringCoefficients();
  private readonly kBrow = new BrowSpringCoefficients();
  private readonly target = new Float64Array(N);
  private readonly browTarget = new Float64Array(NB);
  private readonly old = new Float64Array(N);
  private readonly oldBrows = new Float64Array(NB);
  private readonly overlayPose = new Float64Array(N);
  private readonly overlayBrows = new Float64Array(NB);
  private readonly emotionPose = new Float64Array(N);
  private readonly emotionBrows = new Float64Array(NB);
  private readonly t1 = new Float64Array(N);
  private readonly b1 = new Float64Array(NB);
  private readonly cuts = new Float64Array(4);
  private ew = 0;
  private ow = 0;

  update(s: FaceState): void {
    const isOverride = s.expressionOverride !== null;
    const mix = s.expressionOverride ?? s.targetMix;
    const tStart = s.time - s.dt;
    const speed = Math.max(s.modulation.speed, 0.05);

    if (!this.hasCache || s.libraryVersion !== this.cachedLibraryVersion || isOverride !== this.cachedIsOverride
      || !entriesEqual(mix.entries, this.cachedEntries)) {
      const fresh = ExpressionTransition.resolve(mix, s.library);
      this.neutral = s.library.neutral.copy();
      this.neutralBrows = s.library.neutralBrows.copy();
      if (this.hasCache) this.beginHolds(tStart, speed);
      this.current = fresh;
      this.cachedEntries = copyEntries(mix.entries);
      this.cachedLibraryVersion = s.libraryVersion;
      this.cachedIsOverride = isOverride;
      this.hasCache = true;
      this.cacheRecomputeCount += 1;
    }

    const intensity = mix.intensity * s.modulation.intensity;
    const bi = Number.isFinite(s.browIntensity) ? Math.min(Math.max(s.browIntensity, 0), 2) : 1;

    // Reaction overlay (weight 0 → exactly the plain target).
    const rawW = s.reactionOverlayWeight;
    let ow = (isOverride || !Number.isFinite(rawW)) ? 0 : Math.min(Math.max(rawW, 0), 1);
    const ov = s.reactionOverlay;
    if (ow > 0 && ov !== null) {
      if (!this.hasOverlayCache || !entriesEqual(ov.entries, this.overlayEntries) || s.libraryVersion !== this.overlayLibraryVersion) {
        this.overlay = ExpressionTransition.resolve(ov, s.library);
        this.overlayEntries = copyEntries(ov.entries);
        this.overlayLibraryVersion = s.libraryVersion;
        this.hasOverlayCache = true;
        this.overlayRecomputeCount += 1;
      }
      const oi = ov.intensity * s.modulation.intensity;
      this.evaluate(this.overlay, oi, this.overlayPose);
      this.evaluateBrows(this.overlay, oi * bi, this.overlayBrows);
    } else {
      ow = 0;
    }
    this.ow = ow;
    // Emotion expression (weight 0 → exactly the state target).
    const ew = this.emotionWeight(s, isOverride);
    this.ew = ew;
    if (ew > 0) {
      const ei = Math.min(this.emotionIntensity * s.modulation.intensity, ExpressionTransition.maxEmotionIntensity);
      this.evaluate(this.emotion, ei, this.emotionPose);
      this.evaluateBrows(this.emotion, ei * bi, this.emotionBrows);
    }

    const target = this.target, browTarget = this.browTarget;
    this.evaluate(this.current, intensity, target);
    this.layered(target, this.emotionPose, this.overlayPose);
    this.evaluateBrows(this.current, intensity * bi, browTarget);
    this.layered(browTarget, this.emotionBrows, this.overlayBrows);
    this.currentTarget.raw.set(target);
    this.currentBrowTarget.raw.set(browTarget);

    if (!this.initialized) {
      this.initialized = true;
      if (this.snapOnFirstFrame) {
        s.basePose.raw.set(target); this.velocity.fill(0);
        s.browBase.raw.set(browTarget); this.browVelocity.fill(0);
        this.holdUntil.fill(-Infinity);
        return;
      }
    }
    if (s.basePose.hasNonFinite || !allFinite(this.velocity, N)) {
      s.basePose.raw.set(target); this.velocity.fill(0);
    }
    if (s.browBase.hasNonFinite || !ExpressionTransition.finite(this.browVelocity)) {
      s.browBase.raw.set(browTarget); this.browVelocity.fill(0);
    }

    const dt = s.dt;
    if (!(dt > 0)) return;
    const bounce = s.modulation.bounciness;
    const tEnd = tStart + dt;
    const hu = this.holdUntil;
    if (Math.max(hu[0], hu[1], hu[2]) > tStart) {
      const old = this.old, oldBrows = this.oldBrows;
      this.evaluate(this.previous, intensity, old);
      this.layered(old, this.emotionPose, this.overlayPose);
      this.evaluateBrows(this.previous, intensity * bi, oldBrows);
      this.layered(oldBrows, this.emotionBrows, this.overlayBrows);
      // Split the step exactly at each hold's end inside this frame (≤ 3 interior cuts, sorted in place).
      const cuts = this.cuts;
      cuts.fill(tEnd);
      let n = 0;
      for (let c = 0; c < 3; c++) if (hu[c] > tStart && hu[c] < tEnd) { cuts[n] = hu[c]; n += 1; }
      if (n > 1) {
        for (let i = 1; i < n; i++) {
          let j = i;
          while (j > 0 && cuts[j - 1] > cuts[j]) { const t = cuts[j]; cuts[j] = cuts[j - 1]; cuts[j - 1] = t; j -= 1; }
        }
      }
      let a = tStart;
      const sm = ExpressionSprings.scaleMask, lm = ExpressionSprings.lidMask;
      for (let k = 0; k <= n; k++) {
        const b = k < n ? cuts[k] : tEnd;
        const sub = b - a;
        if (sub > 0) {
          const eyeHeld = hu[Hold.eyeShape] > a, lidsHeld = hu[Hold.lids] > a;
          const browHeld = hu[Hold.brows] > a ? 1 : 0;
          const t1 = this.t1, b1 = this.b1;
          for (let i = 0; i < N; i++) {
            const held = (eyeHeld ? sm[i] : 0) + (lidsHeld ? lm[i] : 0);
            t1[i] = target[i] + (old[i] - target[i]) * held;
          }
          for (let i = 0; i < NB; i++) b1[i] = browTarget[i] + (oldBrows[i] - browTarget[i]) * browHeld;
          this.step(s.basePose.raw, t1, sub, speed, bounce);
          this.stepBrows(s.browBase.raw, b1, sub, speed, bounce);
        }
        a = b;
      }
    } else {
      this.step(s.basePose.raw, target, dt, speed, bounce);
      this.stepBrows(s.browBase.raw, browTarget, dt, speed, bounce);
    }
  }

  /// In place: `p = ew > 0 ? p + (emotion − p)·ew : p`, then the overlay the same way.
  private layered(p: Float64Array, emotion: Float64Array, overlay: Float64Array): void {
    const ew = this.ew, ow = this.ow;
    if (ew > 0) for (let i = 0; i < p.length; i++) p[i] = p[i] + (emotion[i] - p[i]) * ew;
    if (ow > 0) for (let i = 0; i < p.length; i++) p[i] = p[i] + (overlay[i] - p[i]) * ow;
  }

  /// Steps the emotion weight spring toward `emotionWeight × authority` (0 under an override), re-resolving the
  /// emotion mix when it changed. Returns the weight to blend with (0 when nothing is cached).
  private emotionWeight(s: FaceState, isOverride: boolean): number {
    const em = s.emotionMix;
    if (em !== null) {
      if (!this.hasEmotionCache || !entriesEqual(em.entries, this.emotionEntries) || s.libraryVersion !== this.emotionLibraryVersion) {
        this.emotion = ExpressionTransition.resolve(em, s.library);
        this.emotionEntries = copyEntries(em.entries);
        this.emotionLibraryVersion = s.libraryVersion;
        this.hasEmotionCache = true;
        this.emotionRecomputeCount += 1;
      }
      this.emotionIntensity = Number.isFinite(em.intensity) ? Math.max(em.intensity, 0) : 1;
    }
    const raw = s.emotionWeight * s.emotionAuthority.get(s.agentState);
    let target = isOverride || s.emotionMix === null || !Number.isFinite(raw) ? 0 : Math.min(Math.max(raw, 0), 1);
    if (!this.hasEmotionCache) target = 0;
    if (!Number.isFinite(this.emotionW.value) || !Number.isFinite(this.emotionW.velocity)) this.emotionW = new Spring1(target);
    // Blend with the weight at mid-step so the pose follows a moving weight the same at 60 and 120 fps.
    const w0 = this.emotionW.value;
    if (s.dt > 0) this.emotionW.step(target, ExpressionTransition.emotionWeightSpring, s.dt);
    if (target === 0 && this.emotionW.value < 1e-4 && Math.abs(this.emotionW.velocity) < 1e-3) this.emotionW = new Spring1(0);
    const mid = this.emotionW.value === 0 ? 0 : (w0 + this.emotionW.value) / 2;
    const w = isOverride || !this.hasEmotionCache ? 0 : Math.min(Math.max(mid, 0), 1);
    this.shownEmotionWeight = w;
    return w;
  }

  /// A new mix arrived at `t`: decide lead / follow (only when no hold is pending), snapshot each group's held
  /// target and restart the holds.
  private beginHolds(t: number, speed: number): void {
    const hu = this.holdUntil;
    const pending = Math.max(hu[0], hu[1], hu[2]) > t;
    if (!pending) {
      const lead = this.leadChance > 0 && this.rng.unit() < this.leadChance;
      this.lastChangeLedByBrows = lead;
      if (lead) {
        const d = this.rng.uniform(ExpressionTransition.leadDelay[0], ExpressionTransition.leadDelay[1]);
        this.delay[0] = d; this.delay[1] = Math.max(d, ExpressionSprings.lidLag); this.delay[2] = 0;
      } else {
        this.delay[0] = 0; this.delay[1] = ExpressionSprings.lidLag;
        this.delay[2] = this.rng.uniform(ExpressionTransition.followBrowDelay[0], ExpressionTransition.followBrowDelay[1]);
      }
    }
    for (let c = 0; c < 3; c++) {
      const period = Math.min(this.delay[c] / speed, ExpressionTransition.snapshotPeriod);
      if (t >= hu[c] || t - this.snapshotAt[c] >= period - 1e-9) {
        this.copyGroup(c);
        this.snapshotAt[c] = t;
      }
      hu[c] = this.delay[c] > 0 ? t + this.delay[c] / speed : -Infinity;
    }
  }

  /// `previous` takes `current`'s lanes of one hold group.
  private copyGroup(c: number): void {
    const p = this.previous, cur = this.current;
    switch (c) {
      case Hold.eyeShape: {
        const m = ExpressionSprings.scaleMask;
        for (let i = 0; i < N; i++) {
          p.logScale[i] = p.logScale[i] + (cur.logScale[i] - p.logScale[i]) * m[i];
          p.linear[i] = p.linear[i] + (cur.linear[i] - p.linear[i]) * m[i];
        }
        break;
      }
      case Hold.lids: {
        const m = ExpressionSprings.lidMask;
        for (let i = 0; i < N; i++) p.linear[i] = p.linear[i] + (cur.linear[i] - p.linear[i]) * m[i];
        break;
      }
      case Hold.brows:
        p.browLinear.set(cur.browLinear);
        p.browLog.set(cur.browLog);
        break;
    }
    // Lanes in no hold group always follow at once; keep them current so a held evaluation never lags them.
    for (let i = 0; i < N; i++) {
      p.linear[i] = p.linear[i] + (cur.linear[i] - p.linear[i]) * FREE[i];
      p.logScale[i] = p.logScale[i] + (cur.logScale[i] - p.logScale[i]) * FREE_LOG[i];
    }
  }

  private step(x: Float64Array, target: Float64Array, dt: number, speed: number, bounciness: number): void {
    if (!(dt > 0)) return;
    const k = ExpressionSprings.coefficients(dt, speed, bounciness, this.kPose);
    const v = this.velocity;
    for (let i = 0; i < N; i++) {
      const e = x[i] - target[i];
      x[i] = target[i] + e * k.a[i] + v[i] * k.b[i];
      v[i] = e * k.c[i] + v[i] * k.d[i];
    }
  }

  private stepBrows(x: Float64Array, target: Float64Array, dt: number, speed: number, bounciness: number): void {
    if (!(dt > 0)) return;
    const k = BrowSprings.coefficients(dt, speed, bounciness, this.kBrow);
    const v = this.browVelocity;
    for (let i = 0; i < NB; i++) {
      const e = x[i] - target[i];
      x[i] = target[i] + e * k.a[i] + v[i] * k.b[i];
      v[i] = e * k.c[i] + v[i] * k.d[i];
    }
  }

  /// Target pose at a given intensity into `out`. Matches `ExpressionMix.pose(in:)`.
  private evaluate(r: Resolved, intensity: number, out: Float64Array): void {
    const n = this.neutral.raw;
    for (let i = 0; i < N; i++) out[i] = n[i] + r.linear[i] * intensity;
    for (const i of ExpressionSprings.scaleIndices) out[i] = n[i] * Math.exp(intensity * r.logScale[i]);
  }

  /// Target brows at a given amplitude into `out`. Matches `ExpressionMix.brows(in:)`.
  private evaluateBrows(r: Resolved, amplitude: number, out: Float64Array): void {
    const n = this.neutralBrows.raw;
    for (let i = 0; i < NB; i++) out[i] = n[i] + r.browLinear[i] * amplitude;
    for (const i of BrowLayout.scaleIndices) out[i] = n[i] * Math.exp(amplitude * r.browLog[i]);
  }

  static resolve(mix: ExpressionMix, library: ExpressionLibrary): Resolved {
    const n = library.neutral;
    const unitMix = new ExpressionMix(mix.entries, 1);
    const unit = unitMix.pose(library);
    const r = new Resolved();
    for (let i = 0; i < N; i++) r.linear[i] = unit.raw[i] - n.raw[i];
    for (const i of ParamLayout.scaleIndices) {
      r.linear[i] = 0;
      r.logScale[i] = Math.log(Math.max(unit.raw[i], 1e-3) / Math.max(n.raw[i], 1e-3));
    }
    const nb = library.neutralBrows;
    const ub = unitMix.brows(library);
    for (let i = 0; i < NB; i++) r.browLinear[i] = ub.raw[i] - nb.raw[i];
    for (const i of BrowLayout.scaleIndices) {
      r.browLinear[i] = 0;
      r.browLog[i] = Math.log(Math.max(ub.raw[i], 1e-3) / Math.max(nb.raw[i], 1e-3));
    }
    return r;
  }

  static finite(v: Float64Array): boolean {
    for (const i of BrowLayout.usedIndices) if (!Number.isFinite(v[i])) return false;
    return true;
  }
}

function allFinite(v: Float64Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}
