// Port of yanni/Preview/SoundPanel.swift: the voice by ear (PAD shared with the mood sliders, every reaction with or
// without its face one-shot, emote / repeat / reseed / stop, the last phrase's notes), the voice settings (owner
// settings, through the hub when attached), and the voice fingerprint with save / load (this browser's storage),
// copy JSON and the bundled one.
import type { EntitySettings } from '@yanni/server/protocol';
import type { VoiceDirector } from '../voice/bridge/VoiceDirector';
import { VoiceFingerprint } from '../voice/model/VoiceFingerprint';
import { allVoiceReactions } from '../voice/model/VoiceModel';
import type { TuningModel } from './TuningModel';
import { buttons, note, readout, section, segmented, slider, toggle, type Build } from './ui';

const FP_KEY = 'yanni-fingerprint.json';

export class SoundPreview {
  withFace = true;
  status = '';

  constructor(readonly m: TuningModel, readonly director: VoiceDirector) {}

  pushFingerprint(fp: VoiceFingerprint): void {
    const d = this.director;
    d.generator.fingerprint = fp;
    d.renderer.setFingerprint(fp);
    d.replyRenderer.setFingerprint(fp);
  }

  editFingerprint(f: (fp: VoiceFingerprint) => void): void {
    const fp = this.director.generator.fingerprint.copy();
    f(fp);
    this.pushFingerprint(fp);
  }

  voice(f: (s: VoiceDirector['settings']) => void, entity: Partial<EntitySettings> | null): void {
    const direct = (): void => { const s = this.director.settings.copy(); f(s); this.director.settings = s; };
    if (entity) this.m.persist(entity, direct); else direct();
  }

  save(): void {
    try { localStorage.setItem(FP_KEY, this.director.generator.fingerprint.json()); this.status = `Saved ${FP_KEY}`; }
    catch (e) { this.status = `Save failed: ${String(e)}`; }
  }

  load(): void {
    try {
      const fp = VoiceFingerprint.decode(JSON.parse(localStorage.getItem(FP_KEY) ?? 'null'));
      if (!fp) { this.status = 'Load failed: nothing saved'; return; }
      this.pushFingerprint(fp);
      this.status = `Loaded ${FP_KEY}`;
    } catch (e) { this.status = `Load failed: ${String(e)}`; }
  }

  copyJSON(): void {
    const text = this.director.generator.fingerprint.json();
    void navigator.clipboard?.writeText(text).then(() => { this.status = `Copied ${text.length} bytes of fingerprint JSON`; },
      (e: unknown) => { this.status = `Copy failed: ${String(e)}`; });
  }

  lastPhrase(): string {
    const d = this.director, p = d.lastPhrase;
    if (!p) return '—';
    const stretch = d.lastScheduled?.timeStretch ?? 1;
    const a = p.affect, sg = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
    const head = `${p.reaction} · ${p.notes.length} notes · ${(p.duration * 1000).toFixed(0)} ms · P ${sg(a.pleasure)} A ${sg(a.arousal)} D ${sg(a.dominance)}`
      + (stretch > 1 ? ` · ×${stretch.toFixed(1)}` : '');
    return [head, ...p.notes.map((n, i) => `${i + 1}  ${(n.start * 1000).toFixed(0).padStart(4)} ms  ${(n.duration * 1000).toFixed(0).padStart(4)} ms  `
      + `${sg(n.contour.start)}→${sg(n.contour.end)} st  ${[n.slur ? 'slur' : '', n.accent ? 'accent' : ''].filter(Boolean).join(' ')}`)].join('\n');
  }
}

type FpKey = 'basePitchHz' | 'rangeSemitones' | 'maxPitchHz' | 'sine' | 'square' | 'fm' | 'fmRatio' | 'fmIndexPeak' | 'fmIndexSustain'
  | 'brightness' | 'formantAmount' | 'vowel' | 'breathDB' | 'glideEase' | 'scoop' | 'vibratoRateHz' | 'vibratoDepthSemitones' | 'scaleSnap' | 'loudness';
const FP: readonly (readonly [string, FpKey, number, number, (v: number) => string])[] = [
  ['Base pitch', 'basePitchHz', 300, 1600, (v) => `${v.toFixed(0)} Hz`], ['Range', 'rangeSemitones', 2, 24, (v) => `${v.toFixed(1)} st`],
  ['Max pitch', 'maxPitchHz', 600, 4000, (v) => `${v.toFixed(0)} Hz`], ['Sine', 'sine', 0, 1, (v) => v.toFixed(2)],
  ['Square', 'square', 0, 1, (v) => v.toFixed(2)], ['FM', 'fm', 0, 1, (v) => v.toFixed(2)], ['FM ratio', 'fmRatio', 0.25, 4, (v) => v.toFixed(2)],
  ['FM index peak', 'fmIndexPeak', 0, 6, (v) => v.toFixed(2)], ['FM index sustain', 'fmIndexSustain', 0, 3, (v) => v.toFixed(2)],
  ['Brightness', 'brightness', 0, 1, (v) => v.toFixed(2)], ['Formant amount', 'formantAmount', 0, 1, (v) => v.toFixed(2)],
  ['Vowel (oo → ee)', 'vowel', 0, 1, (v) => v.toFixed(2)], ['Breath', 'breathDB', -60, -6, (v) => `${v.toFixed(0)} dB`],
  ['Glide ease', 'glideEase', 0, 1, (v) => v.toFixed(2)], ['Scoop', 'scoop', 0, 3, (v) => `${v.toFixed(1)} st`],
  ['Vibrato rate', 'vibratoRateHz', 3, 10, (v) => `${v.toFixed(1)} Hz`], ['Vibrato depth', 'vibratoDepthSemitones', 0, 1, (v) => `${v.toFixed(2)} st`],
  ['Scale snap', 'scaleSnap', 0, 1, (v) => v.toFixed(2)], ['Loudness', 'loudness', 0, 1, (v) => v.toFixed(2)],
];

export function soundSections(sp: SoundPreview, b: Build): HTMLElement[] {
  const { m, director: d } = sp;
  const mood = (label: string, k: 'pleasure' | 'arousal' | 'dominance') =>
    slider(label, () => m.mood[k], (v) => { m.mood = { ...m.mood, [k]: v }; m.pushMood(); }, [-1, 1]);
  return [
    section('Sound',
      mood('Pleasure', 'pleasure'), mood('Arousal', 'arousal'), mood('Dominance', 'dominance'),
      toggle('Play paired face one-shot', () => sp.withFace, (v) => { sp.withFace = v; }),
      buttons(...allVoiceReactions.filter((r) => r !== 'emote' && r !== 'babble').map((r) => [r, () => d.react(r, sp.withFace)] as [string, () => void])),
      buttons(['Emote', () => d.emote()], ['Repeat last', () => d.repeatLast()], ['Randomize seed', () => { d.randomizeSeed(); sp.status = 'New generator seed'; }],
        ['Stop', () => d.cancel()]),
      readout(b, () => sp.lastPhrase()),
      toggle('Auto-vocalize', () => d.settings.autoVocalize, (v) => sp.voice((s) => { s.autoVocalize = v; }, null)),
      toggle('Mute', () => d.settings.muted, (v) => sp.voice((s) => { s.muted = v; }, { sounds: !v })),
      toggle('Quiet mode', () => d.settings.quietMode, (v) => sp.voice((s) => { s.quietMode = v; }, { quiet_mode: v })),
      readout(b, () => `Bedtime: ${d.isBedtime ? 'on (life cycle)' : 'off'}`, 'pv-note'),
      segmented('Bedtime sounds', [['off', 'Off'], ['quiet', 'Quiet']] as const, () => d.settings.bedtimeSounds,
        (v) => sp.voice((s) => { s.bedtimeSounds = v; }, { bedtime_sounds: v })),
      slider('Volume', () => d.settings.volume, (v) => sp.voice((s) => { s.volume = v; }, { chirp_volume: Math.round(v * 100) }), [0, 1]),
      slider('AV offset (face delay)', () => d.settings.avOffset * 1000, (v) => sp.voice((s) => { s.avOffset = v / 1000; }, null), [-60, 60],
        (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)} ms`, 1)),
    section('Voice fingerprint',
      ...FP.map(([label, k, lo, hi, fmt]) => slider(label, () => d.generator.fingerprint[k], (v) => sp.editFingerprint((fp) => { fp[k] = v; }), [lo, hi], fmt)),
      buttons(['Save', () => sp.save()], ['Load', () => { sp.load(); b.rebuild(); }], ['Copy JSON', () => sp.copyJSON()],
        ['Bundled', () => { sp.pushFingerprint(VoiceFingerprint.bundled()); sp.status = 'Bundled fingerprint'; b.rebuild(); }]),
      readout(b, () => sp.status, 'pv-note'),
      note('Saved in this browser (the Swift app writes yanni-fingerprint.json to Documents).')),
  ];
}
