// The production slice of yanni/Perception/PerceptionHarness.swift: the perception counters behind the Home Assistant
// sensors (false engagements, gesture reactions and wrong-reaction reports per hour) and the owner's "Wrong reaction"
// (Status page or the HA button). port-note: the consented feature recorder, labelled sessions, the skeleton viewer
// and the timing HUD are dev tools and aren't ported; `perception_recording` is always false.
import type { DisplayState } from '@yanni/server/protocol';
import type { ConversationPerception } from '../conversation/core/Ports';
import { PerceptionCounters } from '../perception/PerceptionCounters';
import type { PerceptionEvent } from '../perception/PerceptionTypes';

export class PerceptionHarness {
  readonly counters = new PerceptionCounters();
  /** The last "Wrong reaction" message (Status). */
  message = '';
  private lastSlowTick = -Infinity;

  /** Every coordinator log entry (camera only). */
  note(e: PerceptionEvent, note: string | null, now: number): void { this.counters.note(e, note, now); }

  noteEngagementOutcome(spoke: boolean): void { this.counters.noteEngagementOutcome(spoke); }

  /** The owner's "Wrong reaction": counts a false positive. */
  wrongReaction(): string {
    const last = this.counters.reportWrongReaction();
    this.message = last ? `Marked ${last.gesture} → ${last.beat} as a wrong reaction` : 'Counted (no reaction yet)';
    return this.message;
  }

  /** The 4 Hz tick: the channels' spans; once a second, re-entries from the people in view. */
  tick(now: number, visibleIDs: () => readonly number[]): void {
    this.counters.tick(now);
    if (now - this.lastSlowTick < 0.99) return;
    this.lastSlowTick = now;
    this.counters.noteVisible(visibleIDs());
  }

  homeSignals(): Pick<DisplayState, 'false_engagements_per_hour' | 'gesture_reactions_per_hour' |
    'gesture_false_reports_per_hour' | 'perception_recording'> {
    const c = this.counters.lifetime;
    const r = (x: number) => Math.round(x * 10) / 10;
    return { false_engagements_per_hour: r(c.perHour(c.falseEngagements)), gesture_reactions_per_hour: r(c.perHour(c.reactions)),
      gesture_false_reports_per_hour: r(c.perHour(c.gestureFalsePositives)), perception_recording: false };
  }
}

/** The voice loop's view of perception, counting each engagement's outcome on the way (CountingConversationPerception). */
export function countingConversationPerception(base: ConversationPerception, harness: PerceptionHarness): ConversationPerception {
  return {
    pinTurn: (id) => base.pinTurn(id),
    unpinTurn: () => base.unpinTurn(),
    releaseTurn: () => base.releaseTurn(),
    noteEngagementOutcome: (id, spoke) => { harness.noteEngagementOutcome(spoke); base.noteEngagementOutcome(id, spoke); },
    setLookToTalkDryRun: (on) => base.setLookToTalkDryRun(on),
  };
}
