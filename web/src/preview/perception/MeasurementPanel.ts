// Port of yanni/Perception/MeasurementPanel.swift (Tune → Perception → Measure) and the Perception panel's
// CalibrationView: the live HUD switch, the counters and "Wrong reaction"; Collect (consent, participants, scripted /
// "none" sessions, the recorded sessions and the skeleton viewer); and the calibration flow — camera offset and (web)
// field of view, estimator bias, the head-pose frame check and labelled eye-contact samples. Calibration results go
// into the perception settings through the settings hub.
import type { PerceptionHarness } from '../../app/PerceptionHarness';
import { RecordingSessionType } from '../../perception/FeatureRecordFormat';
import { CollectPreset } from '../../perception/CollectScript';
import { CameraOffsetTable } from '../../perception/CameraGeometry';
import type { PerceptionSettings } from '../../perception/PerceptionSettings';
import { fmtG } from '../../perception/PerceptionTypes';
import { RecordingPolicy } from '../../perception/RecordingConsent';
import { interfaceOrientation, type PerceptionHandle } from '../../perception/web/startPerception';
import { button, buttons, caption, group, h, note, readout, select, slider, toggle, type Build } from '../ui';
import { askPIN, openNewSessionSheet } from './NewSessionSheet';
import { openSkeletonViewer } from './SkeletonViewer';

/** Measure + Collect. */
export function measurementSection(harness: PerceptionHarness, b: Build): HTMLElement {
  const c = () => harness.counts;
  const measure = group('Measure',
    toggle('Perception HUD (live stage timings)', () => harness.hudEnabled, (v) => { harness.hudEnabled = v; }),
    readout(b, () => `Engagements ${c().engagements} · ${c().perHour(c().falseEngagements).toFixed(1)} false / h`),
    readout(b, () => `Gesture reactions ${c().reactions} · ${c().perHour(c().reactions).toFixed(1)} / h`),
    readout(b, () => `False positives ${c().gestureFalsePositives} (button ${c().wrongReactionReports}, none sessions ${c().noneSessionReactions})`),
    readout(b, () => {
      const r = Object.entries(c().rejectionsByReason).sort((a, z) => z[1] - a[1]).slice(0, 6);
      return r.length ? `Rejections: ${r.map(([k, v]) => `${k} ×${v}`).join(', ')}` : '';
    }, 'pv-note'),
    buttons(['Wrong reaction', () => harness.wrongReaction()]),
    readout(b, () => harness.message, 'pv-note'));
  measure.open = true;

  const participants = h('div', {});
  let addingChild = false, guardian = '';
  const renderParticipants = (): void => {
    const adults = harness.policy.participants.filter((p) => !p.isChild);
    participants.replaceChildren(caption('Participants (pseudonyms; consent recorded when added)'),
      ...harness.policy.participants.map((p) => h('div', { className: 'pv-buttons' },
        h('span', { className: 'pv-readout' }, `${p.pseudonym} · ${p.isChild ? `child · consent by ${p.consentedBy}` : 'adult'} · ${p.consentDate.toLocaleDateString()}`),
        button('Withdraw', () => { if (confirm(`Withdraw ${p.pseudonym}'s consent and delete their sessions?`)) { harness.withdraw(p.pseudonym); b.rebuild(); } }))),
      buttons(['Add adult', () => { harness.addParticipant(false, null); b.rebuild(); }],
        adults.length ? ['Add child…', () => { addingChild = true; guardian = adults[0].pseudonym; renderParticipants(); }] : null),
      ...(addingChild ? [
        select('Guardian consenting', adults.map((p) => [p.pseudonym, p.pseudonym] as const), () => guardian, (v) => { guardian = v; }),
        buttons(['Add child with this guardian\'s consent', () => { harness.addParticipant(true, guardian); addingChild = false; b.rebuild(); }],
          ['Cancel', () => { addingChild = false; renderParticipants(); }]),
      ] : []));
  };
  renderParticipants();

  const running = h('div', {});
  let wasRecording = harness.isRecording;
  const renderRunning = (): void => {
    if (!harness.isRecording) {
      const start = button('New session…', () => openNewSessionSheet(harness, () => b.rebuild()));
      start.disabled = !harness.policy.allowed || harness.policy.participants.length === 0;
      running.replaceChildren(start);
      return;
    }
    running.replaceChildren(
      readout(b, () => {
        const s = harness.status;
        if (!s) return '';
        const none = harness.sessionType === 'none' || harness.sessionType === 'hardNegatives';
        return `● ${s.state === 'paused' ? 'paused (someone undeclared in view)' : 'recording'} · ${harness.sessionType ? RecordingSessionType.title(harness.sessionType) : ''}`
          + ` · ${s.elapsed.toFixed(0)} s · ${s.framesWritten} frames · ${(s.bytes / 1_048_576).toFixed(1)} MB${s.framesDropped > 0 ? ` · ${s.framesDropped} dropped` : ''}`
          + (none ? `\n"None" hours so far: ${(s.elapsed / 3600).toFixed(2)} h (≥ 10 h needed before a per-gesture rate is claimed)` : '');
      }),
      buttons(['Stop', () => { harness.stop(); b.rebuild(); }], ['Skip prompt', () => harness.skipPrompt()]));
  };
  renderRunning();
  b.poll.add(() => { if (harness.isRecording !== wasRecording) { wasRecording = harness.isRecording; renderRunning(); } });

  const collect = group('Collect (movement recording)',
    toggle('Allow recording (needs the PIN)', () => harness.policy.allowed, (on) => {
      if (!on) { harness.setAllowed(false); b.rebuild(); return; }
      void askPIN(harness, 'allow movement recording').then((ok) => { if (ok) harness.setAllowed(true); b.rebuild(); });
    }),
    harness.pinSet ? null : note('Set a Settings PIN first: recording is only possible while a PIN is set.'),
    slider('Keep on this device (days)', () => harness.policy.retentionDays, (v) => harness.setRetentionDays(Math.round(v)),
      RecordingPolicy.retentionRange, (v) => String(Math.round(v)), 1),
    participants, running,
    buttons([`Recorded sessions & skeleton viewer (${harness.sessions.length})`, () => openSkeletonViewer(harness)]));
  return h('div', {}, measure, collect);
}

/** "Camera offset & calibration". `save` writes the perception settings through the hub. */
export function calibrationGroup(harness: PerceptionHarness, p: PerceptionHandle, get: () => PerceptionSettings,
  save: (s: PerceptionSettings) => void, b: Build): HTMLElement {
  const cal = harness.calibration;
  const orientation = () => interfaceOrientation(screen.orientation?.type);
  // The override is stored in the portrait frame (Swift); the owner measures it as mounted.
  const mounted = () => { const o = get().cameraOffsetOverride; return o ? CameraOffsetTable.offset(o, orientation()) : p.stats().cameraOffset; };
  const setMounted = (x: number, y: number) => save(get().with({ cameraOffsetOverride: CameraOffsetTable.toPortrait({ x, y }, orientation()) }));
  const apply = (k: 'bias' | 'frame' | 'sigma' | 'fov') => { const s = cal.applied(k, get()); if (s) { save(s); b.rebuild(); } };
  let fovMark = 1;
  const pr = () => { const r = cal.precisionRecall(get().eyeContactSigmaEyes); return r ? `current σ: precision ${r.precision.toFixed(2)} · recall ${r.recall.toFixed(2)}` : ''; };
  const g = group('Camera offset & calibration',
    caption('Camera offset'),
    readout(b, () => { const o = p.stats().cameraOffset; return `in use (${o.x >= 0 ? '+' : ''}${o.x.toFixed(3)}, ${o.y >= 0 ? '+' : ''}${o.y.toFixed(3)}) m from the drawn face · ${get().cameraOffsetOverride ? 'manual (measured)' : 'uncalibrated guess'}`; }),
    note('Measure with a ruler, as mounted: from the middle between the drawn eyes to the camera lens (x + to the viewer\'s right, y + down).'),
    toggle('Manual override (measured)', () => get().cameraOffsetOverride !== null, (on) => {
      if (on) { const o = p.stats().cameraOffset; setMounted(o.x, o.y); } else save(get().with({ cameraOffsetOverride: null }));
      b.rebuild();
    }),
    get().cameraOffsetOverride ? slider('Offset x (m, as mounted)', () => mounted().x, (v) => setMounted(v, mounted().y), [-0.3, 0.3], (v) => v.toFixed(3), 0.001) : null,
    get().cameraOffsetOverride ? slider('Offset y (m, as mounted)', () => mounted().y, (v) => setMounted(mounted().x, v), [-0.3, 0.3], (v) => v.toFixed(3), 0.001) : null,

    caption('Camera field of view'),
    readout(b, () => `in use ${get().horizontalFovDegrees.toFixed(1)}° horizontal${cal.fovResult !== null ? ` · measured ${cal.fovResult.toFixed(1)}°` : ''}`),
    note('Stand alone at a taped mark facing the screen, eyes open, and capture. Uses the 63 mm average pupil distance.'),
    select('Mark', CollectPreset.floorMarks.map((m) => [m, `${fmtG(m)} m`] as const), () => fovMark, (v) => { fovMark = v; }),
    buttons(['Capture (3 s)', () => cal.start({ kind: 'fov', distance: fovMark }, 3)], ['Apply', () => apply('fov')]),
    slider('Field of view (°)', () => get().horizontalFovDegrees, (v) => save(get().with({ horizontalFovDegrees: v })), [40, 130], (v) => v.toFixed(1), 0.5),

    caption('Live'), readout(b, () => cal.live),

    caption('1 · Estimator bias'),
    note('Stand about 1 m away and look at Yanni\'s eyes, then about 2 m.'),
    buttons(['Capture 1 m (3 s)', () => { cal.biasSamples = []; cal.biasNearCount = 0; cal.start({ kind: 'biasNear' }, 3); }],
      ['Capture 2 m (3 s)', () => { if (cal.biasNearCount > 0) cal.start({ kind: 'biasFar' }, 3); }],
      ['Apply', () => apply('bias')]),
    readout(b, () => `current bias yaw ${get().estimatorBiasDegrees.x.toFixed(1)}°, pitch ${get().estimatorBiasDegrees.y.toFixed(1)}°`),

    caption('2 · Head-pose frame check'),
    note('Stand at ≈ 1.2 m at about 40° to the left, straight ahead, and 40° to the right; look into the lens each time.'),
    buttons(['Left', () => cal.start({ kind: 'frame', index: 0 }, 2)], ['Centre', () => cal.start({ kind: 'frame', index: 1 }, 2)],
      ['Right', () => cal.start({ kind: 'frame', index: 2 }, 2)], ['Apply', () => apply('frame')]),
    readout(b, () => `in use: ${get().headPoseFrame}, yaw sign ${get().headYawSign}, pitch sign ${get().headPitchSign}`),

    caption('3 · Eye-contact threshold'),
    buttons(['I\'m looking (5 s)', () => cal.start({ kind: 'looking' }, 5)], ['I\'m not looking (5 s)', () => cal.start({ kind: 'notLooking' }, 5)],
      ['Apply σ', () => apply('sigma')]),
    readout(b, () => { const s = cal.suggestedSigma; return s !== null ? `suggested σ ${s.toFixed(1)}° (1 % false positives)` : ''; }),
    readout(b, pr),
    readout(b, () => cal.message, 'pv-note'));
  return g;
}
