// Port of FaceEngine/AgentState.swift.

/// Conversation / life-cycle states the face must show. The engine only visualises whatever it is told.
export type AgentState =
  | 'idle' | 'noticing' | 'engaged' | 'listening' | 'thinking' | 'speaking' | 'followUp' | 'interrupted'
  | 'notForMe' | 'confused' | 'sheepish' | 'hasMessage' | 'drowsy' | 'asleep' | 'halfAwake' | 'waking';

const AGENT_STATES: readonly AgentState[] = [
  'idle', 'noticing', 'engaged', 'listening', 'thinking', 'speaking', 'followUp', 'interrupted',
  'notForMe', 'confused', 'sheepish', 'hasMessage', 'drowsy', 'asleep', 'halfAwake', 'waking',
];

export const AgentState = {
  allCases: AGENT_STATES,
  /// Swift `AgentState(rawValue:)`: undefined for an unknown name.
  fromRaw: (raw: string): AgentState | undefined => (AGENT_STATES as readonly string[]).includes(raw) ? raw as AgentState : undefined,
} as const;

/// Pleasure / arousal / dominance input, each -1...1.
export interface Mood { pleasure: number; arousal: number; dominance: number }

export const Mood = {
  make: (pleasure = 0.2, arousal = 0.15, dominance = 0.1): Mood => ({ pleasure, arousal, dominance }),
  /// Playful baseline: mildly positive pleasure, above-average arousal. Fresh each access.
  get playful(): Mood { return { pleasure: 0.2, arousal: 0.15, dominance: 0.1 }; },
  equals: (a: Mood, b: Mood): boolean => a.pleasure === b.pleasure && a.arousal === b.arousal && a.dominance === b.dominance,
} as const;

/// Per-frame modulation values every modifier reads. Neutral value for each is 1 unless noted.
export interface Modulation {
  /// Time multiplier for transitions and one-shot playback (>1 faster).
  speed: number;
  /// Expression intensity multiplier.
  intensity: number;
  /// 0 = default damping; >0 lowers spring damping for bouncier motion (ζ' = ζ·(1 − 0.25·bounciness)).
  bounciness: number;
  /// Blink frequency multiplier; 0 suppresses blinking.
  blinkRate: number;
  /// Blink duration multiplier (>1 slower, heavier).
  blinkDuration: number;
  /// Extra upper-lid coverage as a fraction of the remaining opening, 0...1. 0 = none.
  lidHeaviness: number;
  /// Idle glance frequency multiplier.
  glanceRate: number;
}

export const Modulation = {
  make: (): Modulation => ({ speed: 1, intensity: 1, bounciness: 0, blinkRate: 1, blinkDuration: 1, lidHeaviness: 0, glanceRate: 1 }),
  copy: (m: Modulation): Modulation => ({ ...m }),
  equals: (a: Modulation, b: Modulation): boolean =>
    a.speed === b.speed && a.intensity === b.intensity && a.bounciness === b.bounciness && a.blinkRate === b.blinkRate &&
    a.blinkDuration === b.blinkDuration && a.lidHeaviness === b.lidHeaviness && a.glanceRate === b.glanceRate,
  /// Convenience builder for profile tables (AgentStateProfiles.swift `Modulation.state`).
  state(o: Partial<Pick<Modulation, 'speed' | 'blinkRate' | 'blinkDuration' | 'lidHeaviness' | 'glanceRate' | 'bounciness'>> = {}): Modulation {
    return { ...Modulation.make(), ...o };
  },
} as const;
