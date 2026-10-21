// Port of the app's Kiosk/BurnInCheck.swift. The burn-in / image-retention check (hardening design §8): full-screen
// uniform fields over the face, 20 s each — 18 % grey, 50 % grey, pure red, green and blue, then a black-to-white grey
// ramp — to inspect an OLED panel for burn-in or an LCD for image retention. A tap anywhere (or Escape, or the
// screen reader's activate) exits; it also ends by itself after the last step.

export type BurnInStep = 'grey18' | 'grey50' | 'red' | 'green' | 'blue' | 'ramp';

export const BurnInCheckModel = {
  stepSeconds: 20,
  steps: ['grey18', 'grey50', 'red', 'green', 'blue', 'ramp'] as readonly BurnInStep[],

  /// The step at `elapsed` seconds, or null once the sequence is over.
  step(elapsed: number): BurnInStep | null {
    return BurnInCheckModel.steps[Math.floor(elapsed / BurnInCheckModel.stepSeconds)] ?? null;
  },

  /// The CSS background for a step (sRGB, as the Swift colours).
  field(s: BurnInStep): string {
    switch (s) {
      case 'grey18': return 'rgb(46, 46, 46)';      // 0.18 white
      case 'grey50': return 'rgb(128, 128, 128)';   // 0.5 white
      case 'red': return 'rgb(255, 0, 0)';
      case 'green': return 'rgb(0, 255, 0)';
      case 'blue': return 'rgb(0, 0, 255)';
      case 'ramp': return 'linear-gradient(to right, #000, #fff)';
    }
  },

  name(s: BurnInStep): string {
    switch (s) {
      case 'grey18': return 'dark grey';
      case 'grey50': return 'mid grey';
      case 'red': return 'red';
      case 'green': return 'green';
      case 'blue': return 'blue';
      case 'ramp': return 'grey ramp';
    }
  },

  /// "Step n of 6: name" (the screen reader's value).
  value(elapsed: number): string {
    const count = BurnInCheckModel.steps.length;
    const index = Math.floor(elapsed / BurnInCheckModel.stepSeconds);
    const number = Math.min(index, count - 1) + 1;
    return `Step ${number} of ${count}: ${BurnInCheckModel.name(BurnInCheckModel.step(elapsed) ?? 'ramp')}`;
  },
};

/// Shows the check full screen over everything; resolves when it ends (tap, Escape, or after the last step).
export function runBurnInCheck(doc: Document = document, now: () => number = () => performance.now() / 1000): Promise<void> {
  return new Promise((resolve) => {
    const el = doc.createElement('div');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Burn-in check');
    el.setAttribute('aria-description', 'Tap to exit.');
    el.tabIndex = 0;
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:none;touch-action:none;outline:none';
    const started = now();
    let shown: BurnInStep | null | undefined;
    const paint = () => {
      const e = now() - started;
      const s = BurnInCheckModel.step(e);
      if (s === null) { finish(); return; }
      if (s !== shown) { shown = s; el.style.background = BurnInCheckModel.field(s); }
      el.setAttribute('aria-valuetext', BurnInCheckModel.value(e));
      el.setAttribute('aria-label', `Burn-in check, ${BurnInCheckModel.value(e)}`);
    };
    const timer = setInterval(paint, 1000);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(); } };
    let done = false;
    function finish(): void {
      if (done) return;
      done = true;
      clearInterval(timer);
      doc.removeEventListener('keydown', onKey, true);
      el.remove();
      resolve();
    }
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); finish(); });
    el.addEventListener('click', finish);
    doc.addEventListener('keydown', onKey, true);
    paint();
    doc.body.append(el);
    el.focus();
  });
}
