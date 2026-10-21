// The harness's recording flow (Swift PerceptionHarness+Recording) wired to a pipeline: consent gates, frames from
// the live `onFrame` into the writer, the auto-pause, caps, retention, withdraw, labels and the HA sensor.
import { describe, expect, test } from 'vitest';
import { PerceptionHarness } from '../../src/app/PerceptionHarness';
import {
  CameraStatus, FeatureRecordingHeader, FeatureRecordingStore, MemoryFileSystem, PerceptionProcessor, PerceptionSettings,
  CameraGeometry, RecordingLimits, SyntheticScenes, type FrameDetections, type PerceptionOutput,
} from '../../src/perception';
import type { FrameResult } from '../../src/perception/web/PerceptionPipeline';
import type { PerceptionHandle, PerceptionRuntimeStats } from '../../src/perception/web/startPerception';
import { T } from './TestSupport';

/** The parts of a PerceptionHandle the harness uses, with a frame pump. */
function fakeHandle(source: 'camera' | 'replay' = 'camera') {
  const listeners = new Set<(o: PerceptionOutput, r: FrameResult) => void>();
  const stats = { source, camera: CameraStatus.running, tier: 3, cameraOffset: { x: 0, y: -0.1 }, video: { width: 1280, height: 960 },
    lateFraction: 0 } as unknown as PerceptionRuntimeStats;
  const h = {
    coordinator: { settings: new PerceptionSettings(), source },
    stats: () => stats,
    onFrame(cb: (o: PerceptionOutput, r: FrameResult) => void) { listeners.add(cb); return () => listeners.delete(cb); },
  };
  const proc = new PerceptionProcessor(new PerceptionSettings(), new CameraGeometry(), 3);
  return {
    handle: h as unknown as PerceptionHandle, stats,
    pump(det: FrameDetections) {
      const out = proc.process(det);
      for (const l of listeners) l(out, { out, detections: det, stages: { rects: 2, landmarks: 1 }, totalMs: 3, analysisFPS: 15, captureFPS: 30 });
    },
  };
}

function rig(o: { pin?: boolean } = {}) {
  const clock = { t: 1000 };
  const store = new FeatureRecordingStore(new MemoryFileSystem(), 'Perception');
  const harness = new PerceptionHarness({ store, clock: () => clock.t });
  harness.access = { isPINRequired: o.pin ?? true, verify: async () => 'ok' };
  const cam = fakeHandle();
  harness.attach(cam.handle);
  return { clock, store, harness, cam };
}

const allowWith = (harness: PerceptionHarness, n = 1): string[] => {
  harness.setAllowed(true);
  return Array.from({ length: n }, () => harness.addParticipant(false, null)!.pseudonym);
};

describe('HarnessRecordingTests', () => {
  test('consent gates: no PIN, not allowed, not entered, no participants, unconfirmed, a child without a guardian', () => {
    const a = rig({ pin: false });
    a.harness.setAllowed(true);
    expect(a.harness.policy.allowed).toBe(false);
    expect(a.harness.message).toMatch(/PIN/);
    const { harness } = rig();
    expect(harness.start({ type: 'free', declared: ['P1'], consentConfirmed: true, pinVerified: true }).kind).toBe('notAllowed');
    const [p1] = allowWith(harness);
    expect(harness.start({ type: 'free', declared: [p1], consentConfirmed: true, pinVerified: false }).kind).toBe('pinNotEntered');
    expect(harness.start({ type: 'free', declared: [], consentConfirmed: true, pinVerified: true }).kind).toBe('noParticipants');
    expect(harness.start({ type: 'free', declared: [p1], consentConfirmed: false, pinVerified: true }).kind).toBe('consentNotConfirmed');
    expect(harness.addParticipant(true, 'self')).toBeNull();
    const child = harness.addParticipant(true, p1)!;
    expect(child.consentedBy).toBe(p1);
    expect(harness.isRecording).toBe(false);
  });

  test('the camera must be the people source', () => {
    const { harness } = rig();
    const [p1] = allowWith(harness);
    const replay = fakeHandle('replay');
    harness.attach(replay.handle);
    expect(harness.start({ type: 'free', declared: [p1], consentConfirmed: true, pinVerified: true }).kind).toBe('notAllowed');
    expect(harness.message).toMatch(/camera isn't running/);
  });

  test('a session records the live frames, pauses for undeclared people, saves labels and reports the HA sensor', async () => {
    const { harness, store, cam, clock } = rig();
    const [p1] = allowWith(harness);
    expect(harness.start({ type: 'free', declared: [p1], consentConfirmed: true, pinVerified: true, preset: 'nods', distance: 1.3 }).kind).toBe('ok');
    expect(harness.homeSignals().perception_recording).toBe(true);
    expect(harness.sessionType).toBe('scripted');
    // One person, then two: frames with more people than the one declared pause.
    const frames = [...SyntheticScenes.sitAndLook.recording().frames, ...SyntheticScenes.twoPeopleEngage.recording().frames.map((f) => ({ ...f, time: f.time + 20 }))]
      .map((f) => ({ ...f, time: f.time - 1000 + clock.t }));

    // Frames arrive asynchronously in the app; the writer drains between them (a microtask).
    for (const f of frames) { clock.t = f.time; cam.pump(f); harness.tick(clock.t, () => []); await Promise.resolve(); }
    expect(harness.prompt?.kind).toBeDefined();
    harness.wrongReaction();
    harness.stop();
    expect(harness.homeSignals().perception_recording).toBe(false);
    const [s] = harness.sessions;
    expect(s.header!.framesWritten + s.header!.framesPausedUndeclared).toBe(frames.length);
    expect(s.header!.framesPausedUndeclared).toBeGreaterThan(0);
    expect(s.header!.framesDropped).toBe(0);
    expect(s.header!.framesWritten).toBeGreaterThan(0);
    expect(s.header!.platform).toBe('web');
    expect(s.header!.participants.map((p) => p.pseudonym)).toEqual([p1]);
    const labels = store.loadLabels(s.id);
    expect(labels.marks.map((m) => m.kind)).toEqual(['wrongReaction']);
    expect(labels.labels.length).toBeGreaterThan(0);   // the nods prompts' go-windows
  });

  test('a session stops when the camera stops being the source; the storage cap blocks a start', () => {
    const { harness, cam } = rig();
    const [p1] = allowWith(harness);
    harness.start({ type: 'free', declared: [p1], consentConfirmed: true, pinVerified: true });
    (cam.stats as { source: string }).source = 'replay';
    harness.tick(1001, () => []);
    expect(harness.isRecording).toBe(false);
    expect(harness.message).toMatch(/camera stopped being the people source/);
    // 2 GB already stored.
    (cam.stats as { source: string }).source = 'camera';
    const full = harness.store.fs as MemoryFileSystem;
    full.files.set('Perception/recordings/big/chunk-0000.yfr', { length: RecordingLimits.maxTotalBytes } as unknown as Uint8Array);
    expect(harness.start({ type: 'free', declared: [p1], consentConfirmed: true, pinVerified: true }).kind).toBe('storageFull');
  });

  test('the 2 h cap stops a running session', () => {
    const { harness, cam, clock } = rig();
    const [p1] = allowWith(harness);
    harness.start({ type: 'free', declared: [p1], consentConfirmed: true, pinVerified: true });
    clock.t += RecordingLimits.maxSessionSeconds + 1;
    cam.pump(SyntheticScenes.passerBy.recording().frames.map((f) => ({ ...f, time: clock.t }))[0]);
    harness.tick(clock.t, () => []);
    expect(harness.isRecording).toBe(false);
    expect(harness.message).toMatch(/2 h session limit/);
  });

  test('retention purges old sessions hourly; withdrawing consent deletes that person\'s sessions', () => {
    const { harness, store } = rig();
    const [p1, p2] = allowWith(harness, 2);
    const put = (id: string, who: string, daysAgo: number) => {
      const h = new FeatureRecordingHeader(id, 'free', [T.participant(who)], new Date(Date.now() - daysAgo * 86_400_000), 0);
      store.fs.write(`${store.directory(id)}/header.json`, new TextEncoder().encode(h.encode()));
    };
    put('old', p1, 40); put('new1', p1, 1); put('new2', p2, 1);
    harness.setRetentionDays(30);
    harness.tick(5000, () => []);
    expect(harness.sessions.map((s) => s.id).sort()).toEqual(['new1', 'new2']);
    harness.withdraw(p1);
    expect(harness.sessions.map((s) => s.id)).toEqual(['new2']);
    expect(harness.policy.participants.map((p) => p.pseudonym)).toEqual([p2]);
    harness.deleteAll();
    expect(harness.sessions).toEqual([]);
  });

  test('frames feed the timing monitor and the calibration (field of view capture through the live pipeline)', () => {
    const { harness, cam, clock } = rig();
    harness.calibration.start({ kind: 'fov', distance: 1 }, 1);
    for (const f of SyntheticScenes.sitAndLook.recording().frames.slice(0, 40)) { clock.t = f.time; cam.pump(f); }
    expect(harness.timing.summary(clock.t).stages[0].count).toBeGreaterThan(0);
    expect(harness.calibration.capturing.kind).toBe('none');
    expect(harness.calibration.message).toMatch(/field of view|not enough samples/);
  });
});
