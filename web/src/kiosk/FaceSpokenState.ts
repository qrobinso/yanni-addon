// Port of YanniKiosk/FaceSpokenState.swift and the app's FaceAccessibility.swift. What a screen reader says about the
// face (hardening design §10): the face is one element labelled "Yanni" whose description is this state ("asleep",
// "awake and looking at you", "has a message"), published at a low rate, never per frame.
import type { AgentState } from '../engine/AgentState';

export type FaceSpokenState = 'asleep' | 'drowsy' | 'wakingUp' | 'awake' | 'lookingAtYou' | 'listening' | 'thinking'
  | 'speaking' | 'hasMessage' | 'puzzled';

export const FaceSpokenState = {
  allCases: ['asleep', 'drowsy', 'wakingUp', 'awake', 'lookingAtYou', 'listening', 'thinking', 'speaking', 'hasMessage',
    'puzzled'] as readonly FaceSpokenState[],

  /// The spoken state for the face's agent state and whether it is looking at someone (the engaged person).
  of(agentState: AgentState, lookingAtSomeone: boolean): FaceSpokenState {
    switch (agentState) {
      case 'asleep': return 'asleep';
      case 'drowsy': return 'drowsy';
      case 'halfAwake': case 'waking': return 'wakingUp';
      case 'listening': case 'followUp': case 'interrupted': return 'listening';
      case 'thinking': return 'thinking';
      case 'speaking': return 'speaking';
      case 'hasMessage': return 'hasMessage';
      case 'confused': case 'notForMe': return 'puzzled';
      case 'idle': case 'noticing': case 'engaged': case 'sheepish': return lookingAtSomeone ? 'lookingAtYou' : 'awake';
    }
  },

  /// The words (FaceAccessibility.text; English only, the web app has no string catalog).
  text(s: FaceSpokenState): string {
    switch (s) {
      case 'asleep': return 'asleep';
      case 'drowsy': return 'getting sleepy';
      case 'wakingUp': return 'waking up';
      case 'awake': return 'awake';
      case 'lookingAtYou': return 'awake and looking at you';
      case 'listening': return 'listening';
      case 'thinking': return 'thinking';
      case 'speaking': return 'speaking';
      case 'hasMessage': return 'has a message';
      case 'puzzled': return 'puzzled';
    }
  },
};

/// A new state must hold for `settle` seconds (a glance away doesn't reach the screen reader), and two published
/// changes are at least `minInterval` apart. Fed at the 4 Hz poll; `update` returns the state to publish, or null.
export class SpokenStateThrottle {
  static readonly settle = 1.0;
  static readonly minInterval = 3.0;

  published: FaceSpokenState | null = null;
  private candidate: FaceSpokenState | null = null;
  private candidateSince = 0;
  private publishedAt = -Infinity;

  update(state: FaceSpokenState, now: number): FaceSpokenState | null {
    const current = this.published;
    if (current === null) {
      this.published = state;
      this.publishedAt = now;
      this.candidate = null;
      return state;
    }
    if (state === current) { this.candidate = null; return null; }
    if (state !== this.candidate) { this.candidate = state; this.candidateSince = now; }
    if (!(now - this.candidateSince >= SpokenStateThrottle.settle && now - this.publishedAt >= SpokenStateThrottle.minInterval)) return null;
    this.published = state;
    this.publishedAt = now;
    this.candidate = null;
    return state;
  }
}

/// FaceAccessibility: the 4 Hz poll's state, throttled. `value` is the text to put in the face's description.
export class FaceAccessibility {
  value = FaceSpokenState.text('awake');
  /// Asleep or drowsy: the face's custom action reads "Wake up" instead of "Go to sleep".
  isAsleep = false;
  private throttle = new SpokenStateThrottle();

  /// Returns true when `value` changed.
  poll(agentState: AgentState, lookingAtSomeone: boolean, phase: string, now: number): boolean {
    const s = this.throttle.update(FaceSpokenState.of(agentState, lookingAtSomeone), now);
    this.isAsleep = phase === 'asleep' || phase === 'drowsy';
    if (s === null) return false;
    const text = FaceSpokenState.text(s);
    if (text === this.value) return false;
    this.value = text;
    return true;
  }
}

/// The developer HUD's load dot: the governor's level (0–4) and the overall health in one colour.
export type LoadDot = 'green' | 'yellow' | 'orange' | 'red';
export const LoadDot = {
  of(level: number, health: string): LoadDot {
    const byLevel: LoadDot = level <= 0 ? 'green' : level <= 2 ? 'yellow' : level === 3 ? 'orange' : 'red';
    if (health === 'safe_mode') return 'red';
    if (health === 'degraded') return byLevel === 'red' ? 'red' : 'orange';
    return byLevel;
  },
};
