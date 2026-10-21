// voice-demo.html: every reaction and a babble reply through the real playback path (AudioWorklet), with mood
// sliders. No face engine: phrases go straight from the generator to the renderer, a lead ahead of now.
import { PhraseGenerator } from './generate/PhraseGenerator';
import { makeBabbleRequest } from './generate/BabbleShaping';
import { BabbleText } from './generate/SyllableCounter';
import { HostClock } from './host/VoiceOutput';
import { allVoiceReactions, VoiceAffect, type Phrase, type VoiceReaction } from './model/VoiceModel';
import { installAudioUnlock, VoiceAudioHost } from './playback/VoiceAudioHost';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const ctx = new AudioContext({ latencyHint: 'interactive' });
const host = new VoiceAudioHost(ctx);
installAudioUnlock(ctx);
(globalThis as { voiceHost?: VoiceAudioHost }).voiceHost = host;   // console poking while tuning
let gen = new PhraseGenerator();
let last: { phrases: [Phrase, number][] } | null = null;
let id = 0;

for (const k of ['p', 'a', 'd', 'vol']) {
  const input = $<HTMLInputElement>(k), out = input.nextElementSibling as HTMLOutputElement;
  const show = (): void => { out.value = Number(input.value).toFixed(2); };
  input.addEventListener('input', show);
  show();
}
const affect = (): VoiceAffect =>
  VoiceAffect.make(Number($<HTMLInputElement>('p').value), Number($<HTMLInputElement>('a').value), Number($<HTMLInputElement>('d').value));
const applyVolume = (): void => {
  for (const r of [host.chirp, host.reply]) {
    r.setVolume(Number($<HTMLInputElement>('vol').value));
    r.setMuted($<HTMLInputElement>('mute').checked);
  }
};
$('vol').addEventListener('input', applyVolume);
$('mute').addEventListener('change', applyVolume);

async function play(phrases: [Phrase, number][]): Promise<void> {
  await host.start();
  applyVolume();
  const t0 = HostClock.now() + 0.06;
  for (const [p, offset] of phrases) {
    p.id = ++id;
    (p.reaction === 'babble' || phrases.length > 1 ? host.reply : host.chirp).enqueue(p, t0 + offset);
  }
  last = { phrases };
  show(phrases);
}

function show(phrases: [Phrase, number][]): void {
  const lines: string[] = [];
  const c = $<HTMLCanvasElement>('pitch'), g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  const end = Math.max(0.3, ...phrases.map(([p, o]) => o + p.duration));
  const x = (t: number): number => (t / end) * c.width, y = (st: number): number => c.height / 2 - st * 6;
  g.strokeStyle = '#2a303a';
  g.beginPath(); g.moveTo(0, y(0)); g.lineTo(c.width, y(0)); g.stroke();
  for (const [p, o] of phrases) {
    for (const n of p.notes) {
      g.strokeStyle = n.accent ? '#6cc4ff' : '#7be08f';
      g.lineWidth = 1 + 3 * n.gain;
      g.beginPath();
      for (let k = 0; k <= 32; k++) {
        const t = (n.duration * k) / 32;
        const px = x(o + n.start + t), py = y(n.contour.pitch(t, n.duration));
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
      lines.push(`${p.reaction.padEnd(11)} t ${(o + n.start).toFixed(3)}  ${(n.duration * 1000).toFixed(0).padStart(3)} ms  ` +
        `${n.contour.start.toFixed(1)}→${n.contour.end.toFixed(1)} st  gain ${n.gain.toFixed(2)}${n.slur ? ' slur' : ''}${n.accent ? ' accent' : ''}`);
    }
  }
  $('notes').textContent = lines.join('\n');
}

const box = $('reactions');
for (const r of allVoiceReactions) {
  const b = document.createElement('button');
  b.textContent = r;
  b.addEventListener('click', () => void play([[gen.make(r as VoiceReaction, affect()), 0]]));
  box.append(b);
}
$('seed').addEventListener('click', () => {
  gen = new PhraseGenerator(gen.fingerprint, BigInt(Math.floor(Math.random() * 2 ** 52)));
});
$('repeat').addEventListener('click', () => { if (last) void play(last.phrases.map(([p, o]) => [p.copy(), o])); });
$('say').addEventListener('click', () => {
  const text = $<HTMLTextAreaElement>('text').value;
  const answer = $<HTMLSelectElement>('answer').value as VoiceReaction | '';
  const phrases: [Phrase, number][] = [];
  let t = 0;
  const parts = BabbleText.sentenceStrings(text);
  parts.forEach((s, i) => {
    const plan = gen.makeBabble(makeBabbleRequest({ text: s, affect: affect(), isLast: i === parts.length - 1,
      answer: i === 0 && answer ? answer : null, seed: BigInt(i + 1) * 0x9e3779b9n, budget: 6 - t }));
    for (const it of plan.items) phrases.push([it.phrase, t + it.offset]);
    t += plan.lastNoteEnd + plan.nextGap;
  });
  void play(phrases);
});
