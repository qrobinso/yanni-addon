// Port of yanni/Perception/PerceptionKeepsCard.swift: the Status page's "What perception keeps" (perception upgrade
// design §13) and the measurement counters (§5.3): whether movement recording is on (or paused) and who is declared,
// the stored sessions, the counters, and the card's buttons (Wrong reaction, Sessions…, Stop recording, Delete all).
import type { PerceptionHarness } from '../../app/PerceptionHarness';
import { RecordingSessionType } from '../../perception/FeatureRecordFormat';
import type { StatusCard, StatusRow } from '../DevStatus';
import { button, h, type Poller } from '../ui';
import { openSkeletonViewer } from './SkeletonViewer';

const mb = (b: number): string => (b / 1_048_576).toFixed(1);
const list = (v: readonly string[]): string => v.length <= 1 ? (v[0] ?? '') : `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}`;

export function perceptionKeepsCard(harness: PerceptionHarness | undefined): StatusCard | null {
  if (!harness) return null;
  const s = harness.status, c = harness.counts;
  const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
  const rows: StatusRow[] = [
    { label: 'models', value: 'rules only (no trained models yet)' },
    { label: 'eye contact', value: 'geometric (not taught)' },
  ];
  if (s) {
    rows.push({ label: 'recording', tint: s.state === 'paused' ? 'warn' : 'bad',
      value: `${s.state === 'paused' ? 'paused (undeclared person in view)' : 'on'} · ${harness.sessionType ? RecordingSessionType.title(harness.sessionType) : ''}`
        + ` · ${s.elapsed.toFixed(0)} s · ${s.framesWritten} frames${s.framesDropped > 0 ? ` · ${s.framesDropped} dropped` : ''}` });
    rows.push({ label: 'declared', value: list(harness.declared) });
  } else {
    rows.push({ label: 'recording', value: harness.policy.allowed ? 'allowed, not running' : 'off' });
  }
  const ps = harness.policy.participants;
  rows.push({ label: 'participants', value: ps.length === 0 ? 'none declared' : list(ps.map((p) => p.isChild ? `${p.pseudonym} (child)` : p.pseudonym)) });
  const oldest = harness.sessions.reduce<Date | null>((o, x) => (o === null || x.startDate < o ? x.startDate : o), null);
  rows.push({ label: 'sessions', value: `${harness.sessions.length} · ${mb(harness.totalBytes)} MB`
    + `${oldest && oldest.getTime() > 0 ? ` · oldest ${oldest.toLocaleDateString()}` : ''} · kept ${harness.policy.retentionDays} days`
    + (harness.fs ? ` · ${harness.fs.backend.kind}` : ' · in memory') });
  rows.push({ label: 'engagements', value: `${c.engagements} · false ${c.perHour(c.falseEngagements).toFixed(2)} / h · hand-overs ${c.engagedHandOvers} · re-entries ${c.reentries}` });
  rows.push({ label: 'gestures', value: `${sum(c.gestureEvents)} events · ${c.reactions} reactions (${c.perHour(c.reactions).toFixed(2)} / h)` });
  rows.push({ label: 'false positives', value: `${c.gestureFalsePositives} (${c.perHour(c.gestureFalsePositives).toFixed(2)} / h) · button ${c.wrongReactionReports} · none sessions ${c.noneSessionReactions}` });
  if (c.heapSamples > 0) rows.push({ label: 'alloc proxy', value: `${c.heapBlocksPerFrame.toFixed(1)} heap blocks / analysed frame` });
  if (harness.message) rows.push({ label: 'last action', value: harness.message });
  if (harness.fs?.lastError) rows.push({ label: 'storage', value: harness.fs.lastError, tint: 'warn' });
  return {
    id: 'keeps', title: 'What perception keeps', level: s ? 'degraded' : 'running',
    detail: s ? 'recording' : 'nothing recording', rows,
    note: 'Numbers only — no pictures, video or sound. Nothing about faces or bodies leaves this device.',
  };
}

/** The card's buttons; "Stop recording" shows only while a session runs (refreshed by the page's poll). */
export function perceptionKeepsButtons(harness: PerceptionHarness, poll: Poller): HTMLElement {
  const stop = button('Stop recording', () => harness.stop());
  const del = button('Delete all recordings', () => {
    if (confirm('Delete every recorded session on this device?')) harness.deleteAll();
  });
  poll.add(() => {
    stop.hidden = !harness.isRecording;
    del.disabled = harness.sessions.length === 0 && !harness.isRecording;
  });
  return h('div', { class: 'pv-buttons' }, button('Sessions…', () => openSkeletonViewer(harness)), stop, del);
}
