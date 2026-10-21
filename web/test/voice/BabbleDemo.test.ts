// Port of Tests/FaceVoiceTests/BabbleDemoTests.swift.
// Renders babble replies offline (generator + synth, no audio engine) to WAVs for listening. Output:
// `$YANNI_BABBLE_DEMO_DIR` (default `$TMPDIR/YanniBabbleDemo`).
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  BabbleSeed, BabbleText, PhraseGenerator, VoiceAffect, makeBabbleRequest, type Phrase, type VoiceReaction,
} from '../../src/voice';
import { Fx, longReply } from './voiceTestSupport';

interface Demo { name: string; chunks: string[]; affect: VoiceAffect; answer?: VoiceReaction; turn: string }

const happy = VoiceAffect.make(0.75, 0.55, 0.3);
const sad = VoiceAffect.make(-0.55, -0.35, -0.35);
const excited = VoiceAffect.make(0.85, 0.9, 0.4);
const unsure = VoiceAffect.make(-0.05, 0.25, -0.7);
const neutral = VoiceAffect.neutral;

const demos: Demo[] = [
  { name: '01-happy-statement-then-question', chunks: ['Sure!', 'I turned on the kitchen lights.', 'Want me to dim them a little?'], affect: happy, turn: 'a' },
  { name: '02-yes-big-nod-chirp', chunks: ['Absolutely, the front door is locked.'], affect: happy, answer: 'mmHmBig', turn: 'b' },
  { name: '03-yes-nod-chirp', chunks: ["Yes, it's twenty one degrees inside."], affect: neutral, answer: 'mmHm', turn: 'c' },
  { name: '04-no-shake-chirp', chunks: ["No, it isn't raining right now."], affect: neutral, answer: 'uhUh', turn: 'd' },
  { name: '05-absolutely-not', chunks: ["Nope, I can't open the garage while you're away."], affect: neutral, answer: 'nuhUh', turn: 'e' },
  { name: '06-sorry-sad', chunks: ["Sorry, I couldn't find that device.", "Maybe it's offline?"], affect: sad, turn: 'f' },
  { name: '07-excited', chunks: ['Wow, that is amazing news!', 'Congratulations!'], affect: excited, turn: 'g' },
  { name: '08-unsure-question', chunks: ['Hmm, did you mean the bedroom lamp or the hallway one?'], affect: unsure, turn: 'h' },
  { name: '09-long-reply-capped-at-6s', chunks: BabbleText.sentenceStrings(longReply), affect: neutral, turn: 'i' },
  { name: '10-same-text-turn-1', chunks: ['Okay, the lights are on.'], affect: neutral, turn: 'j1' },
  { name: '11-same-text-turn-2', chunks: ['Okay, the lights are on.'], affect: neutral, turn: 'j2' },
  { name: '12-same-text-turn-3', chunks: ['Okay, the lights are on.'], affect: neutral, turn: 'j3' },
];

/// Plans a reply chunk by chunk like the director (breath gaps, 6 s budget) and renders it.
function render(d: Demo, gen: PhraseGenerator, fs = 48000): { audio: Float32Array; duration: number } {
  const items: [Phrase, number][] = [];
  let t = 0.08;
  const origin = t;
  for (let i = 0; i < d.chunks.length; i++) {
    const plan = gen.makeBabble(makeBabbleRequest({
      text: d.chunks[i], affect: d.affect, isLast: i === d.chunks.length - 1,
      answer: i === 0 ? d.answer ?? null : null, seed: BabbleSeed.make(d.turn, i), budget: 6 - (t - origin),
    }));
    if (plan.isEmpty) break;
    for (const it of plan.items) items.push([it.phrase, t + it.offset]);
    t += plan.lastNoteEnd + plan.nextGap;
  }
  const end = items.reduce((m, [p, o]) => Math.max(m, o + p.duration), 0);
  const r = Fx.renderer(fs, gen.fingerprint.basePitchHz, gen.fingerprint.maxPitchHz, gen.fingerprint.loudness);
  r.setVolume(1);
  let next = 0;
  let id = 0;
  const audio = Fx.render(r, end + 0.3, (n) => {
    // Enqueue phrases shortly before they start (the ring holds 8).
    while (next < items.length && items[next][1] <= n / fs + 0.3) {
      const p = items[next][0].copy();
      id += 1; p.id = id;
      r.enqueue(p, Fx.host0 + items[next][1]);
      next += 1;
    }
  });
  return { audio, duration: end - origin };
}

test('writeBabbleDemos', () => {
  const dir = Fx.outDir('YANNI_BABBLE_DEMO_DIR', 'YanniBabbleDemo');
  const gen = new PhraseGenerator(undefined, 0x5eedn);
  for (const d of demos) {
    const { audio, duration } = render(d, gen);
    expect(audio.every((x) => Number.isFinite(x) && Math.abs(x) <= 1)).toBe(true);
    expect(duration <= 6.01, `${d.name} runs ${duration} s`).toBe(true);
    expect(Fx.rms(audio) > 0.003, `${d.name} is audible`).toBe(true);
    Fx.writeWAV(audio, 48000, join(dir, `${d.name}.wav`));
  }
  console.log(`Yanni babble demo: ${demos.length} files in ${dir}`);
});
