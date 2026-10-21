// Port of yanni/Preview/BackgroundPanel.swift: the mood background (mode, strength, speed, vignette, colour at
// bedtime, fixed colour, bursts: owner settings, through the hub when attached), the read-out, a fire button per
// colour burst, the six reference moods (optionally cycling), the anchor colours (runtime only, never persisted) and
// the listening glow with its preview mic.
import type { EntitySettings } from '@yanni/server/protocol';
import type { V3 } from '../core/vec';
import type { Mood } from '../engine/AgentState';
import { BackgroundBurstStyle } from '../engine/BackgroundBurstStyle';
import { OneShotKind } from '../engine/Commands';
import { MoodBackground, type MoodBackgroundConfig, type MoodBackgroundMode } from '../engine/MoodBackground';
import { MoodPalette } from '../engine/MoodPalette';
import { ExpressionMix } from '../model/ExpressionMix';
import { Oklab } from '../model/Oklab';
import { EyeGeometry } from '../render/EyeGeometry';
import type { TuningModel } from './TuningModel';
import { button, buttons, caption, color, group, h, hexText, section, segmented, slider, swatch, toggle, type Build } from './ui';

interface MoodColorView {
  expressionInfluence: number;
  background: { palette: MoodPalette; targetLab: V3; isFast(t: number): boolean };
}

const MODES: readonly (readonly [MoodBackgroundMode, string, EntitySettings['mood_background']])[] = [
  ['black', 'Black', 'Black'], ['mood', 'Mood', 'Mood'], ['fixed', 'Fixed colour', 'Fixed colour'],
];

/** Runtime state of the section (the reference preset shown, the cycle, the preview mic). */
export class BackgroundPreview {
  preset: number | null = null;
  cycle: ReturnType<typeof setInterval> | null = null;
  previewMic = false;
  previewSpeaking = false;

  constructor(readonly m: TuningModel, readonly onMood: (mood: Mood) => void = () => {}) {}

  private get mc(): MoodColorView | undefined { return this.m.modifier<MoodColorView>('MoodColor'); }

  /** Shows reference mood `i`: its mood (compensated so mood + expression lands on the anchor) and expression. Turns
   *  the background to mood mode if it is black. */
  show(i: number): void {
    const refs = MoodBackground.referenceMoods, r = refs[i], e = this.m.engine;
    if (!r) return;
    this.preset = i;
    if (e.moodBackground.mode === 'black') {
      this.m.persist({ mood_background: 'Mood' }, () => { const c = e.moodBackground; c.mode = 'mood'; e.moodBackground = c; });
    }
    const mc = this.mc;
    const mood = MoodBackground.presetMood(r.anchor, r.expression, e.state.library, mc?.background.palette ?? MoodPalette.background,
      mc?.expressionInfluence ?? 0.5);
    e.setMood(mood);
    e.setExpressionOverride(ExpressionMix.single(r.expression));
    this.onMood(mood);
  }

  toggleCycle(interval = 6): void {
    if (this.cycle) { this.stopCycling(); return; }
    const next = (): void => this.show(((this.preset ?? -1) + 1) % MoodBackground.referenceMoods.length);
    next();
    this.cycle = setInterval(next, interval * 1000);
  }

  stopCycling(): void { if (this.cycle) clearInterval(this.cycle); this.cycle = null; }

  readout(): string {
    const e = this.m.engine, out = e.state.output, mc = this.mc;
    const cur = EyeGeometry.background(out, this.m.style, 4 / 3);
    const target = mc ? Oklab.toLinearClamped(mc.background.targetLab, { x: 0, y: 0, z: 0 }) : { x: 0, y: 0, z: 0 };
    const burst = e.backgroundBurst;
    return `${hexText(cur)} → ${hexText(target)} · presence ${out.backgroundPresence.toFixed(2)} · strength ${out.backgroundStrength.toFixed(2)}`
      + (mc?.background.isFast(e.state.time) ? ' · fast' : '') + (burst.kind ? ` · burst ${burst.kind} ${burst.level.toFixed(2)}` : '');
  }
}

export function backgroundSection(bp: BackgroundPreview, b: Build): HTMLElement[] {
  const m = bp.m, e = m.engine;
  const cfg = (): MoodBackgroundConfig => e.moodBackground;
  const write = (f: (c: MoodBackgroundConfig) => void, entity: Partial<EntitySettings>): void =>
    m.persist(entity, () => { const c = cfg(); f(c); e.moodBackground = c; });
  const pct = (v: number): number => Math.round(v * 100);
  const sw = h('span', {}), st = h('span', { class: 'pv-readout' });
  let last = '';
  b.poll.add(() => {
    const t = bp.readout();
    if (t === last) return;
    last = t;
    st.textContent = t;
    sw.replaceChildren(swatch(EyeGeometry.background(e.state.output, m.style, 4 / 3)));
  });
  const burstKinds = OneShotKind.allCases.filter((k) => !BackgroundBurstStyle.standard(k).isNone);
  const palette = (): MoodPalette | undefined => m.modifier<MoodColorView>('MoodColor')?.background.palette;
  return [
    section('Background',
      segmented('Mode', MODES.map(([v, t]) => [v, t] as const), () => cfg().mode,
        (v) => write((c) => { c.mode = v; }, { mood_background: MODES.find((x) => x[0] === v)![2] })),
      slider('Strength', () => cfg().strength, (v) => write((c) => { c.strength = v; }, { mood_background_strength: pct(v) }), [0, 1]),
      slider('Speed', () => cfg().speed, (v) => write((c) => { c.speed = v; }, { mood_background_speed: v }), [0.25, 2], (v) => `${v.toFixed(2)}×`),
      slider('Vignette', () => m.style.backgroundVignette, (v) => m.persist({ mood_background_vignette: pct(v) },
        () => m.editStyle((s) => { s.backgroundVignette = v; })), [0, 1]),
      toggle('Keep the colour at bedtime', () => cfg().colourAtBedtime,
        (v) => write((c) => { c.colourAtBedtime = v; }, { mood_background_at_bedtime: v })),
      color('Fixed colour', () => cfg().fixedColor, (v) => write((c) => { c.fixedColor = v; }, { mood_background_colour: hexText(v).toLowerCase() })),
      h('div', { class: 'pv-toggle' }, sw, st),
      toggle('Colour bursts', () => cfg().colourBursts, (v) => write((c) => { c.colourBursts = v; }, { colour_bursts: v })),
      slider('Burst strength', () => cfg().burstStrength, (v) => write((c) => { c.burstStrength = v; }, { burst_strength: pct(v) }), [0, 1]),
      group('Fire a burst (Mood background only)', buttons(...burstKinds.map((k) => [k, () => e.playBackgroundBurst(k)] as [string, () => void]))),
      caption('Reference moods'),
      buttons(...MoodBackground.referenceMoods.map((r, i) => [r.title, () => { bp.stopCycling(); bp.show(i); }] as [string, () => void])),
      button('Cycle moods / stop', () => bp.toggleCycle()),
      group('Anchor colours (preview only)',
        ...(palette()?.anchors ?? []).map((a, i) => color(a.name, () => palette()!.anchors[i]!.linear, (v) => palette()?.setAnchorColor(i, v))),
        button('Reset anchors', () => {
          const bg = m.modifier<{ background: { palette: MoodPalette } }>('MoodColor')?.background;
          if (bg) bg.palette = MoodPalette.background.copy();
          b.rebuild();
        }))),
    section('Listening glow',
      toggle('Listening glow', () => e.listeningGlow.enabled, (v) => m.persist({ listening_glow: v }, () => {
        const g = e.listeningGlow; g.enabled = v; e.listeningGlow = g;
      })),
      toggle('Open mic (preview)', () => bp.previewMic, (v) => { bp.previewMic = v; e.setListeningGlow(v ? 1 : 0); }),
      toggle('Speaking (preview)', () => bp.previewSpeaking, (v) => { bp.previewSpeaking = v; e.setListeningVoice(v ? 1 : 0); })),
  ];
}
