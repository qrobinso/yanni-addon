// Port of ConversationTurn/TurnDetectionStatus.swift.
import type { TurnPhase } from './TurnSignal';
import { TurnTunablesStatics } from './TurnTunables';

/** Whether turn detection can run. */
export type TurnDetectionAvailability =
  /** No detector is installed in this build: voice conversation can't run. */
  | { kind: 'notInstalled' }
  /** Installed, models not loaded yet: they load and warm when conversation mode starts (Noticing). */
  | { kind: 'notLoaded' }
  /** Models loading / warming up (Noticing). */
  | { kind: 'loading' }
  | { kind: 'ready' }
  /** A model failed to load or keeps failing (reason for Status; never audio). */
  | { kind: 'unavailable'; reason: string };

/** Voice conversation can run (loading still counts: the first pause runs on whatever instance loaded first). */
export function canListen(a: TurnDetectionAvailability): boolean {
  return a.kind === 'ready' || a.kind === 'loading' || a.kind === 'notLoaded';
}

export function availabilityLabel(a: TurnDetectionAvailability): string {
  switch (a.kind) {
    case 'notInstalled': return 'not installed';
    case 'notLoaded': return 'not loaded (loads at Noticing)';
    case 'loading': return 'loading';
    case 'ready': return 'ready';
    case 'unavailable': return `unavailable (${a.reason})`;
  }
}

/** A status snapshot (design §13.3), read at ≤ 4 Hz. Probabilities, times and counters only: never audio or text. */
export interface TurnDetectionStatus {
  availability: TurnDetectionAvailability;
  phase: TurnPhase;
  /** The newest frame's speech probability. */
  vadProbability: number;
  /** The threshold the newest frame was judged by (boosted while the echo rule applies). */
  threshold: number;
  echoActive: boolean;
  /** Last and median (over the last 20 runs) Smart Turn inference, ms. */
  smartTurnLastMs: number | null;
  smartTurnP50Ms: number | null;
  /** Smart Turn runs since launch. */
  smartTurnRuns: number;
  /** Self-trigger rejections since launch. */
  selfTriggerRejections: number;
  /** Capture discontinuities since launch. */
  gaps: number;
  /** Smart Turn's execution provider ("webgpu", "wasm"), when known. port-note: Core ML compute units on iOS. */
  computeUnits: string | null;
  /** The live microphone level, dBFS (smoothed), while the mic is open; null while closed. */
  micLevelDB: number | null;
}

export function makeTurnDetectionStatus(s: Partial<TurnDetectionStatus> = {}): TurnDetectionStatus {
  return {
    availability: { kind: 'notInstalled' }, phase: 'off', vadProbability: 0,
    threshold: TurnTunablesStatics.defaults.vadThreshold, echoActive: false, smartTurnLastMs: null,
    smartTurnP50Ms: null, smartTurnRuns: 0, selfTriggerRejections: 0, gaps: 0, computeUnits: null, micLevelDB: null,
    ...s,
  };
}
