// Port of yanni/Conversation/CaptionBubble.swift (CaptionMetrics, CaptionTypeFit, CaptionFonts, CaptionBubble,
// SpeakingBars, CaptionPill, BubbleInk) as DOM elements and a 2D canvas.
import type { V3 } from '../../core/vec';
import { CaptionInset } from '../../engine/modifiers/CaptionInset';
import { EyeSDF } from '../../render/EyeSDF';
import type { RenderStyle } from '../../render/RenderStyle';
import { Viewport } from '../../render/Viewport';
import { CaptionFit } from '../core/CaptionTimeline';

/// The bubble kind: the person's words or Yanni's reply.
export type CaptionKind = 'you' | 'yanni';
export type CaptionHeader = 'listening' | 'heard' | 'speaking' | 'none';

/// Measures the words: their height (px) set in the caption face at `font` px, wrapped at `width` px.
export type CaptionMeasure = (text: string, font: number, width: number) => number;

/// A word size and the height the words take in it (capped at the bubble's room).
export interface CaptionTypeFit { font: number; textHeight: number; overflows: boolean }

/// Caption sizes from the screen and the face's style (caption bubbles design §5). The bubbles live in the bottom
/// `CaptionInset.band` of the screen, which the face springs up out of while they show: the person's words fill it
/// while they speak; once Yanni answers its bubble takes about 25 % of the height above a slim dark pill of about 5 %.
/// Type is big, bold and rounded for 2 m, shrinking only as far as the words need. Sizes in CSS px (Swift points).
export class CaptionMetrics {
  /// The share of the height for Yanni's bubble once the person's words have docked as the pill.
  static readonly replyShare = 0.25;
  static readonly pillShare = 0.05;

  readonly width: number;
  readonly height: number;
  /// The eyes' rim band and ink line at this size.
  readonly rim: number;
  readonly ink: number;
  /// The largest and smallest word size.
  readonly fontMax: number;
  readonly fontMin: number;
  /// The bubbles' width (the pill's too).
  readonly maxWidth: number;
  /// The caption band's height and the gap below it.
  readonly band: number;
  readonly bottomInset: number;
  readonly pillHeight: number;
  readonly gap: number;

  constructor(width: number, height: number, style: RenderStyle, private readonly measure: CaptionMeasure) {
    this.width = width;
    this.height = height;
    const w = Math.max(width, 1), h = Math.max(height, 1);
    const ppu = Viewport.fitting(w, h, style, CaptionInset.band).pixelsPerUnit;
    this.rim = Math.min(Math.max(style.rimWidth * ppu, 2), 9);
    this.ink = Math.min(Math.max(style.inkWidth * ppu, 1.5), 4);
    this.band = h * CaptionInset.band;
    this.bottomInset = Math.max(h * 0.02, 10);
    this.pillHeight = Math.max(h * CaptionMetrics.pillShare, 30);
    this.gap = Math.max(h * 0.012, 6);
    this.maxWidth = Math.min(w * 0.88, Math.max(h * 1.6, 320));
    this.fontMax = Math.min(Math.max(h * 0.074, 28), 84);
    this.fontMin = Math.min(Math.max(h * 0.026, 18), this.fontMax);
  }

  /// The reference size for the tail, padding and pop distance.
  get font(): number { return this.fontMax * 0.8; }
  get tail(): number { return this.fontMax * 0.45; }
  get line(): number { return this.rim + this.ink; }
  get key(): string { return `${Math.trunc(this.width)}x${Math.trunc(this.height)}`; }

  /// The person's bubble: the whole band (less its tail).
  get youMaxHeight(): number { return this.band - this.bottomInset - this.tail; }
  /// Yanni's bubble: about 25 % of the screen above the pill, or the whole band on its own.
  replyMaxHeight(withPill: boolean): number {
    return withPill ? this.height * CaptionMetrics.replyShare - this.gap - this.tail : this.band - this.bottomInset - this.tail;
  }

  header(font: number): number { return Math.max(font * 0.52, 14); }
  padH(font: number): number { return font * 0.6; }
  padV(font: number): { top: number; bottom: number } { return { top: font * 0.34, bottom: font * 0.4 }; }

  /// The largest word size at which `text` fits a bubble of `maxHeight`; at the smallest it may overflow, and the
  /// bubble then shows the latest lines.
  fit(text: string, maxHeight: number): CaptionTypeFit {
    const r = CaptionFit.size(this.fontMax, this.fontMin, (s) => this.textHeight(text, s) <= maxHeight - this.chrome(s));
    const f = r.size;
    const content = Math.min(this.textHeight(text, f), Math.max(maxHeight - this.chrome(f), f * 1.2));
    return { font: f, textHeight: content, overflows: r.overflows };
  }

  /// Everything but the words: the header, padding and the ink line on both sides.
  chrome(f: number): number {
    const p = this.padV(f);
    return p.top + p.bottom + this.header(f) * 1.25 + f * 0.08 + this.line * 2;
  }

  /// The bubble's size at a fit.
  size(fit: CaptionTypeFit): { width: number; height: number } {
    return { width: this.maxWidth, height: fit.textHeight + this.chrome(fit.font) };
  }

  pillSize(): { width: number; height: number } { return { width: this.maxWidth, height: this.pillHeight }; }

  /// The words' wrap width at a word size.
  wordsWidth(f: number): number { return this.maxWidth - 2 * this.padH(f) - this.line * 2; }

  private textHeight(text: string, f: number): number {
    const s = (text.length === 0 ? '…' : text) + ' |';
    return Math.ceil(this.measure(s, f, Math.max(this.wordsWidth(f), 10)));
  }
}

/// The rounded heavy face the words are set in (measured the same way they're drawn). port-note: SF Rounded is
/// Apple's; `ui-rounded` gets it in Safari (the iPad kiosk), and everywhere else the self-hosted Nunito (OFL, in
/// `public/fonts/`) stands in (the stack is in captions.css). Weights: heavy 800, black 900, semibold 600, regular 400.
export const CaptionFonts = {
  /// Registers Nunito once (the page is cross-origin isolated: no font CDN). Resolves when it's ready (or failed).
  load(): Promise<void> {
    if (fontLoad) return fontLoad;
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    const dir = `${base.endsWith('/') ? base : `${base}/`}fonts/`;
    const faces: [string, string][] = [
      ['nunito-latin.woff2', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
      ['nunito-latin-ext.woff2', 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF'],
    ];
    fontLoad = typeof FontFace === 'undefined' || typeof document === 'undefined' ? Promise.resolve()
      : Promise.all(faces.map(([file, range]) => {
        const f = new FontFace('Nunito', `url(${dir}${file}) format('woff2')`, { weight: '400 1000', unicodeRange: range, display: 'swap' });
        document.fonts.add(f);
        return f.load().catch(() => f);
      })).then(() => document.fonts.ready).then(() => undefined);
    return fontLoad;
  },
};
let fontLoad: Promise<void> | null = null;

/// A DOM measurer for `CaptionMetrics`: one hidden element in `host`, set like the words.
export function domMeasure(host: HTMLElement): CaptionMeasure {
  const el = document.createElement('div');
  el.className = 'caption-measure caption-words';
  el.setAttribute('aria-hidden', 'true');
  host.appendChild(el);
  return (text, font, width) => {
    el.style.width = `${width}px`;
    el.style.fontSize = `${font}px`;
    el.textContent = text;
    return el.getBoundingClientRect().height;
  };
}

/// A linear RGB style colour as CSS (Swift `SIMD3<Float>.color`, `Color(.sRGBLinear, …)`).
export function cssLinear(c: V3, alpha = 1): string {
  const e = (v: number): number => Math.round(Math.min(Math.max(EyeSDF.srgbEncode(Math.max(v, 0)), 0), 1) * 255);
  return alpha >= 1 ? `rgb(${e(c.x)} ${e(c.y)} ${e(c.z)})` : `rgb(${e(c.x)} ${e(c.y)} ${e(c.z)} / ${alpha})`;
}

const inkText = 'rgb(18 18 20)';   // Color(red: 0.07, green: 0.07, blue: 0.08)
const grey = 'rgb(107 110 117)';   // Color(red: 0.42, green: 0.43, blue: 0.46)

/// What one bubble shows at one moment.
export interface CaptionBubbleProps {
  kind: CaptionKind;
  text: string;
  /// Characters revealed so far.
  shown: number;
  header: CaptionHeader;
  fit: CaptionTypeFit;
  metrics: CaptionMetrics;
  style: RenderStyle;
  /// The header dot: the crescent's cyan for the person, the mood colour for Yanni (CSS).
  dot: string;
  /// The wobble and speaking-bars clock (seconds).
  clock: number;
  motion: boolean;
}

/// One caption bubble: ivory like the sclera, the eyes' rim and ink around it with a slow hand-drawn wobble, a tail,
/// a small header and the words in big rounded type. The words beyond `shown` are laid out but clear, so the bubble
/// never resizes as they appear; when they overflow the bubble the latest lines stay in view.
export class CaptionBubble {
  readonly el = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly name = document.createElement('span');
  private readonly dotEl = document.createElement('span');
  private readonly bars = document.createElement('span');
  private readonly barEls: HTMLElement[] = [];
  private readonly label = document.createElement('span');
  private readonly words = document.createElement('div');
  private readonly shownEl = document.createElement('span');
  private readonly caret = document.createElement('span');
  private readonly rest = document.createElement('span');
  private layoutKey = '';
  private textKey = '';
  private canvasKey = '';

  constructor() {
    this.el.className = 'caption-bubble';
    this.canvas.className = 'caption-ink';
    const header = document.createElement('div');
    header.className = 'caption-header';
    this.name.className = 'caption-name';
    this.dotEl.className = 'caption-dot';
    this.bars.className = 'caption-bars';
    for (let i = 0; i < 4; i++) { const b = document.createElement('span'); this.bars.appendChild(b); this.barEls.push(b); }
    this.label.className = 'caption-label';
    header.append(this.name, this.dotEl, this.bars, this.label);
    this.words.className = 'caption-words-frame';
    const inner = document.createElement('div');
    inner.className = 'caption-words';
    this.caret.className = 'caption-caret';
    this.caret.textContent = ' |';
    this.rest.className = 'caption-rest';
    this.caret.setAttribute('aria-hidden', 'true');
    this.rest.setAttribute('aria-hidden', 'true');
    inner.append(this.shownEl, this.caret, this.rest);
    this.words.appendChild(inner);
    this.el.append(this.canvas, header, this.words);
  }

  update(p: CaptionBubbleProps): void {
    const m = p.metrics, f = p.fit.font, h = m.header(f), pv = m.padV(f);
    const lk = `${p.kind}|${f}|${p.fit.textHeight}|${m.key}`;
    if (lk !== this.layoutKey) {
      this.layoutKey = lk;
      const s = this.el.style;
      s.width = `${m.maxWidth}px`;
      s.padding = `${pv.top + m.line}px ${m.padH(f) + m.line}px ${pv.bottom + m.line}px`;
      s.gap = `${f * 0.08}px`;
      s.setProperty('--h', `${h}px`);
      s.setProperty('--f', `${f}px`);
      this.words.style.height = `${p.fit.textHeight}px`;
      this.name.textContent = p.kind === 'you' ? 'You' : 'Yanni';
    }
    const speaking = p.header === 'speaking';
    this.bars.style.display = speaking ? '' : 'none';
    this.dotEl.style.display = speaking ? 'none' : '';
    if (!speaking) this.dotEl.style.background = p.dot;
    const label = p.header === 'listening' ? 'Listening' : p.header === 'heard' ? 'Heard' : p.header === 'speaking' ? 'Speaking' : '';
    if (this.label.textContent !== label) this.label.textContent = label;
    if (speaking) SpeakingBars.update(this.barEls, h, p.motion ? p.clock : 0, cssLinear(p.style.crescentColor));
    this.updateWords(p);
    this.drawInk(p);
  }

  /// The revealed words (or a listening "…" before the first word), the caret while the person's words come in, and
  /// the rest laid out but clear.
  private updateWords(p: CaptionBubbleProps): void {
    const cs = Array.from(p.text);
    const n = Math.min(Math.max(p.shown, 0), cs.length);
    const caret = p.kind === 'you' && p.header === 'listening';
    let dots = 0;
    if (cs.length === 0) dots = Math.max(p.motion ? Math.trunc(p.clock * 3) % 4 : 3, 1);
    const key = `${p.text.length}|${p.text}|${n}|${caret}|${dots}`;
    if (key === this.textKey) return;
    this.textKey = key;
    if (cs.length === 0) {
      this.shownEl.textContent = '•'.repeat(dots);
      this.shownEl.style.color = grey;
      this.caret.style.display = 'none';
      this.rest.textContent = '';
      return;
    }
    this.shownEl.style.color = '';
    this.shownEl.textContent = cs.slice(0, n).join('');
    this.caret.style.display = caret ? '' : 'none';
    this.caret.style.color = cssLinear(p.style.crescentColor);
    this.rest.textContent = cs.slice(n).join('');
  }

  private drawInk(p: CaptionBubbleProps): void {
    const m = p.metrics;
    const size = m.size(p.fit);
    const pad = m.tail * 1.8;
    const t = p.motion ? p.clock : 0;
    const ck = `${size.width}|${size.height}|${p.kind}|${m.key}`;
    if (!p.motion && ck === this.canvasKey) return;   // still: drawn once
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const cw = size.width + 2 * pad, ch = size.height + 2 * pad;
    if (ck !== this.canvasKey) {
      this.canvasKey = ck;
      this.canvas.width = Math.ceil(cw * dpr);
      this.canvas.height = Math.ceil(ch * dpr);
      const s = this.canvas.style;
      s.left = s.top = `${-pad}px`;
      s.width = `${cw}px`;
      s.height = `${ch}px`;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    BubbleInk.draw(ctx, { x: pad, y: pad, w: size.width, h: size.height }, p.kind, m, t, p.style);
  }
}

/// The small animated level bars beside "Speaking": four rounded bars breathing out of phase (drawn from the
/// overlay's clock, so no animation of their own).
export const SpeakingBars = {
  update(bars: HTMLElement[], height: number, clock: number, color: string): void {
    bars.forEach((b, i) => {
      const phase = clock * 7 + i * 1.7;
      const v = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(phase) * Math.cos(phase * 0.37 + i));
      b.style.width = `${height * 0.2}px`;
      b.style.height = `${height * v}px`;
      b.style.marginRight = i < 3 ? `${height * 0.16}px` : '0';
      b.style.background = color;
    });
  },
};

/// The person's words once Yanni answers: a slim dark pill docked at the bottom, "YOU" and the words on one line.
export class CaptionPill {
  readonly el = document.createElement('div');
  private readonly words = document.createElement('span');
  private key = '';

  constructor() {
    this.el.className = 'caption-pill';
    const you = document.createElement('span');
    you.className = 'caption-pill-name';
    you.textContent = 'You';
    this.words.className = 'caption-pill-words';
    this.el.append(you, this.words);
  }

  update(text: string, m: CaptionMetrics): void {
    const k = `${text}|${m.key}`;
    if (k === this.key) return;
    this.key = k;
    const s = m.pillSize();
    const f = Math.max(s.height * 0.36, 13);
    const st = this.el.style;
    st.width = `${s.width}px`;
    st.height = `${s.height}px`;
    st.padding = `0 ${s.height * 0.5}px`;
    st.gap = `${f * 0.8}px`;
    st.fontSize = `${f}px`;
    st.borderWidth = `${Math.max(m.ink * 0.8, 1.5)}px`;
    this.words.textContent = text;
  }
}

interface Rect { x: number; y: number; w: number; h: number }

/// The bubble's ink, layered like the eyes: the rim band, the ink line, then the ivory, each a rounded rectangle
/// whose edge carries slow, low-frequency noise (out of phase between layers, so the line's weight breathes a little
/// like a brush stroke). The person's tail hangs from the bottom right; Yanni's points up from the top centre.
export const BubbleInk = {
  draw(ctx: CanvasRenderingContext2D, r: Rect, kind: CaptionKind, m: CaptionMetrics, t: number, style: RenderStyle): void {
    const lw = m.line;
    const radius = Math.min(r.h / 2, m.font * 0.9);
    const amp = Math.max(lw * 0.3, 1.2);
    const layers: [number, number, V3][] = [
      [lw / 2, 0, style.rimColor],
      [lw / 2 - m.rim, 0.8, style.inkColor],
      [-lw / 2, 1.9, style.scleraColor],
    ];
    layers.forEach(([grow, seed, color], i) => {
      const rr = Math.max(radius + grow, 1);
      ctx.fillStyle = cssLinear(color);
      ctx.fill(BubbleInk.blob({ x: r.x - grow, y: r.y - grow, w: r.w + 2 * grow, h: r.h + 2 * grow }, rr, amp, t, seed));
      ctx.fill(tailPath(r, kind, m, lw / 2 - grow, i === 2));
    });
  },

  /// A closed, smooth (Catmull-Rom) path through 64 points around the rounded rectangle, each pushed along the edge
  /// normal by two slow sines (3 and 5 bumps around the edge).
  blob(r: Rect, radius: number, amp: number, t: number, seed: number): Path2D {
    const n = 64;
    const rr = Math.max(0, Math.min(radius, Math.min(r.w, r.h) / 2));
    const sw = r.w - 2 * rr, sh = r.h - 2 * rr, arc = Math.PI * rr / 2;
    const total = 2 * sw + 2 * sh + 4 * arc;
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = i / n;
      const [px, py, nx, ny] = edgePoint(r, rr, sw, sh, arc, s * total);
      const ph = s * 2 * Math.PI;
      const off = amp * (0.6 * Math.sin(3 * ph + t * 0.7 + seed) + 0.4 * Math.sin(5 * ph - t * 0.45 + seed * 2.3));
      xs.push(px + nx * off); ys.push(py + ny * off);
    }
    const path = new Path2D();
    path.moveTo(xs[0], ys[0]);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n, c = (i + 2) % n;
      path.bezierCurveTo(xs[i] + (xs[b] - xs[a]) / 6, ys[i] + (ys[b] - ys[a]) / 6,
        xs[b] - (xs[c] - xs[i]) / 6, ys[b] - (ys[c] - ys[i]) / 6, xs[b], ys[b]);
    }
    path.closePath();
    return path;
  },
};

/// The point `d` along the rounded rectangle's edge (clockwise from the top edge's left end) and its outward normal.
function edgePoint(r: Rect, rr: number, sw: number, sh: number, arc: number, d: number): [number, number, number, number] {
  const minX = r.x, minY = r.y, maxX = r.x + r.w, maxY = r.y + r.h;
  const corner = (cx: number, cy: number, a0: number): [number, number, number, number] => {
    const a = a0 + (rr > 0 ? d / rr : 0);
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a), Math.cos(a), Math.sin(a)];
  };
  if (d < sw) return [minX + rr + d, minY, 0, -1];
  d -= sw;
  if (d < arc) return corner(maxX - rr, minY + rr, -Math.PI / 2);
  d -= arc;
  if (d < sh) return [maxX, minY + rr + d, 1, 0];
  d -= sh;
  if (d < arc) return corner(maxX - rr, maxY - rr, 0);
  d -= arc;
  if (d < sw) return [maxX - rr - d, maxY, 0, 1];
  d -= sw;
  if (d < arc) return corner(minX + rr, maxY - rr, Math.PI / 2);
  d -= arc;
  if (d < sh) return [minX, maxY - rr - d, -1, 0];
  d -= sh;
  return corner(minX + rr, minY + rr, Math.PI);
}

/// A curved wedge from the body's edge out to a tip, shrunk by `inset` for the inner layers; its base sits well inside
/// the body so the layers close around it. The person's leans out past the bottom-right corner; Yanni's rises from the
/// top centre with a slight lean.
function tailPath(r: Rect, kind: CaptionKind, m: CaptionMetrics, i: number, inner: boolean): Path2D {
  const len = m.tail, w = m.font * 0.85, lw = m.line;
  const sink = inner ? lw * 1.2 : lw;   // how far inside the body the base sits
  const minY = r.y, maxX = r.x + r.w, maxY = r.y + r.h, midX = r.x + r.w / 2;
  const p = new Path2D();
  if (kind === 'you') {
    const baseY = maxY - sink;
    const ax = maxX - m.font * 0.8 - w + i, bx = maxX - m.font * 0.8 - i * 0.4;
    const tx = maxX - m.font * 0.45 - i * 0.9, ty = maxY + len - i * 1.3;
    p.moveTo(ax, baseY);
    p.quadraticCurveTo(ax + w * 0.45, maxY + len * 0.7, tx, ty);
    p.quadraticCurveTo(bx + w * 0.12, maxY + len * 0.3, bx, baseY);
  } else {
    const baseY = minY + sink;
    const ax = midX - w / 2 + i, bx = midX + w / 2 - i;
    const tx = midX - w * 0.1 + i * 0.3, ty = minY - len * 1.45 + i * 1.4;
    p.moveTo(ax, baseY);
    p.quadraticCurveTo(ax + w * 0.3, minY - len * 0.5, tx, ty);
    p.quadraticCurveTo(bx - w * 0.2, minY - len * 0.4, bx, baseY);
  }
  p.closePath();
  return p;
}
