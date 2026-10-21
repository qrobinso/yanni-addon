// Port of ConversationTurnMLTests/TurnModelTests.swift: Silero (onnxruntime-web wasm in node) on the committed clips
// against the ONNX reference outputs in expected.json.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { beforeAll, describe, expect, test } from 'vitest';
import { ModelCatalog } from '../../src/conversation/turnml/ModelCatalog';
import { SileroVADModel } from '../../src/conversation/turnml/SileroVADModel';
import { clipSamples, loadClips, modelPath, modelsPresent, onsetEnd } from './support/ClipSupport';

const clips = loadClips().clips;

// Single-threaded in node: ort's idle wasm threads spin, and on a 4-core CI runner they starve Vitest's worker RPC.
ort.env.wasm.numThreads = 1;

describe.skipIf(!modelsPresent)('Silero VAD on onnxruntime-web (run web/scripts/fetch-models.mjs first)', () => {
  let vad: SileroVADModel;
  beforeAll(async () => {
    vad = await SileroVADModel.create(new Uint8Array(readFileSync(modelPath('silero_vad.onnx'))));
  });

  test('catalog matches the fetched models', () => {
    for (const e of Object.values(ModelCatalog.entries)) {
      expect(createHash('sha256').update(readFileSync(modelPath(e.file))).digest('hex')).toBe(e.sha256);
    }
  });

  async function stream(audio: Float32Array): Promise<number[]> {
    vad.reset();
    const probs: number[] = [];
    for (let i = 0; i + 512 <= audio.length; i += 512) probs.push(await vad.speechProbability(audio.subarray(i, i + 512)));
    return probs;
  }

  test('matches the ONNX reference frame by frame', async () => {
    let worst = 0;
    const t0 = performance.now();
    let frames = 0;
    for (const clip of clips) {
      const probs = await stream(clipSamples(clip.file));
      frames += probs.length;
      expect(probs.length, clip.file).toBe(clip.sileroFrames.length);
      const d = Math.max(0, ...probs.map((p, i) => Math.abs(p - clip.sileroFrames[i])));
      worst = Math.max(worst, d);
      expect(d, `${clip.file}: max |Δp|`).toBeLessThanOrEqual(0.02);
      expect(onsetEnd(probs), `${clip.file}: onset/end`).toEqual([clip.sileroOnset, clip.sileroEnd]);
    }
    const ms = (performance.now() - t0) / frames;
    console.log(`Silero ort-web (wasm, node) vs ONNX reference on ${clips.length} clips: max |Δp| ${worst.toExponential(2)}, ${ms.toFixed(3)} ms/frame`);
  });

  test('hears speech and not silence', async () => {
    const peak = async (a: Float32Array) => Math.max(...(await stream(a)));
    expect(await peak(clipSamples('say-complete-weather.wav'))).toBeGreaterThan(0.8);
    expect(await peak(new Float32Array(16000))).toBeLessThan(0.1);
    expect(await peak(clipSamples('synthetic-tone-1k.wav'))).toBeLessThan(0.5);
    // Wrong frame size is an error, not a crash.
    await expect(vad.speechProbability(new Float32Array(100))).rejects.toThrow(/512/);
    expect(vad.stats.snapshot.vadFrames).toBeGreaterThan(0);
  });
});
