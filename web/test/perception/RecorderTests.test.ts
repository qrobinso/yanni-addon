// Port of Tests/FacePerceptionTests/RecorderTests.swift: feature recorder v2, the Float16 format round trip.
// Files go to an in-memory `RecordingFileSystem` (Swift: a temporary directory).
import { describe, expect, test } from 'vitest';
import {
  FeatureFrameCodec, FeatureRecordingSession, Half, StageTimings, SyntheticScenes, makeFrameDetections,
  makePerceptionSnapshot, PerceptionTier, type FeatureFrame,
} from '../../src/perception';
import { T } from './TestSupport';

describe('RecorderTests', () => {
  test('halfFloatConversion', () => {
    expect(Half.bits(1)).toBe(0x3c00);
    expect(Half.bits(-2)).toBe(0xc000);
    expect(Half.bits(65504)).toBe(0x7bff);
    expect(Half.bits(1e6)).toBe(0x7c00);
    expect(Number.isNaN(Half.float(Half.bits(NaN)))).toBe(true);
    expect(Half.float(Half.bits(Infinity))).toBe(Infinity);
    expect(Half.float(Half.bits(5.96e-8))).toBe(Half.float(1));        // smallest subnormal
    for (const v of [0, 0.1, 0.333, 0.5, 0.9999, 1.6, 3.5, 47.25, 612.5, -0.75, 1e-5]) {
      const back = Half.float(Half.bits(v));
      expect(Math.abs(back - v), `${v} → ${back}`).toBeLessThanOrEqual(Math.max(Math.abs(v) * 0.0005, 6e-8));
    }
  });

  test('formatRoundTripKeepsNumbersAndOrder', () => {
    const s = FeatureRecordingSession.synthetic(SyntheticScenes.simulatorDemo.recording(), 'scripted');
    const [back, status] = T.roundTrip(s, ['P1', 'P2', 'P3']);
    expect(status.framesDropped).toBe(0);
    expect(back.frames).toHaveLength(s.frames.length);
    expect(back.header.framesWritten).toBe(s.frames.length);
    expect(back.events).toHaveLength(s.frames.length);
    s.frames.forEach((a, i) => {
      const b = back.frames[i];
      expect(a.detections.time, 'time is Float64').toBe(b.detections.time);
      expect(a.detections.faces.length).toBe(b.detections.faces.length);
      expect(a.detections.bodies.length).toBe(b.detections.bodies.length);
      expect(a.detections.hands.length).toBe(b.detections.hands.length);
      expect(a.people.map((p) => p.id)).toEqual(b.people.map((p) => p.id));
      expect(a.primaryID === b.primaryID && a.engagedID === b.engagedID).toBe(true);
      expect(b.tier).toBe(PerceptionTier.standard);
      expect(Math.abs(b.stages.rects - 3.25) < 0.01 && b.stages.hands === 0).toBe(true);
      a.detections.faces.forEach((fa, k) => {
        const fb = b.detections.faces[k];
        expect(Math.abs(fa.box.x - fb.box.x) < 0.001 && Math.abs(fa.box.w - fb.box.w) < 0.001).toBe(true);
        expect(fa.headPose === null).toBe(fb.headPose === null);
        expect(fa.eyes === null).toBe(fb.eyes === null);
      });
      a.detections.hands.forEach((ha, k) => {
        const hb = b.detections.hands[k];
        expect(Object.keys(ha.joints).length === Object.keys(hb.joints).length && ha.chirality === hb.chirality).toBe(true);
      });
      a.people.forEach((pa, k) => {
        const pb = b.people[k];
        expect(Math.abs(pa.distance - pb.distance) < 0.005 && pa.engaged === pb.engaged && pa.state === pb.state).toBe(true);
      });
    });
    // Decoding is lossless after the first quantisation: re-encoding a decoded frame gives the same bytes.
    for (const f of back.frames.slice(0, 50)) {
      const snap = makePerceptionSnapshot({ people: f.people, primaryID: f.primaryID, engagedID: f.engagedID });
      const once = FeatureFrameCodec.record(f.detections, snap, f.stages, f.tier, back.header.layout);
      const again = FeatureFrameCodec.decode(once.subarray(4), back.header.layout, back.header.intrinsics);
      const snap2 = makePerceptionSnapshot({ people: again.people, primaryID: again.primaryID, engagedID: again.engagedID });
      expect(FeatureFrameCodec.record(again.detections, snap2, again.stages, again.tier, back.header.layout)).toEqual(once);
    }
    expect(back.asPerceptionRecording().frames).toHaveLength(s.frames.length);
  });

  test('chunksRotateEverySixtySeconds', () => {
    const frames: FeatureFrame[] = [];
    for (let i = 0; i < 150 * 2; i++) {
      frames.push({ detections: makeFrameDetections(100 + i * 0.5), people: [], primaryID: null, engagedID: null,
        stages: new StageTimings(), tier: 2 });
    }
    const s = new FeatureRecordingSession(T.header('c', ['P1'], 100), frames);
    const [back, , fs] = T.roundTrip(s, ['P1']);
    const chunks = fs.list(back.url!).filter((f) => f.endsWith('.yfr'));
    expect(chunks, '150 s of frames → 3 chunks of ≤ 60 s').toHaveLength(3);
    expect(back.frames).toHaveLength(frames.length);
  });
});
