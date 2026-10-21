// Port of yanni/Conversation/CaptionModel.swift (CaptionModel, CaptionOverlay, CaptionMotion, CaptionFitCache,
// CaptionStack, YouCaption, PopIn) as a DOM overlay over the face's canvas.
import './captions.css';
import { v3, type V3 } from '../../core/vec';
import { CaptionInset } from '../../engine/modifiers/CaptionInset';
import { FaceFrame } from '../../model/FaceFrame';
import { makeRenderStyle, type RenderStyle } from '../../render/RenderStyle';
import { HostClock } from '../../voice/host/VoiceOutput';
import { CaptionTimeline } from '../core/CaptionTimeline';
import type { Caption } from '../events/Captions';
import {
  CaptionBubble, CaptionFonts, CaptionMetrics, CaptionPill, cssLinear, domMeasure, type CaptionMeasure, type CaptionTypeFit,
} from './CaptionBubble';

/// The band the face makes room for while a caption shows (re-exported for the app's `setCaptionInset`).
export const captionBand = CaptionInset.band;

/// The caption bubbles' state (caption bubbles design): the controller's captions into a `CaptionTimeline`, woken by
/// one timer at its next deadline, never per frame. The words live here only while they're on screen; nothing is
/// logged, stored or sent.
export class CaptionModel {
  readonly timeline = new CaptionTimeline();
  /// The Yanni dot once the reply has finished: the mood's eye colour (linear RGB), taken as each reply piece appears.
  moodColor: V3 = v3(FaceFrame.defaultColor.x, FaceFrame.defaultColor.y, FaceFrame.defaultColor.z);
  /// The current mood's eye colour (the app reads the engine's mood).
  mood: () => V3 = () => FaceFrame.defaultColor;
  /// A bubble started or stopped showing: the app springs the face up out of the caption band and back.
  onShowingChange: ((showing: boolean) => void) | null = null;
  /// port-note: SwiftUI's observation; the overlay redraws when the timeline changes.
  onUpdate: (() => void) | null = null;
  /// port-note: Swift posts an accessibility announcement; the overlay writes it to an aria-live region.
  onAnnounce: ((text: string) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private preview: ReturnType<typeof setTimeout>[] = [];

  receive(c: Caption): void {
    if (c.kind === 'replySentence') {
      const m = this.mood();
      this.moodColor = v3(m.x, m.y, m.z);
      this.announce(c.text);
    }
    this.update((t) => t.apply(c, HostClock.nowSeconds()));
  }

  private update(change: (t: CaptionTimeline) => void): void {
    const was = !this.timeline.isEmpty;
    change(this.timeline);
    if (was !== !this.timeline.isEmpty) this.onShowingChange?.(!this.timeline.isEmpty);
    this.schedule();
    this.onUpdate?.();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const due = this.timeline.nextDeadline;
    if (due === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.update((t) => t.tick(HostClock.nowSeconds()));
    }, (Math.max(0, due - HostClock.nowSeconds()) + 0.01) * 1000);
  }

  /// Screen readers hear Yanni's words politely (never interrupting): in Yanni's babble voice they're the only way to
  /// understand it.
  private announce(text: string): void { this.onAnnounce?.(text); }

  /// Tune › Look › Preview captions: a scripted you → Yanni exchange through the real timeline, no conversation: the
  /// words stream in as they're heard, the reply's words follow a made-up voice.
  playPreview(): void {
    this.cancelPreview();
    this.receive({ kind: 'cleared' });
    const now = (): number => HostClock.nowSeconds();
    const steps: [number, () => Caption][] = [
      [0.2, () => ({ kind: 'transcriptPartial', text: '' })],
      [0.5, () => ({ kind: 'transcriptPartial', text: 'Can you tell' })],
      [0.5, () => ({ kind: 'transcriptPartial', text: 'Can you tell me a story' })],
      [0.6, () => ({ kind: 'transcriptPartial', text: 'Can you tell me a story about a sleepy' })],
      [0.6, () => ({ kind: 'transcript', turnId: 'preview', text: 'Can you tell me a story about a sleepy dragon?' })],
      [1.4, () => ({ kind: 'replySentence', turnId: 'preview', index: 0, text: 'Once upon a time, a sleepy dragon curled up on a cloud.',
        audibleAtHostTime: now(), audioSeconds: 3.2 })],
      [3.3, () => ({ kind: 'replySentence', turnId: 'preview', index: 1, text: 'It yawned so big that the stars blinked!',
        audibleAtHostTime: now(), audioSeconds: 2.4 })],
      [2.5, () => ({ kind: 'replyEnded', turnId: 'preview' })],
    ];
    let at = 0;
    for (const [wait, c] of steps) {
      at += wait;
      this.preview.push(setTimeout(() => this.receive(c()), at * 1000));
    }
  }

  cancelPreview(): void {
    for (const t of this.preview) clearTimeout(t);
    this.preview = [];
  }

  dispose(): void {
    this.cancelPreview();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/// The springs of the caption handoff (caption bubbles design §5), shared by the live view and the snapshots.
export const CaptionMotion = {
  /// The "you" bubble shrinking into the pill: lots of bounce.
  dockResponse: 0.55, dockDamping: 0.5,
  /// Yanni's bubble grows up out of it a beat later.
  replyDelay: 0.09,
  /// The pop: width and height out of phase, and a lift.
  popX: { response: 0.42, damping: 0.45 }, popY: { response: 0.5, damping: 0.32 },
  lift: { response: 0.38, damping: 0.62 },
  /// The removal's spring (SwiftUI `.spring(response: 0.22, dampingFraction: 0.8)`).
  removal: { response: 0.22, damping: 0.8 },

  /// A SwiftUI spring from 0 to 1 at `t` seconds (from rest).
  spring(t: number, response: number, damping: number): number {
    if (!(t > 0)) return 0;
    const w = 2 * Math.PI / response, z = Math.min(damping, 0.999);
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + z * w / wd * Math.sin(wd * t));
  },

  /// The spring as WAAPI keyframe progress (port-note: SwiftUI animates removals natively; sampled here). The
  /// samples run until the spring is within 0.001 of rest.
  samples(response: number, damping: number, n = 24): { duration: number; values: number[] } {
    const z = Math.min(damping, 0.999), w = 2 * Math.PI / response;
    const duration = Math.min(Math.log(1000 / Math.sqrt(1 - z * z)) / (z * w), 2);
    const values: number[] = [];
    for (let i = 0; i <= n; i++) values.push(i === n ? 1 : CaptionMotion.spring(duration * i / n, response, damping));
    return { duration, values };
  },
};

/// Where the overlay's layout memoises its type fits (the words change a few times a second, the frames 30 times).
export class CaptionFitCache {
  private entries = new Map<string, CaptionTypeFit>();
  fit(key: string, make: () => CaptionTypeFit): CaptionTypeFit {
    const f = this.entries.get(key);
    if (f) return f;
    if (this.entries.size > 12) this.entries.clear();
    const n = make();
    this.entries.set(key, n);
    return n;
  }
  clear(): void { this.entries.clear(); }
}

/// The bubble's entrance: it starts small and low, then two springs out of phase and a lift make it squash, stretch,
/// overshoot and wobble to rest. `age` is seconds since it appeared; no motion: none.
function popIn(el: HTMLElement, motion: boolean, delay: number, age: number, rise: number): void {
  const M = CaptionMotion;
  const a = age - delay;
  const [x, y, lift] = motion && a < 3
    ? [M.spring(a, M.popX.response, M.popX.damping), M.spring(a, M.popY.response, M.popY.damping), M.spring(a, M.lift.response, M.lift.damping)]
    : [1, 1, 1];
  el.style.transform = x === 1 && y === 1 && lift === 1 ? ''
    : `translateY(${(1 - lift) * rise}px) scale(${0.3 + 0.7 * x}, ${0.15 + 0.85 * y})`;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/// One bubble on screen: `slot` (its place in the stack, and the removal) around `pop` (the entrance).
interface Slot { id: number; slot: HTMLElement; pop: HTMLElement; appearedAt: number }
interface YouSlot extends Slot { box: HTMLElement; big: CaptionBubble; pill: CaptionPill }
interface ReplySlot extends Slot { bubble: CaptionBubble }

export interface CaptionOverlayOptions {
  /// The current mood's eye colour, linear RGB (the app reads the engine's mood).
  mood: () => V3;
  reduceMotion: () => boolean;
  /// The face's style (the ink colours and widths); default `makeRenderStyle()`.
  style?: () => RenderStyle;
}

/// The caption bubbles over the face, in the bottom `CaptionInset.band` of the screen (the face springs up out of it
/// while they show). The person's words fill the band while they speak; when Yanni answers they shrink into a slim
/// dark pill docked at the bottom and Yanni's bubble grows up out of it. With nothing to show it holds no bubble and
/// runs no frame loop.
export class CaptionOverlay {
  readonly model = new CaptionModel();
  private readonly el = document.createElement('div');
  private readonly stack = document.createElement('div');
  private readonly live = document.createElement('div');
  private readonly measure: CaptionMeasure;
  private readonly fits = new CaptionFitCache();
  private readonly defaultStyle = makeRenderStyle();
  private metrics: CaptionMetrics | null = null;
  private you: YouSlot | null = null;
  private reply: ReplySlot | null = null;
  /// The handoff: 0 the "you" bubble, 1 docked as the pill (sprung, so it overshoots a little). null = undocked.
  private dockStart: number | null = null;
  private dockReduced = false;
  private raf = 0;
  private lastFrame = 0;
  private readonly resize: ResizeObserver | null;

  constructor(root: HTMLElement, private readonly opts: CaptionOverlayOptions) {
    this.el.className = 'caption-overlay';
    this.stack.className = 'caption-stack';
    this.live.className = 'caption-live';
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    this.el.append(this.stack, this.live);
    root.appendChild(this.el);
    this.measure = domMeasure(this.el);
    this.model.mood = opts.mood;
    this.model.onUpdate = () => this.render();
    this.model.onAnnounce = (text) => { this.live.textContent = text; };
    this.resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { this.metrics = null; this.render(); });
    this.resize?.observe(this.el);
    void CaptionFonts.load().then(() => { this.fits.clear(); this.metrics = null; this.render(); });
  }

  /// A bubble started or stopped showing: call `engine.setCaptionInset(showing ? captionBand : 0, reduceMotion)`.
  set onShowingChange(f: ((showing: boolean) => void) | null) { this.model.onShowingChange = f; }
  get onShowingChange(): ((showing: boolean) => void) | null { return this.model.onShowingChange; }

  receive(c: Caption): void { this.model.receive(c); }
  /// Takes everything down now.
  clear(): void { this.model.receive({ kind: 'cleared' }); }
  /// The scripted you → Yanni exchange (Tune › Look › Preview captions).
  playPreview(): void { this.model.playPreview(); }

  dispose(): void {
    this.model.dispose();
    cancelAnimationFrame(this.raf);
    this.resize?.disconnect();
    this.el.remove();
  }

  private style(): RenderStyle { return this.opts.style?.() ?? this.defaultStyle; }

  private currentMetrics(): CaptionMetrics {
    if (!this.metrics) {
      const r = this.el.getBoundingClientRect();
      this.metrics = new CaptionMetrics(r.width, r.height, this.style(), this.measure);
    }
    return this.metrics;
  }

  /// Reconciles the bubbles with the timeline (on each caption and deadline), then draws a frame.
  private render(): void {
    const t = this.model.timeline;
    const motion = !this.opts.reduceMotion();
    const now = HostClock.nowSeconds();
    if (this.reply && this.reply.id !== t.reply?.id) { this.leave(this.reply, '50% 100%', motion); this.reply = null; }
    if (this.you && this.you.id !== t.you?.id) { this.leave(this.you, '100% 100%', motion); this.you = null; }
    if (t.reply && !this.reply) this.reply = this.makeReply(t.reply.id, now, motion);
    if (t.you && !this.you) this.you = this.makeYou(t.you.id, now, motion);
    // `.onChange(of: youDocked)`.
    if (t.youDocked && this.dockStart === null) { this.dockStart = now; this.dockReduced = !motion; }
    if (!t.youDocked) this.dockStart = null;
    this.frame();
  }

  private frame(): void {
    const t = this.model.timeline;
    if (t.isEmpty) return;
    const m = this.currentMetrics();
    const style = this.style();
    const motion = !this.opts.reduceMotion();
    const host = HostClock.nowSeconds();
    const now = motion ? host : Infinity;
    const clock = motion ? host : 0;
    const crescent = cssLinear(style.crescentColor);
    this.stack.style.gap = `${m.gap}px`;
    this.stack.style.paddingBottom = `${m.bottomInset}px`;
    const r = t.reply;
    if (r && this.reply) {
      // port-note: the Swift key leaves out whether the pill is there (a stale fit across that change); kept in here.
      const fit = this.fits.fit(`y${r.text}|${m.key}|${t.you !== null}`, () => m.fit(r.text, m.replyMaxHeight(t.you !== null)));
      const speaking = t.replyEndedAt === null;
      this.reply.bubble.update({ kind: 'yanni', text: r.text, shown: motion ? r.revealed(now) : r.length,
        header: speaking ? 'speaking' : 'none', fit, metrics: m, style, dot: speaking ? crescent : cssLinear(this.model.moodColor),
        clock, motion });
      popIn(this.reply.pop, motion, CaptionMotion.replyDelay, host - this.reply.appearedAt, m.font * 1.4);
    }
    const y = t.you;
    let animating = false;
    if (y && this.you) {
      const fit = this.fits.fit(`u${y.text}|${m.key}`, () => m.fit(y.text + ' |', m.youMaxHeight));
      const big = m.size(fit), pill = m.pillSize();
      let d = 0;
      if (r !== null && this.dockStart !== null) {
        const age = host - this.dockStart;
        if (this.dockReduced) {
          // port-note: SwiftUI `.easeInOut(duration: 0.3)` is a cubic Bézier; a smoothstep is close.
          d = smoothstep(0, 1, age / 0.3);
          animating = age < 0.3;
        } else {
          d = age < 4 ? CaptionMotion.spring(age, CaptionMotion.dockResponse, CaptionMotion.dockDamping) : 1;
          animating = age < 4;
        }
      }
      const p = Math.min(Math.max(d, 0), 1);
      // Squash and stretch through the move (wider and flatter mid-way); the spring's overshoot adds the bounce.
      // port-note: at rest (d = 1) the squash is sin(π/1.2) = 0.5, so the docked pill stays ~5 % wider and ~6 % flatter.
      const squash = motion ? Math.sin(Math.PI * Math.min(Math.max(d, 0), 1.2) / 1.2) : 0;
      const sx = motion ? (1 + (pill.width / big.width - 1) * d) * (1 + 0.14 * squash) : 1;
      const sy = motion ? (1 + (pill.height / big.height - 1) * d) * (1 - 0.16 * squash) : 1;
      const typing = motion && y.revealed(now) < y.length;
      this.you.big.update({ kind: 'you', text: y.text, shown: motion ? y.revealed(now) : y.length,
        header: !y.isFinal || typing ? 'listening' : 'heard', fit, metrics: m, style, dot: crescent, clock, motion });
      this.you.big.el.style.transform = sx === 1 && sy === 1 ? '' : `scale(${sx}, ${sy})`;
      this.you.big.el.style.opacity = `${1 - smoothstep(0.05, 0.55, d)}`;
      const pe = this.you.pill.el;
      pe.style.display = p > 0 ? '' : 'none';
      if (p > 0) {
        this.you.pill.update(y.text, m);
        const px = motion ? (1 + (big.width / pill.width - 1) * (1 - d)) * (1 + 0.1 * squash) : 1;
        const py = motion ? (1 + (big.height / pill.height - 1) * (1 - d)) * (1 - 0.12 * squash) : 1;
        pe.style.transform = px === 1 && py === 1 ? '' : `scale(${px}, ${py})`;
        pe.style.opacity = `${smoothstep(0.2, 0.65, d)}`;
      }
      this.you.box.style.width = `${m.maxWidth}px`;
      this.you.box.style.height = `${big.height + (pill.height - big.height) * p}px`;
      popIn(this.you.pop, motion, 0, host - this.you.appearedAt, m.font * 1.4);
    }
    // The wobble, reveal and springs redraw at 30 Hz while a bubble shows (Swift `TimelineView(.animation(1/30))`);
    // with Reduce Motion only while the dock eases.
    if (motion || animating) this.requestFrame();
  }

  private requestFrame(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame((ts) => {
      this.raf = 0;
      if (ts - this.lastFrame < 1000 / 30 - 2) { this.requestFrame(); return; }
      this.lastFrame = ts;
      this.frame();
    });
  }

  private slot(id: number, now: number, motion: boolean, first: boolean): Slot {
    const slot = document.createElement('div');
    slot.className = 'caption-slot';
    const pop = document.createElement('div');
    pop.className = 'caption-pop';
    slot.appendChild(pop);
    if (first) this.stack.prepend(slot); else this.stack.appendChild(slot);
    // In: the bubble's own pop; with Reduce Motion a fade.
    if (!motion) slot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-in-out' });
    return { id, slot, pop, appearedAt: now };
  }

  private makeReply(id: number, now: number, motion: boolean): ReplySlot {
    const s = this.slot(id, now, motion, true);
    const bubble = new CaptionBubble();
    s.pop.appendChild(bubble.el);
    return { ...s, bubble };
  }

  private makeYou(id: number, now: number, motion: boolean): YouSlot {
    const s = this.slot(id, now, motion, false);
    const box = document.createElement('div');
    box.className = 'caption-you';
    const big = new CaptionBubble();
    const pill = new CaptionPill();
    pill.el.style.display = 'none';
    box.append(big.el, pill.el);
    s.pop.appendChild(box);
    return { ...s, box, big, pill };
  }

  /// Out: a quick shrink-and-fade toward `anchor` (a fade with Reduce Motion), then gone.
  private leave(s: Slot, anchor: string, motion: boolean): void {
    s.slot.style.transformOrigin = anchor;
    s.slot.setAttribute('aria-hidden', 'true');
    let a: Animation;
    if (motion) {
      const { duration, values } = CaptionMotion.samples(CaptionMotion.removal.response, CaptionMotion.removal.damping);
      a = s.slot.animate(values.map((v) => ({ transform: `scale(${1 - 0.5 * v})`, opacity: Math.min(Math.max(1 - v, 0), 1) })),
        { duration: duration * 1000, fill: 'forwards' });
    } else {
      a = s.slot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-in-out', fill: 'forwards' });
    }
    a.onfinish = () => s.slot.remove();
    a.oncancel = () => s.slot.remove();
  }
}
