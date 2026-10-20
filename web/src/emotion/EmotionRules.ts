// Port of FaceEmotion/EmotionRules.swift.
import type { AgentState } from '../engine';
import { TouchReactions } from '../engine/modifiers/TouchReactions';
import type { EmotionCondition, PAD3 } from './EmotionTypes';

/// What entering an agent state does.
export interface StateRule {
  target: PAD3;
  strength: number;
  /// The state's profile already shows this feeling: nudge the slow mood only (felt isn't counted twice).
  moodOnly: boolean;
  /// Minimum seconds between two firings (0: none).
  cooldown: number;
}

const rule = (x: number, y: number, z: number, strength: number, moodOnly: boolean, cooldown: number): StateRule =>
  ({ target: { x, y, z }, strength, moodOnly, cooldown });

/// Input → impulse / condition tables (emotion layer design §4). Targets are absolute PAD points, so "toward
/// embarrassed" means the same from any starting point; strengths are fractions of the way.
export const EmotionRules = {
  /// Agent-state transitions (observed on the engine; the conversation loop owns the state).
  stateRule(s: AgentState): StateRule | null {
    switch (s) {
      case 'engaged': return rule(0.6, 0.5, 0.2, 0.4, false, 60);
      case 'interrupted': return rule(0.0, 0.4, -0.3, 0.4, false, 0);
      case 'notForMe': return rule(-0.3, 0.3, -0.5, 0.5, true, 0);
      case 'confused': return rule(-0.1, 0.3, -0.4, 0.4, false, 0);
      case 'sheepish': return rule(-0.4, 0.1, -0.6, 0.6, true, 0);
      case 'hasMessage': return rule(0.5, 0.6, 0.3, 0.4, false, 120);
      default: return null;
    }
  },

  /// Mood-only impulses move the mood this fraction of strength × the way.
  moodOnlyGain: 0.04,

  // Presence (read from the engine and the life cycle).
  /// Someone arrives after the room was empty at least this long.
  arrivalAloneSeconds: 120,
  arrival: { target: { x: 0.4, y: 0.5, z: 0.1 } as PAD3, strength: 0.4 },
  /// The engaged person leaves.
  leaveWhileEngaged: { target: { x: 0.0, y: -0.1, z: 0.0 } as PAD3, strength: 0.2 },
  /// "Engaged" counts for the leave rule this long after eye contact ended (the person turns away, then walks out).
  leaveEngagedWindow: 4,

  // Taps: a small relative push at each annoyance tier crossing (hey, hmph, sulk start), scaled by the tier.
  tapDelta: { x: -0.15, y: 0.1, z: 0 } as PAD3,
  tapStrength(tier: number): number {
    switch (tier) {
      case 1: return 0.4;
      case 2: return 0.7;
      case 3: return 1;
      default: return 0;
    }
  },

  /// TouchReactions' tier for an annoyance level (0 calm, 1 "hey", 2 "hmph", 3 sulk).
  tapTier(a: number, sulking: boolean): number {
    if (sulking) return 3;
    if (a >= TouchReactions.hmphThreshold) return 2;
    if (a >= TouchReactions.heyThreshold) return 1;
    return 0;
  },

  // Failures.
  /// `decisionModelUnavailable`: a small dominance dip (relative), plus the `decisionModelDown` condition.
  decisionModelDip: { delta: { x: 0, y: 0, z: -0.5 } as PAD3, strength: 0.3 },
  /// The voice services came back: relief.
  relief: { target: { x: 0.4, y: 0.2, z: 0.4 } as PAD3, strength: 0.4 },

  /// Rest-point shift while a condition is active (felt only; kept small so the sheepish face's colour stays within
  /// ±0.15 of the state's own).
  shift(c: EmotionCondition): PAD3 {
    switch (c) {
      case 'voiceServicesUnreachable': return { x: -0.06, y: 0, z: -0.12 };
      case 'decisionModelDown': return { x: 0, y: 0, z: -0.06 };
    }
  },

  /// A lasting condition fades to 30 % of its shift between 2 and 3 minutes (it stops being news).
  conditionFade(age: number): number {
    const t = Math.min(Math.max((age - 120) / 60, 0), 1);
    return 1 - 0.7 * t * t * (3 - 2 * t);
  },

  // Home Assistant.
  nudgeMaxStrength: 0.5,
  nudgeMinPleasure: -0.3,
  nudgeGlanceSeconds: 1.2,

  /// Bad news: valence below this opens the somber window (and the arbiter's).
  somberValence: -0.2,

  /// States in which the face is sleepy (impulses from perception and Home Assistant are ignored; mood decays fast;
  /// conditions fade out).
  isSleepy: (s: AgentState): boolean => s === 'drowsy' || s === 'asleep' || s === 'halfAwake' || s === 'waking',
} as const;
