// Port of ConversationTurnML/SileroVADModel.swift on onnxruntime-web (wasm).
import * as ort from 'onnxruntime-web';
import type { VoiceActivityDetecting } from '../turn/DetectorPorts';
import { TurnAudioFormat } from '../turn/TurnTunables';
import { configureRuntime, ModelCatalog, TurnModelError, type ModelSource } from './ModelCatalog';
import { nowMs, TurnModelStats } from './TurnModelStats';

/** Silero VAD v6.2.1 (MIT, © Silero Team), the upstream ONNX: `input [1,576]` (64 context + 512 new samples),
 *  `state [2,1,128]`, `sr` → `output [1,1]`, `stateN`. The iPad's Core ML rebuild has the same math with h/c split.
 *
 *  Called serially (the engine awaits each frame). Inputs are preallocated; a frame copies 512 floats in, runs, and
 *  copies the new state back. Wasm only: the model is tiny and WebGPU dispatch would cost more than the math (the iPad
 *  runs it `.cpuOnly` for the same reason). */
export class SileroVADModel implements VoiceActivityDetecting {
  static readonly contextSamples = 64;
  static readonly inputSamples = 576;

  private readonly audio = new Float32Array(SileroVADModel.inputSamples);
  private readonly state = new Float32Array(2 * 128);
  private readonly feeds: Record<string, ort.Tensor>;

  private constructor(private readonly session: ort.InferenceSession, readonly stats: TurnModelStats) {
    this.feeds = {
      input: new ort.Tensor('float32', this.audio, [1, SileroVADModel.inputSamples]),
      state: new ort.Tensor('float32', this.state, [2, 1, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
    };
  }

  /** Loads the model and runs one warm-up frame, then a clean state. */
  static async create(source: ModelSource = ModelCatalog.url('SileroVAD'), stats = new TurnModelStats()): Promise<SileroVADModel> {
    configureRuntime();
    const start = nowMs();
    const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const session = await (typeof source === 'string' ? ort.InferenceSession.create(source, opts) : ort.InferenceSession.create(source, opts));
    const m = new SileroVADModel(session, stats);
    await m.speechProbability(new Float32Array(TurnAudioFormat.frameSamples));
    m.reset();
    stats.recordVADLoad(nowMs() - start);
    return m;
  }

  async speechProbability(frame: Float32Array): Promise<number> {
    if (frame.length !== TurnAudioFormat.frameSamples) {
      throw new TurnModelError('badOutput', `VAD frame must be ${TurnAudioFormat.frameSamples} samples, got ${frame.length}`);
    }
    const start = nowMs();
    // `audio` = [context (the previous frame's last 64 samples) | 512 new samples]: shift the context, then copy
    // (before the first await: the engine reuses `frame`).
    this.audio.copyWithin(0, TurnAudioFormat.frameSamples, SileroVADModel.inputSamples);
    this.audio.set(frame, SileroVADModel.contextSamples);
    let out: ort.InferenceSession.OnnxValueMapType;
    try {
      out = await this.session.run(this.feeds);
    } catch (e) {
      this.stats.recordVADFailure();
      throw e;
    }
    this.state.set(out.stateN.data as Float32Array);
    const p = (out.output.data as Float32Array)[0];
    out.stateN.dispose();
    out.output.dispose();
    this.stats.recordVAD(nowMs() - start);
    if (!Number.isFinite(p)) throw new TurnModelError('badOutput', `VAD probability ${p}`);
    return Math.min(Math.max(p, 0), 1);
  }

  reset(): void {
    this.audio.fill(0);
    this.state.fill(0);
  }
}
