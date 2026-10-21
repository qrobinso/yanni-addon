// Port of Tests/FacePerceptionTests/RecorderPrivacyTests.swift: the recorder writes numbers only, only with consent,
// never while someone undeclared is in view, and keeps nothing past its caps and retention.
import { describe, expect, test } from 'vitest';
import {
  BodyJointName, CameraIntrinsics, FeatureFrameCodec, FeatureRecordLayout, FeatureRecordingSession, FeatureRecordingStore,
  FeatureRecordingWriter, MemoryFileSystem, NRect, RecordedEvent, RecordingGate, RecordingLimits, RecordingPolicy,
  StageTimings, makeBodyDetection, makeFrameDetections, makeMotionGrid, makePerceptionSnapshot, makeTrackedPerson,
  type FrameDetections, type RecordingStartCheck,
} from '../../src/perception';
import { T } from './TestSupport';

describe('RecorderPrivacyTests', () => {
  test('schemaHasNoImageDerivedFields', () => {
    const l = new FeatureRecordLayout();
    // Stage names are timings (milliseconds), not data; every data field is checked.
    expect(l.stages).toEqual(StageTimings.names);
    const all = [...l.face, ...l.body, ...l.hand, ...l.person];
    for (const banned of ['luma', 'grid', 'pixel', 'image', 'appearance', 'histogram', 'colour', 'color', 'landmark', 'motion']) {
      expect(all.some((f) => f.toLowerCase().includes(banned)), `field containing ${banned}`).toBe(false);
    }
    // Face records keep derived eye features, not the 76 landmark points.
    expect(l.face).toHaveLength(17);
    expect(l.hand).toHaveLength(2 + 21 * 3);
    expect(l.body).toHaveLength(5 + BodyJointName.allCases.length * 3);
  });

  test('recordsDropTheMotionGridAndColourHistogram', () => {
    const grid = makeMotionGrid(32, 24, new Array(32 * 24).fill(0.5));
    const body = makeBodyDetection(NRect.make(0.4, 0.3, 0.2, 0.4), { appearance: [0.1, 0.2, 0.3, 0.4, 0, 0, 0, 0] });
    const det = makeFrameDetections(5, { bodies: [body], motion: grid });
    const rec = FeatureFrameCodec.record(det, makePerceptionSnapshot(), new StageTimings(), 3, new FeatureRecordLayout());
    // Exactly the fixed preamble plus one body block: nothing else can be in the record.
    const fixed = 4 + 8 + 2 + 5 + 8 + StageTimings.names.length * 2;
    expect(rec.length).toBe(fixed + new FeatureRecordLayout().body.length * 2);
    const back = FeatureFrameCodec.decode(rec.subarray(4), new FeatureRecordLayout(), CameraIntrinsics.typicalLandscape);
    expect(back.detections.motion).toBeNull();
    expect(back.detections.bodies[0]?.appearance).toBeNull();
  });

  test('consentGate', () => {
    const p = new RecordingPolicy();
    p.participants = [T.participant('P1'), T.participant('P2', true, 'P1'), T.participant('P3', true)];
    const check = (pol: RecordingPolicy, o: { pin?: boolean; entered?: boolean; declared?: string[]; confirmed?: boolean; stored?: number } = {}): RecordingStartCheck =>
      RecordingGate.canStart({ policy: pol, pinSet: o.pin ?? true, pinVerified: o.entered ?? true, declared: o.declared ?? ['P1'],
        consentConfirmed: o.confirmed ?? true, storedBytes: o.stored ?? 0 });
    expect(check(p)).toEqual({ kind: 'notAllowed' });
    p.allowed = true;
    expect(check(p)).toEqual({ kind: 'ok' });
    expect(check(p, { declared: ['P1', 'P2'] }), "a child with a guardian's consent").toEqual({ kind: 'ok' });
    expect(check(p, { pin: false })).toEqual({ kind: 'noPIN' });
    expect(check(p, { entered: false })).toEqual({ kind: 'pinNotEntered' });
    expect(check(p, { declared: [] })).toEqual({ kind: 'noParticipants' });
    expect(check(p, { declared: ['P3'] }), "a child can't consent for themselves").toEqual({ kind: 'invalidConsent', pseudonym: 'P3' });
    expect(check(p, { declared: ['P9'] }), 'undeclared pseudonym').toEqual({ kind: 'invalidConsent', pseudonym: 'P9' });
    expect(check(p, { confirmed: false })).toEqual({ kind: 'consentNotConfirmed' });
    expect(check(p, { stored: RecordingLimits.maxTotalBytes })).toEqual({ kind: 'storageFull' });
    const old = new RecordingPolicy();
    old.allowed = true;
    old.participants = p.participants.map((x, i) => i === 0 ? { ...x, consentTextVersion: 0 } : x);
    expect(check(old), 'a new consent text needs a new consent').toEqual({ kind: 'invalidConsent', pseudonym: 'P1' });
  });

  test('autoPausesWhenUndeclaredPeopleAppearAndStopsAtCaps', () => {
    const fs = new MemoryFileSystem();
    const dir = 'tmp/pause';
    const w = new FeatureRecordingWriter(fs, dir, T.header('pause', ['P1'], 0), RecordingLimits.maxTotalBytes);
    const one = makeFrameDetections(1, { bodies: [makeBodyDetection(NRect.make(0.1, 0.1, 0.2, 0.4))] });
    const at = (f: FrameDetections, time: number): FrameDetections => ({ ...f, time });
    const two = at({ ...one, bodies: [...one.bodies, makeBodyDetection(NRect.make(0.6, 0.1, 0.2, 0.4))] }, 2);
    const snap0 = makePerceptionSnapshot();
    expect(w.offer(one, snap0, new StageTimings(), 3)).toEqual({ kind: 'write' });
    w.flush();
    expect(w.offer(two, snap0, new StageTimings(), 3)).toEqual({ kind: 'pauseUndeclared' });
    expect(w.status.state).toBe('paused');
    w.note(RecordedEvent.make(2, 'gesture.wave'));                     // a visitor's event is not kept either
    // Tracked people count too (a coasting track with no rectangle this frame).
    const snap = makePerceptionSnapshot({ people: [makeTrackedPerson(1), makeTrackedPerson(2)] });
    expect(w.offer(at(one, 3), snap, new StageTimings(), 3)).toEqual({ kind: 'pauseUndeclared' });
    w.flush();
    expect(w.offer(at(one, 4), snap0, new StageTimings(), 3)).toEqual({ kind: 'write' });
    w.flush();
    expect(w.offer(at(one, RecordingLimits.maxSessionSeconds + 1), snap0, new StageTimings(), 3)).toEqual({ kind: 'stop', reason: '2 h session limit' });
    expect(w.offer(one, snap0, new StageTimings(), 3), 'stopped stays stopped').toBeNull();
    const h = w.finish('test');
    expect(h.framesWritten === 2 && h.framesPausedUndeclared === 2 && h.stopReason === '2 h session limit').toBe(true);
    const s = FeatureRecordingSession.load(fs, dir);
    expect(s.frames.map((f) => f.detections.time)).toEqual([1, 4]);
    expect(s.events).toHaveLength(0);
    expect(RecordingGate.decide(1, 1, 1, 10, 10)).toEqual({ kind: 'stop', reason: '2 GB storage limit' });
  });

  test('retentionDeleteAndPolicy', () => {
    const fs = new MemoryFileSystem();
    const store = new FeatureRecordingStore(fs, 'root');
    const now = new Date(1_900_000_000 * 1000);
    for (const [id, daysAgo] of [['old', 31], ['recent', 2], ['edge', 29.9]] as [string, number][]) {
      const w = new FeatureRecordingWriter(fs, store.directory(id), T.header(id, ['P1'], 0, new Date(now.getTime() - daysAgo * 86_400_000)), 1_000);
      w.finish('test');
    }
    expect(store.sessions().map((s) => s.id)).toEqual(['recent', 'edge', 'old']);
    expect(store.purge(30, now)).toEqual(['old']);
    expect(new Set(store.sessions().map((s) => s.id))).toEqual(new Set(['recent', 'edge']));
    store.delete('../policy');                                    // never outside the recordings folder
    store.delete('edge');
    expect(store.sessions().map((s) => s.id)).toEqual(['recent']);
    expect(store.totalBytes()).toBeGreaterThan(0);
    store.deleteAll();
    expect(store.sessions().length === 0 && store.totalBytes() === 0).toBe(true);

    const p = new RecordingPolicy();
    p.allowed = true;
    p.retentionDays = 500;
    p.participants = [T.participant('P1'), T.participant('P1')];
    store.savePolicy(p);
    const loaded = store.loadPolicy();
    expect(loaded.allowed && loaded.retentionDays === 90 && loaded.participants.length === 1).toBe(true);
    const tolerant = RecordingPolicy.decode('{"retentionDays":"x","future":1}');
    expect(!tolerant.allowed && tolerant.retentionDays === 30).toBe(true);
  });
});
