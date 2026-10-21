// Port of Tests/FaceVoiceTests/ReactionDemoTests.swift.
// Renders every reaction through the real generator + synth at a few moods to WAVs for listening.
// Output: $TMPDIR/YanniVoiceDemo-reactions/<mood>/<reaction>-<n>.wav (three takes each, to hear the variation).
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { PhraseGenerator, VoiceAffect, allVoiceReactions } from '../../src/voice';
import { Fx } from './voiceTestSupport';

test('writeReactionDemos', () => {
  const dir = join(tmpdir(), 'YanniVoiceDemo-reactions');
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* try? in Swift */ }
  const moods: [string, VoiceAffect][] = [
    ['playful', VoiceAffect.neutral],
    ['happy', VoiceAffect.make(0.8, 0.6, 0.3)],
    ['sad', VoiceAffect.make(-0.6, -0.4, -0.4)],
    ['unsure', VoiceAffect.make(-0.1, 0.3, -0.7)],
  ];
  const gen = new PhraseGenerator(undefined, 7n);
  let count = 0;
  for (const [name, affect] of moods) {
    const sub = join(dir, name);
    mkdirSync(sub, { recursive: true });
    for (const r of allVoiceReactions) {
      for (let take = 1; take <= 3; take++) {
        const p = gen.make(r, affect);
        const audio = Fx.renderPhrase(p, gen.fingerprint.basePitchHz, gen.fingerprint.maxPitchHz, p.duration + 0.15);
        expect(audio.every((x) => Number.isFinite(x) && Math.abs(x) <= 1)).toBe(true);
        Fx.writeWAV(audio, 48000, join(sub, `${r}-${take}.wav`));
        count += 1;
      }
    }
  }
  console.log(`Yanni voice demo: ${count} files in ${dir}`);
});

/// The tickle's giggle chirps as a scratch plays them: three giggles ~2.2 s apart at a delighted mood, mixed into one
/// WAV (`$YANNI_TICKLE_RENDERS/tickle-giggles.wav` or `$TMPDIR/YanniVoiceDemo-giggles/tickle-giggles.wav`).
test('writeTickleGiggles', () => {
  const dir = Fx.outDir('YANNI_TICKLE_RENDERS', 'YanniVoiceDemo-giggles');
  const gen = new PhraseGenerator(undefined, 21n);
  const fs = 48000, gap = 2.2;
  const mix = new Float32Array(Math.trunc(fs * (3 * gap + 0.5)));
  for (let k = 0; k < 3; k++) {
    const p = gen.make('giggle', VoiceAffect.make(0.8, 0.75, 0.3));
    const a = Fx.renderPhrase(p, gen.fingerprint.basePitchHz, gen.fingerprint.maxPitchHz, p.duration + 0.15);
    const off = Math.trunc(k * gap * fs);
    for (let i = 0; i < a.length; i++) if (off + i < mix.length) mix[off + i] += a[i];
  }
  expect(mix.every((x) => Number.isFinite(x) && Math.abs(x) <= 1)).toBe(true);
  expect(mix.some((x) => Math.abs(x) > 0.01), 'audible').toBe(true);
  Fx.writeWAV(mix, fs, join(dir, 'tickle-giggles.wav'));
});
