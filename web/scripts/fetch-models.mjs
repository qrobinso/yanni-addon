#!/usr/bin/env node
// Downloads the pinned turn-detection ONNX models into web/public/models/ and verifies each SHA-256
// (pins from yanni Packages/YanniConversation/Tools/turn-models/pins.json), then copies onnxruntime-web's wasm runtime
// into web/public/ort/ so the add-on serves everything itself (no CDN). Both folders are gitignored.
// Usage: node web/scripts/fetch-models.mjs   (idempotent: verified files are kept)
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SMART_TURN_REV = 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93';
export const MODELS = [
  {
    // Silero VAD v6.2.1 (MIT): input [1,576] (64 context + 512), state [2,1,128], sr int64 → output [1,1], stateN.
    file: 'silero_vad.onnx',
    url: 'https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.1/src/silero_vad/data/silero_vad.onnx',
    sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
  },
  {
    // Smart Turn v3.2 fp32 (BSD-2-Clause): input_features [1,80,800] (Whisper log-mel) → [1,1] P(complete).
    // The fp32 model is what the iPad's Core ML port was converted from and tracks (99.9 % agreement).
    file: 'smart-turn-v3.2-gpu.onnx',
    url: `https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/${SMART_TURN_REV}/smart-turn-v3.2-gpu.onnx`,
    sha256: 'ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be',
  },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchModel({ file, url, sha256 }) {
  const dst = join(pub, 'models', file);
  try {
    if (sha(await readFile(dst)) === sha256) return console.log(`ok      ${file}`);
    console.log(`stale   ${file}: re-downloading`);
  } catch { /* missing */ }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status} from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha(buf);
  if (got !== sha256) throw new Error(`${file}: SHA-256 ${got} != pinned ${sha256}`);
  await writeFile(dst + '.part', buf);
  await rename(dst + '.part', dst);
  console.log(`fetched ${file} (${buf.length} bytes) ${got}`);
}

async function copyRuntime() {
  const dist = dirname(createRequire(import.meta.url).resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
  const out = join(pub, 'ort');
  await mkdir(out, { recursive: true });
  const files = (await readdir(dist)).filter((f) => /^ort-wasm-simd-threaded\.(jsep\.)?(wasm|mjs)$/.test(f));
  for (const f of files) await copyFile(join(dist, f), join(out, f));
  console.log(`copied  ${files.length} onnxruntime-web runtime files to public/ort/`);
}

await mkdir(join(pub, 'models'), { recursive: true });
for (const m of MODELS) await fetchModel(m);
await copyRuntime();
