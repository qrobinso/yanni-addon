// Smart Turn's own thread (port-note: the Swift `yanni.turn.smart` queue): the Whisper front end and the inference
// never run on the main thread, so a pause never costs the face a frame.
import { SmartTurnModel, type SmartTurnProvider } from './SmartTurnModel';

export type SmartTurnWorkerRequest =
  | { kind: 'prepare'; id: number; url: string; providers: SmartTurnProvider[] }
  | { kind: 'run'; id: number; samples: Float32Array };

export type SmartTurnWorkerReply =
  | { kind: 'prepared'; id: number; provider: SmartTurnProvider | null; loadMs: number }
  | { kind: 'result'; id: number; probability: number; ms: number; samples: Float32Array }
  | { kind: 'error'; id: number; message: string; samples?: Float32Array };

let model: SmartTurnModel | null = null;
const post = (m: SmartTurnWorkerReply, transfer: Transferable[] = []): void =>
  (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<SmartTurnWorkerRequest>) => {
  const m = e.data;
  if (m.kind === 'prepare') {
    model ??= new SmartTurnModel(m.url, m.providers);
    try {
      await model.prepare();
      post({ kind: 'prepared', id: m.id, provider: model.provider, loadMs: model.stats.snapshot.smartTurnLoadMs });
    } catch (err) {
      post({ kind: 'error', id: m.id, message: String(err) });
    }
    return;
  }
  try {
    if (!model) throw new Error('turn model not loaded');
    const t0 = performance.now();
    const p = await model.predictNow(m.samples);
    post({ kind: 'result', id: m.id, probability: p, ms: performance.now() - t0, samples: m.samples }, [m.samples.buffer]);
  } catch (err) {
    post({ kind: 'error', id: m.id, message: String(err), samples: m.samples }, [m.samples.buffer]);
  }
};
