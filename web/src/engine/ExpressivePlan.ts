// Port of FaceEngine/ExpressivePlan.swift.
import type { AgentState } from './AgentState';
import type { OneShotKind } from './Commands';
import { Ease } from './Easing';
import { OneShotRequest } from './OneShots';
import { reactionCueEquals, type ReactionCue } from './PupilReactionTypes';

/// A brow pose an expressive plan layers over the expression brows (expressive decisions design §7).
export type ExpressiveBrow = 'none' | 'raise' | 'sceptical' | 'furrow' | 'worried';

export interface ExpressiveBrowDelta { y: number; rotation: number; inner: number; outer: number; curvature: number }

export const ExpressiveBrow = {
  allCases: ['none', 'raise', 'sceptical', 'furrow', 'worried'] as readonly ExpressiveBrow[],
  /// Eye-relative delta for one brow (`lead`: the raised brow of a sceptical look).
  delta(b: ExpressiveBrow, lead: boolean): ExpressiveBrowDelta {
    const d = (y: number, rotation: number, inner: number, outer: number, curvature: number): ExpressiveBrowDelta =>
      ({ y, rotation, inner, outer, curvature });
    switch (b) {
      case 'none': return d(0, 0, 0, 0, 0);
      case 'raise': return d(0.14, 0, 0.04, 0.02, 0.18);
      case 'sceptical': return lead ? d(0.18, -6, 0, 0.06, 0.2) : d(-0.05, 4, -0.05, 0, -0.05);
      case 'furrow': return d(-0.07, -12, -0.08, 0, -0.1);
      case 'worried': return d(0.04, 9, 0.08, -0.02, -0.04);
    }
  },
} as const;

/// A glance an expressive plan makes, sent as an ordinary `.glance` command so it composes with Attention.
export type ExpressiveGaze = 'none' | 'lookAt' | 'lookAway' | 'glanceAround' | 'eyeRoll';
export const ExpressiveGaze = {
  allCases: ['none', 'lookAt', 'lookAway', 'glanceAround', 'eyeRoll'] as readonly ExpressiveGaze[],
} as const;

const SLEEPY: ReadonlySet<AgentState> = new Set<AgentState>(['asleep', 'drowsy', 'waking', 'halfAwake']);
const TURN: ReadonlySet<AgentState> = new Set<AgentState>(['listening', 'thinking', 'speaking', 'interrupted']);

/// One considered reaction (expressive decisions design §7): an expression overlay with an onset / hold / release
/// envelope, a brow pose on springs, a glance, an optional one-shot and an optional reaction cue for the pupil arbiter.
/// A class standing in for a Swift struct: `copy()` where the Swift copies.
export class ExpressivePlan {
  /// Library expression shown as the overlay (null: brows / glance / beats only).
  expression: string | null = null;
  /// Overlay intensity 0…1 (the envelope's peak weight).
  intensity = 0.7;
  /// Envelope, seconds: ease in, hold, ease out.
  onset = 0.18;
  hold = 1.2;
  release = 0.6;
  brow: ExpressiveBrow = 'none';
  /// Brow delta scale 0…1.
  browAmount = 1;
  /// The raised brow of a sceptical look: −1 left, +1 right.
  browSide = 1;
  gaze: ExpressiveGaze = 'none';
  move: OneShotKind | null = null;
  /// The move's amplitude (`OneShotRequest.intensity`).
  moveIntensity = 1;
  /// A pupil transformation request for the arbiter.
  cue: ReactionCue | null = null;

  constructor(o: Partial<Pick<ExpressivePlan, 'expression' | 'intensity' | 'onset' | 'hold' | 'release' | 'brow' |
    'browAmount' | 'browSide' | 'gaze' | 'move' | 'moveIntensity' | 'cue'>> = {}) {
    Object.assign(this, o);
  }

  copy(): ExpressivePlan { return new ExpressivePlan({ ...this, cue: this.cue && { ...this.cue } }); }

  equals(o: ExpressivePlan): boolean {
    return this.expression === o.expression && this.intensity === o.intensity && this.onset === o.onset &&
      this.hold === o.hold && this.release === o.release && this.brow === o.brow && this.browAmount === o.browAmount &&
      this.browSide === o.browSide && this.gaze === o.gaze && this.move === o.move &&
      this.moveIntensity === o.moveIntensity &&
      (this.cue === o.cue || (this.cue !== null && o.cue !== null && reactionCueEquals(this.cue, o.cue)));
  }

  /// Total length of the envelope, seconds.
  get duration(): number { return this.onset + this.hold + this.release; }

  /// True when nothing would show.
  get isEmpty(): boolean {
    return (this.expression === null || this.intensity <= 0) && (this.brow === 'none' || this.browAmount <= 0) &&
      this.gaze === 'none' && this.move === null && this.cue === null;
  }

  /// Finite, clamped values (envelope ≥ 0, ≤ 6 s per segment; intensities 0…1).
  validated(): ExpressivePlan {
    const c = (v: number, lo: number, hi: number, d: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d);
    const p = this.copy();
    p.intensity = c(this.intensity, 0, 1, 0);
    p.onset = c(this.onset, 0.05, 6, 0.18);
    p.hold = c(this.hold, 0, 6, 1);
    p.release = c(this.release, 0.05, 6, 0.6);
    p.browAmount = c(this.browAmount, 0, 1, 0);
    p.browSide = this.browSide < 0 ? -1 : 1;
    // The pupil transformation must stay readable: no squinted-shut overlay, a gentler move.
    if (this.cue !== null) p.intensity = Math.min(p.intensity, ExpressivePlan.cueMaxOverlay);
    const r = OneShotRequest.amplitudeIntensityRange;
    p.moveIntensity = c(this.moveIntensity, r[0], r[1], 1);
    if (this.cue !== null) p.moveIntensity = Math.min(p.moveIntensity, ExpressivePlan.cueMaxMove);
    return p;
  }

  /// With a pupil cue: the overlay and move caps that keep the transformation visible.
  static readonly cueMaxOverlay = 0.45;
  static readonly cueMaxMove = 0.6;
  /// States where the plan is dropped entirely (Yanni is asleep or getting there).
  static readonly sleepyStates = SLEEPY;
  /// A turn is running: only a subtle overlay and brows.
  static readonly turnStates = TURN;
  static readonly turnOverlayScale = 0.5;
  static readonly turnBrowScale = 0.6;
  static readonly turnMaxHold = 1.2;
  static readonly bedtimeOverlayScale = 0.5;
  static readonly bedtimeBrowScale = 0.7;
  static readonly reduceMotionEnvelopeScale = 1.5;
  /// The governor's motion budget below which moves are dropped.
  static readonly minMotionForMoves = 0.5;

  /// The plan as it may play now (design §7 gating), or null when nothing would show. Pure.
  gated(state: AgentState, bedtime: boolean, reduceMotion: boolean, motion = 1): ExpressivePlan | null {
    const C = ExpressivePlan;
    if (C.sleepyStates.has(state)) return null;
    const p = this.validated();
    if (C.turnStates.has(state)) {
      p.intensity *= C.turnOverlayScale;
      p.hold = Math.min(p.hold, C.turnMaxHold);
      p.browAmount *= C.turnBrowScale;
      p.gaze = 'none';
      p.move = null;
      p.cue = null;
    }
    if (bedtime) {
      p.intensity *= C.bedtimeOverlayScale;
      p.browAmount *= C.bedtimeBrowScale;
      p.move = null;
      p.cue = null;
    }
    if (reduceMotion) {
      p.move = null;
      p.gaze = 'none';
      p.onset *= C.reduceMotionEnvelopeScale;
      p.release *= C.reduceMotionEnvelopeScale;
    }
    if (!(motion >= C.minMotionForMoves)) p.move = null;
    return p.isEmpty ? null : p;
  }

  /// Envelope weight 0…1 at `t` seconds after the start (smoothstep in, hold, smoothstep out; 0 outside).
  envelope(t: number): number {
    if (!(t >= 0)) return 0;
    if (t < this.onset) return Ease.smoothstep(t / Math.max(this.onset, 1e-3));
    const r = t - this.onset - this.hold;
    if (r <= 0) return 1;
    return r < this.release ? 1 - Ease.smoothstep(r / Math.max(this.release, 1e-3)) : 0;
  }
}
