// Port of ConversationTurn/TurnSignal.swift.

/** Where the turn state machine is (design §6.2). */
export type TurnPhase =
  /** Mic closed: no frames are processed. */
  | 'off'
  /** Mic open, no user turn in progress; counting an onset run. */
  | 'quiet'
  /** Inside a turn, the user is talking. */
  | 'speech'
  /** Inside a turn, silence shorter than `stopSecs`. */
  | 'waitingStop'
  /** Inside a turn, silence ≥ `stopSecs`; a Smart Turn request is in flight. */
  | 'evaluating'
  /** Inside a turn; Smart Turn said "not finished"; waiting for more speech or the fallback. */
  | 'incomplete';

export const turnPhases: readonly TurnPhase[] = ['off', 'quiet', 'speech', 'waitingStop', 'evaluating', 'incomplete'];

export const inTurn = (p: TurnPhase): boolean => p !== 'off' && p !== 'quiet';

/** Why a turn ended: Smart Turn judged it complete with this probability, or `fallbackSilence` passed. */
export type TurnEndReason = { kind: 'complete'; probability: number } | { kind: 'silenceFallback' };

/** A finished user turn. Host seconds. */
export interface LocalTurnEnd {
  /** The VAD's end of speech (start of the final silent run). */
  speechEnd: number;
  /** When the verdict was reached (Smart Turn's result, or the fallback deadline). */
  verdictAt: number;
  reason: TurnEndReason;
  /** The last Smart Turn inference of this turn (ms), if one finished. */
  inferenceMs: number | null;
}

/** A mid-turn pause that Smart Turn judged incomplete, or whose run failed or timed out. */
export interface TurnPause {
  /** null when the run failed or timed out (the fallback still ends the turn). */
  probability: number | null;
  inferenceMs: number | null;
}

/** What turn detection tells the conversation (design §6.2 outputs). Host seconds. Never audio, never text. */
export type TurnSignal =
  /** A user turn started (once per turn; never on resuming after a pause). `at` is the start of the confirmed run. */
  | { kind: 'speechStarted'; at: number; echoRule: boolean }
  /** A pause judged incomplete (log and status only). */
  | { kind: 'pause'; pause: TurnPause }
  /** The user's turn is over. */
  | { kind: 'turnEnded'; end: LocalTurnEnd }
  /** The mic closed mid-utterance: the turn is dropped, no turn end. */
  | { kind: 'turnDiscarded'; at: number }
  /** An onset that would have passed the normal rule but failed the echo rule (Yanni's own voice). */
  | { kind: 'selfTriggerRejected'; at: number; peak: number }
  /** The detectors can't run (model load or repeated prediction failure). */
  | { kind: 'unavailable'; reason: string };

/** A Smart Turn run the engine wants: request `id` over the turn audio `[from, to]` (host seconds). */
export interface SmartTurnRequest {
  id: number;
  from: number;
  to: number;
}

/** One step of the state machine: at most one output per input. */
export type TurnMachineOutput = { kind: 'signal'; signal: TurnSignal } | { kind: 'runSmartTurn'; request: SmartTurnRequest };
