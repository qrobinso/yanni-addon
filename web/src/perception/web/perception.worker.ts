// The perception worker: MediaPipe and the processor off the main thread (one frame in flight; the main thread drops
// frames rather than queue them). tasks-vision runs in a module worker: its loader falls back to `import()` when
// `importScripts` throws, and the GPU delegate draws on its own OffscreenCanvas.
import { PerceptionPipeline, type FrameRequest, type PipelineInit } from './PerceptionPipeline';

export type ToWorker = { type: 'init'; init: PipelineInit } | ({ type: 'frame' } & FrameRequest);

let pipeline: Promise<PerceptionPipeline> | null = null;
const reply = (m: unknown) => (self as unknown as Worker).postMessage(m);
const text = (e: unknown) => e instanceof Error ? e.message : String(e);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'init') {
    pipeline = PerceptionPipeline.create(m.init);
    pipeline.then((p) => reply({ type: 'ready', delegate: p.detector.delegate }), (err) => reply({ type: 'failed', error: text(err) }));
    return;
  }
  try {
    reply({ type: 'result', result: await (await pipeline!).analyse(m) });
  } catch (err) {
    m.bitmap.close();
    reply({ type: 'error', error: text(err) });
  }
};
