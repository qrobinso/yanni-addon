// Browser kiosk plumbing: keep the screen on, no zoom / selection / context menu,
// unlock audio on the first gesture, and the Reduce Motion flag.

/** Screen Wake Lock, re-acquired whenever the page becomes visible again (the browser drops it when hidden). */
export function keepScreenOn(): void {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<unknown> } }).wakeLock;
  if (!wl) return;
  const acquire = () => { if (document.visibilityState === 'visible') wl.request('screen').catch(() => {}); };
  acquire();
  document.addEventListener('visibilitychange', acquire);
}

/** No pinch or double-tap zoom, text selection, callouts or context menu over the face (CSS does the rest). */
export function lockDownGestures(): void {
  for (const t of ['contextmenu', 'gesturestart', 'gesturechange', 'dblclick', 'selectstart']) {
    document.addEventListener(t, (e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }, { passive: false });
  }
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
}

/** Resumes `ctx` on the first gesture. Shows `hint` only while audio is actually blocked (autoplay not allowed). */
export function unlockAudio(ctx: AudioContext, hint: HTMLElement): void {
  const events = ['pointerdown', 'pointerup', 'keydown'];
  const gesture = () => { ctx.resume().catch(() => {}); };
  let checked = false;
  const update = () => {
    const ok = ctx.state === 'running' || ctx.state === 'closed';
    if (ok) for (const t of events) removeEventListener(t, gesture, true);
    if (checked) hint.hidden = ok;
  };
  ctx.addEventListener('statechange', update);
  for (const t of events) addEventListener(t, gesture, true);
  gesture();
  // A kiosk browser that allows autoplay is running by now: the hint never shows there.
  setTimeout(() => { checked = true; update(); }, 1000);
}

/** prefers-reduced-motion, live. `onChange` fires on a change (the engine's Reduce Motion flag). */
export const motion = {
  query: typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined,
  get reduce(): boolean { return this.query?.matches ?? false; },
  onChange(fn: (reduce: boolean) => void): void { this.query?.addEventListener('change', (e) => fn(e.matches)); },
};

/** The face's live description for screen readers (the canvas is one `img` element named "Yanni"). */
export function describeFace(text: string): void {
  const d = document.getElementById('face-desc');
  if (d && d.textContent !== text) d.textContent = text;
}
