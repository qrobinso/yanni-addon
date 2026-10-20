// Port of FaceEmotion/EmotionTypes.swift.
import type { V2, V3 } from '../core/vec';
import { roundSwift } from '../core/vec';

/// A (pleasure, arousal, dominance) point or offset, each −1…1. Treated as immutable throughout the emotion layer
/// (every operation returns a new value), which gives Swift's value semantics for free.
export type PAD3 = V3;

/// PAD3 helpers (Swift SIMD3 arithmetic). No Swift file.
export const P3 = {
  make: (x: number, y: number, z: number): PAD3 => ({ x, y, z }),
  zero: { x: 0, y: 0, z: 0 } as Readonly<PAD3>,
  add: (a: PAD3, b: PAD3): PAD3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a: PAD3, b: PAD3): PAD3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a: PAD3, s: number): PAD3 => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  mul: (a: PAD3, b: PAD3): PAD3 => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z }),
  div: (a: PAD3, s: number): PAD3 => ({ x: a.x / s, y: a.y / s, z: a.z / s }),
  dot: (a: PAD3, b: PAD3): number => a.x * b.x + a.y * b.y + a.z * b.z,
  /// Swift's `(v * v).sum().squareRoot()`.
  length: (a: PAD3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z),
  isFinite: (a: PAD3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z),
  equals: (a: PAD3, b: PAD3): boolean => a.x === b.x && a.y === b.y && a.z === b.z,
  isZero: (a: PAD3): boolean => a.x === 0 && a.y === 0 && a.z === 0,
  /// max(|x|, |y|, |z|).
  maxAbs: (a: PAD3): number => Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z)),
  clamp: (a: PAD3, lo: number, hi: number): PAD3 =>
    ({ x: Math.min(Math.max(a.x, lo), hi), y: Math.min(Math.max(a.y, lo), hi), z: Math.min(Math.max(a.z, lo), hi) }),
  /// Component by index (Swift `v[i]`).
  at: (a: PAD3, i: number): number => (i === 0 ? a.x : i === 1 ? a.y : a.z),
  fromArray: (v: readonly number[]): PAD3 => ({ x: v[0], y: v[1], z: v[2] }),
  toArray: (a: PAD3): [number, number, number] => [a.x, a.y, a.z],
} as const;

/// Where an impulse came from (status card, gating, the event log).
export type ImpulseSource = 'decision' | 'perception' | 'conversation' | 'touch' | 'home' | 'failure' | 'debug';
export const ImpulseSource = {
  allCases: ['decision', 'perception', 'conversation', 'touch', 'home', 'failure', 'debug'] as readonly ImpulseSource[],
} as const;

/// `absolute` moves felt toward a PAD point by a fraction (`strength`) of the way, never past it; `relative` pushes
/// felt by `strength × δ`.
export type ImpulseTarget = { kind: 'absolute'; pad: PAD3 } | { kind: 'relative'; pad: PAD3 };

/// An emotion impulse.
export interface EmotionImpulse {
  target: ImpulseTarget;
  /// 0…1.
  strength: number;
  source: ImpulseSource;
  /// Short reason for the status card and log ("wave → dance", "engaged", "decision joke").
  label: string;
}

export const EmotionImpulse = {
  make: (target: ImpulseTarget, strength: number, source: ImpulseSource, label = ''): EmotionImpulse =>
    ({ target, strength, source, label }),
  toward: (pad: PAD3, strength: number, source: ImpulseSource, label = ''): EmotionImpulse =>
    ({ target: { kind: 'absolute', pad }, strength, source, label }),
  /// Finite target and strength (strength is clamped when applied).
  isValid: (i: EmotionImpulse): boolean => Number.isFinite(i.strength) && P3.isFinite(i.target.pad),
  equals: (a: EmotionImpulse, b: EmotionImpulse): boolean =>
    a.target.kind === b.target.kind && P3.equals(a.target.pad, b.target.pad) && a.strength === b.strength &&
    a.source === b.source && a.label === b.label,
} as const;

/// A sustained condition: shifts the emotion's rest point while active (felt only, never mood).
/// `voiceServicesUnreachable`: Home Assistant / the speech recognizer can't be reached. `decisionModelDown`: set by
/// `decisionModelUnavailable`, cleared by the next decision or the client's health probe.
export type EmotionCondition = 'voiceServicesUnreachable' | 'decisionModelDown';
export const EmotionCondition = {
  allCases: ['voiceServicesUnreachable', 'decisionModelDown'] as readonly EmotionCondition[],
} as const;

/// Which way a Home Assistant nudge glances.
export type NudgeLook = 'left' | 'right' | 'up';
export const NudgeLook = {
  allCases: ['left', 'right', 'up'] as readonly NudgeLook[],
  /// Where the eyes glance (normalised gaze space, screen left / right / up).
  gazePoint(l: NudgeLook): V2 {
    switch (l) {
      case 'left': return { x: -0.7, y: 0 };
      case 'right': return { x: 0.7, y: 0 };
      case 'up': return { x: 0, y: -0.7 };
    }
  },
} as const;

/// A Home Assistant nudge `{feeling, strength, look}`: feel an expression of the library briefly, say nothing.
export interface EmotionNudge {
  /// An expression name (case-insensitive).
  feeling: string;
  /// 0…1 (clamped to `EmotionRules.nudgeMaxStrength`).
  strength: number;
  look: NudgeLook | null;
}
export const makeNudge = (feeling: string, strength = 0.5, look: NudgeLook | null = null): EmotionNudge =>
  ({ feeling, strength, look });

/// Everything that can push the feeling, besides decisions (`EmotionLayer.receive`) and conditions.
export type EmotionInput =
  /// A raw impulse (perception reflexes, the preview's custom impulse).
  | { kind: 'impulse'; impulse: EmotionImpulse }
  /// A Home Assistant nudge (ignored asleep or at bedtime).
  | { kind: 'nudge'; nudge: EmotionNudge };

/// The decision model's gate outcomes, handed back to the conversation controller (which sets the agent state).
/// `notForMe` → the `notForMe` state; `didNotUnderstand` (garbled or empty) → `confused`.
export type GateEvent = { kind: 'notForMe'; turnId: string } | { kind: 'didNotUnderstand'; turnId: string };
export const GateEvent = {
  notForMe: (turnId: string): GateEvent => ({ kind: 'notForMe', turnId }),
  didNotUnderstand: (turnId: string): GateEvent => ({ kind: 'didNotUnderstand', turnId }),
  equals: (a: GateEvent, b: GateEvent): boolean => a.kind === b.kind && a.turnId === b.turnId,
} as const;

// MARK: - Mood report (emotion layer → conversation)

export interface PADValue { p: number; a: number; d: number }
const r2 = (x: number): number => roundSwift(x * 100) / 100;
export const PADValue = {
  make: (v: PAD3): PADValue => ({ p: r2(v.x), a: r2(v.y), d: r2(v.z) }),
} as const;

export type MoodReportTrigger = 'connect' | 'endOfTurn' | 'replyEnded' | 'labelChange' | 'heartbeat' | 'manual';

const isNum = (v: unknown): v is number => typeof v === 'number';
const isPADValue = (v: unknown): v is PADValue =>
  typeof v === 'object' && v !== null && isNum((v as PADValue).p) && isNum((v as PADValue).a) && isNum((v as PADValue).d);

/// The mood report the conversation hands to its transport verbatim (`{"type": "mood", …}`), which folds it into the
/// per-turn context note so the agent's tone matches the face. Sent on session connect, at end of turn (listening →
/// thinking), when a reply ends (speaking → follow-up), when the label or mood label changes (at most once a second),
/// and as a 60 s heartbeat.
export class MoodReport {
  static readonly currentVersion = 1;
  readonly type = 'mood';
  version = MoodReport.currentVersion;
  /// What Yanni feels right now (baseline + mood + emotion).
  felt: PADValue;
  /// The slow mood (baseline + mood).
  mood: PADValue;
  /// The expression the feeling reads as ("Neutral" inside the deadzone).
  label: string;
  /// A plain-word bucket of the slow mood.
  moodLabel: string;
  /// The life cycle's idle boredom, 0…1.
  boredom: number;
  /// Active conditions.
  conditions: string[];
  /// Why it was sent (not on the wire).
  trigger: MoodReportTrigger;

  constructor(felt: PAD3, mood: PAD3, label: string, moodLabel: string, boredom: number, conditions: string[],
    trigger: MoodReportTrigger) {
    this.felt = PADValue.make(felt);
    this.mood = PADValue.make(mood);
    this.label = label;
    this.moodLabel = moodLabel;
    this.boredom = roundSwift(Math.min(Math.max(Number.isFinite(boredom) ? boredom : 0, 0), 1) * 100) / 100;
    this.conditions = [...conditions];
    this.trigger = trigger;
  }

  equals(o: MoodReport): boolean {
    const pe = (a: PADValue, b: PADValue): boolean => a.p === b.p && a.a === b.a && a.d === b.d;
    return this.version === o.version && pe(this.felt, o.felt) && pe(this.mood, o.mood) && this.label === o.label &&
      this.moodLabel === o.moodLabel && this.boredom === o.boredom && this.trigger === o.trigger &&
      this.conditions.length === o.conditions.length && this.conditions.every((c, i) => c === o.conditions[i]);
  }

  /// The wire object (sorted keys, so fixtures and tests compare bytes).
  toJSON(): Record<string, unknown> {
    const pad = (v: PADValue): PADValue => ({ a: v.a, d: v.d, p: v.p } as PADValue);
    return {
      boredom: this.boredom, conditions: [...this.conditions], felt: pad(this.felt), label: this.label,
      mood: pad(this.mood), moodLabel: this.moodLabel, type: this.type, version: this.version,
    };
  }

  /// The JSON form (sorted keys).
  jsonData(): string { return JSON.stringify(this.toJSON()); }

  /// Decodes the wire form (trigger `manual`); null when a field is missing or mistyped.
  static decode(text: string): MoodReport | null {
    let o: unknown;
    try { o = JSON.parse(text); } catch { return null; }
    if (typeof o !== 'object' || o === null) return null;
    const j = o as Record<string, unknown>;
    if (typeof j.type !== 'string' || !Number.isInteger(j.version) || !isPADValue(j.felt) || !isPADValue(j.mood) ||
      typeof j.label !== 'string' || typeof j.moodLabel !== 'string' || !isNum(j.boredom) ||
      !Array.isArray(j.conditions) || !j.conditions.every((c) => typeof c === 'string')) return null;
    const r = new MoodReport(P3.zero, P3.zero, j.label, j.moodLabel, 0, j.conditions as string[], 'manual');
    r.version = j.version as number;
    r.felt = { ...j.felt };
    r.mood = { ...j.mood };
    r.boredom = j.boredom;
    return r;
  }
}

// MARK: - Snapshot (status card, preview; 4 Hz)

export type EmotionEventKind = 'impulse' | 'label' | 'beat' | 'cue' | 'decision' | 'dropped' | 'condition' | 'gate' |
  'report' | 'nudge';

/// One logged emotion-layer event (status card, preview, the Dev Status event log).
export interface EmotionEvent {
  id: number;
  /// Layer time (seconds).
  time: number;
  kind: EmotionEventKind;
  text: string;
}

export interface RecentImpulse { label: string; source: ImpulseSource; strength: number; at: number }

/// What the emotion layer is doing (polled at 4 Hz; never on the frame path).
export class EmotionSnapshot {
  baseline: PAD3 = P3.zero;
  felt: PAD3 = P3.zero;
  /// Slow mood deviation from the baseline.
  mood: PAD3 = P3.zero;
  /// Fast emotion deviation (relative to the rest point).
  emotion: PAD3 = P3.zero;
  /// The rest point's shift from conditions.
  rest: PAD3 = P3.zero;
  /// felt + the life cycle's mood offset (what the face reads).
  effective: PAD3 = P3.zero;
  label = 'Neutral';
  runnerUp: string | null = null;
  challenger: string | null = null;
  weight = 0;
  intensity = 0;
  authority = 0;
  moodLabel = 'playful';
  boredom = 0;
  somber = false;
  conditions: EmotionCondition[] = [];
  lastImpulse: { label: string; source: ImpulseSource; strength: number; age: number } | null = null;
  lastDecision: string | null = null;
  lastReport: MoodReport | null = null;
  reportsSent = 0;
  versionMismatches = 0;
  decisionsApplied = 0;
  decisionsDropped = 0;
  time = 0;

  equals(b: EmotionSnapshot): boolean {
    const re = this.lastReport === b.lastReport ||
      (this.lastReport !== null && b.lastReport !== null && this.lastReport.equals(b.lastReport));
    return P3.equals(this.felt, b.felt) && P3.equals(this.mood, b.mood) && this.label === b.label &&
      this.weight === b.weight && this.time === b.time && this.conditions.length === b.conditions.length &&
      this.conditions.every((c, i) => c === b.conditions[i]) && re && this.lastDecision === b.lastDecision;
  }
}
