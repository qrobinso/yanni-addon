// Port of yanni/Preview/DevStatus.swift: the Status page's model. One card per subsystem, built only while the Status
// page is on screen (4 Hz; never per frame), each a plain value (title, status dot, rows) so the panel renders them
// generically and tests can read them. Never audio, transcripts, message text or credentials.
import type { V2, V3 } from '../core/vec';
import type { AppContext } from '../app/AppContext';
import { FaceAffect } from '../engine/FaceAffect';
import type { GazeIntent } from '../engine/FaceState';
import { FaceFrame } from '../model/FaceFrame';
import type { PupilShape } from '../model/PupilShape';
import { EyeGeometry } from '../render/EyeGeometry';
import { StatsTier } from '../render/FrameStats';
import { resolvedEyeColor } from '../render/MoodColorMix';
import { VoiceDirector } from '../voice/bridge/VoiceDirector';
import { HostClock } from '../voice/host/VoiceOutput';
import { availabilityLabel } from '../conversation/turn/TurnDetectionStatus';
import type { EventSource } from './EventLog';
import { shapeName } from './TuningModel';
import { perceptionKeepsCard as keepsCard } from './perception/PerceptionKeepsCard';

export type StatusLevel = 'running' | 'degraded' | 'notBuilt' | 'error';
export const StatusLevel = {
  label: (l: StatusLevel): string => (l === 'notBuilt' ? 'not built' : l),
} as const;

export type Tint = 'warn' | 'bad' | 'good' | 'accent';

export interface StatusRow {
  label: string;
  value: string;
  tint?: Tint;
  /** A mini bar: signed values fill from zero. */
  bar?: { value: number; min: number; max: number; color?: string };
}

export interface StatusCard {
  id: string;
  title: string;
  level: StatusLevel;
  /** The right-hand summary (defaults to the level's label). */
  detail: string;
  rows: StatusRow[];
  /** Colour swatches shown beside the rows (linear RGB). */
  swatches?: { label: string; color: V3 }[];
  note?: string;
}

/** The kiosk services as the Status page uses them (I3's KioskModel): its Health card, the diagnostics export and the
 *  burn-in refresh. Every member optional. */
export interface StatusKioskPort {
  healthCard?(): StatusCard | null;
  exportDiagnostics?(): unknown;
  burnInRefresh?(): unknown;
}

const f2 = (v: V2): string => `(${sg(v.x)}, ${sg(v.y)})`;
const sg = (v: number, d = 2): string => { const x = Math.abs(v) < 0.5 * 10 ** -d ? 0 : v; return `${x >= 0 ? '+' : ''}${x.toFixed(d)}`; };
const pad3 = (v: V3): string => `${sg(v.x)} ${sg(v.y)} ${sg(v.z)}`;
const hex = (c: V3): string => `#${((): string => {
  const g = (x: number): number => Math.round(255 * Math.min(Math.max(x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055, 0), 1));
  return ((g(c.x) << 16) | (g(c.y) << 8) | g(c.z)).toString(16).padStart(6, '0').toUpperCase();
})()}`;
const bar = (label: string, value: number, min = -1, max = 1, color?: string, fmt = (v: number) => sg(v)): StatusRow =>
  ({ label, value: fmt(value), bar: { value, min, max, color } });
/** Seconds as "42 s" or "3:05" (LifeModel.format). */
export const formatSeconds = (s: number): string => {
  const t = Math.ceil(s);
  return t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t} s`;
};

// shortcut: reads the renderer's private canvas for the drawable size; use an AppContext field once there is one.
const drawable = (ctx: AppContext): HTMLCanvasElement | undefined =>
  (ctx.renderer as unknown as { canvas?: HTMLCanvasElement }).canvas;

export function describeGaze(g: GazeIntent): string {
  switch (g.kind) {
    case 'idle': return 'idle';
    case 'track': return 'track';
    case 'thinking': return 'thinking';
    case 'rest': return `rest ${f2(g.at)}`;
    case 'lookAway': return 'look away';
  }
}

/** The face HUD's small snapshot (the HUD itself is the app's). */
export interface HudSnap { agent: string; phase: string; people: number; fps: number; lastEvent: string | null }

/** The Status page and HUD model (Swift DevStatusModel minus the event capture, which is `EventCollector`). */
export class DevStatusModel {
  private lastTicks: number;
  private lastWall: number;
  private lastTier: { delivered: number; seconds: number }[] = [{ delivered: 0, seconds: 0 }, { delivered: 0, seconds: 0 }, { delivered: 0, seconds: 0 }];
  fps = 0;

  constructor(readonly ctx: AppContext, readonly log: EventSource, readonly kiosk: StatusKioskPort | null = null,
    readonly wallNow: () => number = () => performance.now() / 1000) {
    this.lastTicks = ctx.clock.ticks;
    this.lastWall = wallNow();
  }

  /** Every card, in the Swift order (Health, Performance, Display, Face engine, Perception, Life, Voice, Touch,
   *  Voice services, Emotion, Decision model, Home Assistant). */
  poll(): StatusCard[] {
    const now = this.wallNow();
    const ticks = this.ctx.clock.ticks;
    this.fps = (ticks - this.lastTicks) / Math.max(now - this.lastWall, 1e-6);
    this.lastTicks = ticks;
    this.lastWall = now;
    const cards = [
      this.kiosk?.healthCard?.() ?? null,
      this.performanceCard(), this.displayCard(), engineCard(this.ctx), perceptionCard(this.ctx), perceptionKeepsCard(this.ctx), lifeCard(this.ctx),
      voiceCard(this.ctx), touchCard(this.ctx), voiceServicesCard(this.ctx), emotionCard(this.ctx), decisionCard(this.ctx),
      homeCard(this.ctx, this.log),
    ];
    return cards.filter((c): c is StatusCard => c !== null);
  }

  hud(): HudSnap {
    const s = this.ctx.engine.state;
    return { agent: s.agentState, phase: this.ctx.life.phase, people: s.people.length, fps: Math.round(this.fps),
      lastEvent: this.log.events()[0]?.text ?? null };
  }

  displayCard(): StatusCard {
    const { clock, renderer } = this.ctx;
    const out = this.ctx.engine.state.output;
    const tier = clock.policy.tier;
    const canvas = drawable(this.ctx);
    const w = canvas?.width ?? 0, hgt = canvas?.height ?? 0;
    const fps = this.fps;
    return {
      id: 'display', title: 'Display & renderer', level: fps > 1 ? (fps < 25 ? 'degraded' : 'running') : 'error',
      detail: `${fps.toFixed(0)} fps`, rows: [
        { label: 'fps', value: `${fps.toFixed(1)}  (target tier ${tier})` },
        { label: 'engine frame', value: `${(clock.lastTickSeconds * 1000).toFixed(3)} ms · ${clock.ticks} frames` },
        { label: 'drawable', value: w > 0 ? `${w} × ${hgt} px` : '—' },
        { label: 'orientation', value: hgt > w ? 'portrait' : 'landscape' },
        { label: 'refresh', value: out.isAsleep ? '30 Hz tier (asleep)' : `${tier} Hz tier · display ${clock.displayMaximumFramesPerSecond} Hz` },
        { label: 'renderer', value: `WebGPU · ${renderer.frames} drawn · ${renderer.deviceLosses} GPU losses`, tint: renderer.deviceLosses > 0 ? 'warn' : undefined },
      ],
    };
  }

  performanceCard(): StatusCard {
    const { clock } = this.ctx;
    const snap = clock.stats.snapshot();
    const current = StatsTier.from(clock.policy.tier);
    const rows: StatusRow[] = [];
    for (const t of StatsTier.allCases) {
      const s = snap.tier(t), last = this.lastTier[t]!;
      const dSec = s.seconds - last.seconds;
      const fps = dSec > 0.05 ? (s.delivered - last.delivered) / dSec : 0;
      this.lastTier[t] = { delivered: s.delivered, seconds: s.seconds };
      rows.push({ label: StatsTier.label(t) + (t === current ? ' ●' : ''), tint: s.meetsCriteria ? undefined : 'warn',
        value: `${fps.toFixed(1)} fps · delivered ${s.deliveredRatio.toFixed(3)} · p99 ${(s.gapP99 * 1000).toFixed(2)} ms · `
          + `hitches ${s.hitches} (${s.hitchMsPerSecond.toFixed(2)} ms/s) · skipped ${s.skipped}` });
      if (s.gpuSamples > 0 || s.mainP99 > 0) {
        rows.push({ label: '', value: `GPU ${(s.gpuMean * 1000).toFixed(2)} ms (${s.gpuSamples} samples) · main p99 ${(s.mainP99 * 1000).toFixed(2)} ms` });
      }
    }
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    rows.push({ label: 'render', value: `WebGPU${clock.isBackupRunning ? ' · backup clock driving' : ''}`
      + (clock.backupTakeovers > 0 ? ` · backup ×${clock.backupTakeovers}` : '') + (snap.gpuErrors > 0 ? ` · GPU errors ${snap.gpuErrors}` : '') });
    rows.push({ label: 'JS heap', value: mem ? `${(mem.usedJSHeapSize / 1_048_576).toFixed(1)} MB` : '— (not exposed by this browser)' });
    const level: StatusLevel = this.ctx.renderer.deviceLosses > 0 && !this.ctx.renderer.isReady ? 'error'
      : snap.meetsCriteria ? 'running' : 'degraded';
    return { id: 'performance', title: 'Performance', level, detail: `${StatsTier.label(current)} · webgpu`, rows };
  }
}

export function engineCard(ctx: AppContext): StatusCard {
  const e = ctx.engine, s = e.state, out = s.output;
  const mix = s.expressionOverride ?? s.targetMix;
  const sampler = e.director.modifier('OneShotSampler') as unknown as { activePupilShape: { kind: string; switchingBack: boolean } | null } | undefined;
  const active = sampler?.activePupilShape ?? null;
  const shapeL = FaceFrame.shape(out, 'left'), shapeR = FaceFrame.shape(out, 'right');
  const ml = FaceFrame.morph(out, 'left').toFixed(2), mr = FaceFrame.morph(out, 'right').toFixed(2);
  const pupil = active ? `${shapeName(shapeOf(active.kind))} (L ${ml} / R ${mr})${active.switchingBack ? ' · switching back' : ''}`
    : shapeL !== 0 || shapeR !== 0 ? `L ${shapeName(shapeL)} ${ml} / R ${shapeName(shapeR)} ${mr}` : '—';
  const style = ctx.style();
  let brows = 'off';
  if (style.browsEnabled) {
    const b = out.brows, o = out.browOffset;
    const side = (sd: 'left' | 'right'): string => `y${sg(b.lane(sd, 'y'))} ${sg(b.lane(sd, 'rotation'), 0)}° arch ${b.lane(sd, 'curvature').toFixed(2)}`;
    const led = (e.director.modifier('ExpressionTransition') as unknown as { lastChangeLedByBrows?: boolean } | undefined)?.lastChangeLedByBrows;
    brows = `presence ${out.browPresence.toFixed(2)} · L ${side('left')} · R ${side('right')} · follow ${o.y.toFixed(1)}/${o.w.toFixed(1)}${led ? ' · led' : ''}`;
  }
  const mc = e.director.modifier('MoodColor') as unknown as { expressionInfluence: number;
    background: { targetLab: V3; isFast(t: number): boolean } } | undefined;
  const effective = FaceAffect.effectivePAD(s, mc?.expressionInfluence ?? 0.5);
  const canvas = drawable(ctx);
  const bg = EyeGeometry.background(out, style, (canvas?.width ?? 4) / Math.max(canvas?.height ?? 3, 1));
  const burst = e.backgroundBurst;
  const m = s.modulation;
  const eyeColor = resolvedEyeColor(style, out);
  const rows: StatusRow[] = [
    { label: 'agent state', value: `${s.agentState} · ${Math.max(s.time - s.agentStateEnteredAt, 0).toFixed(1)} s` },
    { label: s.expressionOverride ? 'expr (override)' : 'expression',
      value: (mix.entries.filter((x) => x.weight > 0.001).map((x) => `${x.name} ${x.weight.toFixed(2)}`).join(', ') || '—') + ` · ×${mix.intensity.toFixed(2)}` },
    { label: 'one-shots', value: s.activeOneShots.length ? s.activeOneShots.join(', ') : 'none' },
    { label: 'pupil shape', value: pupil, tint: pupil === '—' ? undefined : 'accent' },
    { label: 'eyebrows', value: brows },
    { label: 'background', value: `${s.backgroundConfig.mode} · ${hex(bg)} · presence ${out.backgroundPresence.toFixed(2)} · strength ${out.backgroundStrength.toFixed(2)}${mc?.background.isFast(s.time) ? ' · fast' : ''}` },
    { label: 'colour burst', value: burst.kind ? `${burst.kind} · level ${burst.level.toFixed(2)}` : 'none' },
    bar('base P', s.baseMood.pleasure), bar('base A', s.baseMood.arousal), bar('base D', s.baseMood.dominance),
    { label: 'offset', value: pad3(s.moodOffset) },
    bar('effective P', effective.x, -1, 1, '#ff6fa8'), bar('effective A', effective.y, -1, 1, '#ff6fa8'), bar('effective D', effective.z, -1, 1, '#ff6fa8'),
    { label: 'speed · int.', value: `×${m.speed.toFixed(2)} · ×${m.intensity.toFixed(2)}` },
    { label: 'blink · lids', value: `×${m.blinkRate.toFixed(2)} · ${m.lidHeaviness.toFixed(2)} heavy` },
    { label: 'bounciness', value: m.bounciness.toFixed(2) },
    { label: 'gaze intent', value: describeGaze(s.gazeIntent) + (s.gazeTarget.contact ? ' · eye contact' : '') },
    { label: 'target', value: `${f2(s.gazeTarget.point)} · ${s.gazeTarget.mode}` },
    { label: 'eyes', value: f2(s.eyeGaze) }, { label: 'head', value: f2(s.headGaze) },
    { label: 'pupils', value: `L ×${s.pupilSizeMul.x.toFixed(2)}  R ×${s.pupilSizeMul.y.toFixed(2)}` },
    bar('brightness', out.brightness, 0, 1.2, '#f5d76e', (v) => v.toFixed(2)),
  ];
  if (e.timeScale !== 1) rows.push({ label: 'time scale', value: `×${e.timeScale.toFixed(2)}`, tint: 'warn' });
  return { id: 'face', title: 'Face engine', level: 'running', detail: s.agentState, rows,
    swatches: [{ label: 'Mood colour', color: eyeColor }, { label: 'Background', color: bg }] };
}

function shapeOf(kind: string): PupilShape {
  switch (kind) {
    case 'starEyes': return 1;
    case 'heartEyes': return 2;
    case 'noteEyes': return 3;
    case 'questionEyes': return 4;
    case 'exclaimEyes': return 5;
    default: return 0;
  }
}

export function perceptionCard(ctx: AppContext): StatusCard {
  const p = ctx.perception, s = ctx.engine.state;
  const rows: StatusRow[] = [];
  let level: StatusLevel = 'degraded', detail = 'simulated', note: string | undefined;
  if (p) {
    const st = p.stats(), snap = p.snapshot();
    const cam = st.camera as unknown as { kind?: string } | string;
    const camText = typeof cam === 'string' ? cam : cam.kind ?? 'unknown';
    level = camText === 'running' || camText === 'lowRate' ? 'running' : camText === 'denied' || camText === 'unavailable' ? 'error' : 'degraded';
    detail = camText;
    rows.push({ label: 'camera', value: `${camText} · tier ${st.tier} · ${st.delegate ?? '—'}${st.worker ? ' · worker' : ' · main thread'}` });
    rows.push({ label: 'rate', value: `${st.analysisFPS.toFixed(0)} fps analysed (${st.hz.toFixed(0)} Hz) · p90 ${st.p90Ms.toFixed(1)} ms` });
    rows.push({ label: 'frames', value: `${st.arrived} arrived · ${st.accepted} analysed · ${st.droppedBusy} dropped busy`
      + (st.noFramesFor !== null ? ` · no frames for ${st.noFramesFor} s` : ''), tint: st.noFramesFor !== null ? 'warn' : undefined });
    rows.push({ label: 'stages', value: Object.entries(st.stageMs).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' · ') || '—' });
    rows.push({ label: 'camera offset', value: f2(st.cameraOffset) + ' m' });
    rows.push({ label: 'sees', value: `${snap.people.length} ${snap.people.length === 1 ? 'person' : 'people'}` });
  } else {
    rows.push({ label: 'source', value: 'simulated (gaze pad)' });
    note = 'No camera: the gaze pad drives the people.';
  }
  rows.push({ label: 'camera mode', value: ctx.life.cameraMode === 'low' ? 'low rate (asleep)' : 'normal' });
  for (const q of s.people) {
    rows.push({ label: `#${q.id}${q.id === s.primaryPersonID ? ' ★' : ''}${q.id === s.engagedPersonID ? ' ●' : ''}`,
      value: `${f2(q.position)} · ${q.distance.toFixed(1)} m · sal ${q.salience.toFixed(2)}`, tint: q.id === s.engagedPersonID ? 'good' : undefined });
  }
  if (s.people.length === 0) rows.push({ label: 'people', value: 'Nobody in view.' });
  else note = '★ primary (eyes follow)   ● engaged (looking at Yanni)';
  return { id: 'perception', title: 'Perception', level, detail, rows, note };
}

export function lifeCard(ctx: AppContext): StatusCard {
  const l = ctx.life, s = ctx.engine.state;
  const next = l.nextTransition;
  const detail: string[] = [];
  if (l.isScheduledBedtime) detail.push(l.scheduleSuspended ? 'schedule suspended' : 'scheduled');
  if (l.settings.manualBedtime) detail.push('manual');
  if (l.isNightAwake) detail.push('night wake');
  if (l.isForceSleepActive) detail.push('forced');
  return {
    id: 'life', title: 'Life cycle', level: 'running', detail: l.phase, rows: [
      { label: 'phase', value: `${l.phase} · ${s.agentState}` },
      { label: 'reason', value: l.lastChange?.reason ?? '—' },
      { label: 'next', value: next ? (next.seconds !== null ? `${next.label} in ${formatSeconds(next.seconds)}` : next.label) : '—' },
      { label: 'bedtime', value: l.isBedtime ? 'on' + (detail.length ? ` (${detail.join(' · ')})` : '') : 'off' },
      { label: 'camera mode', value: l.cameraMode + (l.isPresent ? ' · someone present' : '') },
      bar('boredom', l.boredom, 0, 1, '#8c7cff', (v) => v.toFixed(2)),
      { label: 'time warp', value: l.timeWarp === 1 ? '×1' : `×${l.timeWarp.toFixed(0)}`, tint: l.timeWarp === 1 ? undefined : 'warn' },
    ],
  };
}

export function voiceCard(ctx: AppContext): StatusCard {
  const v = ctx.voice;
  if (!v) return { id: 'voice', title: 'Voice', level: 'notBuilt', detail: 'not attached', rows: [] };
  const o = v.output, vs = v.settings;
  const running = o?.isRunning ?? false;
  const host = HostClock.nowSeconds(), until = v.audibleUntilHostTime;
  const sounding = host < until - VoiceDirector.audibleTail;
  const flags: string[] = [];
  if (vs.muted || v.rendererMuted) flags.push('muted');
  if (vs.quietMode) flags.push('quiet');
  if (v.isBedtime) flags.push(`bedtime (${vs.bedtimeSounds})`);
  const sch = v.lastScheduled;
  const level: StatusLevel = !o || !running ? 'error' : flags.length ? 'degraded' : 'running';
  const rows: StatusRow[] = [
    { label: 'output', value: running ? `running · ${o!.sampleRate.toFixed(0)} Hz · ${(o!.outputLatency * 1000).toFixed(1)} ms latency`
      : o ? 'not running' : 'unavailable', tint: running ? undefined : 'bad' },
    { label: 'gates', value: flags.length ? flags.join(', ') : `open · volume ${vs.volume.toFixed(2)}`, tint: flags.length ? 'warn' : undefined },
    { label: 'auto-vocalize', value: vs.autoVocalize ? 'on' : 'off' },
    { label: 'last phrase', value: sch ? `${sch.phrase.reaction} · ${sch.phrase.notes.length} notes · ${(sch.phrase.duration * sch.timeStretch).toFixed(2)} s${sch.audible ? '' : ' · silent'}` : '—' },
    { label: 'sounding', value: sounding ? 'yes' : 'no' },
    { label: 'audible for', value: until > host ? `${(until - host).toFixed(1)} s (incl. tail)` : '—' },
  ];
  if (v.rejectedOneShotCount + v.retimedPhraseCount > 0) {
    rows.push({ label: 'glitches', value: `${v.rejectedOneShotCount} rejected one-shots · ${v.retimedPhraseCount} re-timed`, tint: 'warn' });
  }
  return { id: 'voice', title: 'Voice', level, detail: running ? (sounding ? 'sounding' : 'silent') : 'output stopped', rows };
}

export function touchCard(ctx: AppContext): StatusCard {
  const tr = ctx.engine.director.modifier('TouchReactions') as unknown as { annoyance: number; isSulking: boolean; tapCount: number;
    tapWakeCount: number; pendingWakeTaps: number; lastReaction: string | null } | undefined;
  if (!tr) return { id: 'touch', title: 'Touch', level: 'notBuilt', detail: 'not built', rows: [] };
  const a = tr.annoyance;
  return {
    id: 'touch', title: 'Touch', level: 'running', detail: tr.isSulking ? 'sulking' : 'running', rows: [
      bar('annoyance', a, 0, 4.5, a > 3 ? '#ff6b6b' : a > 1.5 ? '#ffb35c' : '#7be08f', (v) => v.toFixed(2)),
      { label: 'sulking', value: tr.isSulking ? 'yes (taps ignored)' : 'no', tint: tr.isSulking ? 'bad' : undefined },
      { label: 'taps', value: `${tr.tapCount} total · ${tr.tapWakeCount} woke · ${tr.pendingWakeTaps} pending` },
      { label: 'last reaction', value: tr.lastReaction ?? '—' },
    ],
  };
}

export function emotionCard(ctx: AppContext): StatusCard {
  const layer = ctx.emotion;
  if (!layer) return { id: 'emotion', title: 'Emotion', level: 'notBuilt', detail: 'not attached', rows: [] };
  const s = layer.snapshot;
  const label = s.weight > 0.005 ? s.label + (s.runnerUp ? ` + ${s.runnerUp}` : '') : '— (deadzone)';
  const mood = { x: s.baseline.x + s.mood.x, y: s.baseline.y + s.mood.y, z: s.baseline.z + s.mood.z };
  const li = s.lastImpulse;
  const rep = s.lastReport;
  return {
    id: 'emotion', title: 'Emotion', level: s.conditions.length === 0 && s.versionMismatches === 0 ? 'running' : 'degraded',
    detail: label, rows: [
      { label: 'label', value: `${label} · w ${s.weight.toFixed(2)} · authority ${s.authority.toFixed(2)}` },
      bar('felt P', s.felt.x, -1, 1, '#ff6fa8'), bar('felt A', s.felt.y, -1, 1, '#ff6fa8'), bar('felt D', s.felt.z, -1, 1, '#ff6fa8'),
      bar('mood P', mood.x, -1, 1, '#6c9cff'), bar('mood A', mood.y, -1, 1, '#6c9cff'), bar('mood D', mood.z, -1, 1, '#6c9cff'),
      { label: 'baseline', value: `${layer.personality} · ${pad3(s.baseline)}` },
      { label: 'mood label', value: s.moodLabel + (s.somber ? ' · somber' : '') },
      { label: 'boredom', value: `${s.boredom.toFixed(2)} (life)` },
      { label: 'conditions', value: s.conditions.length ? s.conditions.join(', ') : 'none', tint: s.conditions.length ? 'warn' : undefined },
      { label: 'last impulse', value: li ? `${li.label} (${li.source}) ${li.strength.toFixed(2)} · ${li.age.toFixed(0)} s ago` : '—' },
      { label: 'recent', value: [...layer.impulses].slice(-4).reverse().map((i) => `${i.label} ${i.strength.toFixed(2)}`).join(' · ') || '—' },
      { label: 'mood report', value: (rep ? `${rep.trigger} · ${rep.label}, ${rep.moodLabel}` : '—') + (s.reportsSent > 0 ? ` · ${s.reportsSent} sent` : '') },
    ],
  };
}

export function decisionCard(ctx: AppContext): StatusCard {
  const layer = ctx.emotion;
  if (!layer) return { id: 'decision', title: 'Decision model', level: 'notBuilt', detail: 'not attached', rows: [] };
  const s = layer.snapshot;
  const down = s.conditions.includes('decisionModelDown');
  return {
    id: 'decision', title: 'Decision model', level: down || s.versionMismatches > 0 ? 'degraded' : 'running',
    detail: down ? 'unavailable' : 'running', rows: [
      { label: 'last decision', value: s.lastDecision ?? '—' },
      { label: 'decisions', value: `${s.decisionsApplied} applied · ${s.decisionsDropped} dropped` },
      { label: 'expressive', value: layer.lastExpressive ?? '—' },
      { label: 'expressive applied', value: String(layer.expressiveApplied) },
      { label: 'versions', value: s.versionMismatches === 0 ? 'ok' : `${s.versionMismatches} mismatched (ignored)`, tint: s.versionMismatches ? 'warn' : undefined },
    ],
    note: 'Conversation decisions come from Pass A and Pass B; expressive ones from what Yanni sees (never what was sent).',
  };
}

/** Home Assistant through the add-on: the socket, the broker connection the add-on reports, and the recent HA events
 *  (commands in, settings and announcements; never message text or credentials). */
export function homeCard(ctx: AppContext, log: EventSource): StatusCard {
  const c = ctx.client;
  if (!c) return { id: 'home', title: 'Home Assistant', level: 'notBuilt', detail: 'not paired', rows: [] };
  const level: StatusLevel = c.connected ? (c.haConnected ? 'running' : 'degraded') : c.status === 'unpaired' ? 'error' : 'degraded';
  const recent = log.events().filter((e) => e.category === 'HA').slice(0, 10);
  const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });
  const rows: StatusRow[] = [
    { label: 'socket', value: `${c.status}${c.attempts > 0 && !c.connected ? ` · attempt ${c.attempts}` : ''}`, tint: c.connected ? undefined : 'warn' },
    { label: 'Home Assistant', value: c.haConnected ? 'connected (add-on)' : 'not connected', tint: c.haConnected ? undefined : 'warn' },
    { label: 'display', value: c.deviceId ?? '—' }, { label: 'room', value: c.room ?? '—' },
    { label: 'last in', value: recent[0] ? `${recent[0].text} · ${time(recent[0].at)}` : '—' },
  ];
  const q = ctx.announcements;
  if (q) {
    const now = Date.now();
    if (q.items.length === 0) rows.push({ label: 'queue', value: 'empty' });
    for (const a of q.items) {
      rows.push({ label: a.id, value: `${a.state}${a.priority === 'high' ? ' · high' : ''} · expires in ${formatSeconds(Math.max((a.expiresAt - now) / 1000, 0))}`
        + (a.state === 'delivering' && q.inFlight ? ` · batch ${q.inFlight.id}` : '') });
    }
    const r = q.lastResult;
    rows.push({ label: 'last outcome', value: r ? `${r.id} ${r.outcome}${r.reason ? ` (${r.reason})` : ''}` : '—' });
  }
  for (const e of recent.slice(1)) rows.push({ label: time(e.at), value: e.text });
  return { id: 'home', title: 'Home Assistant', level, detail: c.connected ? (c.haConnected ? 'connected' : 'HA down') : c.status, rows };
}

/** Voice services (direct Home Assistant design §13.3): session, conversation, mic, turn detection and the last turn's
 *  timings. Never transcripts or reply text. */
export function voiceServicesCard(ctx: AppContext): StatusCard {
  const c = ctx.conversation;
  if (!c) return { id: 'talk', title: 'Voice services', level: 'notBuilt', detail: 'not attached', rows: [] };
  const s = c.status;
  const t = s.turnDetection;
  const ms = (v: number | null): string => (v === null ? '–' : `${(v * 1000).toFixed(0)} ms`);
  const lt = s.lastTurn;
  let lastTurn = '–';
  if (lt) {
    const verdict = lt.reason?.kind === 'complete' ? `complete p ${lt.reason.probability.toFixed(2)}` : lt.reason ? 'fallback' : 'verdict';
    const parts = [`end of speech → ${verdict} ${ms(lt.verdict)}`, `turn-end sent ${ms(lt.turnEndSent)}`, `transcript ${ms(lt.turnEndedReceived)}`];
    if (lt.firstReplyMarker !== null) parts.push(`first audio ${ms(lt.firstReplyMarker)}`);
    if (lt.heard !== null) parts.push(`heard ${ms(lt.heard)}`);
    if (lt.replyAudioMs !== null) parts.push(`reply ${(lt.replyAudioMs / 1000).toFixed(1)} s`);
    lastTurn = parts.join(' · ');
  }
  const level: StatusLevel = s.session === 'dormant' ? 'notBuilt' : s.session === 'ready' ? 'running'
    : s.session === 'connecting' ? 'degraded' : s.servicesReachable === false ? 'error' : 'running';
  const session = [s.session, s.servicesReachable === null ? null : s.servicesReachable ? 'reachable' : 'unreachable',
    s.reconnectIn !== null ? `retry in ${s.reconnectIn.toFixed(1)} s` : null].filter(Boolean).join(' · ');
  const mic = ctx.conversationAudio.micOpen;
  return {
    id: 'talk', title: 'Voice services', level,
    detail: s.session === 'dormant' ? s.dormantReason ?? 'not set up' : s.session === 'disconnected'
      ? (s.servicesReachable === false ? 'unreachable' : 'idle (connects when someone’s here)') : s.session + (s.phase === 'idle' ? '' : ` · ${s.phase}`),
    rows: [
      ...healthRows(ctx),
      { label: 'Home Assistant', value: s.haVersion ?? '–' },
      { label: 'reply voice', value: s.replyVoice === 'yanni' ? 'Yanni (babble)' : s.replyVoice ?? '–' },
      { label: 'session', value: session },
      { label: 'conversation', value: s.phase + (s.turnId ? ` · turn ${s.turnId}` : '') },
      { label: 'mic', value: (s.micOpen ? 'open' : 'closed') + (mic ? ' · capture running' : '') },
      { label: 'turn detection', value: t ? [availabilityLabel(t.availability), t.computeUnits, `VAD p ${t.vadProbability.toFixed(2)}${t.echoActive ? ' (echo rule)' : ''}`, t.phase]
        .filter(Boolean).join(' · ') : '–' },
      { label: 'Smart Turn', value: t ? `last ${t.smartTurnLastMs === null ? '–' : t.smartTurnLastMs.toFixed(0) + ' ms'} · p50 ${t.smartTurnP50Ms === null ? '–' : t.smartTurnP50Ms.toFixed(0) + ' ms'} · ${t.smartTurnRuns} runs` : '–' },
      { label: 'self-trigger rejections', value: `${s.selfTriggerRejections} this session${t ? ` · ${t.selfTriggerRejections} since launch` : ''}` },
      { label: 'last turn', value: lastTurn },
      { label: 'decision', value: s.decisionModel ?? '–' },
      { label: 'last dismissal', value: s.lastDismissal ?? '–' },
    ],
  };
}

/** One row per integration (HA, speech recognition, speech voice, Jev) from the transport's health. */
function healthRows(ctx: AppContext): StatusRow[] {
  const h = ctx.transport?.health;
  if (!h) return [{ label: 'services', value: 'no transport' }];
  const warn = (st: string): Tint | undefined => (st === 'down' || st === 'preparing' ? 'warn' : undefined);
  const jev = [h.jev, h.jevRoundTripMs !== null ? `round trip ${h.jevRoundTripMs} ms` : null,
    h.jevLatencyMs !== null ? `latency_ms ${h.jevLatencyMs}` : null, h.breakerOpen ? 'breaker open' : 'breaker closed'].filter(Boolean).join(' · ');
  return [
    { label: 'HA (services)', value: [h.haVersion, h.homeAssistant].filter(Boolean).join(' · '), tint: warn(h.homeAssistant) },
    { label: 'agent', value: h.agentPath ? `${h.agentPath} path` : '–' },
    { label: 'speech recognition', value: [h.asrRoute, h.asr, h.asrDetail ?? h.asrProgram].filter(Boolean).join(' · '), tint: warn(h.asr) },
    { label: 'speech voice', value: [h.ttsRoute, h.tts, h.ttsProgram, h.pipelineName].filter(Boolean).join(' · '), tint: warn(h.tts) },
    { label: 'Jev', value: jev, tint: h.breakerOpen || h.jev === 'down' ? 'warn' : undefined },
  ];
}

/** "What perception keeps" (perception upgrade design §13, §5.3): numbers only, never pictures, video or sound. */
export const perceptionKeepsCard = (ctx: AppContext): StatusCard | null => keepsCard(ctx.harness);
