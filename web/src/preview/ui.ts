// Small DOM builders for the inspector: labelled controls that write through a setter on input, and read-outs that
// a 4 Hz poller refreshes only while they are on screen. Nothing here runs per frame.
import type { V3 } from '../core/vec';
import { Oklab } from '../model/Oklab';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Runs registered read-outs at 4 Hz while started (the inspector is open and the page visible). */
export class Poller {
  private fns: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly interval = 250) {}

  add(fn: () => void): void { this.fns.push(fn); }
  /** Drops every read-out (a section was replaced). */
  reset(): void { this.fns = []; }
  get running(): boolean { return this.timer !== undefined; }

  start(): void {
    if (this.timer !== undefined) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.interval);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    for (const f of this.fns) f();
  }
}

/** The builder context a section gets: the poller for its read-outs and a way to rebuild itself (after a reset). */
export interface Build {
  poll: Poller;
  rebuild(): void;
  /** Runs when the section leaves the screen (subscriptions, timers it started). */
  onDispose(fn: () => void): void;
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'pv-section' }, h('h3', {}, title), ...children);
}

export function group(title: string, ...children: Child[]): HTMLDetailsElement {
  return h('details', { class: 'pv-group' }, h('summary', {}, title), ...children);
}

export function note(text: string): HTMLElement { return h('p', { class: 'pv-note' }, text); }
export function caption(text: string): HTMLElement { return h('div', { class: 'pv-caption' }, text); }

/** A button grid; each entry is [label, action] (null skips). */
export function buttons(...items: ([string, () => void] | null)[]): HTMLElement {
  const grid = h('div', { class: 'pv-buttons' });
  for (const it of items) if (it) grid.append(button(it[0], it[1]));
  return grid;
}

export function button(label: string, action: () => void): HTMLButtonElement {
  return h('button', { type: 'button', textContent: label, onclick: action });
}

export function slider(label: string, get: () => number, set: (v: number) => void, range: readonly [number, number],
  format: (v: number) => string = (v) => v.toFixed(2), step?: number): HTMLElement {
  const out = h('output', {});
  const input = h('input', { type: 'range', min: String(range[0]), max: String(range[1]),
    step: String(step ?? (range[1] - range[0]) / 200) });
  input.setAttribute('aria-label', label);
  const show = (): void => { out.textContent = format(get()); };
  input.value = String(get());
  input.addEventListener('input', () => { set(Number(input.value)); show(); });
  show();
  return h('label', { class: 'pv-slider' }, h('span', {}, label), out, input);
}

export function toggle(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: get() });
  input.addEventListener('change', () => set(input.checked));
  return h('label', { class: 'pv-toggle' }, input, h('span', {}, label));
}

export function select<T extends string | number>(label: string, options: readonly (readonly [T, string])[], get: () => T,
  set: (v: T) => void): HTMLElement {
  const sel = h('select', {});
  sel.setAttribute('aria-label', label);
  options.forEach(([v, text], i) => sel.append(h('option', { value: String(i), textContent: text, selected: v === get() })));
  sel.addEventListener('change', () => set(options[Number(sel.value)]![0]));
  return h('label', { class: 'pv-select' }, h('span', {}, label), sel);
}

/** A segmented picker (radio buttons). */
export function segmented<T extends string | number>(label: string, options: readonly (readonly [T, string])[],
  get: () => T, set: (v: T) => void): HTMLElement {
  const box = h('div', { class: 'pv-segmented', role: 'radiogroup' });
  box.setAttribute('aria-label', label);
  const name = `pv-seg-${Math.random().toString(36).slice(2)}`;
  for (const [v, text] of options) {
    const input = h('input', { type: 'radio', name, checked: v === get() });
    input.addEventListener('change', () => { if (input.checked) set(v); });
    box.append(h('label', {}, input, h('span', {}, text)));
  }
  return box;
}

export function textField(label: string, get: () => string, set: (v: string) => void, multiline = false): HTMLElement {
  const input = multiline ? h('textarea', { rows: 3, value: get() }) : h('input', { type: 'text', value: get() });
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => set(input.value));
  return h('label', { class: 'pv-text' }, h('span', {}, label), input);
}

const hex6 = (c: V3): string => `#${Oklab.hex(c).toString(16).padStart(6, '0')}`;
export const hexText = (c: V3): string => hex6(c).toUpperCase();

/** A colour well over a linear-RGB value. */
export function color(label: string, get: () => V3, set: (v: V3) => void): HTMLElement {
  const input = h('input', { type: 'color', value: hex6(get()) });
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => set(Oklab.linear(parseInt(input.value.slice(1), 16))));
  return h('label', { class: 'pv-color' }, h('span', {}, label), input);
}

export function swatch(c: V3): HTMLElement {
  const el = h('span', { class: 'pv-swatch' });
  el.style.background = hex6(c);
  return el;
}

/** A read-out line the poller refreshes (the DOM is touched only when the text changes). */
export function readout(b: Build, text: () => string, cls = 'pv-readout'): HTMLElement {
  const el = h('div', { class: cls });
  let last = '';
  const f = (): void => { const t = text(); if (t !== last) { last = t; el.textContent = t; } };
  f();
  b.poll.add(f);
  return el;
}
