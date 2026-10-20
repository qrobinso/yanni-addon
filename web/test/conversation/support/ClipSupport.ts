// Port of ConversationTurnMLTests/ClipSupport.swift: the committed clip set (fixtures/TurnClips, built by yanni's
// Tools/turn-models/make_fixtures.py; synthetic or CC-BY-4.0 TTS only) with the ONNX reference outputs.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnAudioWindow } from '../../../src/conversation/turn';

const here = dirname(fileURLToPath(import.meta.url));
export const clipDir = join(here, '..', 'fixtures', 'TurnClips');
export const modelDir = join(here, '..', '..', '..', 'public', 'models');
export const modelPath = (file: string): string => join(modelDir, file);
/** The models are fetched by web/scripts/fetch-models.mjs (gitignored); the model tests skip without them. */
export const modelsPresent = existsSync(modelPath('silero_vad.onnx')) && existsSync(modelPath('smart-turn-v3.2-gpu.onnx'));

export interface Clip {
  file: string;
  source: string;
  license: string;
  label: number | null;
  smartTurnFp32: number;
  smartTurnInt8: number;
  sileroFrames: number[];
  sileroOnset: number | null;
  sileroEnd: number | null;
}

export const loadClips = (): { sampleRate: number; clips: Clip[] } =>
  JSON.parse(readFileSync(join(clipDir, 'expected.json'), 'utf8'));

/** 16-bit PCM WAV → Float32 (x / 32768), the way soundfile reads it in the reference scripts. */
export function clipSamples(file: string): Float32Array {
  const d = readFileSync(join(clipDir, file));
  let o = 12;
  while (o + 8 <= d.length) {
    const id = d.toString('ascii', o, o + 4);
    const size = d.readUInt32LE(o + 4);
    if (id === 'data') {
      const out = new Float32Array(size >> 1);
      for (let i = 0; i < out.length; i++) out[i] = d.readInt16LE(o + 8 + 2 * i) / 32768;
      return out;
    }
    o += 8 + size + (size & 1);
  }
  throw new Error(`${file}: no data chunk`);
}

/** The Smart Turn input: the last 8 s, zero-padded at the beginning. */
export function clipWindow(audio: Float32Array): TurnAudioWindow {
  const w = new TurnAudioWindow();
  const n = Math.min(audio.length, w.count);
  w.samples.set(audio.subarray(audio.length - n), w.count - n);
  w.validCount = n;
  return w;
}

/** parity.py's `onset_end`: the §6 defaults reduced to frame indices (first onset, first end of speech after it). */
export function onsetEnd(probs: ArrayLike<number>, thr = 0.6, hyst = 0.15, minSpeech = 2, stop = 6): [number | null, number | null] {
  let run = 0, runStart = 0, silent = 0, cand = 0;
  let onset: number | null = null;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (onset === null) {
      if (p >= thr) {
        if (run === 0) runStart = i;
        run += 1;
        if (run >= minSpeech) onset = runStart;
      } else if (p < thr - hyst) {
        run = 0;
      }
    } else if (p < thr - hyst) {
      silent += 1;
      if (silent === 1) cand = i;
      if (silent >= stop) return [onset, cand];
    } else if (p >= thr) {
      silent = 0;
    }
  }
  return [onset, null];
}
