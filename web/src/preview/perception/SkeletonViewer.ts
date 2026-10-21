// Port of yanni/Perception/SkeletonViewer.swift + SkeletonPlayer.swift: the recorded sessions (Status → "What
// perception keeps" and Tune → Collect) with export, delete and the skeleton viewer; the player shows a recording as
// stick figures with the model outputs underneath and edits its labels (`labels.json`). No image is ever shown.
import type { PerceptionHarness } from '../../app/PerceptionHarness';
import type { FeatureFrame } from '../../perception/FeatureFrameCodec';
import { RecordingSessionType } from '../../perception/FeatureRecordFormat';
import {
  MemoryFileSystem, bytesText, makeSessionLabel, type RecordingSessionSummary, type SessionLabels,
} from '../../perception/FeatureRecordingStore';
import { FeatureRecordingSession } from '../../perception/FeatureRecordingSession';
import { StageTimings } from '../../perception/HarnessTiming';
import { PerceptionRecording } from '../../perception/Replay';
import { RecordingLimits } from '../../perception/RecordingConsent';
import { untarInto } from '../../perception/web/BrowserRecordingFileSystem';
import { button, h } from '../ui';
import { drawSkeleton } from './SkeletonCanvas';
import { download, openSheet, type Sheet } from './sheet';

const mb = (b: number): string => (b / 1_048_576).toFixed(1);

export function sessionSummary(s: RecordingSessionSummary): string {
  const hd = s.header;
  if (!hd) return `${mb(s.bytes)} MB · unreadable header`;
  const dur = hd.endDate ? (hd.endDate.getTime() - hd.startDate.getTime()) / 1000 : null;
  return `${RecordingSessionType.title(hd.sessionType)} · ${hd.participants.map((p) => p.pseudonym).join(', ')} · ${hd.platform}`
    + ` · ${hd.framesWritten} frames${dur !== null ? ` · ${(dur / 60).toFixed(0)} min` : ' · running'} · ${mb(s.bytes)} MB`
    + ` · ${hd.startDate.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/** A session from a picked file: a v1 recording (.json) or an exported session (.tar). */
export async function sessionFromFile(f: File): Promise<FeatureRecordingSession> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  if (f.name.endsWith('.json')) return FeatureRecordingSession.fromV1(PerceptionRecording.decode(bytesText(bytes)), f.name);
  const fs = new MemoryFileSystem();
  const [top] = untarInto(fs, bytes);
  if (!top) throw new Error('empty archive');
  return FeatureRecordingSession.load(fs, `import/${top}`);
}

export function openSkeletonViewer(harness: PerceptionHarness): Sheet {
  const sheet = openSheet('Recorded sessions');
  const showList = (): void => {
    sheet.setTitle('Recorded sessions');
    harness.refreshSessions();
    const msg = h('p', { className: 'pv-note' });
    const show = (t: string) => { msg.textContent = t; };
    const picker = h('input', { type: 'file', accept: '.json,.tar' });
    picker.addEventListener('change', () => {
      const f = picker.files?.[0];
      if (f) sessionFromFile(f).then((s) => showPlayer(s, null), (e: unknown) => show(`Couldn't read ${f.name}: ${e}`));
    });
    const rows = harness.sessions.map((s) => h('div', { className: 'pv-session' },
      h('div', { className: 'pv-mono' }, s.id), h('div', { className: 'pv-note' }, sessionSummary(s)),
      h('div', { className: 'pv-buttons' },
        button('View', () => { show('loading…'); harness.loadSession(s.id).then((x) => showPlayer(x, s.id), (e: unknown) => show(`Couldn't read ${s.id}: ${e}`)); }),
        button('Export', () => { harness.exportTar(s.id).then((x) => download(x.name, x.bytes), () => show('Export failed')); }),
        Object.assign(button('Delete', () => { harness.delete(s.id); showList(); }), { disabled: s.id === harness.sessionID }))));
    sheet.body.replaceChildren(
      h('p', { className: 'pv-note' }, `${harness.sessions.length} sessions · ${mb(harness.totalBytes)} MB of `
        + `${(RecordingLimits.maxTotalBytes / 1e9).toFixed(0)} GB · kept ${harness.policy.retentionDays} days on this device`),
      h('label', {}, 'Open a file (session .tar or v1 .json): ', picker), msg, ...rows,
      ...(harness.sessions.length > 0 ? [button('Delete all recordings', () => {
        if (confirm('Delete every recorded session on this device?')) { harness.deleteAll(); showList(); }
      })] : []));
  };
  const showPlayer = (s: FeatureRecordingSession, storedID: string | null): void => {
    sheet.setTitle(s.header.id);
    // Imported files and v1 recordings are read-only.
    const save = storedID !== null && s.header.platform !== 'v1' ? (l: SessionLabels) => harness.saveSessionLabels(storedID, l) : null;
    sheet.body.replaceChildren(button('Back', () => { player.dispose(); showList(); }), (player = skeletonPlayer(s, save)).el);
  };
  let player: { el: HTMLElement; dispose(): void } = { el: h('div'), dispose() {} };
  sheet.dialog.addEventListener('close', () => player.dispose());
  showList();
  return sheet;
}

/** The player: canvas, play / pause, scrubbing, the frame's outputs and the label editor. */
export function skeletonPlayer(session: FeatureRecordingSession, saveLabels: ((l: SessionLabels) => void) | null): { el: HTMLElement; dispose(): void } {
  const frames = session.frames;
  const t0 = frames[0]?.detections.time ?? 0;
  const labels: SessionLabels = { labels: [...session.labels.labels], marks: [...session.labels.marks] };
  const k = session.header.intrinsics.imageSize;
  const canvas = h('canvas', { width: 640, height: Math.round(640 * k.y / Math.max(k.x, 1)) });
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Recorded frame as stick figures');
  const slider = h('input', { type: 'range', min: '0', max: String(Math.max(frames.length - 1, 1)), step: '1', value: '0' });
  slider.setAttribute('aria-label', 'Frame');
  const time = h('span', { className: 'pv-mono' });
  const outputs = h('div', { className: 'pv-mono' });
  const labelList = h('div', {});
  let index = 0, timer: ReturnType<typeof setTimeout> | undefined, markStart: number | null = null;
  const frame = (): FeatureFrame | null => frames[index] ?? null;
  const play = button('Play', () => (timer === undefined ? start() : stop()));
  const render = (): void => {
    const f = frame();
    slider.value = String(index);
    drawSkeleton(canvas, f);
    time.textContent = `${((f?.detections.time ?? t0) - t0).toFixed(1)} s`;
    outputs.replaceChildren(...(f ? frameLines(session, f, labels) : []));
  };
  const stop = (): void => { clearTimeout(timer); timer = undefined; play.textContent = 'Play'; };
  const step = (): void => {
    if (index + 1 >= frames.length) { stop(); return; }
    const dt = frames[index + 1].detections.time - frames[index].detections.time;
    index += 1;
    render();
    timer = setTimeout(step, Math.min(Math.max(dt, 0.01), 0.5) * 1000);
  };
  const start = (): void => { play.textContent = 'Pause'; timer = setTimeout(step, 0); };
  slider.addEventListener('input', () => { index = Number(slider.value); render(); });

  const label = h('input', { type: 'text', value: 'none', placeholder: 'label (wave, looking, none, …)' });
  label.setAttribute('aria-label', 'Label');
  const mark = button('Mark start', () => {
    const t = frame()?.detections.time;
    if (t === undefined) return;
    if (markStart === null) { markStart = t; mark.textContent = 'Mark end'; return; }
    labels.labels.push(makeSessionLabel(Math.min(markStart, t), Math.max(markStart, t), label.value));
    markStart = null;
    mark.textContent = 'Mark start';
    saveLabels?.(labels);
    renderLabels();
    render();
  });
  const renderLabels = (): void => {
    labelList.replaceChildren(
      ...[...labels.labels].sort((a, b) => a.start - b.start).map((l) => h('div', { className: 'pv-buttons' },
        h('span', { className: 'pv-mono' }, `${(l.start - t0).toFixed(1)}–${(l.end - t0).toFixed(1)} s  ${l.label}`
          + (l.person ? ` · ${l.person}` : '') + (l.distance !== null ? ` · ${l.distance} m` : '')),
        button('Go', () => { const i = frames.findIndex((f) => f.detections.time >= l.start); if (i >= 0) { index = i; render(); } }),
        saveLabels ? button('Delete', () => { labels.labels = labels.labels.filter((x) => x.id !== l.id); saveLabels(labels); renderLabels(); render(); }) : null)),
      ...labels.marks.map((m) => h('div', { className: 'pv-mono t-warn' }, `${(m.t - t0).toFixed(1)} s · ${m.kind} ${m.note ?? ''}`)));
  };
  renderLabels();
  render();
  const el = h('div', {}, canvas, h('div', { className: 'pv-buttons' }, play, slider, time), outputs,
    saveLabels ? h('div', { className: 'pv-buttons' }, label, mark) : h('p', { className: 'pv-note' }, 'Read-only (imported).'), labelList);
  return { el, dispose: stop };
}

/** One frame's model outputs (SkeletonPlayer.outputs). */
export function frameLines(session: FeatureRecordingSession, f: FeatureFrame, labels: SessionLabels): HTMLElement[] {
  const d = f.detections;
  const stages = StageTimings.names.map((n, i) => (f.stages.values[i] > 0 ? `${n} ${f.stages.values[i].toFixed(1)}` : null)).filter(Boolean).join(' ');
  const out = [h('div', {}, `faces ${d.faces.length} · bodies ${d.bodies.length} · hands ${d.hands.length} · stages ${stages}`)];
  for (const p of f.people) {
    out.push(h('div', {}, `#${p.id}${p.id === f.primaryID ? ' ★' : ''}${p.engaged ? ' ● engaged' : ''} · ${p.distance.toFixed(2)} m (${p.distanceSource})`
      + ` · facing ${p.facing.toFixed(2)} · looking ${p.lookingAtMe.toFixed(2)} · θ ${p.gazeErrorDegrees !== null ? `${p.gazeErrorDegrees.toFixed(1)}°` : '—'}`
      + ` · dwell ${p.dwell.toFixed(1)}/${p.dwellNeeded.toFixed(1)}`));
  }
  for (const e of session.events.filter((e) => Math.abs(e.t - d.time) < 0.5 && e.name !== 'lookingAtMe')) {
    out.push(h('div', { className: 't-accent' }, e.name + (e.person !== undefined ? ` #${e.person}` : '') + (e.note ? ` → ${e.note}` : '')));
  }
  const active = labels.labels.filter((l) => d.time >= l.start && d.time <= l.end).map((l) => l.label);
  if (active.length) out.push(h('div', { className: 't-good' }, `labels: ${active.join(', ')}`));
  return out;
}
