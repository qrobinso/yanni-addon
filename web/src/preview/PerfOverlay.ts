// Port of yanni/Preview/PerfOverlay.swift: the fps / engine frame-time read-out pinned above the Tune sections, polled
// at 4 Hz while visible from the clock's counters (nothing added to the frame path).
import type { FrameClock } from '../render/FrameClock';
import { h, type Build } from './ui';

export function perfReadout(clock: FrameClock, b: Build, onPoll: () => void = () => {}): HTMLElement {
  const fps = h('span', {}), engine = h('span', {}), frames = h('span', {});
  const stat = (label: string, v: HTMLElement) => h('div', {}, h('small', {}, label), v);
  let lastTicks = clock.ticks, lastWall = performance.now();
  b.poll.add(() => {
    const now = performance.now(), ticks = clock.ticks;
    fps.textContent = ((ticks - lastTicks) / Math.max((now - lastWall) / 1000, 1e-6)).toFixed(1);
    engine.textContent = `${(clock.lastTickSeconds * 1000).toFixed(3)} ms`;
    frames.textContent = String(ticks);
    lastTicks = ticks;
    lastWall = now;
    onPoll();
  });
  return h('div', { class: 'pv-perf', role: 'status' }, stat('fps', fps), stat('engine + hooks', engine), stat('frames', frames));
}
