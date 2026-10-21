// Browser kiosk plumbing: keep the screen on, no zoom / selection / context menu,
// unlock audio on the first gesture, and the Reduce Motion flag.
import { installAudioUnlock } from '../voice/playback/VoiceAudioHost';

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

/** Resumes `ctx` on the first gesture (`installAudioUnlock`). Shows `hint` only while audio is actually blocked
 *  (autoplay not allowed). */
export function unlockAudio(ctx: AudioContext, hint: HTMLElement): void {
  installAudioUnlock(ctx);
  ctx.resume().catch(() => {});
  let checked = false;
  const update = () => { if (checked) hint.hidden = ctx.state === 'running' || ctx.state === 'closed'; };
  ctx.addEventListener('statechange', update);
  // A kiosk browser that allows autoplay is running by now: the hint never shows there.
  setTimeout(() => { checked = true; update(); }, 1000);
}

/** prefers-reduced-motion, live. `onChange` fires on a change (the engine's Reduce Motion flag). */
export const motion = {
  query: typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined,
  get reduce(): boolean { return this.query?.matches ?? false; },
  onChange(fn: (reduce: boolean) => void): void { this.query?.addEventListener('change', (e) => fn(e.matches)); },
};
