// Port of yanni/Preview/PupilReactionPanel.swift: manual transformation triggers (bypassing the arbiter), the reaction
// cue simulator (through the arbiter, with its accept / reject reason), every pupil reaction setting (owner settings,
// through the hub when attached), the interruption checks and live read-outs.
import type { EntitySettings } from '@yanni/server/protocol';
import { PUPIL_SHAPES, SETTING_DEFAULTS } from '@yanni/server/settings';
import { PupilReactionSettings, ReactionCueKind, type ReactionCueSource } from '../engine/PupilReactionTypes';
import { PUPIL_KINDS, type TuningModel } from './TuningModel';
import { button, buttons, group, h, readout, section, select, slider, textField, toggle, type Build } from './ui';

const SOURCES: readonly ReactionCueSource[] = ['conversation', 'perception', 'debug'];
const shapeKey = (i: number): string => PUPIL_SHAPES[i]!;
type Settings = Record<string, unknown>;

export function pupilReactionSection(m: TuningModel, b: Build): HTMLElement {
  const get = (): PupilReactionSettings => m.engine.pupilReactionSettings;
  const write = (f: (s: PupilReactionSettings) => void, entity: Settings): void =>
    m.persist(entity as Partial<EntitySettings>, () => { const s = get(); f(s); m.engine.pupilReactionSettings = s; });
  const decision = h('div', { class: 'pv-readout' });
  let last = '';
  b.poll.add(() => {
    const r = m.pupilReadouts();
    if (r.last !== last) { last = r.last; decision.textContent = r.last; }
    decision.classList.toggle('pv-ok', r.accepted);
  });
  const line = (label: string, f: () => string) => readout(b, () => `${label}: ${f()}`);
  return section('Pupil reactions',
    buttons(...PUPIL_KINDS.map(([k, t]) => [t, () => m.playPupil(k)] as [string, () => void]), ['Switch back', () => m.cancelPupil()]),
    buttons(['Question (left first)', () => m.playPupil('questionEyes', -1)], ['Question (right first)', () => m.playPupil('questionEyes', 1)]),
    group('Cue simulator (through the arbiter)',
      select('Cue', ReactionCueKind.allCases.map((k) => [k, `${k} → ${ReactionCueKind.oneShot(k)}`] as const), () => m.cueKind, (v) => { m.cueKind = v; }),
      slider('Confidence', () => m.cueConfidence, (v) => { m.cueConfidence = v; }, [0, 1]),
      slider('Valence', () => m.cueValence, (v) => { m.cueValence = v; }, [-1, 1], (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`),
      toggle('Directed at Yanni', () => m.cueDirected, (v) => { m.cueDirected = v; }),
      textField('Topic key (optional)', () => m.cueKey, (v) => { m.cueKey = v; }),
      select('Source', SOURCES.map((s) => [s, s] as const), () => m.cueSource, (v) => { m.cueSource = v; }),
      slider('Age (s)', () => m.cueAge, (v) => { m.cueAge = v; }, [0, 3], (v) => `${v.toFixed(1)} s`),
      buttons(['Send cue', () => m.sendCue()], ['Mark somber', () => m.markSomber()]),
      decision),
    toggle('Cue-driven transformations', () => get().enabled, (v) => write((s) => { s.enabled = v; }, { pupil_reactions: v })),
    slider('Intensity', () => get().intensity, (v) => write((s) => { s.intensity = v; }, { pupil_intensity: Math.round(v * 100) }),
      PupilReactionSettings.intensityRange),
    slider('Min confidence', () => get().minConfidence, (v) => write((s) => { s.minConfidence = v; }, { pupil_min_confidence: Math.round(v * 100) }),
      PupilReactionSettings.confidenceRange),
    slider('Global cooldown (s)', () => get().globalCooldown, (v) => write((s) => { s.globalCooldown = v; }, { pupil_pause: Math.round(v) }),
      PupilReactionSettings.globalCooldownRange, (v) => `${v.toFixed(0)} s`),
    slider('Repeat window (s)', () => get().repeatWindow, (v) => write((s) => { s.repeatWindow = v; }, { pupil_repeat_window: Math.round(v) }),
      PupilReactionSettings.repeatWindowRange, (v) => `${v.toFixed(0)} s`),
    toggle('Mood accent (stars, hearts)', () => get().moodAccent, (v) => write((s) => { s.moodAccent = v; }, { pupil_mood_accent: v })),
    readout(b, () => `Reduce Motion: ${get().reduceMotion ? 'on' : 'off'} (system)`, 'pv-note'),
    ...PUPIL_KINDS.map(([kind, title], i) => {
      const sh = () => get().shape(kind)!;
      const key = `pupil_${shapeKey(i)}`;
      const set = (f: (v: ReturnType<typeof sh>) => void, entity: Settings) =>
        write((s) => { const v = s.shape(kind)!; f(v); s.setShape(kind, v); }, entity);
      return group(title,
        toggle('Enabled', () => sh().enabled, (v) => set((a) => { a.enabled = v; }, { [key]: v })),
        slider('Hold (s)', () => sh().hold, (v) => set((a) => { a.hold = v; }, { [`${key}_hold`]: v }), PupilReactionSettings.holdRange,
          (v) => `${v.toFixed(2)} s`),
        slider('Cooldown (s)', () => sh().cooldown, (v) => set((a) => { a.cooldown = v; }, { [`${key}_cooldown`]: v }),
          PupilReactionSettings.cooldownRange, (v) => `${v.toFixed(0)} s`));
    }),
    buttons(['Sweep gaze during transform', () => m.sweepGazeDuringTransform()], ['Blink now', () => m.blinkNow()]),
    buttons(['Interrupt: engage', () => m.interruptPupilEngage()], ['Interrupt: startle', () => m.interruptPupilStartle()],
      ['Back to idle', () => m.endInterrupt()]),
    line('eyes', () => m.pupilReadouts().eyes),
    line('active', () => m.pupilReadouts().active),
    line('watchdog', () => String(m.pupilReadouts().watchdog)),
    line('next allowed', () => m.pupilReadouts().next),
    line('somber', () => m.pupilReadouts().somber),
    button('Reset pupil reaction settings', () => {
      const keys = ['pupil_reactions', 'pupil_intensity', 'pupil_min_confidence', 'pupil_pause', 'pupil_repeat_window', 'pupil_mood_accent',
        ...PUPIL_SHAPES.flatMap((s) => [`pupil_${s}`, `pupil_${s}_hold`, `pupil_${s}_cooldown`])];
      m.persist(Object.fromEntries(keys.map((k) => [k, (SETTING_DEFAULTS as Settings)[k]])) as Partial<EntitySettings>, () => {
        const s = new PupilReactionSettings();
        s.reduceMotion = get().reduceMotion;
        m.engine.pupilReactionSettings = s;
      });
      b.rebuild();
    }));
}
