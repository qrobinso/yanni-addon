// Port of yanni/Preview/EdgeAnticPanel.swift: trigger buttons for each antic (left / right edge), interruptions
// mid-antic, and every screen-edge antic setting. On / off and frequency are owner settings (through the hub); the
// rest are the engine's tunables, preview only.
import type { EntitySettings } from '@yanni/server/protocol';
import { SETTING_DEFAULTS } from '@yanni/server/settings';
import type { OneShotKind } from '../engine/Commands';
import { EdgeAnticSettings } from '../engine/EdgeAnticSettings';
import type { TuningModel } from './TuningModel';
import { button, buttons, group, h, readout, section, slider, toggle, type Build } from './ui';

export const EDGE_KINDS: readonly (readonly [OneShotKind, string])[] = [
  ['shyPeek', 'Shy peek'], ['popUp', 'Pop-up'], ['curiousLean', 'Curious lean'], ['pretendExit', 'Pretend exit'], ['sleepySink', 'Sleepy sink'],
];

const x = (v: number): string => `${v.toFixed(2)}×`;

export function edgeAnticSection(m: TuningModel, b: Build): HTMLElement {
  const get = (): EdgeAnticSettings => m.engine.edgeAnticSettings;
  const write = (f: (s: EdgeAnticSettings) => void, entity?: Partial<EntitySettings>): void => {
    const apply = (): void => { const s = get(); f(s); m.engine.edgeAnticSettings = s; };
    if (entity) m.persist(entity, apply); else apply();
  };
  const num = (label: string, k: 'travel' | 'intensity' | 'timingScale' | 'maxHiddenSeconds' | 'greetingChance' | 'postConversationChance'
    | 'sleepySinkChance', range: readonly [number, number], fmt = (v: number) => v.toFixed(2)) =>
    slider(label, () => get()[k], (v) => write((s) => { s[k] = v; }), range, fmt);
  const rows = EDGE_KINDS.map(([kind, title]) => h('div', { class: 'pv-toggle' }, h('span', { class: 'pv-grow' }, title),
    ...(kind === 'sleepySink' || kind === 'popUp' ? [button('Play', () => m.playEdge(kind))]
      : [button('◀ Left', () => m.playEdge(kind, -1)), button('Right ▶', () => m.playEdge(kind, 1))])));
  const perKind = EDGE_KINDS.map(([kind, title]) => {
    const antic = () => get().antic(kind)!;
    const setAntic = (f: (a: ReturnType<typeof antic>) => void) => write((s) => { const a = s.antic(kind)!; f(a); s.setAntic(kind, a); });
    return group(title,
      toggle('Enabled', () => antic().enabled, (v) => setAntic((a) => { a.enabled = v; })),
      kind === 'sleepySink' ? null : slider('Weight', () => antic().weight, (v) => setAntic((a) => { a.weight = v; }), EdgeAnticSettings.weightRange),
      slider('Cooldown (s)', () => antic().cooldown, (v) => setAntic((a) => { a.cooldown = v; }), EdgeAnticSettings.cooldownRange, (v) => `${v.toFixed(0)} s`));
  });
  return section('Edge antics',
    readout(b, () => m.edgeStatus()),
    ...rows,
    buttons(['Interrupt (engage)', () => m.interruptEngage()], ['Interrupt (tap)', () => m.interruptTap()], ['Back to idle', () => m.endInterrupt()]),
    toggle('Automatic antics', () => get().enabled, (v) => write((s) => { s.enabled = v; }, { screen_antics: v })),
    slider('Frequency', () => get().frequency, (v) => write((s) => { s.frequency = v; }, { antics_frequency: v }), EdgeAnticSettings.frequencyRange, x),
    num('Travel', 'travel', EdgeAnticSettings.travelRange, x),
    num('Intensity', 'intensity', EdgeAnticSettings.intensityRange, x),
    num('Timing scale', 'timingScale', EdgeAnticSettings.timingScaleRange, x),
    num('Max hidden (s)', 'maxHiddenSeconds', EdgeAnticSettings.maxHiddenRange, (v) => `${v.toFixed(2)} s`),
    num('Greeting chance', 'greetingChance', EdgeAnticSettings.chanceRange),
    num('After-conversation chance', 'postConversationChance', EdgeAnticSettings.chanceRange),
    num('Sleepy sink chance', 'sleepySinkChance', EdgeAnticSettings.chanceRange),
    toggle('No sleepy sink at bedtime', () => get().quietAtBedtime, (v) => write((s) => { s.quietAtBedtime = v; })),
    ...perKind,
    button('Reset edge antic settings', () => {
      m.engine.edgeAnticSettings = new EdgeAnticSettings();
      m.hub?.change({ screen_antics: SETTING_DEFAULTS.screen_antics, antics_frequency: SETTING_DEFAULTS.antics_frequency });
      b.rebuild();
    }));
}
