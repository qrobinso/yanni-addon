// Port of yanni/Perception/PerceptionPanel.swift (with HarnessOverlays' camera overlay): the people source and status,
// look-to-talk and gesture settings, the recent decisions, the camera offset and calibration flow, the measurement
// harness (MeasurementPanel), and a live camera preview with the tracked people's boxes. Settings are saved through
// the settings hub's `perception_tunables` (Swift PerceptionSettingsStore), which applies them to the pipeline.
import { PerceptionEvent } from '../perception/PerceptionTypes';
import { PerceptionSettings, TierOverride } from '../perception/PerceptionSettings';
import type { PerceptionSourceChoice } from '../perception/web/startPerception';
import type { TuningModel } from './TuningModel';
import { calibrationGroup, measurementSection } from './perception/MeasurementPanel';
import { group, h, note, readout, section, select, slider, toggle, type Build } from './ui';

export const MORE_GESTURES = ['byeWave', 'clap', 'armsUp', 'nod', 'thumbsDown', 'peace', 'heartHands', 'peekaboo', 'dancing', 'highFive'] as const;

/** People-source picker value: camera, the synthetic demo replay, a stored session's replay, or the gaze pad. */
type SourcePick = 'camera' | 'replay' | 'simulated' | `session:${string}`;

/** The section's runtime state: the settings being edited, the people source and the recent decisions. */
export class PerceptionPreview {
  settings: PerceptionSettings;
  source: SourcePick = 'camera';
  readonly decisions: string[] = [];
  constructor(readonly m: TuningModel) {
    this.settings = m.ctx.perception?.coordinator.settings.copy() ?? new PerceptionSettings();
    if (m.ctx.perception) this.source = m.ctx.perception.stats().source;
  }
  /** Through the hub when attached (it persists, syncs and applies), else straight to the pipeline. */
  push(): void {
    const s = this.settings.validated();
    if (this.m.hub) this.m.hub.change({ perception_tunables: s.toJSON() });
    else this.m.ctx.perception?.setSettings(s);
  }
  save(s: PerceptionSettings): void { this.settings = s.validated(); this.push(); }
}

export function perceptionSection(pp: PerceptionPreview, b: Build): HTMLElement {
  const p = pp.m.ctx.perception;
  const harness = pp.m.ctx.harness;
  if (!p) {
    return section('Perception',
      note('Simulated: no camera pipeline is running, so the gaze pad (Face › Gaze) drives the people.'),
      readout(b, () => `people ${pp.m.engine.state.people.length} · primary ${pp.m.engine.state.primaryPersonID ?? 'none'} · engaged ${pp.m.engine.state.engagedPersonID ?? 'none'}`));
  }
  const edit = (f: () => void): void => { f(); pp.push(); };
  const num = (label: string, k: 'engageDwell' | 'engageDwellHeadOnly' | 'engageMaxDistance' | 'releaseAfter' | 'eyeContactSigmaEyes'
    | 'eyeContactSigmaHead' | 'eyeContactEnter' | 'eyeContactExit', range: readonly [number, number], d = 2) =>
    slider(label, () => pp.settings[k], (v) => edit(() => { pp.settings[k] = v; }), range, (v) => v.toFixed(d));
  const flag = (label: string, k: 'enabled' | 'lookToTalkDryRun' | 'gesturesEnabled' | 'waveEnabled' | 'thumbsUpEnabled' | 'openPalmEnabled'
    | 'pointEnabled' | 'gestureReactionsEnabled' | 'cameraOffWhenAsleepAtBedtime' | 'wristROIPasses') =>
    toggle(label, () => pp.settings[k], (v) => edit(() => { pp.settings[k] = v; }));
  const decisions = h('div', { class: 'pv-readout' });
  b.onDispose(p.onEvent((e, n) => {
    pp.decisions.push(`${PerceptionEvent.text(e)}${n ? ` → ${n}` : ''}`);
    if (pp.decisions.length > 5) pp.decisions.shift();
  }));
  b.poll.add(() => { const t = pp.decisions.join('\n'); if (decisions.textContent !== t) decisions.textContent = t; });
  const sources: [SourcePick, string][] = [['camera', 'Camera'], ['replay', 'Replay (synthetic)'],
    ...(harness?.sessions ?? []).map((x) => [`session:${x.id}`, `Replay ${x.id}`] as [SourcePick, string]), ['simulated', 'Simulated']];
  const sourceNote = h('p', { class: 'pv-note' });
  const pick = (v: SourcePick): void => {
    pp.source = v;
    pp.m.peopleDrivenByPerception = v !== 'simulated';
    sourceNote.textContent = '';
    if (!v.startsWith('session:')) { p.setSource({ kind: v } as PerceptionSourceChoice); return; }
    sourceNote.textContent = 'loading…';
    harness!.loadSession(v.slice(8)).then((session) => {
      p.setSource({ kind: 'replay', recording: session.asPerceptionRecording() });
      sourceNote.textContent = '';
    }, (e: unknown) => { sourceNote.textContent = `Couldn't read the session: ${e}`; });
  };
  return section('Perception',
    select('People source', sources, () => pp.source, pick), sourceNote,
    readout(b, () => { const st = p.stats(); return `${st.source} · camera ${JSON.stringify(st.camera)} · tier ${st.tier} · ${st.analysisFPS.toFixed(0)} fps`; }),
    readout(b, () => pp.source === 'simulated' ? 'The gaze pad drives the people.'
      : pp.source !== 'camera' ? 'A recording plays through the real tracker, engagement and reflexes (looping).' : '', 'pv-note'),
    flag('Perception on', 'enabled'),
    flag('Look-to-talk dry run', 'lookToTalkDryRun'),
    select('Tier', TierOverride.allCases.map((t) => [t, t] as const), () => pp.settings.tierOverride, (v) => edit(() => { pp.settings.tierOverride = v; })),
    num('Engage dwell (s)', 'engageDwell', [0.4, 3]),
    num('Engage dwell, head only (s)', 'engageDwellHeadOnly', [0.4, 3]),
    num('Engage range (m)', 'engageMaxDistance', [0.5, 3]),
    num('Release after (s)', 'releaseAfter', [1, 10]),
    num('Eye-contact σ, eyes (°)', 'eyeContactSigmaEyes', [3, 25], 1),
    num('Eye-contact σ, head (°)', 'eyeContactSigmaHead', [3, 25], 1),
    num('Contact enter', 'eyeContactEnter', [0.05, 0.95]),
    num('Contact exit', 'eyeContactExit', [0.05, 0.95]),
    slider('Max people', () => pp.settings.maxPeople, (v) => edit(() => { pp.settings.maxPeople = Math.round(v); }), [1, 6], (v) => String(Math.round(v)), 1),
    flag('Gestures', 'gesturesEnabled'), flag('Wave', 'waveEnabled'), flag('Thumbs up', 'thumbsUpEnabled'),
    flag('Open palm', 'openPalmEnabled'), flag('Point', 'pointEnabled'),
    group('More gestures', ...MORE_GESTURES.map((g) => toggle(g, () => !pp.settings.disabledGestures.includes(g), (on) => edit(() => {
      pp.settings.disabledGestures = pp.settings.disabledGestures.filter((x) => x !== g).concat(on ? [] : [g]);
    }))), flag('Zoomed wrist hand passes', 'wristROIPasses')),
    flag('Face reacts to gestures', 'gestureReactionsEnabled'),
    flag('Camera off asleep at bedtime', 'cameraOffWhenAsleepAtBedtime'),
    h('div', { class: 'pv-caption' }, 'Recent decisions'), decisions,
    harness ? calibrationGroup(harness, p, () => pp.settings, (x) => pp.save(x), b) : null,
    harness ? measurementSection(harness, b) : null,
    cameraPreview(pp, b));
}

/** The camera with the tracked people's face and body boxes (drawn at the 4 Hz poll, never per camera frame). */
function cameraPreview(pp: PerceptionPreview, b: Build): HTMLElement {
  const p = pp.m.ctx.perception!;
  const canvas = h('canvas', { width: 320, height: 240, class: 'pv-plot' });
  canvas.setAttribute('aria-label', 'Camera preview with tracked people');
  const g = canvas.getContext('2d');
  let on = false;
  b.poll.add(() => {
    if (!on || !g) return;
    const w = canvas.width, hh = canvas.height;
    g.save();
    g.scale(-1, 1);   // mirrored, as the viewer sees themselves
    g.drawImage(p.video, -w, 0, w, hh);
    g.restore();
    g.lineWidth = 2;
    for (const q of p.snapshot().people) {
      for (const [box, c] of [[q.bodyBox, '#4a8'], [q.faceBox, '#fc4']] as const) {
        if (!box) continue;
        g.strokeStyle = c;
        g.strokeRect(box.x * w, box.y * hh, box.w * w, box.h * hh);
      }
      const fb = q.faceBox ?? q.bodyBox;
      if (fb) { g.fillStyle = '#fff'; g.font = '11px ui-monospace'; g.fillText(`#${q.id} ${q.distance.toFixed(1)} m`, fb.x * w, fb.y * hh - 3); }
    }
  });
  return group('Camera preview', toggle('Show camera', () => on, (v) => { on = v; if (!v) g?.clearRect(0, 0, canvas.width, canvas.height); }), canvas);
}
