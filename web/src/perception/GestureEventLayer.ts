// Port of FacePerception/GestureEventLayer.swift.
import type { GestureParams, GesturePerson } from './Gestures';
import { clamp, type GestureDecision, type GestureKind } from './PerceptionTypes';

/// Per (person, gesture) state of the rule-driven gestures: fired → refractory until the rule's candidate has been
/// absent for `rearm`. Swift `GestureEventLayer.State`.
export interface GestureEventLayerState { armed: boolean; candidateOffSince: number | null; lastFire: number }

/// The shared firing rules every gesture goes through (design §6.5), as pure functions plus the per-(person, gesture)
/// state. Detection-level only; the beat-level mechanisms (budget, habituation, cooldowns) sit at the reflex table
/// (`GestureBeatBudget`), where it is known that a beat really plays.
export const GestureEventLayer = {
  State: (): GestureEventLayerState => ({ armed: true, candidateOffSince: null, lastFire: -Infinity }),

  /// Steps the hysteresis with this sample's candidate flag; true while a firing would be accepted.
  rearm(s: GestureEventLayerState, candidate: boolean, now: number, after: number): boolean {
    if (candidate) {
      s.candidateOffSince = null;
    } else {
      const since = s.candidateOffSince ?? now;
      s.candidateOffSince = since;
      if (!s.armed && now - since >= after) s.armed = true;
    }
    return s.armed;
  },

  /// Precedence rank: two-hand > body > one-hand (design §6.5). Nod, dancing and the high-five are separate channels.
  rank(k: GestureKind): number {
    switch (k.kind) {
      case 'heartHands': return 3;
      case 'wave': case 'byeWave': case 'clap': case 'armsUp': case 'peekaboo': return 2;
      case 'thumbsUp': case 'thumbsDown': case 'openPalm': case 'peace': case 'point': return 1;
      case 'nod': case 'dancing': case 'highFive': return 0;
    }
  },

  /// The aimed-at gate (design §6.5): within engagement range the person looked at Yanni within `lookWindow`;
  /// beyond it, facing ≥ `farFacing`.
  aimed(p: GesturePerson, now: number, k: GestureParams): boolean {
    if (p.distance <= k.engageMaxDistance) return now - p.lastLook <= k.lookWindow;
    return p.facing >= k.farFacing || now - p.lastLook <= k.lookWindow;
  },

  /// The hand-set directed score D (0…1): facing, the hand raised in front of the torso, the onset, distance, and
  /// nobody else near whom this person might be talking to.
  directedScore(p: GesturePerson, raised: boolean, onset: boolean, othersNear: boolean): number {
    const facing = clamp((p.facing - 0.3) / 0.5, 0, 1);
    const dist = clamp((4 - p.distance) / 2.5, 0, 1);
    const others = othersNear && p.facing < 0.5 ? 0 : 1;
    return 0.35 * facing + 0.25 * (raised ? 1 : 0) + 0.15 * (onset ? 1 : 0) + 0.1 * dist + 0.15 * others;
  },
} as const;

/// A fixed ring of recent gesture decisions (the People log).
export class DecisionRing {
  static readonly capacity = 16;
  items: GestureDecision[] = [];
  add(d: GestureDecision): void {
    if (this.items.length >= DecisionRing.capacity) this.items.shift();
    this.items.push(d);
  }
}
