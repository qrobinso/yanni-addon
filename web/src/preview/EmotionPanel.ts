// Port of yanni/Preview/EmotionPanel.swift: read-outs and the pleasure × arousal plot (4 Hz while visible), impulse
// and nudge triggers, the conversation simulator (scripted turns through the real layer), the preview clock (freeze,
// slow motion, mood time warp) and the emotion tuning (developer-only, straight into the layer; the personality is an
// owner setting, through the hub when attached).
import type { EntitySettings } from '@yanni/server/protocol';
import type { V3 } from '../core/vec';
import type { AgentState } from '../engine/AgentState';
import { ConversationSimulator, type SimScenario } from '../emotion/ConversationSimulator';
import type { EmotionLayer } from '../emotion/EmotionLayer';
import { EmotionSettings, PersonalityPreset } from '../emotion/EmotionSettings';
import { EmotionImpulse, NudgeLook, makeNudge, type ImpulseSource } from '../emotion/EmotionTypes';
import { HostClock } from '../voice/host/VoiceOutput';
import type { TuningModel } from './TuningModel';
import { button, buttons, caption, group, h, note, readout, section, select, slider, toggle, type Build } from './ui';

export const PRESETS: readonly (readonly [string, V3, number, ImpulseSource, string])[] = [
  ['Wave', { x: 0.7, y: 0.7, z: 0.3 }, 0.6, 'perception', 'wave'],
  ['Thumbs up', { x: 0.7, y: 0.5, z: 0.4 }, 0.5, 'perception', 'thumbs up'],
  ['Open palm', { x: 0.5, y: 0.4, z: 0.1 }, 0.3, 'perception', 'open palm'],
  ['Delight', { x: 0.8, y: 0.9, z: 0.4 }, 0.8, 'debug', 'delight'],
  ['Warmth', { x: 0.5, y: 0.2, z: 0.2 }, 0.6, 'debug', 'warmth'],
  ['Surprise', { x: 0.2, y: 0.8, z: -0.1 }, 0.8, 'debug', 'surprise'],
  ['Sad', { x: -0.6, y: -0.4, z: -0.4 }, 0.7, 'debug', 'sad'],
  ['Embarrassed', { x: -0.3, y: 0.3, z: -0.5 }, 0.7, 'debug', 'embarrassed'],
  ['Annoyed', { x: -0.4, y: 0.3, z: 0.3 }, 0.7, 'debug', 'annoyed'],
  ['Bored', { x: -0.2, y: -0.6, z: 0 }, 0.7, 'debug', 'bored'],
];

const p3 = (v: V3): string => `P ${v.x >= 0 ? '+' : ''}${v.x.toFixed(2)}  A ${v.y >= 0 ? '+' : ''}${v.y.toFixed(2)}  D ${v.z >= 0 ? '+' : ''}${v.z.toFixed(2)}`;

const previews = new WeakMap<EmotionLayer, EmotionPreview>();

/** The section's runtime state: the simulator and its log, the custom impulse, the nudge. Like the Swift app's
 *  EmotionModel it lives as long as the layer (`EmotionPreview.for`), so a scenario keeps running, ticked by the frame
 *  clock's after-frame hook, in the kiosk as in tuning.html, after the Tuning page closes. */
export class EmotionPreview {
  readonly simulator: ConversationSimulator;
  readonly simLog: string[] = [];
  custom: V3 = { x: 0.6, y: 0.5, z: 0.2 };
  customStrength = 0.6;
  nudgeFeeling = 'Curious';
  nudgeStrength = 0.5;
  nudgeLook: NudgeLook | null = null;
  private lastHost: number | null = null;

  /** The layer's one preview (made on first use, its frame hook added once); `m` is the Tuning page now open. */
  static for(m: TuningModel, layer: EmotionLayer): EmotionPreview {
    let ep = previews.get(layer);
    if (!ep) { ep = new EmotionPreview(m, layer); previews.set(layer, ep); } else ep.m = m;
    return ep;
  }

  constructor(public m: TuningModel, readonly layer: EmotionLayer) {
    this.simulator = new ConversationSimulator(layer);
    this.simulator.onLog = (line) => {
      this.simLog.unshift(`${layer.realTime.toFixed(1).padStart(5)}  ${line}`);
      this.simLog.length = Math.min(this.simLog.length, 14);
    };
    m.ctx.clock.addAfterFrame((t) => this.tick(t));
  }

  /** Per frame (EmotionModel.tick): runs the scripted conversation's due steps. No work when idle. */
  tick(hostTime: number): void {
    this.lastHost = hostTime;
    if (this.simulator.running !== null) this.simulator.tick(hostTime);
  }

  /** Runs a scenario. Without a conversation controller the layer's gate hand-offs set the state, as the app's
   *  stand-in does (in the kiosk the controller's sink hands them to the face while no conversation runs). */
  simulate(s: SimScenario): void {
    this.simLog.length = 0;
    this.simulator.start(s, this.lastHost ?? HostClock.nowSeconds());
    if (!this.m.ctx.conversation) {
      this.layer.onGate = (g) => this.layer.engine.setAgentState(g.kind === 'notForMe' ? 'notForMe' : 'confused');
    }
  }

  stop(): void { this.simulator.stop(); }

  tune(f: (s: EmotionSettings) => void): void {
    const s = this.layer.settings.copy();
    f(s);
    this.layer.settings = s;
  }
}

export function emotionSection(ep: EmotionPreview, b: Build): HTMLElement {
  const { m, layer } = ep;
  const plot = h('canvas', { class: 'pv-plot', width: 340, height: 190 });
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', 'Pleasure and arousal plot');
  b.poll.add(() => drawPlot(plot, layer));
  const tune = <K extends 'dynamics' | 'classifier' | 'mapper'>(label: string, part: K, key: keyof EmotionSettings[K] & string,
    range: readonly [number, number], d = 2) => slider(label,
    () => (layer.settings[part] as unknown as Record<string, number>)[key]!,
    (v) => ep.tune((s) => { (s[part] as unknown as Record<string, number>)[key] = v; }), range, (v) => v.toFixed(d));
  const AUTH: readonly AgentState[] = ['idle', 'noticing', 'listening', 'thinking', 'speaking', 'followUp', 'engaged'];
  return section('Emotion',
    select('Personality', PersonalityPreset.allCases.map((p) => [p, PersonalityPreset.title(p)] as const), () => layer.personality,
      (v) => m.persist({ personality: v } as Partial<EntitySettings>, () => { layer.personality = v; })),
    readout(b, () => {
      const s = layer.snapshot;
      const mood = { x: s.baseline.x + s.mood.x, y: s.baseline.y + s.mood.y, z: s.baseline.z + s.mood.z };
      return `${s.label}${s.runnerUp ? ` + ${s.runnerUp}` : ''}${s.challenger ? `  → ${s.challenger}?` : ''}`
        + `   w ${s.weight.toFixed(2)} · ×${s.intensity.toFixed(2)} · auth ${s.authority.toFixed(2)}\n`
        + `felt      ${p3(s.felt)}\nmood      ${p3(mood)}\nbaseline  ${p3(s.baseline)}\n`
        + `mood “${s.moodLabel}” · boredom ${s.boredom.toFixed(2)}${s.somber ? ' · somber' : ''}${s.conditions.length ? ' · ' + s.conditions.join(', ') : ''}`;
    }),
    plot,
    buttons(['Reset to baseline', () => layer.resetToBaseline()]),
    toggle('Freeze', () => layer.isFrozen, (v) => { layer.isFrozen = v; }),
    slider('Time scale', () => layer.timeScale, (v) => { layer.timeScale = v; }, [0.1, 10], (v) => `${v.toFixed(1)}×`),
    slider('Mood time warp', () => layer.moodTimeWarp, (v) => { layer.moodTimeWarp = v; }, [1, 120], (v) => `${v.toFixed(0)}×`, 1),
    toggle('Voice services unreachable', () => layer.isActive('voiceServicesUnreachable'), (v) => layer.setCondition('voiceServicesUnreachable', v)),
    toggle('Decision model down', () => layer.isActive('decisionModelDown'), (v) => layer.setCondition('decisionModelDown', v)),
    group('Impulses',
      buttons(...PRESETS.map(([t, pad, k, src, label]) => [t, () => layer.apply({ kind: 'impulse', impulse: EmotionImpulse.toward(pad, k, src, label) })] as [string, () => void])),
      caption('States (the layer reacts to the transition)'),
      buttons(...(['engaged', 'interrupted', 'notForMe', 'confused', 'sheepish', 'hasMessage', 'idle'] as const)
        .map((s) => [s, () => m.setAgentState(s)] as [string, () => void])),
      caption('Custom impulse'),
      slider('Pleasure', () => ep.custom.x, (v) => { ep.custom.x = v; }, [-1, 1]),
      slider('Arousal', () => ep.custom.y, (v) => { ep.custom.y = v; }, [-1, 1]),
      slider('Dominance', () => ep.custom.z, (v) => { ep.custom.z = v; }, [-1, 1]),
      slider('Strength', () => ep.customStrength, (v) => { ep.customStrength = v; }, [0, 1]),
      button('Fire custom impulse', () => layer.apply({ kind: 'impulse', impulse: EmotionImpulse.toward({ ...ep.custom }, ep.customStrength, 'debug', 'custom') })),
      readout(b, () => [...layer.impulses].reverse().map((i) =>
        `${i.label} · ${i.source} · ${i.strength.toFixed(2)} · ${Math.max(layer.layerTime - i.at, 0).toFixed(1)} s ago`).join('\n'))),
    group('Conversation simulator',
      note('Scripted turns through the real layer, face and chirps (the voice loop’s API with a fake source).'),
      buttons(...ConversationSimulator.scenarios.map((s) => [ConversationSimulator.title(s), () => ep.simulate(s)] as [string, () => void]),
        ['Stop', () => ep.stop()]),
      readout(b, () => {
        const s = layer.snapshot;
        return `${ep.simulator.running ? `running ${ConversationSimulator.title(ep.simulator.running)}\n` : ''}`
          + `${s.lastDecision ? `last decision: ${s.lastDecision}\n` : ''}decisions ${s.decisionsApplied} applied · ${s.decisionsDropped} dropped\n`
          + ep.simLog.join('\n');
      }),
      buttons(['Send mood report', () => layer.sendMoodReportNow()]),
      readout(b, () => { const r = layer.snapshot.lastReport; return r ? `${r.trigger}: ${r.label}, ${r.moodLabel}` : ''; }, 'pv-note')),
    group('Home Assistant nudge',
      select('Feeling', m.engine.state.library.names.map((n) => [n, n] as const), () => ep.nudgeFeeling, (v) => { ep.nudgeFeeling = v; }),
      slider('Strength (≤ 0.5 applies)', () => ep.nudgeStrength, (v) => { ep.nudgeStrength = v; }, [0, 1]),
      select('Look', [['', '—'], ...NudgeLook.allCases.map((l) => [l, l] as const)] as const, () => ep.nudgeLook ?? '',
        (v) => { ep.nudgeLook = v === '' ? null : v as NudgeLook; }),
      button('Send nudge', () => layer.apply({ kind: 'nudge', nudge: makeNudge(ep.nudgeFeeling, ep.nudgeStrength, ep.nudgeLook) }))),
    group('Watch mood decay',
      note('Sets the slow mood; raise the mood time warp to watch minutes of decay in seconds.'),
      buttons(['Cheerful', () => layer.setSlowMood({ x: 0.4, y: 0.2, z: 0.15 })], ['Excited', () => layer.setSlowMood({ x: 0.35, y: 0.45, z: 0.15 })],
        ['Down', () => layer.setSlowMood({ x: -0.3, y: -0.15, z: -0.1 })], ['Clear', () => layer.setSlowMood({ x: 0, y: 0, z: 0 })])),
    group('Tuning',
      caption('Dynamics'),
      tune('Emotion decay (s)', 'dynamics', 'emotionDecaySeconds', [1, 12], 1),
      tune('Attack (s)', 'dynamics', 'attackSeconds', [0.02, 0.3]),
      tune('Impulse gain', 'dynamics', 'impulseGain', [0, 1.5]),
      tune('Mood gain (/s)', 'dynamics', 'moodGain', [0, 0.2], 3),
      tune('Mood τ⁺ (s)', 'dynamics', 'moodTauPositive', [30, 3600], 0),
      tune('Mood τ⁻ (s)', 'dynamics', 'moodTauNegative', [30, 3600], 0),
      tune('Mood cap', 'dynamics', 'moodCap', [0.1, 0.9]),
      caption('Classifier'),
      tune('Deadzone', 'classifier', 'deadzone', [0, 0.6]),
      tune('Deviation gain', 'classifier', 'deviationGain', [1, 4]),
      tune('Mood share', 'classifier', 'moodShare', [0, 1]),
      tune('Dwell (s)', 'classifier', 'dwell', [0, 3]),
      caption('Decisions'),
      tune('Strength gain', 'mapper', 'strengthGain', [0, 3]),
      tune('Cue threshold', 'mapper', 'cueThreshold', [0.3, 1]),
      tune('Hint cooldown (s)', 'mapper', 'hintCooldown', [0, 120], 0),
      caption('Authority'),
      ...AUTH.map((s) => slider(s, () => layer.settings.authority.get(s), (v) => ep.tune((x) => { x.authority.set(s, v); }), [0, 1])),
      button('Reset emotion tuning', () => { layer.settings = new EmotionSettings(); b.rebuild(); })));
}

/** Pleasure × arousal: felt (filled, size = dominance), the mood point, the baseline, and the allow-listed anchors. */
function drawPlot(c: HTMLCanvasElement, layer: EmotionLayer): void {
  const g = c.getContext('2d');
  if (!g) return;
  const w = c.width, hh = c.height, s = layer.snapshot;
  const pt = (v: V3): [number, number] => [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * hh];
  g.clearRect(0, 0, w, hh);
  g.strokeStyle = 'rgba(139,147,161,.35)';
  g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, hh); g.moveTo(0, hh / 2); g.lineTo(w, hh / 2); g.stroke();
  g.font = '9px system-ui';
  g.textAlign = 'center';
  const lib = layer.engine.state.library;
  for (const name of layer.settings.classifier.allowList) {
    const pad = lib.get(name)?.pad;
    if (!pad) continue;
    const [x, y] = pt({ x: pad.p, y: pad.a, z: pad.d });
    const on = name === s.label && s.weight > 0;
    g.fillStyle = on ? '#ff9f0a' : 'rgba(139,147,161,.7)';
    g.beginPath(); g.arc(x, y, 2.5, 0, 7); g.fill();
    g.fillText(name, x, y - 5);
  }
  const [bx, by] = pt(s.baseline);
  g.strokeStyle = '#8b93a1'; g.beginPath(); g.arc(bx, by, 5, 0, 7); g.stroke();
  const [mx, my] = pt({ x: s.baseline.x + s.mood.x, y: s.baseline.y + s.mood.y, z: 0 });
  g.fillStyle = 'rgba(108,156,255,.75)'; g.beginPath(); g.arc(mx, my, 4, 0, 7); g.fill();
  const [fx, fy] = pt(s.effective);
  g.fillStyle = '#ff6fa8'; g.beginPath(); g.arc(fx, fy, 5 + (4 * (s.felt.z + 1)) / 2, 0, 7); g.fill();
  g.fillStyle = '#8b93a1'; g.fillText('P →', w - 14, hh / 2 + 10); g.fillText('A ↑', w / 2 + 14, 10);
}
