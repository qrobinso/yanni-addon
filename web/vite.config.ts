import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Cross-origin isolation in dev too (the add-on server sends the same headers): onnxruntime-web gets its threads.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
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
  test: { include: ['test/**/*.test.ts'] },
});
