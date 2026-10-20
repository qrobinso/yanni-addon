// Port of FaceEngine/Modifiers/ExpressiveOverlay.swift.
import type { V2 } from '../../core/vec';
import { BrowLayout, ExpressionMix, type Side } from '../../model';
import { ExpressiveBrow, type ExpressiveBrowDelta, type ExpressivePlan } from '../ExpressivePlan';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { Spring1, SpringParams } from '../Spring';

/// Swift `ExpressionMix?` equality.
const mixEq = (a: ExpressionMix | null, b: ExpressionMix | null): boolean => (a === null || b === null ? a === b : a.equals(b));

/// Behaviour phase, after `OneShotSampler`: plays the overlay and brows of the current `ExpressivePlan` (expressive
/// decisions design §7). `FaceEngine.playExpressive` gates the plan and sends its glance, move and cue as ordinary
/// commands; this modifier owns only what lasts:
///
/// - Overlay: the envelope × intensity on a critically damped spring, written to `reactionOverlay` /
///   `reactionOverlayWeight`, only while TouchReactions' overlay is silent (weight < `touchYield`).
/// - Brows: the plan's brow delta × envelope × `browAmount` × brow intensity × brow presence, on two slightly
///   different underdamped springs, added to `browDelta`.
export class ExpressiveOverlay implements Modifier {
  readonly name = 'ExpressiveOverlay';
  readonly phase = Phase.behaviour;
  isEnabled = true;

  static readonly weightSpring = new SpringParams(12, 1);
  static readonly browSprings = { left: new SpringParams(13, 0.55), right: new SpringParams(14.5, 0.55) } as const;
  /// TouchReactions' overlay weight above which the plan's overlay yields.
  static readonly touchYield = 0.02;

  /// The plan playing (null: none) and when it started (engine time).
  private _plan: ExpressivePlan | null = null;
  get plan(): ExpressivePlan | null { return this._plan; }
  private startedAt = 0;
  private mix: ExpressionMix | null = null;
  private savedOverlay: ExpressionMix | null = null;
  private ownsOverlay = false;
  private weight = new Spring1(0);
  private browL = new Spring1(0);
  private browR = new Spring1(0);
  /// Plans started so far (status, tests).
  plansStarted = 0;
  /// This frame's overlay weight and brow levels (tests, status).
  overlayWeight = 0;
  browLevels: V2 = { x: 0, y: 0 };

  private lastBrow: ExpressiveBrow = 'none';
  private lastSide = 1;

  /// Starts `plan` (already gated) at engine time `time`, replacing any plan playing (its levels ease across).
  start(plan: ExpressivePlan, time: number): void {
    this._plan = plan.copy();
    this.startedAt = time;
    if (plan.expression !== null && plan.intensity > 0) {
      const m = ExpressionMix.single(plan.expression, 1);
      if (!mixEq(this.mix, m)) this.mix = m;
    } else {
      this.mix = null;
    }
    this.plansStarted += 1;
  }

  /// Eases the playing plan out from where it is.
  cancel(): void { this._plan = null; }

  update(s: FaceState): void {
    const dt = Math.max(s.dt, 0);
    let env = 0;
    let browTarget = 0;
    const p0 = this._plan;
    if (p0 !== null) {
      const t = s.time - this.startedAt;
      env = p0.envelope(t);
      browTarget = env * p0.browAmount;
      if (t > p0.duration) this._plan = null;
    }
    const overlayTarget = this.mix !== null && this._plan !== null ? env * this._plan.intensity : 0;
    this.weight.step(overlayTarget, ExpressiveOverlay.weightSpring, dt);
    this.browL.step(browTarget, ExpressiveOverlay.browSprings.left, dt);
    this.browR.step(browTarget, ExpressiveOverlay.browSprings.right, dt);
    if (!Number.isFinite(this.weight.value) || !Number.isFinite(this.weight.velocity)) this.weight = new Spring1(0);
    if (!Number.isFinite(this.browL.value) || !Number.isFinite(this.browL.velocity)) this.browL = new Spring1(0);
    if (!Number.isFinite(this.browR.value) || !Number.isFinite(this.browR.velocity)) this.browR = new Spring1(0);

    // Overlay.
    const w = Math.min(Math.max(this.weight.value, 0), 1);
    this.overlayWeight = 0;
    const m = this.mix;
    if (m !== null && w > 1e-4 && s.reactionOverlayWeight < ExpressiveOverlay.touchYield) {
      if (!this.ownsOverlay) { this.savedOverlay = s.reactionOverlay; this.ownsOverlay = true; }
      if (!mixEq(s.reactionOverlay, m)) s.reactionOverlay = m.copy();
      s.reactionOverlayWeight = w;
      this.overlayWeight = w;
    } else if (this.ownsOverlay && (w <= 1e-4 || s.reactionOverlayWeight >= ExpressiveOverlay.touchYield)) {
      // Ended, or the touch overlay took over (it sets its own mix at its taps): never stomp on it.
      if (m !== null && mixEq(s.reactionOverlay, m) && s.reactionOverlayWeight < ExpressiveOverlay.touchYield) s.reactionOverlay = this.savedOverlay;
      this.ownsOverlay = false;
      this.savedOverlay = null;
      if (this._plan === null) this.mix = null;
    }

    // Brows (the last plan's pose eases out on the springs after the plan ends).
    const p = this._plan;
    const brow = p?.brow ?? this.lastBrow;
    if (p !== null) { this.lastBrow = p.brow; this.lastSide = p.browSide; }
    const bi = Number.isFinite(s.browIntensity) ? Math.min(Math.max(s.browIntensity, 0), 2) : 1;
    const presence = Number.isFinite(s.browPresence) ? Math.min(Math.max(s.browPresence, 0), 1) : 1;
    const l = this.browL.value * bi * presence, r = this.browR.value * bi * presence;
    this.browLevels = { x: l, y: r };
    if (brow === 'none' || !(Math.abs(l) > 1e-4 || Math.abs(r) > 1e-4)) return;
    this.add(ExpressiveBrow.delta(brow, this.lastSide < 0), 'left', l, s);
    this.add(ExpressiveBrow.delta(brow, this.lastSide > 0), 'right', r, s);
  }

  private add(d: ExpressiveBrowDelta, side: Side, k: number, s: FaceState): void {
    const b = s.browDelta.raw;
    b[BrowLayout.index(side, 'y')] += d.y * k;
    b[BrowLayout.index(side, 'rotation')] += d.rotation * k;
    b[BrowLayout.index(side, 'inner')] += d.inner * k;
    b[BrowLayout.index(side, 'outer')] += d.outer * k;
    b[BrowLayout.index(side, 'curvature')] += d.curvature * k;
  }
}
