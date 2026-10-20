// Port of ConversationTurnML/SmartTurnModel.swift on onnxruntime-web: WebGPU with a wasm fallback.
import * as ort from 'onnxruntime-web';
import type { TurnAudioWindow, TurnCompletionDetecting } from '../turn/DetectorPorts';
import { TurnAudioFormat } from '../turn/TurnTunables';
import { configureRuntime, ModelCatalog, TurnModelError, type ModelSource } from './ModelCatalog';
import { nowMs, TurnModelStats } from './TurnModelStats';
import { N_FRAMES, N_MELS, WhisperFeatureExtractor } from './WhisperFeatures';

export type SmartTurnProvider = 'webgpu' | 'wasm';

/** Smart Turn v3.2 (BSD-2-Clause, © Daily / pipecat-ai), the upstream fp32 ONNX: `input_features [1,80,800]` (the
 *  Whisper log-mel of the turn's last 8 s, zero-padded at the beginning) → `logits [1,1]`, which is already
 *  P(turn complete) (a sigmoid ends the graph). The front end runs in `WhisperFeatureExtractor` (on the iPad it is
 *  inside the Core ML model).
 *
 *  - Runs serially (a promise chain stands in for the Swift `yanni.turn.smart` queue): at most one inference at once.
 *  - `prepare()` loads and runs one warm-up inference (the first WebGPU pipeline compile is slow); idempotent, and a
 *    load failure is remembered.
 *  - Execution providers are tried in order (default WebGPU, then wasm); `provider` says which one loaded (Status).
 *  port-note: for the browser, run this behind `SmartTurnWorkerClient` (a Worker) so feature extraction and wasm
 *  inference never block the face's frames; the class itself is also what the node tests run. */
export class SmartTurnModel implements TurnCompletionDetecting {
  provider: SmartTurnProvider | null = null;
  readonly stats: TurnModelStats;
  private session: ort.InferenceSession | null = null;
  private loading: Promise<void> | null = null;
  private loadError: unknown = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly extractor = new WhisperFeatureExtractor();
  private readonly input: ort.Tensor;

  constructor(
    private readonly source: ModelSource = ModelCatalog.url('SmartTurn'),
    private readonly providers: SmartTurnProvider[] = ['webgpu', 'wasm'],
    stats = new TurnModelStats(),
  ) {
    this.stats = stats;
    this.input = new ort.Tensor('float32', this.extractor.features, [1, N_MELS, N_FRAMES]);
  }

  /** "webgpu" / "wasm", for Status. */
  get computeUnitsLabel(): string | null {
    return this.provider;
  }

  prepare(): Promise<void> {
    return this.serial(() => this.loadIfNeeded());
  }

  completionProbability(window: TurnAudioWindow): Promise<number> {
    return this.serial(() => this.predict(window.samples));
  }

  /** Inference on a 128 000-sample window (tests, the parity check, the worker). */
  predictNow(samples: Float32Array): Promise<number> {
    return this.serial(() => this.predict(samples));
  }

  private serial<T>(body: () => Promise<T>): Promise<T> {
    const run = this.queue.then(body, body);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async loadIfNeeded(): Promise<void> {
    if (this.session) return;
    if (this.loadError) throw this.loadError;
    const start = nowMs();
    try {
      configureRuntime();
      let lastError: unknown = new TurnModelError('notLoaded');
      for (const ep of this.providers) {
        if (ep === 'webgpu' && !(typeof navigator !== 'undefined' && 'gpu' in navigator)) continue;
        try {
          const opts: ort.InferenceSession.SessionOptions = { executionProviders: [ep], graphOptimizationLevel: 'all' };
          this.session = await (typeof this.source === 'string'
            ? ort.InferenceSession.create(this.source, opts) : ort.InferenceSession.create(this.source, opts));
          this.provider = ep;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (!this.session) throw lastError;
      await this.run(new Float32Array(TurnAudioFormat.windowSamples)); // warm-up
      this.stats.recordSmartTurnLoad(nowMs() - start);
    } catch (e) {
      this.loadError = e;
      throw e;
    }
  }

  private async predict(samples: Float32Array): Promise<number> {
    await this.loadIfNeeded();
    const start = nowMs();
    try {
      const p = await this.run(samples);
      this.stats.recordSmartTurn(nowMs() - start);
      return p;
    } catch (e) {
      this.stats.recordSmartTurnFailure();
      throw e;
    }
  }

  private async run(samples: Float32Array): Promise<number> {
    if (samples.length !== TurnAudioFormat.windowSamples) {
      throw new TurnModelError('badOutput', `Smart Turn window must be ${TurnAudioFormat.windowSamples} samples`);
    }
    const s = this.session;
    if (!s) throw new TurnModelError('notLoaded');
    this.extractor.extract(samples);
    const out = await s.run({ input_features: this.input });
    const t = out[s.outputNames[0]];
    const p = (t.data as Float32Array)[0];
    t.dispose();
    if (!Number.isFinite(p)) throw new TurnModelError('badOutput', `Smart Turn probability ${p}`);
    return Math.min(Math.max(p, 0), 1);
  }
}
