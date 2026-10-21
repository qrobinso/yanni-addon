// Port of yanni/Preview/TuningModel.swift (plus Showcase.swift's model half): the preview / tuning panel's state.
// Everything changes on user input only; per-frame engine output is never mirrored here, the read-outs are pulled by
// the panel's 4 Hz poller while visible. Persisted tunables (Home Assistant entity settings) go through the settings
// hub when one is attached, so the owner pages, Home Assistant and the panel never hold two copies; preview-only knobs
// go straight to the engine, the life cycle, the emotion layer or the voice.
import type { EntitySettings } from '@yanni/server/protocol';
import type { V2, V3 } from '../core/vec';
import type { AppContext } from '../app/AppContext';
import { Mood, type AgentState } from '../engine/AgentState';
import { FaceCommand, makePersonTarget, type OneShotKind, type PersonTarget } from '../engine/Commands';
import { isEdgeAntic, isIdleGame } from '../engine/OneShots';
import { makeReactionCue, type ReactionCueKind, type ReactionCueSource } from '../engine/PupilReactionTypes';
import type { NoticingBeat } from '../engine/modifiers/NoticingAttention';
import type { ThinkingBeat } from '../engine/modifiers/ThinkingBeats';
import { ExpressionLibrary } from '../model/Expression';
import { ExpressionMix, mixEntry } from '../model/ExpressionMix';
import { FaceFrame } from '../model/FaceFrame';
import { FacePose } from '../model/FacePose';
import { BrowPose } from '../model/BrowPose';
import { PupilShape } from '../model/PupilShape';
import { resolvedEyeColor } from '../render/MoodColorMix';
import { makeRenderStyle, RenderStyle } from '../render/RenderStyle';

/** The settings hub as the inspector needs it (I2's SettingsHub): the synced owner settings, and a write that
 *  persists, applies and syncs them. */
export interface TuningSettingsPort {
  get(): Partial<EntitySettings>;
  change(values: Partial<EntitySettings>): void;
}

/** A settings hub if `x` looks like one. */
export function settingsPort(x: unknown): TuningSettingsPort | null {
  const o = x as Partial<TuningSettingsPort> | null | undefined;
  return o && typeof o.get === 'function' && typeof o.change === 'function' ? o as TuningSettingsPort : null;
}

export type TuneSection = 'face' | 'look' | 'behaviour' | 'perception' | 'sound' | 'advanced';
export const TuneSection = {
  allCases: ['face', 'look', 'behaviour', 'perception', 'sound', 'advanced'] as readonly TuneSection[],
  title: (s: TuneSection): string => s[0]!.toUpperCase() + s.slice(1),
} as const;

/** The six reference brow expressions (inky-eyebrows-expressions.png) and the library expression each shows. */
export type BrowLook = 'neutral' | 'delighted' | 'curious' | 'surprised' | 'concerned' | 'mockAnnoyed';
export const BrowLook = {
  allCases: ['neutral', 'delighted', 'curious', 'surprised', 'concerned', 'mockAnnoyed'] as readonly BrowLook[],
  title: (b: BrowLook): string => (b === 'mockAnnoyed' ? 'Mock annoyed' : b[0]!.toUpperCase() + b.slice(1)),
  expression(b: BrowLook): string {
    switch (b) {
      case 'neutral': return 'Neutral';
      case 'delighted': return 'Happiness';
      case 'curious': return 'Curious';
      case 'surprised': return 'Surprise';
      case 'concerned': return 'Concerned';
      case 'mockAnnoyed': return 'MockAnnoyed';
    }
  },
} as const;

/** Showcase.swift: one tap puts the face into a representative look. */
export type ShowcaseLook = 'idle' | 'happy' | 'curious' | 'listening' | 'surprised' | 'yes' | 'no' | 'sleepy' | 'asleep';
export const ShowcaseLook = {
  allCases: ['idle', 'happy', 'curious', 'listening', 'surprised', 'yes', 'no', 'sleepy', 'asleep'] as readonly ShowcaseLook[],
} as const;

/** Short read-out name of a pupil shape (TuningModel.name). */
export function shapeName(s: PupilShape): string {
  switch (s) {
    case PupilShape.ellipse: return 'oval';
    case PupilShape.star: return 'stars';
    case PupilShape.heart: return 'hearts';
    case PupilShape.note: return 'notes';
    case PupilShape.question: return 'question';
    case PupilShape.exclaim: return 'exclaim';
    default: return `shape ${s}`;
  }
}

const sgn = (v: number, d = 2): string => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

interface Beatable<B> { play(b: B): void }
type Mod = Record<string, unknown> & { isEnabled: boolean; name: string };

export class TuningModel {
  static readonly virtualPersonID = 999;
  static readonly secondPerson: PersonTarget = makePersonTarget(998, { x: 0.65, y: 0.15 }, 1.5, 0.4);
  static readonly noticingSpot: V2 = { x: 0.3, y: 0.05 };
  static readonly sectionKey = 'yanni.tuneSection';

  readonly ctx: AppContext;
  readonly hub: TuningSettingsPort | null;

  // Expression override.
  exprA = 'Neutral';
  /** Empty: no second expression. */
  exprB = '';
  blend = 0.5;
  intensity = 1;
  overrideActive = false;

  // Gaze.
  gazePoint: V2 | null = null;
  simulateTwoPeople = false;
  /** The virtual person is present (the eyes follow them) but not looking at the face: not engaged. */
  passerBy = false;
  /** True while the camera drives the engine's people: the gaze pad leaves them alone. */
  peopleDrivenByPerception = false;

  // Mood, speech, time.
  mood: Mood = { ...Mood.playful };
  speechLevel = 0;
  elasticity = 1.3;
  showcaseLook: ShowcaseLook | null = null;
  showcaseCycling = false;

  // Brows.
  browLook: BrowLook | null = null;
  browBlendTo: BrowLook = 'delighted';
  browBlend = 0;
  browCycling = false;

  // Pupil cue simulator.
  cueKind: ReactionCueKind = 'delight';
  cueConfidence = 0.9;
  cueValence = 0.4;
  cueDirected = true;
  cueKey = '';
  cueSource: ReactionCueSource = 'debug';
  /** Seconds in the past the simulated cue belongs to (stale beyond `PupilReactions.freshness`). */
  cueAge = 0;
  sweepingGaze = false;

  // Thinking.
  thinkingHold = 5;

  // Library / parameter editor.
  library: ExpressionLibrary;
  private baseline: ExpressionLibrary;
  editingName = 'Neutral';

  // Noticing preview.
  noticingPresent = false;
  private noticingFacing = 0;
  private noticingDistance = 1.6;

  private timers = new Map<string, ReturnType<typeof setTimeout>[]>();

  constructor(ctx: AppContext, hub: TuningSettingsPort | null = null) {
    this.ctx = ctx;
    this.hub = hub;
    this.library = ctx.engine.state.library.copy();
    this.baseline = this.library.copy();
    this.mood = { ...ctx.engine.state.baseMood };
    this.elasticity = ctx.engine.state.elasticity;
    if (!this.library.get('Neutral')) {
      const first = this.library.names[0];
      if (first) { this.exprA = first; this.editingName = first; }
    }
  }

  get engine() { return this.ctx.engine; }

  /** The Tune page's remembered section. */
  static savedSection(): TuneSection {
    try {
      const s = localStorage.getItem(TuningModel.sectionKey) as TuneSection | null;
      return s && TuneSection.allCases.includes(s) ? s : 'face';
    } catch { return 'face'; }
  }
  static saveSection(s: TuneSection): void { try { localStorage.setItem(TuningModel.sectionKey, s); } catch { /* private mode */ } }

  /** Writes a persisted tunable: through the hub when attached (it persists, applies and syncs), else straight in. */
  persist(values: Partial<EntitySettings>, direct: () => void): void {
    if (this.hub) this.hub.change(values); else direct();
  }

  /** The hub's value of an entity setting, else `fallback` (the applied engine value). */
  entity<K extends keyof EntitySettings>(key: K, fallback: EntitySettings[K]): EntitySettings[K] {
    return (this.hub?.get()[key] ?? fallback) as EntitySettings[K];
  }

  modifier<T = Mod>(name: string): T | undefined { return this.engine.director.modifier(name) as unknown as T | undefined; }

  // MARK: Timers (scripted checks; never the frame loop)

  private schedule(key: string, steps: [number, () => void][]): void {
    this.cancel(key);
    this.timers.set(key, steps.map(([delay, f]) => setTimeout(f, Math.max(delay, 0.01) * 1000)));
  }
  private cancel(key: string): void {
    for (const t of this.timers.get(key) ?? []) { clearTimeout(t); clearInterval(t); }
    this.timers.delete(key);
  }
  /** Stops every scripted check and cycle (the inspector closed). */
  dispose(): void { for (const k of [...this.timers.keys()]) this.cancel(k); }

  // MARK: Expression

  applyOverride(): void {
    const entries = [mixEntry(this.exprA, this.exprB === '' ? 1 : 1 - this.blend)];
    if (this.exprB !== '') entries.push(mixEntry(this.exprB, this.blend));
    this.engine.setExpressionOverride(new ExpressionMix(entries, this.intensity));
    this.overrideActive = true;
  }

  clearOverride(): void {
    this.engine.setExpressionOverride(null);
    this.overrideActive = false;
  }

  // MARK: Agent state / one-shots

  setAgentState(s: AgentState): void { this.engine.setAgentState(s); }
  play(kind: OneShotKind): void { this.engine.send(FaceCommand.playOneShot(kind)); }
  simulateTap(at: V2): void { this.engine.send(FaceCommand.tap(at)); }
  blinkNow(): void { this.engine.send(FaceCommand.blink); }

  /** Touch › Tickle: two seconds of a lively rub near the face centre (a stroke every 150 ms). */
  simulateTickle(): void {
    this.schedule('tickle', Array.from({ length: 14 }, (_, i) =>
      [i * 0.15, () => this.engine.send(FaceCommand.scratch({ x: 0.15, y: 0.1 }, 0.8))] as [number, () => void]));
  }

  /** "Annoyance 1.2 · sulking" (TouchReactions' A against its sulk threshold). */
  touchReadout(): { annoyance: number; sulking: boolean } {
    const tr = this.modifier<{ annoyance: number; isSulking: boolean }>('TouchReactions');
    return { annoyance: tr?.annoyance ?? 0, sulking: tr?.isSulking ?? false };
  }

  // MARK: Gaze

  dragGaze(p: V2): void { this.gazePoint = { ...p }; this.pushPeople(); }
  releaseGaze(): void { this.gazePoint = null; this.pushPeople(); }

  /** Sends the current virtual people to the engine. */
  pushPeople(): void {
    if (this.peopleDrivenByPerception) return;
    const people: PersonTarget[] = [];
    const id = TuningModel.virtualPersonID;
    if (this.noticingPresent) {
      people.push(makePersonTarget(id, this.gazePoint ?? TuningModel.noticingSpot, this.noticingDistance, 1, this.noticingFacing));
    } else if (this.gazePoint) {
      people.push(makePersonTarget(id, this.gazePoint, 1.5, 1));
    }
    if (this.simulateTwoPeople) people.push(TuningModel.secondPerson);
    const primary = this.noticingPresent || this.gazePoint ? id : null;
    this.engine.setPeople(people, primary, this.passerBy || this.noticingPresent ? null : primary);
  }

  // Preview-only randomness (never engine logic).
  private static randomPoint(): V2 { return { x: Math.random() * 1.8 - 0.9, y: Math.random() * 1.4 - 0.7 }; }
  glanceAtRandomPoint(): void { this.engine.send(FaceCommand.glance(TuningModel.randomPoint(), 0.8)); }
  stimulusAtRandomPoint(): void { this.engine.send(FaceCommand.stimulus(TuningModel.randomPoint(), 0.8)); }

  // MARK: Mood / speech / modifiers / time

  /** The mood sliders are the emotion layer's baseline (the playful mood clears the override); without a layer they
   *  set the engine's mood. */
  pushMood(): void {
    const m = this.mood, layer = this.ctx.emotion;
    if (!layer) { this.engine.setMood(m); return; }
    const p = Mood.playful;
    layer.baselineOverride = m.pleasure === p.pleasure && m.arousal === p.arousal && m.dominance === p.dominance
      ? null : { x: m.pleasure, y: m.arousal, z: m.dominance };
  }
  pushSpeech(): void { this.engine.setSpeechLevel(this.speechLevel); }
  setElasticity(e: number): void { this.elasticity = e; this.engine.setElasticity(e); }

  get timeScale(): number { return this.engine.timeScale; }
  set timeScale(v: number) { this.engine.timeScale = Math.min(Math.max(v, 0.05), 1); }

  get modifierNames(): string[] { return this.engine.director.ordered.map((m) => m.name); }
  modifierEnabled(name: string): boolean { return this.engine.director.modifier(name)?.isEnabled ?? true; }
  setModifier(name: string, on: boolean): void { const m = this.engine.director.modifier(name); if (m) m.isEnabled = on; }

  // MARK: Style (the developer style; the owner's look fields stay the hub's)

  get style(): RenderStyle { return this.ctx.style(); }
  editStyle(f: (s: RenderStyle) => void): void {
    const s = RenderStyle.clone(this.ctx.style());
    f(s);
    this.ctx.setStyle(s);
  }
  /** Replaces the developer style (presets, reset), keeping the owner's brow and pupil-accent settings. */
  setStylePreset(p: RenderStyle): void {
    const s = RenderStyle.clone(p), cur = this.style;
    s.browsEnabled = cur.browsEnabled;
    s.browInk = cur.browInk;
    s.shapeMoodAccent = cur.shapeMoodAccent;
    s.backgroundVignette = cur.backgroundVignette;
    s.backgroundVignetteInner = cur.backgroundVignetteInner;
    this.ctx.setStyle(s);
  }
  resetStyle(): void { this.setStylePreset(makeRenderStyle()); }

  /** MoodColor's expression influence and lightness match (runtime only). */
  moodColor(): { expressionInfluence: number; lightnessMatch: number } | undefined { return this.modifier('MoodColor'); }

  /** The eye colour on screen (mood colour mixed by the style), linear RGB. */
  currentEyeColor(): V3 { return resolvedEyeColor(this.style, this.engine.state.output); }

  // MARK: Brows

  showBrowLook(look: BrowLook): void {
    this.browLook = look;
    this.browBlend = 0;
    this.exprA = BrowLook.expression(look);
    this.exprB = '';
    this.intensity = 1;
    this.applyOverride();
  }

  applyBrowBlend(): void {
    const from = this.browLook ?? 'neutral';
    this.exprA = BrowLook.expression(from);
    this.exprB = BrowLook.expression(this.browBlendTo) === this.exprA ? '' : BrowLook.expression(this.browBlendTo);
    this.blend = this.browBlend;
    this.intensity = 1;
    this.applyOverride();
  }

  resetBrowProportions(): void {
    const d = makeRenderStyle();
    this.editStyle((s) => {
      s.browLength = d.browLength; s.browThickness = d.browThickness; s.browGap = d.browGap; s.browMinGap = d.browMinGap;
      s.browThickestAt = d.browThickestAt; s.browInnerTip = d.browInnerTip; s.browOuterTip = d.browOuterTip;
    });
  }

  browStatus(): string {
    const out = this.engine.state.output;
    if (!this.style.browsEnabled) return 'off';
    const b = out.brows;
    const side = (s: 'left' | 'right'): string =>
      `y${sgn(b.lane(s, 'y'))} ${sgn(b.lane(s, 'rotation'), 0)}° arch ${b.lane(s, 'curvature').toFixed(2)}`;
    return `presence ${out.browPresence.toFixed(2)} · L ${side('left')} · R ${side('right')}`;
  }

  /** Blink storm: ten blinks in quick succession (the brows must stay put). */
  checkBlinkStorm(): void {
    this.schedule('check', Array.from({ length: 10 }, (_, i) => [i * 0.28, () => this.blinkNow()] as [number, () => void]));
  }

  /** Drowsy → asleep → wake: the brows relax, fade out with the closing lids and grow back with the opening eyes. */
  checkSleepCycle(): void {
    this.clearOverride();
    this.schedule('check', [
      [0.01, () => this.setAgentState('drowsy')], [3.5, () => this.setAgentState('asleep')],
      [8.5, () => this.setAgentState('waking')], [12, () => this.setAgentState('idle')],
    ]);
  }

  setBrowCycling(on: boolean, interval = 2.2): void {
    this.cancel('browCycle');
    this.browCycling = on;
    if (!on) return;
    this.showBrowLook(this.browLook ?? 'neutral');
    const all = BrowLook.allCases;
    this.timers.set('browCycle', [setInterval(() => {
      this.showBrowLook(all[(all.indexOf(this.browLook ?? 'mockAnnoyed') + 1) % all.length]!);
    }, interval * 1000)]);
  }

  // MARK: Showcase

  showcase(look: ShowcaseLook): void {
    const e = this.engine;
    this.showcaseLook = look;
    e.setListeningGlow(look === 'listening' ? 1 : 0);
    const mood = (p: number, a: number, d: number): void => { this.mood = { pleasure: p, arousal: a, dominance: d }; };
    switch (look) {
      case 'idle': e.setExpressionOverride(null); this.setAgentState('idle'); this.mood = { ...Mood.playful }; break;
      case 'happy':
        this.setAgentState('followUp'); mood(0.8, 0.5, 0.3);
        e.setExpressionOverride(ExpressionMix.single('Happiness', 0.9)); this.play('delightedSquint'); break;
      case 'curious': e.setExpressionOverride(null); this.setAgentState('noticing'); mood(0.3, 0.4, -0.1); this.play('curiousTilt'); break;
      case 'listening': e.setExpressionOverride(null); this.setAgentState('listening'); this.mood = { ...Mood.playful }; break;
      case 'surprised':
        this.setAgentState('noticing'); mood(0.2, 0.8, -0.1);
        e.setExpressionOverride(ExpressionMix.single('Surprise')); this.play('bigSurprise'); break;
      case 'yes': e.setExpressionOverride(null); this.setAgentState('speaking'); mood(0.7, 0.6, 0.3); this.play('nodYesBig'); break;
      case 'no': e.setExpressionOverride(null); this.setAgentState('speaking'); mood(0.1, 0.5, 0.4); this.play('shakeNoBig'); break;
      case 'sleepy': e.setExpressionOverride(null); mood(0, -0.7, 0); this.setAgentState('drowsy'); break;
      case 'asleep': e.setExpressionOverride(null); mood(0, -0.9, 0); this.setAgentState('asleep'); break;
    }
    this.overrideActive = e.state.expressionOverride !== null;
    this.pushMood();
  }

  setShowcaseCycling(on: boolean, interval = 4.5): void {
    this.cancel('showcase');
    this.showcaseCycling = on;
    if (!on) return;
    const all = ShowcaseLook.allCases;
    this.timers.set('showcase', [setInterval(() => {
      this.showcase(all[(all.indexOf(this.showcaseLook ?? 'asleep') + 1) % all.length]!);
    }, interval * 1000)]);
  }

  // MARK: Edge antics

  /** Plays an edge antic now (+1 right edge, −1 left, 0 random). The sleepy sink plays as it would while drowsy. */
  playEdge(kind: OneShotKind, side = 0): void {
    const st = this.engine.state.agentState;
    if (kind === 'sleepySink' && st !== 'drowsy' && st !== 'asleep') this.setAgentState('drowsy');
    this.engine.playEdgeAntic(kind, side);
  }

  /** Interrupt mid-antic as if someone engaged: a virtual person who looks at the face, then listening. */
  interruptEngage(): void { this.passerBy = false; this.dragGaze({ x: 0.15, y: -0.05 }); this.setAgentState('listening'); }
  interruptTap(): void { this.simulateTap({ x: 0, y: 0 }); }
  endInterrupt(): void { this.releaseGaze(); this.setAgentState('idle'); }

  edgeStatus(): string {
    const ea = this.modifier<{ lastAntic: OneShotKind | null; nextAnticAt: number | null; watchdogSeeks: number;
      watchdogReleases: number }>('EdgeAntics');
    if (!ea) return '';
    const s = this.engine.state, parts: string[] = [];
    const playing = s.activeOneShots.find(isEdgeAntic);
    if (playing) parts.push(`playing ${playing}`); else if (ea.lastAntic) parts.push(`last ${ea.lastAntic}`);
    if (ea.nextAnticAt !== null && ea.nextAnticAt !== undefined) parts.push(`next in ${Math.max(ea.nextAnticAt - s.time, 0).toFixed(0)} s`);
    if (s.edgeGeometry === null) parts.push('no screen geometry');
    if ((ea.watchdogSeeks ?? 0) + (ea.watchdogReleases ?? 0) > 0) parts.push(`watchdog ${ea.watchdogSeeks}/${ea.watchdogReleases}`);
    return parts.join(' · ');
  }

  // MARK: Idle games

  idleGameStatus(): string {
    const ig = this.modifier<{ lastGame: OneShotKind | null; nextGameAt: number | null }>('IdleGames');
    if (!ig) return '—';
    const s = this.engine.state, parts: string[] = [];
    const playing = s.activeOneShots.find(isIdleGame);
    if (playing) parts.push(`playing ${playing}`); else if (ig.lastGame) parts.push(`last ${ig.lastGame}`);
    if (ig.nextGameAt !== null) parts.push(`next in ${Math.max(ig.nextGameAt - s.time, 0).toFixed(0)} s`);
    if (s.noticingWatching) parts.push('watching (games wait)');
    return parts.length ? parts.join(' · ') : '—';
  }

  // MARK: Pupil reactions

  playPupil(kind: OneShotKind, leadEye?: number): void { this.engine.playPupilShape(kind, leadEye); }
  cancelPupil(): void { this.engine.cancelPupilShape(); }
  markSomber(): void { this.engine.markSomber(); }

  /** Sends the cue simulator's cue through the arbiter (an age > 0 back-dates it on the display-link clock). */
  sendCue(): void { this.engine.send(FaceCommand.reactionCue(simulatedCue(this, this.engine.state.presentationHostTime))); }

  /** Drives the virtual person round a circle for 3 s (the gaze moves while a transformation shows), then releases. */
  sweepGazeDuringTransform(): void {
    this.cancel('sweep');
    this.sweepingGaze = true;
    const start = performance.now();
    this.timers.set('sweep', [setInterval(() => {
      const t = (performance.now() - start) / 1000;
      if (t >= 3) { this.cancel('sweep'); this.sweepingGaze = false; this.releaseGaze(); return; }
      const a = (t / 3) * 2 * Math.PI;
      this.dragGaze({ x: 0.6 * Math.cos(a), y: 0.45 * Math.sin(a) });
    }, 1000 / 30)]);
  }
  checkGazeSweep(): void { this.sweepGazeDuringTransform(); }

  /** Interrupt a transformation as if someone engaged. */
  interruptPupilEngage(): void { this.passerBy = false; this.dragGaze({ x: 0.15, y: -0.05 }); this.setAgentState('engaged'); }
  interruptPupilStartle(): void { this.play('bigSurprise'); }

  pupilReadouts(): { eyes: string; active: string; watchdog: number; last: string; accepted: boolean; next: string; somber: string } {
    const s = this.engine.state, out = s.output;
    const eyes = `L ${shapeName(FaceFrame.shape(out, 'left'))} ${FaceFrame.morph(out, 'left').toFixed(2)} · `
      + `R ${shapeName(FaceFrame.shape(out, 'right'))} ${FaceFrame.morph(out, 'right').toFixed(2)}`;
    const sampler = this.modifier<{ activePupilShape: { kind: OneShotKind; switchingBack: boolean } | null;
      deferredPupilShape: OneShotKind | null; shapeWatchdogCount: number }>('OneShotSampler');
    const parts: string[] = [];
    const a = sampler?.activePupilShape;
    if (a) parts.push(a.kind + (a.switchingBack ? ' · switching back' : ''));
    if (sampler?.deferredPupilShape) parts.push(`deferred ${sampler.deferredPupilShape}`);
    const pr = this.modifier<{ lastDecision: { text: string; accepted: boolean } | null; somberUntil: number;
      nextAllowed(k: OneShotKind, st: unknown): number }>('PupilReactions');
    const st = this.engine.pupilReactionSettings;
    const next = pr ? PUPIL_KINDS.map(([k, title]) => `${title} ${Math.max(pr.nextAllowed(k, st) - s.time, 0).toFixed(0)} s`).join(' · ') : '';
    return {
      eyes, active: parts.length ? parts.join(' · ') : '—', watchdog: sampler?.shapeWatchdogCount ?? 0,
      last: pr?.lastDecision?.text ?? '', accepted: pr?.lastDecision?.accepted ?? false, next,
      somber: pr && pr.somberUntil > s.time ? `${(pr.somberUntil - s.time).toFixed(0)} s left` : '—',
    };
  }

  // MARK: Thinking

  /** Holds thinking for `thinkingHold` seconds, then the reply arrives (speaking, the "aha!" perk) and two seconds
   *  later the follow-up. */
  previewThinking(): void {
    this.setAgentState('thinking');
    const hold = this.thinkingHold;
    this.schedule('thinking', [
      [hold, () => { if (this.engine.state.agentState === 'thinking') this.setAgentState('speaking'); }],
      [hold + 2, () => { if (this.engine.state.agentState === 'speaking') this.setAgentState('followUp'); }],
    ]);
  }

  /** Plays one beat now, entering thinking first if needed. */
  playThinkingBeat(beat: ThinkingBeat): void {
    if (this.engine.state.agentState !== 'thinking') { this.cancel('thinking'); this.setAgentState('thinking'); }
    this.modifier<Beatable<ThinkingBeat>>('ThinkingBeats')?.play(beat);
  }

  // MARK: Noticing preview

  /** Someone steps into view (not facing Yanni, 1.6 m away) and Yanni notices them. */
  noticingArrive(): void {
    this.cancel('noticing');
    this.noticingPresent = true;
    this.noticingFacing = 0;
    this.noticingDistance = 1.6;
    this.pushPeople();
    this.setAgentState('noticing');
  }

  /** They turn to face Yanni for 3 s, then look away again. */
  noticingFace(): void {
    if (!this.noticingPresent) this.noticingArrive();
    this.noticingFacing = 0.9;
    this.pushPeople();
    this.schedule('noticing', [[3, () => { if (this.noticingPresent) { this.noticingFacing = 0; this.pushPeople(); } }]]);
  }

  /** A gesture, as perception reports one. */
  noticingWave(): void {
    if (!this.noticingPresent) this.noticingArrive();
    this.engine.send(FaceCommand.attend(TuningModel.virtualPersonID));
  }

  /** They walk from 1.6 m to 0.9 m over a second. */
  noticingCloser(): void {
    if (!this.noticingPresent) this.noticingArrive();
    this.noticingDistance = 1.6;
    this.schedule('noticing', Array.from({ length: 10 }, (_, i) => [0.1 * (i + 1), () => {
      if (!this.noticingPresent) return;
      this.noticingDistance = 1.6 - 0.07 * (i + 1);
      this.pushPeople();
    }] as [number, () => void]));
  }

  noticingLeave(): void { this.cancel('noticing'); this.noticingPresent = false; this.pushPeople(); }

  playNoticingBeat(beat: NoticingBeat): void {
    if (!this.noticingPresent) this.noticingArrive();
    this.modifier<Beatable<NoticingBeat>>('NoticingAttention')?.play(beat);
  }

  /** "watching · bored in 6.2 s · last snap facing · check-ins 3". */
  noticingReadout(): string {
    const na = this.modifier<{ interest: string; current: string | null; boredAt: number; lastSnap: string | null;
      checkInCount: number }>('NoticingAttention');
    if (!na) return 'no noticing attention';
    const parts = [na.interest];
    if (na.current) parts.push(na.current);
    if (na.interest === 'watching' && Number.isFinite(na.boredAt)) {
      parts.push(`bored in ${Math.max(na.boredAt - this.engine.state.time, 0).toFixed(1)} s`);
    }
    if (na.lastSnap) parts.push(`last snap ${na.lastSnap}`);
    parts.push(`check-ins ${na.checkInCount}`);
    return parts.join(' · ');
  }

  // MARK: Parameter editor (edits a copy of the library, pushed with setLibrary, shown as the override)

  value(i: number): number { return (this.library.get(this.editingName)?.pose ?? FacePose.defaults).raw[i]!; }

  setValue(i: number, v: number): void {
    const e = this.library.get(this.editingName);
    if (!e) return;
    const pose = e.pose.copy();
    pose.raw[i] = v;
    this.library.set({ ...e, pose });
    this.pushLibrary();
  }

  /** A brow lane of the expression being edited (its own brows, or the library Neutral's when it has none). */
  browValue(i: number): number { return this.library.brows(this.editingName).raw[i]!; }

  setBrowValue(i: number, v: number): void {
    const e = this.library.get(this.editingName);
    if (!e) return;
    const b: BrowPose = (e.brows ?? this.library.brows(this.editingName)).copy();
    b.raw[i] = v;
    this.library.set({ ...e, brows: b });
    this.pushLibrary();
  }

  private pushLibrary(): void {
    this.engine.setLibrary(this.library.copy());
    this.previewEditedExpression();
  }

  previewEditedExpression(): void {
    this.exprA = this.editingName;
    this.exprB = '';
    this.intensity = 1;
    this.applyOverride();
  }

  revertEditedExpression(): void {
    const e = this.baseline.get(this.editingName);
    if (!e) return;
    this.library.set(e);
    this.pushLibrary();
  }

  get isEditedExpressionDirty(): boolean {
    const a = this.library.get(this.editingName), b = this.baseline.get(this.editingName);
    return !a || !b ? a !== b : a.pose.toArray().join() !== b.pose.toArray().join()
      || (a.brows?.raw.join() ?? '') !== (b.brows?.raw.join() ?? '');
  }

  /** Takes a loaded library as the new baseline. */
  adopt(lib: ExpressionLibrary): void {
    this.library = lib.copy();
    this.baseline = lib.copy();
    this.engine.setLibrary(lib.copy());
    const names = lib.names;
    if (!names.includes(this.editingName)) this.editingName = names[0] ?? 'Neutral';
    if (!names.includes(this.exprA)) this.exprA = names[0] ?? 'Neutral';
    if (this.exprB !== '' && !names.includes(this.exprB)) this.exprB = '';
  }

  /** Marks the current library saved. */
  markSaved(): void { this.baseline = this.library.copy(); }
  libraryJSON(): string { return this.library.jsonText(); }
  useBundled(): void { this.adopt(ExpressionLibrary.bundled()); }
}

/** The five transformations, titled as in the panel. */
export const PUPIL_KINDS: readonly (readonly [OneShotKind, string])[] = [
  ['starEyes', 'Stars'], ['heartEyes', 'Hearts'], ['noteEyes', 'Notes'], ['questionEyes', 'Question'], ['exclaimEyes', 'Exclaim'],
];

/** The cue simulator's cue: `age` > 0 back-dates it against the frame's host time (none known yet: now). */
export function simulatedCue(m: Pick<TuningModel, 'cueKind' | 'cueConfidence' | 'cueSource' | 'cueDirected' | 'cueValence'
  | 'cueKey' | 'cueAge'>, presentationHostTime: number | null) {
  const host = m.cueAge > 0 && presentationHostTime !== null ? presentationHostTime - m.cueAge : null;
  return makeReactionCue(m.cueKind, m.cueConfidence, { source: m.cueSource, directedAtYanni: m.cueDirected,
    valence: m.cueValence, hostTime: host, key: m.cueKey });
}
