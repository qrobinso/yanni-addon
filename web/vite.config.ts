import { resolve } from 'node:path';
import { defaultClientConditions, defineConfig } from 'vite';

// Cross-origin isolation in dev too (the add-on server sends the same headers): onnxruntime-web gets its threads.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  // onnxruntime-web's default entry (ort.bundle.min.mjs) embeds its loader and points `new URL(…wasm, import.meta.url)`
  // at the 28 MB wasm, which Vite then emits into assets/ a second time. This condition picks the plain entry, which
  // loads loader and wasm from ort.env.wasm.wasmPaths (the self-hosted /ort/, ModelCatalog.configureRuntime).
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  build: {
    target: 'es2023',
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        'render-demo': resolve(import.meta.dirname, 'render-demo.html'),
        'turn-demo': resolve(import.meta.dirname, 'turn-demo.html'),
        'perception-demo': resolve(import.meta.dirname, 'perception-demo.html'),
        'voice-demo': resolve(import.meta.dirname, 'voice-demo.html'),
        tuning: resolve(import.meta.dirname, 'tuning.html'),
      },
    },
  },
  // The perception worker is an ES module (tasks-vision imports its wasm loader there).
  worker: { format: 'es' },
  server: { headers: isolation },
  preview: { headers: isolation },
  test: { include: ['test/**/*.test.ts'], setupFiles: ['test/setup.ts'] },
});
