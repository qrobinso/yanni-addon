// Port of ConversationTurn/DetectorPorts.swift. The two detectors as the turn logic sees them; the onnxruntime-web
// adapters (turnml/) conform to these, tests use scripted fakes.
import { TurnAudioFormat } from './TurnTunables';

/** Voice activity, one 32 ms frame at a time (Silero VAD v6.2.1). Called serially, never concurrently, so a conformer
 *  may keep recurrent state (Silero's LSTM state, its 64-sample context). */
export interface VoiceActivityDetecting {
  /** Speech probability (0…1) for `frame`: exactly 512 new samples of 16 kHz mono, contiguous with the previous call's
   *  frame unless `reset()` came in between. Throws (or rejects) on a prediction failure.
   *  port-note: may return a Promise (onnxruntime-web's `run` is async); the conformer must copy `frame` before its
   *  first await, since the engine reuses the buffer. */
  speechProbability(frame: Float32Array): number | Promise<number>;
  /** Forget recurrent state and context: mic open, a discontinuity, or 5 s of silence outside a turn. */
  reset(): void;
}

/** End of turn on an audio window (Smart Turn v3.2): the probability that the user has finished. Runs serially. */
export interface TurnCompletionDetecting {
  /** Load and warm the model. Called at Noticing, long before the first pause; idempotent. */
  prepare(): Promise<void>;
  /** P(turn complete) in 0…1 for `window`: 128 000 samples, the turn's last ≤ 8 s right-aligned and zero-padded at the
   *  beginning. The conformer must not keep `window.samples` after resolving. */
  completionProbability(window: TurnAudioWindow): Promise<number>;
}

/** A preallocated Smart Turn input (128 000 floats, allocated once, never resized). */
export class TurnAudioWindow {
  readonly samples = new Float32Array(TurnAudioFormat.windowSamples);
  /** Real (non-padding) samples at the end of the window. */
  validCount = 0;
  get count(): number {
    return this.samples.length;
  }
}
