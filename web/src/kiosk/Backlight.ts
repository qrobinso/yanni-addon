// Port of the app's Kiosk/Backlight.swift. "Backlight follows sleep" on LCD panels (hardening design §7.3): entering
// asleep eases the screen down in steps over 3 s to 20 %; any other phase or hiding the page restores it. Never on
// OLED. port-note: a web page can't set the screen brightness, so the face's canvas is dimmed instead with a CSS
// `brightness()` filter (the pixels, not the backlight: it darkens the room as much, it can't save the backlight's
// power). The face's own motion and frame brightness are untouched.

export interface Dimmable { style: { filter: string } }

export class BacklightFollower {
  static readonly asleepFraction = 0.2;
  static readonly rampSeconds = 3.0;
  static readonly steps = 12;

  /// The level the ramp is at (1 = undimmed), or null when not dimmed.
  saved: number | null = null;
  level = 1;
  private ramp: ReturnType<typeof setInterval> | undefined;
  private rampStep = 0;

  constructor(readonly enabled: boolean, private readonly target: Dimmable | null) {}

  /// The life phase changed: dim on asleep, restore on anything else.
  phaseChanged(asleep: boolean): void {
    if (!this.enabled) return;
    if (asleep) this.dim(); else this.restore();
  }

  dim(): void {
    if (!this.enabled || this.saved !== null || !this.target) return;
    const start = 1;
    this.saved = start;
    this.rampTo(start * BacklightFollower.asleepFraction, start);
  }

  restore(): void {
    if (this.saved === null) return;
    this.level = this.saved;
    this.saved = null;
    if (this.ramp !== undefined) clearInterval(this.ramp);
    this.ramp = undefined;
    this.paint();
  }

  private rampTo(target: number, start: number): void {
    if (this.ramp !== undefined) clearInterval(this.ramp);
    this.rampStep = 0;
    this.ramp = setInterval(() => {
      this.rampStep += 1;
      const k = this.rampStep / BacklightFollower.steps;
      this.level = start + (target - start) * k;
      this.paint();
      if (this.rampStep >= BacklightFollower.steps) { clearInterval(this.ramp); this.ramp = undefined; }
    }, BacklightFollower.rampSeconds / BacklightFollower.steps * 1000);
  }

  private paint(): void {
    if (this.target) this.target.style.filter = this.level >= 1 ? '' : `brightness(${this.level.toFixed(3)})`;
  }
}
