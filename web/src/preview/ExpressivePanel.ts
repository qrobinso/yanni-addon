// Port of yanni/Preview/ExpressivePanel.swift: simulate a trigger and see the request features and the decision
// model's answer (a fake Jev, or the live one through the expressive bridge when the app hands it over), mapped and
// played through the emotion layer; fire preset plans by hand; edit the deadline. Developer-only text.
import type { EmotionLayer } from '../emotion/EmotionLayer';
import { ExpressivePlan } from '../engine/ExpressivePlan';
import { makeReactionCue, type ReactionCueKind } from '../engine/PupilReactionTypes';
import type { ExpressiveDecisions } from '../conversation/core/ExpressiveDecisions';
import { expressiveTriggers, makeExpressiveFeatures, normalizedFeatures, type ExpressiveFeatures, type ExpressiveTrigger } from '../conversation/events/ExpressiveEvents';
import { buttons, h, readout, section, select, slider, toggle, type Build } from './ui';

export const GESTURES = ['wave', 'byeWave', 'clap', 'armsUp', 'point', 'nod', 'thumbsUp', 'thumbsDown', 'openPalm', 'peace',
  'heartHands', 'peekaboo', 'dancing', 'highFive'] as const;

const cue = (k: ReactionCueKind) => makeReactionCue(k, 0.9, { source: 'debug', directedAtYanni: true, valence: 0.5, key: `${k}:tune` });
export const EXPRESSIVE_PRESETS: readonly (readonly [string, ExpressivePlan])[] = [
  ['Sceptical brow', new ExpressivePlan({ expression: 'Skepticism', intensity: 0.75, hold: 1.6, brow: 'sceptical' })],
  ['Shy + hearts', new ExpressivePlan({ expression: 'Embarrassment', intensity: 0.7, hold: 1.8, brow: 'worried', browAmount: 0.7, gaze: 'lookAway', cue: cue('affection') })],
  ['Bounce + stars', new ExpressivePlan({ expression: 'Happiness', intensity: 0.9, hold: 1.8, brow: 'raise', move: 'laugh', cue: cue('delight') })],
  ['Soft worry', new ExpressivePlan({ expression: 'Concerned', intensity: 0.8, hold: 1.8, brow: 'worried' })],
  ['Eye-roll', new ExpressivePlan({ expression: 'MockAnnoyed', intensity: 0.6, hold: 1.2, brow: 'sceptical', gaze: 'eyeRoll' })],
  ['Furrow', new ExpressivePlan({ expression: 'Curious', intensity: 0.5, hold: 1.4, brow: 'furrow', move: 'curiousTilt' })],
];

/** Plausible answers for a trigger (no network): a family per trigger with some randomness (preview only). */
export function fakeAnswers(f: ExpressiveFeatures, random: () => number = Math.random): Record<string, Record<string, number>> {
  const g = f.gesture ?? '';
  const fam = f.event === 'gesture' && g === 'heartHands' ? 'shy'
    : (f.event === 'gesture' && g === 'thumbsDown') || f.event === 'leaving' ? 'sympathetic'
    : (f.event === 'gesture' && (g === 'point' || g === 'peekaboo')) || f.event === 'eyeContact' || f.event === 'arrival' ? 'curiosity'
    : (f.event === 'gesture' && ['dancing', 'clap', 'armsUp'].includes(g)) || f.event === 'tickle' ? 'playful'
    : f.event === 'pokeStreak' || f.event === 'ignored' ? 'sceptical' : 'delight';
  const pupil = fam === 'shy' ? 'hearts' : fam === 'playful' ? (g === 'dancing' ? 'notes' : 'stars') : fam === 'curiosity' ? 'question'
    : fam === 'delight' ? 'stars' : 'none';
  const move = fam === 'playful' ? 'bounce' : fam === 'curiosity' ? 'tilt' : fam === 'delight' ? 'perk' : 'none';
  const gaze = fam === 'shy' ? 'lookAway' : fam === 'sceptical' ? 'eyeRoll' : 'lookAt';
  const p = 0.5 + 0.35 * random();
  return { react: { [fam]: p, ignore: 1 - p }, intensity: { 3: 0.4, 4: 0.4, 5: 0.2 }, brow: { none: 0.7 },
    gaze: { [gaze]: 0.55, none: 0.45 }, pupil: { [pupil]: 0.6, none: 0.4 }, move: { [move]: 0.6, none: 0.4 } };
}

export class ExpressivePreview {
  trigger: ExpressiveTrigger = 'gesture';
  gesture: string = 'wave';
  live = false;
  request = '—';
  response = '—';
  plan = '—';

  constructor(readonly layer: EmotionLayer, readonly bridge: ExpressiveDecisions | null) {}

  firePreset(i: number): void {
    const [title, plan] = EXPRESSIVE_PRESETS[i]!;
    const p = this.layer.engine.playExpressive(plan.copy());
    this.plan = p ? `${title}: brow ${p.brow} · gaze ${p.gaze} · move ${p.move ?? 'none'}` : `${title}: gated (nothing plays now)`;
  }

  features(): ExpressiveFeatures {
    const e = this.layer.engine.state;
    const hour = new Date().getHours();
    return makeExpressiveFeatures({ event: this.trigger, people: 1, distance: 'near', facing: true, eyeContact: true, presentSeconds: 20,
      mood: this.layer.snapshot.label, state: e.agentState,
      timeOfDay: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night', bedtime: e.isBedtime, recent: ['arrival'],
      ...(this.trigger === 'gesture' ? { gesture: this.gesture, confidence: 0.85 } : {}),
      ...(this.trigger === 'announcement' ? { priority: 'normal' } : {}) });
  }

  simulate(): void {
    const f = this.features(), n = normalizedFeatures(f);
    this.request = Object.entries({ event: n.event, gesture: n.gesture ?? '–', confidence: n.confidence ?? '–', people: n.people,
      distance: n.distance ?? '–', present_s: n.presentSeconds ?? '–', mood: n.mood, state: n.state, time_of_day: n.timeOfDay,
      bedtime: n.bedtime, recent: n.recent.join(',') }).map(([k, v]) => `${k}=${v}`).join(' · ');
    const key = this.trigger === 'gesture' ? `gesture:${this.gesture}` : this.trigger;
    if (!this.live) { this.show(fakeAnswers(f), key, null); return; }
    const ask = this.bridge?.ask;
    if (!ask) { this.response = 'no decision model (reflex only)'; return; }
    this.response = 'asking…';
    const start = performance.now();
    void ask(f, new AbortController().signal).then((r) => {
      const ms = Math.round(performance.now() - start);
      if (r.kind === 'answered') this.show(r.answers, key, ms);
      else this.response = r.kind === 'failed' ? `failed after ${ms} ms (reflex only)` : r.kind === 'breakerOpen' ? 'breaker open (reflex only)' : 'no decision model (reflex only)';
    });
  }

  private show(a: Record<string, Record<string, number>>, key: string, ms: number | null): void {
    const top = (q: string): string => {
      const best = Object.entries(a[q] ?? {}).sort((x, y) => y[1] - x[1])[0];
      return best ? `${best[0]} ${best[1].toFixed(2)}` : '–';
    };
    this.response = (ms === null ? 'fake · ' : `${ms} ms · `) + ['react', 'intensity', 'brow', 'gaze', 'pupil', 'move'].map((q) => `${q} ${top(q)}`).join(' · ');
    this.plan = this.layer.playExpressive(a, key)?.summary ?? 'below threshold (reflex only)';
  }
}

export function expressiveSection(xp: ExpressivePreview, b: Build): HTMLElement {
  const bridge = xp.bridge;
  return section('Expressive decisions',
    select('Trigger', expressiveTriggers.map((t) => [t, t] as const), () => xp.trigger, (v) => { xp.trigger = v; }),
    select('Gesture (gesture trigger)', GESTURES.map((g) => [g, g] as const), () => xp.gesture as (typeof GESTURES)[number], (v) => { xp.gesture = v; }),
    toggle(bridge ? 'Live Jev (else a fake)' : 'Live Jev (no bridge attached)', () => xp.live, (v) => { xp.live = v; }),
    buttons(['Simulate', () => xp.simulate()]),
    readout(b, () => `request: ${xp.request}\nresponse: ${xp.response}\nplan: ${xp.plan}`),
    buttons(...EXPRESSIVE_PRESETS.map(([t], i) => [t, () => xp.firePreset(i)] as [string, () => void])),
    bridge ? slider('Deadline', () => bridge.budget.deadline, (v) => { bridge.budget.deadline = Math.min(Math.max(v, 0.2), 3); }, [0.2, 3],
      (v) => `${(v * 1000).toFixed(0)} ms`) : null,
    bridge ? readout(b, () => Object.entries(bridge.counts).map(([k, v]) => `${k} ${v}`).join(' · '), 'pv-note') : h('span', {}));
}
