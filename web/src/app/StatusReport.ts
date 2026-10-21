// The render loop's numbers for the owner Status page (the HUD's fps and frame-gap p99, without the HUD): sent as a
// `state` report, which the add-on keeps for the Status page (these keys are not Home Assistant entities).
//
// Wiring (not done yet, main.ts belongs to another work package): next to the 4 Hz face report,
//   const render = new RenderReport(clock);
//   setInterval(() => { const r = render.sample(); const diff = changed(reported, r);
//     if (Object.keys(diff).length && client?.sendState(diff)) Object.assign(reported, diff); }, RenderReport.interval * 1000);
// and the announcement queue (conversation/announcements) feeds `pending_messages` the same way with `queue.report()`.
import type { DisplayState } from '@yanni/server/protocol';
import type { FrameClock } from '../render/FrameClock';
import { StatsTier } from '../render/FrameStats';

export type RenderStatus = Pick<DisplayState, 'fps' | 'frame_gap_p99_ms' | 'render_tier'>;

export class RenderReport {
  /** Seconds between samples (slow on purpose: a status page, not a HUD). */
  static readonly interval = 5;
  private ticks: number;
  private at: number;

  constructor(private readonly clock: Pick<FrameClock, 'ticks' | 'policy' | 'stats'>,
    private readonly now: () => number = () => performance.now() / 1000) {
    this.ticks = clock.ticks;
    this.at = now();
  }

  /** Fps since the last sample (whole frames), the current tier's frame-gap p99 (0.1 ms) and the tier's name. */
  sample(): RenderStatus {
    const t = this.now();
    const fps = (this.clock.ticks - this.ticks) / Math.max(t - this.at, 1e-3);
    this.ticks = this.clock.ticks;
    this.at = t;
    const tier = StatsTier.from(this.clock.policy.tier);
    const p99 = this.clock.stats.peek(1).tier(tier).gapP99 * 1000;
    return { fps: Math.round(fps), frame_gap_p99_ms: Math.round(p99 * 10) / 10, render_tier: StatsTier.label(tier) };
  }
}
