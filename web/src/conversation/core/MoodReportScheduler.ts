// Port of ConversationCore/MoodReportScheduler.swift.
import type { MoodReportPayload } from '../events/AgentIntents';

export type MoodTrigger = 'connect' | 'endOfTurn' | 'replyEnd';

/** When to send the emotion layer's mood report upstream (review C4). The report itself is sent verbatim; this only
 *  decides the moments: the session becomes ready, listening → thinking, speaking → follow-up, a label change (at most
 *  once per `labelMinGap`; a pending change is sent when the gap has passed), and a heartbeat while connected. */
export class MoodReportScheduler {
  latest: MoodReportPayload | null = null;
  lastSent: MoodReportPayload | null = null;
  lastSentAt = -Infinity;
  private labelChangePending = false;
  /** Frame-clock rounding slack. */
  static readonly epsilon = 1e-6;

  constructor(public heartbeat = 60, public labelMinGap = 1) {}

  /** The emotion layer produced a report. Returns it when a label change should go out now. */
  note(report: MoodReportPayload, now: number, connected: boolean): MoodReportPayload | null {
    this.latest = report;
    const changed = this.lastSent !== null ? this.lastSent.label !== report.label : false;
    if (changed) this.labelChangePending = true;
    if (!(connected && this.labelChangePending && now - this.lastSentAt >= this.labelMinGap - MoodReportScheduler.epsilon)) return null;
    return this.markSent(now);
  }

  /** A contract trigger: send the latest report now (if there is one). */
  trigger(_t: MoodTrigger, now: number, connected: boolean): MoodReportPayload | null {
    if (!connected || this.latest === null) return null;
    return this.markSent(now);
  }

  /** Per frame: a deferred label change or the heartbeat. */
  tick(now: number, connected: boolean): MoodReportPayload | null {
    if (!connected || this.latest === null) return null;
    const eps = MoodReportScheduler.epsilon;
    if (this.labelChangePending && now - this.lastSentAt >= this.labelMinGap - eps) return this.markSent(now);
    if (now - this.lastSentAt >= this.heartbeat - eps) return this.markSent(now);
    return null;
  }

  /** The session ended: the next session starts with a connect trigger. */
  sessionEnded(): void {
    this.lastSentAt = -Infinity;
    this.labelChangePending = false;
  }

  private markSent(now: number): MoodReportPayload | null {
    this.lastSent = this.latest;
    this.lastSentAt = now;
    this.labelChangePending = false;
    return this.latest;
  }
}
