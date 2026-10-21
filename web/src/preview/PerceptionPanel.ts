// Port of yanni/Perception/PerceptionPanel.swift (with HarnessOverlays' camera overlay): the people source and status,
// look-to-talk and gesture settings, the camera offset override, the recent decisions, and a live camera preview with
// the tracked people's boxes. Settings go to the running pipeline (`setSettings`); they are developer tuning, not
// owner settings. Without a camera the gaze pad drives the people (simulated).
import type { V2 } from '../core/vec';
import { PerceptionEvent } from '../perception/PerceptionTypes';
import { PerceptionSettings, TierOverride } from '../perception/PerceptionSettings';
import type { TuningModel } from './TuningModel';
import { group, h, note, readout, section, select, slider, toggle, type Build } from './ui';

export const MORE_GESTURES = ['byeWave', 'clap', 'armsUp', 'nod', 'thumbsDown', 'peace', 'heartHands', 'peekaboo', 'dancing', 'highFive'] as const;

/** The section's runtime state: the settings it last sent (the handle has no getter) and the recent decisions. */
export class PerceptionPreview {
  settings = new PerceptionSettings();
  readonly decisions: string[] = [];
  constructor(readonly m: TuningModel) {}
  push(): void { this.m.ctx.perception?.setSettings(new PerceptionSettings({ ...this.settings })); }
}

export function perceptionSection(pp: PerceptionPreview, b: Build): HTMLElement {
  const p = pp.m.ctx.perception;
  if (!p) {
    return section('Perception',
      note('Simulated: no camera pipeline is running, so the gaze pad (Face › Gaze) drives the people.'),
      readout(b, () => `people ${pp.m.engine.state.people.length} · primary ${pp.m.engine.state.primaryPersonID ?? 'none'} · engaged ${pp.m.engine.state.engagedPersonID ?? 'none'}`));
  }
  const s = pp.settings;
  const edit = (f: () => void): void => { f(); pp.push(); };
  const num = (label: string, k: 'engageDwell' | 'engageDwellHeadOnly' | 'engageMaxDistance' | 'releaseAfter' | 'eyeContactSigmaEyes'
    | 'eyeContactSigmaHead' | 'eyeContactEnter' | 'eyeContactExit', range: readonly [number, number], d = 2) =>
    slider(label, () => s[k], (v) => edit(() => { s[k] = v; }), range, (v) => v.toFixed(d));
  const flag = (label: string, k: 'enabled' | 'lookToTalkDryRun' | 'gesturesEnabled' | 'waveEnabled' | 'thumbsUpEnabled' | 'openPalmEnabled'
    | 'pointEnabled' | 'gestureReactionsEnabled' | 'cameraOffWhenAsleepAtBedtime' | 'wristROIPasses') =>
    toggle(label, () => s[k], (v) => edit(() => { s[k] = v; }));
  const decisions = h('div', { class: 'pv-readout' });
  b.onDispose(p.onEvent((e, n) => {
    pp.decisions.push(`${PerceptionEvent.text(e)}${n ? ` → ${n}` : ''}`);
    if (pp.decisions.length > 5) pp.decisions.shift();
  }));
  b.poll.add(() => { const t = pp.decisions.join('\n'); if (decisions.textContent !== t) decisions.textContent = t; });
  const offset = (): V2 => s.cameraOffsetOverride ?? p.stats().cameraOffset;
  return section('Perception',
    readout(b, () => { const st = p.stats(); return `camera ${JSON.stringify(st.camera)} · tier ${st.tier} · ${st.analysisFPS.toFixed(0)} fps`; }),
    flag('Perception on', 'enabled'),
    flag('Look-to-talk dry run', 'lookToTalkDryRun'),
    select('Tier', TierOverride.allCases.map((t) => [t, t] as const), () => s.tierOverride, (v) => edit(() => { s.tierOverride = v; })),
    num('Engage dwell (s)', 'engageDwell', [0.4, 3]),
    num('Engage dwell, head only (s)', 'engageDwellHeadOnly', [0.4, 3]),
    num('Engage range (m)', 'engageMaxDistance', [0.5, 3]),
    num('Release after (s)', 'releaseAfter', [1, 10]),
    num('Eye-contact σ, eyes (°)', 'eyeContactSigmaEyes', [3, 25], 1),
    num('Eye-contact σ, head (°)', 'eyeContactSigmaHead', [3, 25], 1),
    num('Contact enter', 'eyeContactEnter', [0.05, 0.95]),
    num('Contact exit', 'eyeContactExit', [0.05, 0.95]),
    slider('Max people', () => s.maxPeople, (v) => edit(() => { s.maxPeople = Math.round(v); }), [1, 6], (v) => String(Math.round(v)), 1),
    flag('Gestures', 'gesturesEnabled'), flag('Wave', 'waveEnabled'), flag('Thumbs up', 'thumbsUpEnabled'),
    flag('Open palm', 'openPalmEnabled'), flag('Point', 'pointEnabled'),
    group('More gestures', ...MORE_GESTURES.map((g) => toggle(g, () => !s.disabledGestures.includes(g), (on) => edit(() => {
      s.disabledGestures = s.disabledGestures.filter((x) => x !== g).concat(on ? [] : [g]);
    }))), flag('Zoomed wrist hand passes', 'wristROIPasses')),
    flag('Face reacts to gestures', 'gestureReactionsEnabled'),
    flag('Camera off asleep at bedtime', 'cameraOffWhenAsleepAtBedtime'),
    h('div', { class: 'pv-caption' }, 'Recent decisions'), decisions,
    group('Camera offset',
      readout(b, () => { const o = p.stats().cameraOffset; return `in use (${o.x.toFixed(3)}, ${o.y.toFixed(3)}) m · ${s.cameraOffsetOverride ? 'manual override' : 'default table'}`; }),
      toggle('Manual override (measured)', () => s.cameraOffsetOverride !== null, (on) => {
        s.cameraOffsetOverride = on ? { ...p.stats().cameraOffset } : null;
        p.setCameraOffset(s.cameraOffsetOverride);
        b.rebuild();
      }),
      s.cameraOffsetOverride ? slider('Offset x (m)', () => offset().x, (v) => { s.cameraOffsetOverride = { ...offset(), x: v }; p.setCameraOffset(s.cameraOffsetOverride); }, [-0.3, 0.3], (v) => v.toFixed(3)) : null,
      s.cameraOffsetOverride ? slider('Offset y (m)', () => offset().y, (v) => { s.cameraOffsetOverride = { ...offset(), y: v }; p.setCameraOffset(s.cameraOffsetOverride); }, [-0.3, 0.3], (v) => v.toFixed(3)) : null),
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
