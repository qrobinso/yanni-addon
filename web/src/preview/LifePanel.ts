// Port of yanni/Preview/LifePanel.swift: read-outs, force sleep / wake, the preview time warp, the timers, bedtime and
// the waking rules. The life settings are owner settings (through the hub when attached); the time warp and the
// alone-takeover minutes are preview only.
import type { EntitySettings } from '@yanni/server/protocol';
import { LifeSettings } from '../life/LifeSettings';
import { formatSeconds } from './DevStatus';
import type { TuningModel } from './TuningModel';
import { buttons, h, readout, section, segmented, slider, toggle, type Build } from './ui';

type Field = 'minutesToDrowsy' | 'minutesToAsleep' | 'bedtimeAwakeMinutes' | 'aloneTakeoverMinutes' | 'bedtimeEnabled'
  | 'manualBedtime' | 'wakeOnMotionAtBedtime' | 'idleMoodDrift' | 'tapsToWake' | 'bedtimeStart' | 'bedtimeEnd';
const ENTITY: Partial<Record<Field, keyof EntitySettings>> = {
  minutesToDrowsy: 'minutes_to_drowsy', minutesToAsleep: 'minutes_to_asleep', bedtimeAwakeMinutes: 'bedtime_awake_minutes',
  bedtimeEnabled: 'bedtime_schedule', manualBedtime: 'bedtime', wakeOnMotionAtBedtime: 'wake_on_motion_at_bedtime',
  idleMoodDrift: 'idle_mood_drift', tapsToWake: 'taps_to_wake', bedtimeStart: 'bedtime_start', bedtimeEnd: 'bedtime_end',
};

const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function lifeSection(m: TuningModel, b: Build): HTMLElement {
  const life = m.ctx.life;
  const set = <K extends Field>(k: K, v: LifeSettings[K]): void => {
    const key = ENTITY[k];
    const direct = (): void => { life.settings = life.settings.with({ [k]: v } as Partial<LifeSettings>); };
    if (key) m.persist({ [key]: v } as Partial<EntitySettings>, direct); else direct();
  };
  const minutes = (label: string, k: 'minutesToDrowsy' | 'minutesToAsleep' | 'bedtimeAwakeMinutes' | 'aloneTakeoverMinutes',
    range: readonly [number, number]) => slider(label, () => life.settings[k], (v) => set(k, v), range, (v) => `${v.toFixed(2)} min`, 0.25);
  const time = (label: string, k: 'bedtimeStart' | 'bedtimeEnd'): HTMLElement => {
    const input = h('input', { type: 'time', value: hhmm(life.settings[k]) });
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => { const [hh, mm] = input.value.split(':').map(Number); set(k, (hh ?? 0) * 60 + (mm ?? 0)); });
    return h('label', { class: 'pv-select' }, h('span', {}, label), input);
  };
  return section('Life cycle',
    readout(b, () => `${life.phase} · ${m.engine.state.agentState}${life.lastChange ? ` · ${life.lastChange.reason}` : ''}`),
    readout(b, () => { const n = life.nextTransition; return n ? (n.seconds !== null ? `${n.label} in ${formatSeconds(n.seconds)}` : n.label) : '—'; }),
    readout(b, () => {
      const d: string[] = [];
      if (life.isScheduledBedtime) d.push(life.scheduleSuspended ? 'schedule suspended' : 'scheduled');
      if (life.settings.manualBedtime) d.push('manual');
      if (life.isNightAwake) d.push('night wake');
      if (life.isForceSleepActive) d.push('force sleep');
      return `bedtime ${life.isBedtime ? 'on' : 'off'}${d.length ? ` (${d.join(' · ')})` : ''} · camera ${life.cameraMode} · boredom ${life.boredom.toFixed(2)}`;
    }, 'pv-note'),
    buttons(['Force sleep', () => life.forceSleep()], ['Force wake', () => life.forceWake()]),
    segmented('Time warp', [[1, '×1'], [10, '×10'], [60, '×60']] as const, () => life.timeWarp, (v) => { life.timeWarp = v; }),
    minutes('Minutes to drowsy', 'minutesToDrowsy', [0.25, 30]),
    minutes('Minutes to asleep', 'minutesToAsleep', [0.25, 30]),
    toggle('Bedtime schedule', () => life.settings.bedtimeEnabled, (v) => set('bedtimeEnabled', v)),
    time('Bedtime starts', 'bedtimeStart'),
    time('Bedtime ends', 'bedtimeEnd'),
    toggle('Bedtime switch (manual)', () => life.settings.manualBedtime, (v) => set('manualBedtime', v)),
    slider('Taps to wake at bedtime', () => life.settings.tapsToWake, (v) => set('tapsToWake', Math.round(v)), LifeSettings.tapsRange,
      (v) => String(Math.round(v)), 1),
    toggle('Wake on motion at bedtime', () => life.settings.wakeOnMotionAtBedtime, (v) => set('wakeOnMotionAtBedtime', v)),
    minutes('Bedtime awake minutes', 'bedtimeAwakeMinutes', [0.25, 10]),
    minutes('Alone takeover minutes', 'aloneTakeoverMinutes', [0.5, 10]),
    toggle('Idle mood drift', () => life.settings.idleMoodDrift, (v) => set('idleMoodDrift', v)));
}
