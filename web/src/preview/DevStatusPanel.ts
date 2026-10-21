// Port of yanni/Preview/DevStatusPanel.swift: the Status page. One card per subsystem with a status dot (rebuilt only
// when its text changed), the kiosk's Health card with the diagnostics export and burn-in refresh when present, the
// HUD switch, and the filterable, pausable event log. Polled at 4 Hz only while on screen.
import type { AppContext } from '../app/AppContext';
import { DevStatusModel, StatusLevel, type StatusCard, type StatusKioskPort } from './DevStatus';
import { EventLogView, type EventSource, type LoggedEvent } from './EventLog';
import { button, h, Poller, swatch, toggle } from './ui';
import { perceptionKeepsButtons } from './perception/PerceptionKeepsCard';

const CATEGORY_COLOR: Record<string, string> = {
  Face: '#5ad1e6', Life: '#bf8cff', Voice: '#ff8fc8', Touch: '#ffb35c', People: '#7be08f', Emotion: '#f5d76e', HA: '#4fd1c5',
  Scene: '#8ef0c8', Talk: '#8c9cff',
};

export function renderCard(c: StatusCard): HTMLElement {
  const dot = h('span', { class: `pv-dot ${c.level}` });
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', StatusLevel.label(c.level));
  const el = h('article', { class: 'pv-card' }, h('header', {}, dot, h('b', {}, c.title), h('small', {}, c.detail || StatusLevel.label(c.level))));
  if (c.swatches?.length) el.append(h('div', { class: 'pv-toggle' }, ...c.swatches.flatMap((s) => [swatch(s.color), h('span', { class: 'pv-note' }, s.label)])));
  for (const r of c.rows) {
    if (r.bar) {
      const { value, min, max, color } = r.bar;
      const span = max - min, zero = (Math.min(Math.max(0, min), max) - min) / span, pos = (Math.min(Math.max(value, min), max) - min) / span;
      const fill = h('i', {});
      fill.style.left = `${Math.min(pos, zero) * 100}%`;
      fill.style.width = `${Math.max(Math.abs(pos - zero) * 100, 1)}%`;
      if (color) fill.style.background = color;
      el.append(h('div', { class: 'pv-row bar' }, h('span', {}, r.label), h('span', { class: 'mini' }, fill), h('span', {}, r.value)));
    } else {
      el.append(h('div', { class: 'pv-row' }, h('span', {}, r.label), h('span', { class: r.tint ? `t-${r.tint}` : '' }, r.value)));
    }
  }
  if (c.rows.length === 0) el.append(h('p', { class: 'pv-note' }, 'Not attached.'));
  if (c.note) el.append(h('p', { class: 'pv-note' }, c.note));
  return el;
}

export class StatusPage {
  readonly el: HTMLElement;
  readonly poll = new Poller();
  readonly model: DevStatusModel;
  readonly view: EventLogView;
  private readonly cards = h('div', {});
  private readonly shown = new Map<string, { el: HTMLElement; key: string }>();
  private readonly chips = h('div', { class: 'pv-chips' });
  private readonly logList = h('div', { class: 'pv-log', role: 'log' });
  private readonly logDetail = h('small', {});
  private lastLog: number | string = -1;
  private chipKey = '';

  constructor(readonly ctx: AppContext, log: EventSource, readonly kiosk: StatusKioskPort | null = null) {
    this.model = new DevStatusModel(ctx, log, kiosk);
    this.view = new EventLogView(log);
    const hud = toggle('Face HUD overlay (hides after 10 min)', () => ctx.hud.visible, () => ctx.hud.toggle());
    const kioskButtons = h('div', { class: 'pv-buttons' },
      kiosk?.exportDiagnostics ? button('Export diagnostics', () => void kiosk.exportDiagnostics!()) : null,
      kiosk?.burnInRefresh ? button('Burn-in refresh', () => void kiosk.burnInRefresh!()) : null,
      ctx.harness ? button('Wrong reaction', () => { ctx.harness?.wrongReaction(); }) : null);
    const keepsButtons = ctx.harness ? perceptionKeepsButtons(ctx.harness, this.poll) : null;
    const logCard = h('article', { class: 'pv-card' },
      h('header', {}, h('span', { class: 'pv-dot running' }), h('b', {}, 'Event log'), this.logDetail), this.chips, this.logList);
    this.el = h('div', { class: 'pv-body' }, hud, kioskButtons, keepsButtons, this.cards, logCard);
    this.poll.add(() => this.refresh());
  }

  start(): void { this.poll.start(); }
  stop(): void { this.poll.stop(); }

  refresh(): void {
    const seen = new Set<string>();
    let prev: HTMLElement | null = null;
    for (const c of this.model.poll()) {
      seen.add(c.id);
      const key = JSON.stringify(c);
      let s = this.shown.get(c.id);
      if (!s || s.key !== key) {
        const el = renderCard(c);
        if (s) s.el.replaceWith(el); else (prev ? prev.after(el) : this.cards.prepend(el));
        s = { el, key };
        this.shown.set(c.id, s);
      }
      prev = s.el;
    }
    for (const [id, s] of this.shown) if (!seen.has(id)) { s.el.remove(); this.shown.delete(id); }
    this.refreshLog();
  }

  private refreshLog(force = false): void {
    const log = this.view.log;
    const cats = this.view.categories();
    const chipKey = cats.join() + [...this.view.hidden].join() + this.view.paused;
    if (chipKey !== this.chipKey) {
      this.chipKey = chipKey;
      this.chips.replaceChildren(...cats.map((c) => {
        const bt = button(c, () => { this.view.toggle(c); this.refreshLog(true); });
        bt.classList.toggle('on', this.view.isShown(c));
        bt.setAttribute('aria-pressed', String(this.view.isShown(c)));
        return bt;
      }), button(this.view.paused ? 'Resume' : 'Pause', () => { this.view.togglePause(); this.refreshLog(true); }),
      button('Clear', () => { this.view.clear(); this.refreshLog(true); }));
    }
    if (!force && log.version === this.lastLog) return;
    this.lastLog = log.version;
    const events = this.view.visible();
    this.logDetail.textContent = `${events.length} shown${this.view.paused ? ' · paused' : ''}`;
    this.logList.replaceChildren(...(events.length ? events.slice(0, 100).flatMap(row) : [h('span', { class: 'pv-note' }, 'No events yet.')]));
  }
}

function row(e: LoggedEvent): HTMLElement[] {
  const c = h('span', { class: 'c' }, e.category);
  c.style.color = CATEGORY_COLOR[e.category] ?? '#b9c0cc';
  return [h('span', { class: 'pv-note' }, new Date(e.at).toLocaleTimeString([], { hour12: false })), c, h('span', {}, e.text)];
}
