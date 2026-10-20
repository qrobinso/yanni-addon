// The optional translucent HUD: fps, frame-gap p99 (FrameStats, the current tier), the connection and the last event.
// Toggled from the owner menu; hides itself after 10 minutes so it can't burn in. Updates at 2 Hz, never per frame.
import type { FrameClock } from '../render/FrameClock';
import { StatsTier } from '../render/FrameStats';

export class Hud {
  static readonly autoHide = 10 * 60;
  readonly el = document.createElement('div');
  lastEvent = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private shownAt = 0;
  private ticks = 0;
  private at = 0;

  constructor(private readonly clock: FrameClock, private readonly connection: () => string) {
    this.el.className = 'hud';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.hidden = true;
  }

  get visible(): boolean { return !this.el.hidden; }

  toggle(): void { if (this.visible) this.hide(); else this.show(); }

  show(): void {
    this.el.hidden = false;
    this.shownAt = performance.now() / 1000;
    this.ticks = this.clock.ticks;
    this.at = this.shownAt;
    this.timer ??= setInterval(() => this.update(), 500);
  }

  hide(): void {
    this.el.hidden = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  note(event: string): void { this.lastEvent = event; }

  private update(): void {
    const now = performance.now() / 1000;
    if (now - this.shownAt >= Hud.autoHide) { this.hide(); return; }
    const fps = (this.clock.ticks - this.ticks) / Math.max(now - this.at, 1e-3);
    this.ticks = this.clock.ticks;
    this.at = now;
    const tier = StatsTier.from(this.clock.policy.tier);
    const p99 = this.clock.stats.peek(1).tier(tier).gapP99 * 1000;
    this.el.textContent = `${fps.toFixed(0)} fps · ${StatsTier.label(tier)} tier · gap p99 ${p99.toFixed(1)} ms\n`
      + `${this.connection()}${this.clock.isBackupRunning ? ' · backup clock' : ''}\n${this.lastEvent}`;
  }
}
