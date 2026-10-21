// The inspector shell (TuningPanel.swift's body): a translucent sidebar with the Tune / Status switch at the top and a
// close button. One per page; opening it again switches the page. Each page polls only while it is the one on screen.
import type { AppContext } from '../app/AppContext';
import type { StatusKioskPort } from './DevStatus';
import { StatusPage } from './DevStatusPanel';
import { appEventLog, contextEventSource, type EventSource } from './EventLog';
import { TunePage } from './TuningPanel';
import { settingsPort, TuningModel } from './TuningModel';
import { button, h, segmented } from './ui';
import './preview.css';

export type InspectorPage = 'tune' | 'status';

/** What the inspector can use beyond the AppContext (each optional; duck-typed). */
export interface InspectorExtras {
  /** I3's kiosk services (`StatusKioskPort`: health card, diagnostics export, burn-in refresh). */
  kiosk?: unknown;
  /** I2's settings hub (`TuningSettingsPort`: get / change the synced owner settings). */
  settings?: unknown;
  /** Default: `ctx.events` when the app keeps them, else `appEventLog`. */
  eventLog?: EventSource;
}

class Inspector {
  readonly el: HTMLElement;
  private page: InspectorPage;
  private tune: TunePage | null = null;
  private status: StatusPage | null = null;
  private readonly slot = h('div', { class: 'pv-slot' });
  onClose: (() => void) | null = null;

  constructor(readonly ctx: AppContext, readonly extras: InspectorExtras, page: InspectorPage) {
    this.page = page;
    this.slot.style.display = 'contents';
    const sw = segmented('Page', [['tune', 'Tune'], ['status', 'Status']] as const, () => this.page, (p) => this.show(p));
    this.el = h('aside', { class: 'pv-inspector' }, h('div', { class: 'pv-head' }, sw, button('✕', () => this.close())), this.slot);
    this.el.setAttribute('aria-label', 'Tuning and status inspector');
    this.el.querySelector('.pv-head > button')?.setAttribute('aria-label', 'Close');
    // Touches and keys inside the inspector never reach the face's gesture recogniser or the space-bar talk.
    for (const t of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click'] as const) this.el.addEventListener(t, (e) => e.stopPropagation());
    this.el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.close(); });
    document.body.append(this.el);
    this.show(page);
  }

  show(p: InspectorPage): void {
    this.page = p;
    const radios = this.el.querySelectorAll<HTMLInputElement>('.pv-head input[type=radio]');
    radios.forEach((r, i) => { r.checked = (i === 0) === (p === 'tune'); });
    this.tune?.stop();
    this.status?.stop();
    if (p === 'tune') {
      this.tune ??= new TunePage(new TuningModel(this.ctx, settingsPort(this.extras.settings)));
      this.slot.replaceChildren(this.tune.el);
      this.tune.start();
    } else {
      this.status ??= new StatusPage(this.ctx, this.extras.eventLog ?? (this.ctx.events ? contextEventSource({ events: this.ctx.events }) : appEventLog), statusKiosk(this.extras.kiosk));
      this.slot.replaceChildren(this.status.el);
      this.status.start();
    }
  }

  close(): void {
    this.tune?.dispose();
    this.status?.stop();
    this.el.remove();
    this.onClose?.();
  }
}

function statusKiosk(x: unknown): StatusKioskPort | null {
  const k = x as StatusKioskPort | null | undefined;
  return k && (typeof k.healthCard === 'function' || typeof k.exportDiagnostics === 'function' || typeof k.burnInRefresh === 'function') ? k : null;
}

let current: Inspector | null = null;

function open(ctx: AppContext, page: InspectorPage, extras: InspectorExtras): () => void {
  if (current && current.ctx === ctx) current.show(page);
  else {
    current?.close();
    const i = new Inspector(ctx, extras, page);
    i.onClose = () => { if (current === i) current = null; };
    current = i;
  }
  const mine = current;
  return () => { if (current === mine) mine.close(); };
}

/** Opens the inspector on the Tune page; returns its close. */
export function openTuning(ctx: AppContext, extras: InspectorExtras = {}): () => void { return open(ctx, 'tune', extras); }

/** Opens the inspector on the Status page; returns its close. */
export function openStatus(ctx: AppContext, extras: InspectorExtras = {}): () => void { return open(ctx, 'status', extras); }
