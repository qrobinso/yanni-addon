// Port of yanni/Preview/TuningPanel.swift: the Tune page. A live fps read-out pinned above a section picker (Face,
// Look, Behaviour, Perception, Sound, Advanced); only the chosen section is built, so editing re-lays out only the
// controls on screen and never costs the face frames. Also the page's own sections: expression, agent state,
// one-shots, gaze pad, touch, baseline mood & speech, captions, modifiers and slow time, style, and the expression
// library file.
import type { V2 } from '../core/vec';
import { AgentState, Mood } from '../engine/AgentState';
import { OneShotKind } from '../engine/Commands';
import { answerTitle, isAnswer } from '../engine/OneShots';
import { TouchReactions } from '../engine/modifiers/TouchReactions';
import { ExpressionLibrary } from '../model/Expression';
import { RenderStyle } from '../render/RenderStyle';
import { BackgroundPreview, backgroundSection } from './BackgroundPanel';
import { browSection } from './BrowPanel';
import { edgeAnticSection } from './EdgeAnticPanel';
import { EmotionPreview, emotionSection } from './EmotionPanel';
import { ExpressivePreview, expressiveSection } from './ExpressivePanel';
import { idleGameSection } from './IdleGamePanel';
import { lifeSection } from './LifePanel';
import { ListeningPreview, listeningSection } from './ListeningPanel';
import { noticingSection } from './NoticingPanel';
import { parameterEditorSection } from './ParameterEditor';
import { PerceptionPreview, perceptionSection } from './PerceptionPanel';
import { perfReadout } from './PerfOverlay';
import { pupilReactionSection } from './PupilReactionPanel';
import { ReplyBabblePreview, replyBabbleSection } from './ReplyBabblePanel';
import { showcaseSection } from './ShowcasePanel';
import { SoundPreview, soundSections } from './SoundPanel';
import { thinkingSection } from './ThinkingPanel';
import { TuneSection, TuningModel } from './TuningModel';
import { button, buttons, color, h, hexText, note, Poller, readout, section, select, slider, swatch, toggle, type Build } from './ui';

export class TunePage {
  readonly el: HTMLElement;
  readonly poll = new Poller();
  private readonly body = h('div', { class: 'pv-body' });
  private readonly pinnedPoll = new Poller();
  private disposers: (() => void)[] = [];
  private section: TuneSection = TuningModel.savedSection();
  // Section models live across rebuilds (their state is the panel's, not the engine's).
  private readonly background: BackgroundPreview;
  private readonly emotion: EmotionPreview | null;
  private readonly expressive: ExpressivePreview | null;
  private readonly sound: SoundPreview | null;
  private readonly reply: ReplyBabblePreview | null;
  private readonly listening: ListeningPreview;
  private readonly perception: PerceptionPreview;

  constructor(readonly m: TuningModel) {
    const ctx = m.ctx;
    this.background = new BackgroundPreview(m, (mood) => { m.mood = mood; });
    this.emotion = ctx.emotion ? new EmotionPreview(m, ctx.emotion) : null;
    this.expressive = ctx.emotion ? new ExpressivePreview(ctx.emotion, ctx.expressive ?? null) : null;
    this.sound = ctx.voice ? new SoundPreview(m, ctx.voice) : null;
    this.reply = ctx.voice ? new ReplyBabblePreview(ctx.voice) : null;
    this.listening = new ListeningPreview(ctx);
    this.perception = new PerceptionPreview(m);
    const pinnedBuild: Build = { poll: this.pinnedPoll, rebuild: () => {}, onDispose: () => {} };
    const picker = select('Section', TuneSection.allCases.map((s) => [s, TuneSection.title(s)] as const), () => this.section,
      (v) => { this.section = v; TuningModel.saveSection(v); this.render(); });
    this.el = h('div', { class: 'pv-tune' },
      h('div', { class: 'pv-pinned' }, perfReadout(ctx.clock, pinnedBuild), picker), this.body);
    this.el.style.display = 'contents';
    this.render();
  }

  start(): void { this.poll.start(); this.pinnedPoll.start(); }
  stop(): void { this.poll.stop(); this.pinnedPoll.stop(); }

  dispose(): void {
    this.stop();
    for (const d of this.disposers) d();
    this.disposers = [];
    this.background.stopCycling();
    this.emotion?.stop();
    this.m.dispose();
  }

  /** Rebuilds the visible section (section switch, a reset). */
  render(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.poll.reset();
    const scroll = this.body.scrollTop;
    const b: Build = { poll: this.poll, rebuild: () => this.render(), onDispose: (f) => this.disposers.push(f) };
    this.body.replaceChildren(...this.build(this.section, b));
    this.body.scrollTop = scroll;
    if (this.poll.running) this.poll.tick();
  }

  private build(s: TuneSection, b: Build): HTMLElement[] {
    const m = this.m;
    switch (s) {
      case 'face':
        return [showcaseSection(m), expressionSection(m, b), agentStateSection(m, b), oneShotSection(m), gazeSection(m, b), touchSection(m, b)];
      case 'look':
        return [styleSection(m, b), browSection(m, b), ...backgroundSection(this.background, b), moodSection(m),
          section('Captions', this.m.ctx.captions ? button('Preview captions', () => this.m.ctx.captions!.playPreview())
            : note('No caption overlay attached.'))];
      case 'behaviour':
        return [lifeSection(m, b), thinkingSection(m), noticingSection(m, b), edgeAnticSection(m, b), idleGameSection(m, b),
          pupilReactionSection(m, b),
          this.emotion ? emotionSection(this.emotion, b) : section('Emotion', note('No emotion layer attached.')),
          ...(this.expressive ? [expressiveSection(this.expressive, b)] : [])];
      case 'perception':
        return [perceptionSection(this.perception, b)];
      case 'sound':
        return [...(this.sound ? soundSections(this.sound, b) : [section('Sound', note('No voice attached.'))]),
          ...(this.reply ? [replyBabbleSection(this.reply, b)] : []), listeningSection(this.listening, b)];
      case 'advanced':
        return [modifierSection(m), parameterEditorSection(m, b), fileSection(m, b)];
    }
  }
}

// MARK: - (a) Expression

function expressionSection(m: TuningModel, b: Build): HTMLElement {
  const names = m.library.names.map((n) => [n, n] as const);
  return section('Expression',
    select('A', names, () => m.exprA, (v) => { m.exprA = v; m.applyOverride(); }),
    select('B', [['', 'None'] as const, ...names], () => m.exprB, (v) => { m.exprB = v; m.applyOverride(); }),
    slider('Blend A → B', () => m.blend, (v) => { m.blend = v; if (m.exprB) m.applyOverride(); }, [0, 1]),
    slider('Intensity', () => m.intensity, (v) => { m.intensity = v; m.applyOverride(); }, [0, 1.5]),
    buttons(['Apply', () => m.applyOverride()], ['Clear override', () => m.clearOverride()]),
    readout(b, () => (m.overrideActive ? 'override on' : 'agent state drives'), 'pv-note'));
}

// MARK: - (b) Agent state

function agentStateSection(m: TuningModel, b: Build): HTMLElement {
  const grid = buttons(...AgentState.allCases.map((s) => [s, () => m.setAgentState(s)] as [string, () => void]));
  const btns = [...grid.querySelectorAll('button')];
  b.poll.add(() => btns.forEach((x, i) => x.classList.toggle('on', AgentState.allCases[i] === m.engine.state.agentState)));
  return section('Agent state', grid);
}

// MARK: - (c) One-shots (the answers labelled by meaning)

function oneShotSection(m: TuningModel): HTMLElement {
  const grid = buttons(...OneShotKind.allCases.map((k) => {
    const t = answerTitle(k);
    return [t ? t[0]!.toUpperCase() + t.slice(1) : k, () => m.play(k)] as [string, () => void];
  }));
  grid.querySelectorAll('button').forEach((x, i) => { if (isAnswer(OneShotKind.allCases[i]!)) x.classList.add('answer'); });
  return section('One-shots', grid);
}

// MARK: - Touch

function touchSection(m: TuningModel, b: Build): HTMLElement {
  return section('Touch',
    readout(b, () => {
      const t = m.touchReadout();
      const n = Math.round(Math.min(t.annoyance / TouchReactions.sulkThreshold, 1) * 10);
      return `Annoyance ${'▮'.repeat(n)}${'▯'.repeat(10 - n)} ${t.annoyance.toFixed(1)}${t.sulking ? ' · sulking' : ''}`;
    }),
    buttons(['Tap left', () => m.simulateTap({ x: -0.6, y: 0 })], ['Tap centre', () => m.simulateTap({ x: 0, y: 0 })],
      ['Tap right', () => m.simulateTap({ x: 0.6, y: 0 })]),
    buttons(m.ctx.talk ? ['Hold to talk', () => m.ctx.talk?.(null)] : null, ['Tickle', () => m.simulateTickle()]));
}

// MARK: - (d) Gaze

function gazeSection(m: TuningModel, b: Build): HTMLElement {
  const pad = h('div', { class: 'pv-pad', tabIndex: 0 });
  pad.setAttribute('role', 'application');
  pad.setAttribute('aria-label', 'Gaze pad: drag to move a virtual person; arrow keys nudge, Escape releases');
  const dot = h('div', { class: 'dot' }), second = h('div', { class: 'dot second' }), hint = h('div', { class: 'hint' }, 'drag to look');
  pad.append(second, dot, hint);
  const place = (el: HTMLElement, p: V2 | null): void => {
    el.hidden = !p;
    if (p) { el.style.left = `${((p.x + 1) / 2) * 100}%`; el.style.top = `${((p.y + 1) / 2) * 100}%`; }
  };
  const show = (): void => {
    place(dot, m.gazePoint);
    place(second, m.simulateTwoPeople ? TuningModel.secondPerson.position : null);
    hint.hidden = m.gazePoint !== null;
  };
  const at = (e: PointerEvent): V2 => {
    const r = pad.getBoundingClientRect(), c = (v: number) => Math.min(Math.max(v, -1), 1);
    return { x: c(((e.clientX - r.left) / Math.max(r.width, 1)) * 2 - 1), y: c(((e.clientY - r.top) / Math.max(r.height, 1)) * 2 - 1) };
  };
  pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); m.dragGaze(at(e)); show(); });
  pad.addEventListener('pointermove', (e) => { if (pad.hasPointerCapture(e.pointerId)) { m.dragGaze(at(e)); show(); } });
  const up = (e: PointerEvent): void => { if (pad.hasPointerCapture(e.pointerId)) pad.releasePointerCapture(e.pointerId); m.releaseGaze(); show(); };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
  pad.addEventListener('keydown', (e) => {
    const p = m.gazePoint ?? { x: 0, y: 0 }, d = 0.1;
    const moves: Record<string, V2> = { ArrowLeft: { x: -d, y: 0 }, ArrowRight: { x: d, y: 0 }, ArrowUp: { x: 0, y: -d }, ArrowDown: { x: 0, y: d } };
    if (e.key === 'Escape') m.releaseGaze();
    else if (moves[e.key]) m.dragGaze({ x: Math.min(Math.max(p.x + moves[e.key]!.x, -1), 1), y: Math.min(Math.max(p.y + moves[e.key]!.y, -1), 1) });
    else return;
    e.preventDefault();
    show();
  });
  show();
  b.poll.add(show);
  return section('Gaze', pad,
    toggle('Simulate 2 people', () => m.simulateTwoPeople, (v) => { m.simulateTwoPeople = v; m.pushPeople(); show(); }),
    toggle('Passer-by (not looking)', () => m.passerBy, (v) => { m.passerBy = v; m.pushPeople(); }),
    buttons(['Glance (random)', () => m.glanceAtRandomPoint()], ['Stimulus (random)', () => m.stimulusAtRandomPoint()], ['Blink', () => m.blinkNow()]));
}

// MARK: - (e) Mood + (f) speech

function moodSection(m: TuningModel): HTMLElement {
  const pad = (label: string, k: 'pleasure' | 'arousal' | 'dominance') =>
    slider(label, () => m.mood[k], (v) => { m.mood = { ...m.mood, [k]: v }; m.pushMood(); }, [-1, 1]);
  return section('Baseline mood & speech',
    note('The emotion layer’s resting point (overrides the personality while set; feeling and mood still move around it).'),
    pad('Pleasure', 'pleasure'), pad('Arousal', 'arousal'), pad('Dominance', 'dominance'),
    button('Back to the personality', () => { m.mood = { ...Mood.playful }; m.pushMood(); }),
    slider('Speech level', () => m.speechLevel, (v) => { m.speechLevel = v; m.pushSpeech(); }, [0, 1]));
}

// MARK: - (g) Modifiers + slow time

function modifierSection(m: TuningModel): HTMLElement {
  return section('Modifiers',
    slider('Time scale', () => m.timeScale, (v) => { m.timeScale = v; }, [0.05, 1], (v) => `${v.toFixed(2)}×`),
    ...m.modifierNames.map((n) => toggle(n, () => m.modifierEnabled(n), (on) => m.setModifier(n, on))));
}

// MARK: - (h) Style

const PIN_KEY = 'yanni.tuning.pinStyle', STYLE_KEY = 'yanni.tuning.style';

/** The remembered developer style, when "Remember style tweaks" is on (the app applies it at launch). */
export function savedTuningStyle(): RenderStyle | null {
  try { return localStorage.getItem(PIN_KEY) === '1' ? RenderStyle.decode(JSON.parse(localStorage.getItem(STYLE_KEY) ?? 'null')) : null; }
  catch { return null; }
}

function styleSection(m: TuningModel, b: Build): HTMLElement {
  type Num = { [K in keyof RenderStyle]: RenderStyle[K] extends number ? K : never }[keyof RenderStyle];
  type Col = 'backgroundColor' | 'scleraColor' | 'rimColor' | 'inkColor' | 'pupilColor' | 'notchColor' | 'crescentColor' | 'color';
  const pinned = (): boolean => { try { return localStorage.getItem(PIN_KEY) === '1'; } catch { return false; } };
  const remember = (): void => { if (pinned()) try { localStorage.setItem(STYLE_KEY, JSON.stringify(RenderStyle.encode(m.style))); } catch { /* full */ } };
  const edit = (f: (s: RenderStyle) => void): void => { m.editStyle(f); remember(); };
  const num = (label: string, k: Num, range: readonly [number, number], fmt = (v: number) => v.toFixed(2)) =>
    slider(label, () => m.style[k], (v) => edit((s) => { (s[k] as number) = v; }), range, fmt);
  const col = (label: string, k: Col) => color(label, () => m.style[k], (v) => edit((s) => { s[k] = v; }));
  const deg = (v: number) => `${v.toFixed(0)}°`;
  const mc = m.moodColor();
  return section('Style',
    toggle('Remember style tweaks', pinned, (v) => { try { localStorage.setItem(PIN_KEY, v ? '1' : '0'); } catch { /* private */ } remember(); }),
    buttons(['Reference look', () => { m.setStylePreset(RenderStyle.make()); remember(); b.rebuild(); }],
      ['Ivory rim', () => { m.setStylePreset(RenderStyle.ivoryRim); remember(); b.rebuild(); }]),
    col('Background', 'backgroundColor'), col('Sclera', 'scleraColor'), col('Rim', 'rimColor'), col('Ink', 'inkColor'),
    col('Pupil', 'pupilColor'), col('Notch', 'notchColor'), col('Crescent', 'crescentColor'),
    num('Rim width', 'rimWidth', [0, 2]), num('Ink width', 'inkWidth', [0, 3]), num('Egg taper', 'eggTaper', [0, 0.6]),
    num('Eye asymmetry', 'eyeAsymmetry', [0.8, 1.3]), num('Eye spacing', 'eyeSpacing', [0.5, 1.5]),
    num('Pair tilt (°)', 'pairTilt', [-20, 20], deg), num('Eye lean (°)', 'eyeLean', [-20, 20], deg),
    num('Pupil scale', 'pupilScale', [0.5, 1.6]), num('Pupil aspect', 'pupilAspect', [0.7, 1.6]), num('Pupil ink', 'pupilInkWidth', [0, 1.5]),
    toggle('Notch', () => m.style.notchEnabled, (v) => edit((s) => { s.notchEnabled = v; })),
    num('Notch size', 'notchSize', [0, 0.8]), num('Notch angle (°)', 'notchAngle', [-180, 180], deg), num('Notch spread (°)', 'notchSpread', [5, 120], deg),
    num('Crescent strength', 'crescentStrength', [0, 1]), num('Crescent width', 'crescentWidth', [0, 0.5]),
    num('Crescent angle (°)', 'crescentAngle', [0, 360], deg),
    col('Mood anchor colour', 'color'),
    ((): HTMLElement => {
      const sw = h('span', {}), txt = h('span', { class: 'pv-readout' });
      let last = '';
      b.poll.add(() => { const c = m.currentEyeColor(), t = hexText(c); if (t !== last) { last = t; txt.textContent = t; sw.replaceChildren(swatch(c)); } });
      return h('div', { class: 'pv-toggle' }, h('span', { class: 'pv-grow' }, 'Current mood colour'), txt, sw);
    })(),
    slider('Mood → crescent', () => m.style.moodColorAmount, (v) => m.persist({ mood_colour_strength: Math.round(v * 100), mood_colour: v > 0 },
      () => edit((s) => { s.moodColorAmount = v; })), [0, 1]),
    mc ? slider('Expression → colour', () => mc.expressionInfluence, (v) => { mc.expressionInfluence = v; }, [0, 1]) : null,
    mc ? slider('Colour lightness match', () => mc.lightnessMatch, (v) => { mc.lightnessMatch = v; }, [0, 1]) : null,
    num('Lid shadow', 'lidShadow', [0, 0.5]), num('Roundness', 'roundness', [0, 2]), num('Ovalness', 'ovalness', [0, 1]),
    num('Eye scale', 'eyeScale', [0.3, 1.5]), num('Face scale', 'faceScale', [0.3, 1.5]), num('Portrait scale', 'portraitScale', [0.5, 1.5]),
    num('Max luminance', 'maxLuminance', [0.1, 1]),
    button('Reset style', () => { m.resetStyle(); remember(); b.rebuild(); }));
}

// MARK: - (j) File: the expression library (open, save in place where the browser can, download, copy, bundled)

interface FileHandle { name: string; getFile(): Promise<File>; createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> }
type Picker = (o: object) => Promise<FileHandle[]>;

function fileSection(m: TuningModel, b: Build): HTMLElement {
  const state = fileState;
  const status = readout(b, () => state.status, 'pv-note');
  const adopt = (text: string, name: string): void => {
    try {
      const lib = ExpressionLibrary.fromJSON(text);
      m.adopt(lib);
      state.status = `Loaded ${name} (${lib.names.length} expressions)`;
      b.rebuild();
    } catch (e) { state.status = `Open failed: ${e instanceof Error ? e.message : String(e)}`; }
  };
  const input = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void f.text().then((t) => { state.handle = null; state.name = f.name; adopt(t, f.name); });
  });
  const open = async (): Promise<void> => {
    const picker = (globalThis as { showOpenFilePicker?: Picker }).showOpenFilePicker;
    if (!picker) { input.click(); return; }
    try {
      const [handle] = await picker({ types: [{ description: 'Expression library', accept: { 'application/json': ['.json'] } }] });
      if (!handle) return;
      state.handle = handle;
      state.name = handle.name;
      adopt(await (await handle.getFile()).text(), handle.name);
    } catch { /* cancelled */ }
  };
  const save = async (): Promise<void> => {
    const text = m.libraryJSON();
    try {
      if (state.handle) {
        const w = await state.handle.createWritable();
        await w.write(text);
        await w.close();
      } else {
        const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: state.name ?? 'expressions.json' });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
      m.markSaved();
      state.status = `Saved ${state.name ?? 'expressions.json'}${state.handle ? '' : ' (downloaded)'}`;
    } catch (e) { state.status = `Save failed: ${e instanceof Error ? e.message : String(e)}`; }
  };
  return section('File',
    readout(b, () => (state.name ? `${state.name}${state.handle ? ' (saved in place)' : ''}` : 'Bundled expressions'), 'pv-readout'),
    input,
    buttons(['Open expressions.json…', () => void open()], ['Save', () => void save()],
      ['Copy JSON', () => {
        const t = m.libraryJSON();
        void navigator.clipboard?.writeText(t).then(() => { state.status = `Copied ${t.length} bytes of JSON`; },
          (e: unknown) => { state.status = `Copy failed: ${String(e)}`; });
      }],
      ['Use bundled', () => { state.handle = null; state.name = null; m.useBundled(); state.status = 'Using bundled expressions'; b.rebuild(); }]),
    status);
}

/** The chosen file survives section switches (one per page). */
const fileState: { handle: FileHandle | null; name: string | null; status: string } = { handle: null, name: null, status: '' };
