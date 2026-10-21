// Port of ConversationTurnML/ModelCatalog.swift: the turn models and their provenance. The iPad ships Core ML
// conversions; the web runs the upstream ONNX files those were converted from, fetched and SHA-256-verified by
// web/scripts/fetch-models.mjs into web/public/models/ and served by the add-on at <base>/models/.
import * as ort from 'onnxruntime-web';

export interface ModelEntry {
  file: string;
  version: string;
  upstream: string;
  license: string;
  sha256: string;
  inputs: Record<string, number[]>;
  outputs: Record<string, number[]>;
}

export const ModelCatalog = {
  sileroName: 'SileroVAD',
  smartTurnName: 'SmartTurn',
  entries: {
    SileroVAD: {
      file: 'silero_vad.onnx', version: '6.2.1', license: 'MIT',
      upstream: 'snakers4/silero-vad v6.2.1 src/silero_vad/data/silero_vad.onnx',
      sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
      inputs: { input: [1, 576], state: [2, 1, 128], sr: [] }, outputs: { output: [1, 1], stateN: [2, 1, 128] },
    },
    SmartTurn: {
      file: 'smart-turn-v3.2-gpu.onnx', version: '3.2', license: 'BSD-2-Clause',
      upstream: 'pipecat-ai/smart-turn-v3@f766f81d smart-turn-v3.2-gpu.onnx (fp32)',
      sha256: 'ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be',
      inputs: { input_features: [1, 80, 800] }, outputs: { logits: [1, 1] },
    },
  } satisfies Record<string, ModelEntry>,

  /** The model's URL under the app's base (HA ingress serves the add-on below a path prefix). */
  url(name: 'SileroVAD' | 'SmartTurn'): string {
    return `${baseURL()}models/${this.entries[name].file}`;
  },
};

function baseURL(): string {
  // import.meta.env exists under Vite (app and Vitest); plain node gets '/'.
  return (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
}

let configured = false;
/** Points onnxruntime-web at the add-on's own copy of its wasm runtime (fetch-models.mjs copies it to public/ort/).
 *  In node the package resolves its own files. */
export function configureRuntime(): void {
  if (configured) return;
  configured = true;
  ort.env.logLevel = 'error'; // node-to-EP assignment notices are expected (shape ops stay on the CPU)
  if (typeof window !== 'undefined' || typeof WorkerGlobalScope !== 'undefined') {
    ort.env.wasm.wasmPaths = `${new URL(`${baseURL()}ort/`, self.location.href)}`;
    // Left unset, each runtime takes up to 4 threads that spin between inferences (heat on a 24/7 tablet). The page
    // runs only the tiny Silero VAD; the Smart Turn worker gets 2.
    ort.env.wasm.numThreads = typeof document === 'undefined' ? 2 : 1;
  }
}

declare const WorkerGlobalScope: unknown;

export class TurnModelError extends Error {
  constructor(kind: 'missingResource' | 'badOutput' | 'notLoaded', detail = '') {
    super(kind === 'missingResource' ? `turn model resource missing: ${detail}`
      : kind === 'badOutput' ? `turn model output invalid: ${detail}` : 'turn model not loaded');
    this.name = 'TurnModelError';
  }
}

/** Model bytes or a URL, as `InferenceSession.create` takes them. */
export type ModelSource = string | Uint8Array;
