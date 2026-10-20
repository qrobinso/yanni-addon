// The browser's `TurnCompletionDetecting`: Smart Turn in a dedicated Worker (smartTurn.worker.ts).
import type { TurnAudioWindow, TurnCompletionDetecting } from '../turn/DetectorPorts';
import { ModelCatalog } from './ModelCatalog';
import type { SmartTurnProvider } from './SmartTurnModel';
import type { SmartTurnWorkerReply, SmartTurnWorkerRequest } from './smartTurn.worker';

export class SmartTurnWorkerClient implements TurnCompletionDetecting {
  provider: SmartTurnProvider | null = null;
  loadMs = 0;
  /** Worker-side time of the newest run (features + inference), ms. */
  lastMs = 0;
  private readonly worker = new Worker(new URL('./smartTurn.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (m: SmartTurnWorkerReply) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private preparing: Promise<void> | null = null;
  /** Window copies handed back by the worker (transfer ping-pong: no allocation per pause in steady state). */
  private readonly spare: Float32Array[] = [];

  constructor(
    private readonly url = new URL(ModelCatalog.url('SmartTurn'), location.href).href,
    private readonly providers: SmartTurnProvider[] = ['webgpu', 'wasm'],
  ) {
    this.worker.onmessage = (e: MessageEvent<SmartTurnWorkerReply>) => {
      const m = e.data;
      if ((m.kind === 'result' || m.kind === 'error') && m.samples) this.spare.push(m.samples);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.kind === 'error') p.reject(new Error(m.message)); else p.resolve(m);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(`Smart Turn worker: ${e.message}`));
      this.pending.clear();
    };
  }

  prepare(): Promise<void> {
    this.preparing ??= this.send({ kind: 'prepare', id: this.nextId++, url: this.url, providers: this.providers }).then((m) => {
      if (m.kind === 'prepared') { this.provider = m.provider; this.loadMs = m.loadMs; }
    });
    return this.preparing;
  }

  async completionProbability(window: TurnAudioWindow): Promise<number> {
    // A copy: the engine refills its windows, and the buffer crosses to the worker.
    const samples = this.spare.pop() ?? new Float32Array(window.count);
    samples.set(window.samples);
    const m = await this.send({ kind: 'run', id: this.nextId++, samples }, [samples.buffer]);
    if (m.kind !== 'result') throw new Error('Smart Turn: unexpected reply');
    this.lastMs = m.ms;
    return m.probability;
  }

  terminate(): void {
    this.worker.terminate();
  }

  private send(m: SmartTurnWorkerRequest, transfer: Transferable[] = []): Promise<SmartTurnWorkerReply> {
    return new Promise((resolve, reject) => {
      this.pending.set(m.id, { resolve, reject });
      this.worker.postMessage(m, transfer);
    });
  }
}
