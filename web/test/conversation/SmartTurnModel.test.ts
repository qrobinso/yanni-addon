// Port of ConversationTurnMLTests/SmartTurnModelTests.swift: our Whisper front end + the fp32 ONNX on onnxruntime-web
// (wasm in node) against the reference (WhisperFeatureExtractor + onnxruntime fp32) in expected.json.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { TurnAudioWindow } from '../../src/conversation/turn';
import { SmartTurnModel } from '../../src/conversation/turnml/SmartTurnModel';
import { clipSamples, clipWindow, loadClips, modelPath, modelsPresent } from './support/ClipSupport';

const clips = loadClips().clips;

describe.skipIf(!modelsPresent)('Smart Turn on onnxruntime-web (run web/scripts/fetch-models.mjs first)', () => {
  let model: SmartTurnModel;
  beforeAll(async () => {
    model = new SmartTurnModel(new Uint8Array(readFileSync(modelPath('smart-turn-v3.2-gpu.onnx'))));
    await model.prepare();
  }, 60_000);

  test('agrees with the fp32 reference', async () => {
    let worst = 0, agreed = 0, judged = 0;
    for (const clip of clips) {
      const p = await model.completionProbability(clipWindow(clipSamples(clip.file)));
      const d = Math.abs(p - clip.smartTurnFp32);
      worst = Math.max(worst, d);
      // The iPad's fp16 Core ML port is held to 0.05; this runs the reference fp32 graph itself.
      expect(d, `${clip.file}: ${p} vs fp32 ${clip.smartTurnFp32}`).toBeLessThanOrEqual(1e-3);
      if (Math.abs(clip.smartTurnFp32 - 0.5) >= 0.15) {
        judged += 1;
        if (p > 0.5 === clip.smartTurnFp32 > 0.5) agreed += 1;
      }
    }
    expect(judged).toBeGreaterThanOrEqual(20);
    expect(agreed).toBe(judged);
    const s = model.stats.snapshot;
    expect(s.smartTurnRuns).toBe(clips.length);
    expect(model.provider).toBe('wasm');
    console.log(`Smart Turn ort-web (${model.provider}, node) vs fp32 ONNX: ${agreed}/${judged} verdicts, max |Δp| ${worst.toExponential(2)}, p50 ${s.smartTurnP50Ms.toFixed(1)} ms, load+warm ${s.smartTurnLoadMs.toFixed(0)} ms`);
  }, 120_000);

  test('inference time (recorded, loosely gated)', async () => {
    const w = clipWindow(clipSamples('say-complete-weather.wav'));
    for (let i = 0; i < 3; i++) await model.predictNow(w.samples);
    const ms: number[] = [];
    const fe: number[] = [];
    const ex = new (await import('../../src/conversation/turnml/WhisperFeatures')).WhisperFeatureExtractor();
    for (let i = 0; i < 15; i++) {
      let t = performance.now();
      ex.extract(w.samples);
      fe.push(performance.now() - t);
      t = performance.now();
      await model.predictNow(w.samples);
      ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    fe.sort((a, b) => a - b);
    console.log(`Smart Turn wasm (node): p50 ${ms[7].toFixed(1)} ms, p90 ${ms[13].toFixed(1)} ms per run (features p50 ${fe[7].toFixed(1)} ms)`);
    expect(ms[7]).toBeLessThan(1000);
  }, 120_000);

  test('a wrong window size throws', async () => {
    await expect(model.predictNow(new Float32Array(100))).rejects.toThrow(/128000/);
    expect(new TurnAudioWindow().count).toBe(128_000);
  });
});
