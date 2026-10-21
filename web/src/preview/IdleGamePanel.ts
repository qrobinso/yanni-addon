// Port of yanni/Preview/IdleGamePanel.swift: Play and Interrupt for each game, the schedule read-out and every idle
// game setting (all owner settings, written through the hub when attached). Pending games play their rest pose.
import type { EntitySettings } from '@yanni/server/protocol';
import { IDLE_GAMES, SETTING_DEFAULTS } from '@yanni/server/settings';
import type { OneShotKind } from '../engine/Commands';
import { IdleGameSettings } from '../engine/IdleGameSettings';
import { IdleGames } from '../engine/modifiers/IdleGames';
import type { TuningModel } from './TuningModel';
import { button, buttons, group, h, readout, section, slider, toggle, type Build } from './ui';

export const GAMES: readonly (readonly [OneShotKind, string])[] = [
  ['pingPong', 'Ping pong'], ['basketball', 'Basketball'], ['juggling', 'Juggling'], ['yoYo', 'Yo-yo'], ['leapfrog', 'Leapfrog'],
  ['staringContest', 'Staring contest'], ['hideAndSeek', 'Hide-and-seek'], ['catchTheFly', 'Catch the fly'],
  ['danceBreak', 'Dance break'], ['hulaHoop', 'Hula hoop'],
];

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
type Settings = Record<string, unknown>;
const x = (v: number): string => `${v.toFixed(2)}×`;

export function idleGameSection(m: TuningModel, b: Build): HTMLElement {
  const get = (): IdleGameSettings => m.engine.idleGameSettings;
  const write = (f: (s: IdleGameSettings) => void, entity: Settings): void =>
    m.persist(entity as Partial<EntitySettings>, () => { const s = get(); f(s); m.engine.idleGameSettings = s; });
  const perGame = GAMES.map(([kind, title]) => {
    const key = `game_${snake(kind)}`;
    const g = () => get().game(kind)!;
    const set = (f: (v: ReturnType<typeof g>) => void, entity: Settings) =>
      write((s) => { const v = s.game(kind)!; f(v); s.setGame(kind, v); }, entity);
    return group(title,
      toggle('Enabled', () => g().enabled, (v) => set((a) => { a.enabled = v; }, { [key]: v })),
      slider('Weight', () => g().weight, (v) => set((a) => { a.weight = v; }, { [`${key}_weight`]: v }), IdleGameSettings.weightRange),
      slider('Cooldown (s)', () => g().cooldown, (v) => set((a) => { a.cooldown = v; }, { [`${key}_cooldown`]: v }),
        IdleGameSettings.cooldownRange, (v) => `${v.toFixed(0)} s`));
  });
  return section('Idle games',
    readout(b, () => m.idleGameStatus()),
    ...GAMES.map(([kind, title]) => h('div', { class: 'pv-toggle' }, h('span', { class: 'pv-grow' }, IdleGames.isPending(kind) ? `${title} (pending)` : title),
      button('Play', () => m.engine.playIdleGame(kind)), button('Interrupt', () => m.interruptTap()))),
    buttons(['Interrupt (engage)', () => m.interruptEngage()], ['Back to idle', () => m.endInterrupt()]),
    toggle('Automatic games', () => get().enabled, (v) => write((s) => { s.enabled = v; }, { idle_games: v })),
    slider('Frequency', () => get().frequency, (v) => write((s) => { s.frequency = v; }, { idle_games_frequency: v }), IdleGameSettings.frequencyRange, x),
    slider('Intensity', () => get().intensity, (v) => write((s) => { s.intensity = v; }, { idle_games_intensity: v }), IdleGameSettings.intensityRange, x),
    slider('Timing scale', () => get().timingScale, (v) => write((s) => { s.timingScale = v; }, { idle_games_timing: v }), IdleGameSettings.timingScaleRange, x),
    ...perGame,
    button('Reset idle game settings', () => {
      const keys = ['idle_games', 'idle_games_frequency', 'idle_games_intensity', 'idle_games_timing',
        ...IDLE_GAMES.flatMap((g) => [`game_${g}`, `game_${g}_weight`, `game_${g}_cooldown`])];
      m.persist(Object.fromEntries(keys.map((k) => [k, (SETTING_DEFAULTS as Settings)[k]])) as Partial<EntitySettings>,
        () => { m.engine.idleGameSettings = new IdleGameSettings(); });
      b.rebuild();
    }));
}
