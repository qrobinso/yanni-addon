// Port of ConversationTurn/TurnStateMachine.swift.
import { inTurn, type LocalTurnEnd, type TurnEndReason, type TurnMachineOutput, type TurnPhase, type TurnSignal } from './TurnSignal';
import {
  echoMinSpeechFrames, makeTurnTunables, minSpeechFrames, stopFrames, tunableThreshold, TurnTunablesStatics,
  type TurnTunables,
} from './TurnTunables';

const signal = (s: TurnSignal): TurnMachineOutput => ({ kind: 'signal', signal: s });

/** The turn state machine (design §6): off → quiet → speech → waiting for stop → evaluating → incomplete. Driven
 *  entirely by its inputs: time always arrives as an argument, it never reads a clock and returns at most one output
 *  per input.
 *
 *  Frame classes (Silero hysteresis): speech-like when p ≥ threshold, silent when p < threshold − 0.15, anything in
 *  between continues the current run. Outside a turn, a frame captured before `echoUntil` is judged with the boosted
 *  threshold, and an onset run that starts there needs `echoMinSpeech`. Inside a user turn the normal rule applies.
 *  port-note: a Swift struct; nothing relies on copying it, so a class. */
export class TurnStateMachine {
  tunables: TurnTunables;
  phase: TurnPhase = 'off';
  /** The Smart Turn request in flight (evaluating only). */
  evaluatingID: number | null = null;
  /** Start of the current turn's audio (pre-roll included, never before the mic opened or the previous turn ended). */
  turnStart = 0;
  /** The VAD's end of speech in the current pause. */
  speechEnd: number | null = null;
  /** Whether the last frame was judged under the echo rule. */
  lastEchoActive = false;

  private nextID = 0;
  // The onset run (quiet) or the resume run (evaluating, incomplete), judged by each frame's own threshold.
  private runCount = 0;
  private runStart = 0;
  private runEcho = false;
  // The same frames judged by the normal rule only: a run that reaches `minSpeech` here but never starts a turn
  // under the echo rule is a self-trigger rejection.
  private shadowCount = 0;
  private shadowStart = 0;
  private shadowPeak = 0;
  private shadowEcho = false;
  private silentFrames = 0;
  private evaluatingSince = 0;
  private lastInferenceMs: number | null = null;
  private micOpenedAt = -Infinity;
  private lastTurnEndAt = -Infinity;

  constructor(tunables: TurnTunables = makeTurnTunables()) {
    this.tunables = tunables;
  }

  // MARK: - Inputs

  micOpened(now: number): TurnMachineOutput | null {
    if (this.phase !== 'off') return null;
    this.phase = 'quiet';
    this.micOpenedAt = now;
    this.resetRuns();
    return null;
  }

  /** Mic gated: a turn in progress is discarded (no turn end); a late Smart Turn result is ignored. */
  micClosed(now: number): TurnMachineOutput | null {
    const was = this.phase;
    this.phase = 'off';
    this.clearTurn();
    this.resetRuns();
    return inTurn(was) ? signal({ kind: 'turnDiscarded', at: now }) : null;
  }

  /** One Silero frame: its probability, its host-time span and until when Yanni may be audible. */
  frame(p: number, start: number, end: number, echoUntil: number): TurnMachineOutput | null {
    if (this.phase === 'off') return null;
    const echo = !inTurn(this.phase) && start < echoUntil;
    this.lastEchoActive = echo;
    const threshold = tunableThreshold(this.tunables, echo);
    const speechLike = p >= threshold;
    const silent = p < threshold - TurnTunablesStatics.hysteresis;
    switch (this.phase) {
      case 'quiet':
        return this.quietFrame(p, start, speechLike, silent, echo);
      case 'speech':
        if (!silent) return null;
        this.phase = 'waitingStop';
        this.speechEnd = start;
        this.silentFrames = 1;
        return this.checkStop(end);
      case 'waitingStop':
        if (speechLike) {
          this.phase = 'speech';
          this.speechEnd = null;
          this.silentFrames = 0;
          return null;
        }
        if (silent) this.silentFrames += 1;
        return this.timeouts(end) ?? this.checkStop(end);
      case 'evaluating':
      case 'incomplete':
        if (speechLike) {
          if (this.runCount === 0) this.runStart = start;
          this.runCount += 1;
          if (this.runCount >= minSpeechFrames(this.tunables)) {
            // The user went on: the turn continues (no new speech start); a result in flight is now stale.
            this.phase = 'speech';
            this.evaluatingID = null;
            this.speechEnd = null;
            this.silentFrames = 0;
            this.runCount = 0;
            return null;
          }
        } else if (silent) {
          this.runCount = 0;
        }
        return this.timeouts(end);
    }
    return null;
  }

  smartTurnResult(id: number, p: number, inferenceMs: number, now: number): TurnMachineOutput | null {
    if (this.phase !== 'evaluating' || id !== this.evaluatingID) return null; // stale or not waiting
    this.lastInferenceMs = inferenceMs;
    this.evaluatingID = null;
    if (p >= this.tunables.completionThreshold) return this.endTurn({ kind: 'complete', probability: p }, now);
    this.phase = 'incomplete';
    return signal({ kind: 'pause', pause: { probability: p, inferenceMs } });
  }

  smartTurnFailed(id: number, _now: number): TurnMachineOutput | null {
    if (this.phase !== 'evaluating' || id !== this.evaluatingID) return null;
    this.evaluatingID = null;
    this.phase = 'incomplete';
    return signal({ kind: 'pause', pause: { probability: null, inferenceMs: null } });
  }

  /** A ring overrun or discontinuity. In a turn it counts as silence (the fallback keeps running); in quiet it resets
   *  the onset run. */
  gap(now: number): TurnMachineOutput | null {
    switch (this.phase) {
      case 'off': return null;
      case 'quiet': this.resetRuns(); return null;
      default: this.runCount = 0; return this.timeouts(now);
    }
  }

  /** Timeouts when no frames arrive (Smart Turn timeout, the silence fallback). */
  tick(now: number): TurnMachineOutput | null {
    if (!inTurn(this.phase)) return null;
    return this.timeouts(now);
  }

  // MARK: - Steps

  private quietFrame(p: number, start: number, speechLike: boolean, silent: boolean, echo: boolean): TurnMachineOutput | null {
    // Shadow run under the normal rule (self-trigger accounting).
    let rejected: TurnSignal | null = null;
    const normal = this.tunables.vadThreshold;
    if (p >= normal) {
      if (this.shadowCount === 0) { this.shadowStart = start; this.shadowPeak = 0; this.shadowEcho = false; }
      this.shadowCount += 1;
      this.shadowPeak = Math.max(this.shadowPeak, p);
      if (echo) this.shadowEcho = true;
    } else if (p < normal - TurnTunablesStatics.hysteresis) {
      if (this.shadowEcho && this.shadowCount >= minSpeechFrames(this.tunables)) {
        rejected = { kind: 'selfTriggerRejected', at: this.shadowStart, peak: this.shadowPeak };
      }
      this.shadowCount = 0;
      this.shadowEcho = false;
    }
    // The real onset run.
    if (speechLike) {
      if (this.runCount === 0) { this.runStart = start; this.runEcho = echo; }
      this.runCount += 1;
      if (this.runCount >= (this.runEcho ? echoMinSpeechFrames(this.tunables) : minSpeechFrames(this.tunables))) {
        this.phase = 'speech';
        this.turnStart = Math.max(this.runStart - this.tunables.preRoll, this.micOpenedAt, this.lastTurnEndAt);
        this.clearTurn();
        const out: TurnSignal = { kind: 'speechStarted', at: this.runStart, echoRule: this.runEcho };
        this.resetRuns();
        return signal(out);
      }
    } else if (silent) {
      this.runCount = 0;
    }
    return rejected ? signal(rejected) : null;
  }

  private checkStop(now: number): TurnMachineOutput | null {
    if (this.silentFrames < stopFrames(this.tunables)) return null;
    this.nextID += 1;
    this.phase = 'evaluating';
    this.evaluatingID = this.nextID;
    this.evaluatingSince = now;
    this.runCount = 0;
    return { kind: 'runSmartTurn', request: { id: this.nextID, from: this.turnStart, to: now } };
  }

  private timeouts(now: number): TurnMachineOutput | null {
    if (this.speechEnd !== null && now - this.speechEnd >= this.tunables.fallbackSilence) {
      return this.endTurn({ kind: 'silenceFallback' }, now);
    }
    if (this.phase === 'evaluating' && now - this.evaluatingSince >= this.tunables.smartTurnTimeout) {
      this.evaluatingID = null;
      this.phase = 'incomplete';
      return signal({ kind: 'pause', pause: { probability: null, inferenceMs: null } });
    }
    return null;
  }

  private endTurn(reason: TurnEndReason, now: number): TurnMachineOutput {
    const end: LocalTurnEnd = { speechEnd: this.speechEnd ?? now, verdictAt: now, reason, inferenceMs: this.lastInferenceMs };
    this.phase = 'quiet';
    this.lastTurnEndAt = now;
    this.clearTurn();
    this.resetRuns();
    return signal({ kind: 'turnEnded', end });
  }

  private clearTurn(): void {
    this.evaluatingID = null;
    this.speechEnd = null;
    this.silentFrames = 0;
    this.lastInferenceMs = null;
  }

  private resetRuns(): void {
    this.runCount = 0;
    this.runEcho = false;
    this.shadowCount = 0;
    this.shadowEcho = false;
    this.shadowPeak = 0;
  }
}
