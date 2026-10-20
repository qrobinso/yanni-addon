// Port of ConversationTurn/TurnDetectionEngine.swift.
import { TurnAudioWindow, type VoiceActivityDetecting } from './DetectorPorts';
import { TurnAudioBuffer } from './TurnAudioBuffer';
import type { TurnDetectionAvailability, TurnDetectionStatus } from './TurnDetectionStatus';
import type { SmartTurnRequest, TurnMachineOutput, TurnPhase, TurnSignal } from './TurnSignal';
import { TurnStateMachine } from './TurnStateMachine';
import {
  clampedTunables, makeTurnTunables, roundHalfAway, tunableThreshold, TurnAudioFormat, TurnTunablesStatics,
  type TurnTunables,
} from './TurnTunables';

/** The glue the VAD queue calls (design §6.1): 16 kHz samples → 512-sample frames → the VAD → the state machine; the
 *  machine's Smart Turn requests → a filled window handed to the runtime (`onSmartTurnRequest`), whose results come
 *  back through `smartTurnFinished` / `smartTurnFailed`. Preallocated: no allocation per frame or per request.
 *  port-note: `feed` is async because the VAD may be (onnxruntime-web). The caller serialises every call (the runtime's
 *  promise chain is the Swift VAD queue); nothing else may touch the engine while a `feed` is pending. */
export class TurnDetectionEngine {
  /** Every signal, as it is produced. */
  onSignal: ((s: TurnSignal) => void) | null = null;
  /** A Smart Turn run to execute (serially, off this queue), with its filled window. */
  onSmartTurnRequest: ((r: SmartTurnRequest, w: TurnAudioWindow) => void) | null = null;

  readonly machine: TurnStateMachine;
  lastProbability = 0;
  selfTriggerRejections = 0;
  smartTurnRuns = 0;
  gaps = 0;
  static readonly maxConsecutiveVADFailures = 10;

  private readonly vad: VoiceActivityDetecting;
  private readonly buffer = new TurnAudioBuffer();
  private readonly windows = [new TurnAudioWindow(), new TurnAudioWindow()] as const;
  private nextWindowIsFirst = true;
  private readonly frame = new Float32Array(TurnAudioFormat.frameSamples);
  private frameFill = 0;
  /** Absolute 16 kHz index of `frame[0]`. */
  private frameStartIndex = 0;
  /** Timeline anchor: absolute index ↔ capture host time (the newest feed's end). */
  private anchorIndex = 0;
  private anchorTime = 0;
  /** Smart Turn never sees audio before the newest gap. */
  private gapIndex = 0;
  private quietSilentFrames = 0;
  private vadFailures = 0;
  private reportedUnavailable = false;
  private readonly inferenceMs = new Float64Array(20);
  private inferenceNext = 0;
  private inferenceCount = 0;

  constructor(vad: VoiceActivityDetecting, tunables: TurnTunables = makeTurnTunables()) {
    this.vad = vad;
    this.machine = new TurnStateMachine(clampedTunables(tunables));
  }

  get tunables(): TurnTunables {
    return this.machine.tunables;
  }
  set tunables(t: TurnTunables) {
    this.machine.tunables = clampedTunables(t);
  }

  // MARK: - Inputs

  /** Mic open: fresh VAD state, no audio from before. */
  micOpened(now: number): void {
    this.vad.reset();
    this.frameFill = 0;
    this.buffer.discardAll();
    this.gapIndex = this.buffer.endIndex;
    this.quietSilentFrames = 0;
    this.emit(this.machine.micOpened(now));
  }

  micClosed(now: number): void {
    this.frameFill = 0;
    this.emit(this.machine.micClosed(now));
  }

  /** Contiguous 16 kHz mono samples; `endHostTime` is the capture host time just after the last one, `echoUntil` until
   *  when Yanni may be audible (`EchoWindow.until`). */
  async feed(samples: Float32Array, endHostTime: number, echoUntil: number): Promise<void> {
    if (this.machine.phase === 'off' || samples.length === 0) return;
    this.buffer.append(samples);
    this.anchorIndex = this.buffer.endIndex;
    this.anchorTime = endHostTime;
    const firstIndex = this.anchorIndex - samples.length;
    const n = TurnAudioFormat.frameSamples;
    let i = 0;
    while (i < samples.length) {
      if (this.frameFill === 0) this.frameStartIndex = firstIndex + i;
      const take = Math.min(n - this.frameFill, samples.length - i);
      this.frame.set(samples.subarray(i, i + take), this.frameFill);
      this.frameFill += take;
      i += take;
      if (this.frameFill === n) {
        this.frameFill = 0;
        await this.runFrame(echoUntil);
        if ((this.machine.phase as TurnPhase) === 'off') return; // runFrame may have closed it (TS narrows too eagerly)
      }
    }
  }

  /** A ring overrun or discontinuity (rate or generation change): VAD state reset, partial frame dropped. */
  gap(now: number): void {
    this.gaps += 1;
    this.vad.reset();
    this.frameFill = 0;
    this.gapIndex = this.buffer.endIndex;
    this.emit(this.machine.gap(now));
  }

  tick(now: number): void {
    this.emit(this.machine.tick(now));
  }

  smartTurnFinished(id: number, probability: number, ms: number, now: number): void {
    this.smartTurnRuns += 1;
    this.inferenceMs[this.inferenceNext] = ms;
    this.inferenceNext = (this.inferenceNext + 1) % this.inferenceMs.length;
    this.inferenceCount = Math.min(this.inferenceCount + 1, this.inferenceMs.length);
    this.emit(this.machine.smartTurnResult(id, probability, ms, now));
  }

  smartTurnFailed(id: number, now: number): void {
    this.emit(this.machine.smartTurnFailed(id, now));
  }

  // MARK: - Read-outs

  get lastInferenceMs(): number | null {
    const len = this.inferenceMs.length;
    return this.inferenceCount === 0 ? null : this.inferenceMs[(this.inferenceNext + len - 1) % len];
  }

  /** Median of the last ≤ 20 Smart Turn runs (status only; allocates a small sorted copy). */
  get medianInferenceMs(): number | null {
    if (this.inferenceCount === 0) return null;
    const s = Array.from(this.inferenceMs.subarray(0, this.inferenceCount)).sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /** The engine's part of the status (the runtime adds availability, compute units and its own gap count). */
  status(availability: TurnDetectionAvailability): TurnDetectionStatus {
    return {
      availability, phase: this.machine.phase, vadProbability: this.lastProbability,
      threshold: tunableThreshold(this.machine.tunables, this.machine.lastEchoActive),
      echoActive: this.machine.lastEchoActive, smartTurnLastMs: this.lastInferenceMs,
      smartTurnP50Ms: this.medianInferenceMs, smartTurnRuns: this.smartTurnRuns,
      selfTriggerRejections: this.selfTriggerRejections, gaps: this.gaps, computeUnits: null, micLevelDB: null,
    };
  }

  /** Host time of an absolute 16 kHz index (extrapolated from the newest feed). */
  hostTime(index: number): number {
    return this.anchorTime - (this.anchorIndex - index) / TurnAudioFormat.sampleRate;
  }

  sampleIndex(t: number): number {
    return this.anchorIndex - roundHalfAway((this.anchorTime - t) * TurnAudioFormat.sampleRate);
  }

  // MARK: - Steps

  private async runFrame(echoUntil: number): Promise<void> {
    let p: number;
    try {
      p = await this.vad.speechProbability(this.frame);
      this.vadFailures = 0;
      this.reportedUnavailable = false;
    } catch {
      this.vadFailures += 1;
      if (this.vadFailures >= TurnDetectionEngine.maxConsecutiveVADFailures && !this.reportedUnavailable) {
        this.reportedUnavailable = true;
        this.onSignal?.({ kind: 'unavailable', reason: 'voice activity model failed' });
      }
      return;
    }
    this.lastProbability = p;
    const start = this.hostTime(this.frameStartIndex);
    const end = this.hostTime(this.frameStartIndex + TurnAudioFormat.frameSamples);
    // Silero's LSTM state is reset after 5 s of continuous silence outside a turn (never drifts).
    if (this.machine.phase === 'quiet' && p < this.machine.tunables.vadThreshold) {
      this.quietSilentFrames += 1;
      if (this.quietSilentFrames * TurnAudioFormat.frameDuration >= TurnTunablesStatics.vadResetSilence) {
        this.quietSilentFrames = 0;
        this.vad.reset();
      }
    } else {
      this.quietSilentFrames = 0;
    }
    this.emit(this.machine.frame(p, start, end, echoUntil));
  }

  private emit(output: TurnMachineOutput | null): void {
    if (output === null) return;
    if (output.kind === 'signal') {
      if (output.signal.kind === 'selfTriggerRejected') this.selfTriggerRejections += 1;
      this.onSignal?.(output.signal);
      return;
    }
    const r = output.request;
    const window = this.nextWindowIsFirst ? this.windows[0] : this.windows[1];
    this.nextWindowIsFirst = !this.nextWindowIsFirst;
    const from = Math.max(this.sampleIndex(r.from), this.gapIndex);
    this.buffer.copy(from, this.sampleIndex(r.to), window);
    this.onSmartTurnRequest?.(r, window);
  }
}
