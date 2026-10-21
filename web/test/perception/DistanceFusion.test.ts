// Port of Tests/FacePerceptionTests/DistanceFusionTests.swift: multi-cue distance fusion and per-person scale
// (design §10), on projected synthetic people.
import { describe, expect, test } from 'vitest';
import type { V2, V3 } from '../../src/core/vec';
import { CameraGeometry } from '../../src/perception/CameraGeometry';
import { DistanceEstimator, KalmanCV } from '../../src/perception/Distance';
import { DistanceFusion, PersonScale } from '../../src/perception/DistanceFusion';
import {
  CameraIntrinsics, NRect, degToRad, joint, makeBodyDetection, makeFaceDetection, makeFrameDetections, makeHeadPose,
} from '../../src/perception/PerceptionTypes';
import type { BodyJointName, FrameDetections, Joint } from '../../src/perception/PerceptionTypes';
import { PersonTracker } from '../../src/perception/Tracker';
import { frames } from './TestSupport';

const geo = new CameraGeometry();
const k = CameraIntrinsics.typicalLandscape;

/// Body dimensions (metres).
interface Build { ipd: number; faceWidth: number; shoulders: number; torso: number; boxWidth: number }
const build = (o: Partial<Build> = {}): Build => ({ ipd: 0.063, faceWidth: 0.145, shoulders: 0.40, torso: 0.52, boxWidth: 0.55, ...o });
const adult = build();
const bigAdult = build({ shoulders: 0.48, torso: 0.60, boxWidth: 0.66 });
/// A child of about 8: IPD a little under the adult constant, much narrower shoulders and a shorter torso.
const child = build({ ipd: 0.058, faceWidth: 0.12, shoulders: 0.30, torso: 0.38, boxWidth: 0.40 });

/// One frame of a person at range `d`, `angle` degrees across the view, head yaw `yaw` (radians); the face is detected
/// only when `face` is true. Face cues scale with range, body cues with depth (as a real camera sees).
function frame(time: number, d: number, b: Build, o: { angle?: number; face?: boolean; yaw?: number; pose?: boolean } = {}): FrameDetections {
  const a = (o.angle ?? 0) * degToRad;
  const yaw = o.yaw ?? 0;
  const head: V3 = { x: Math.sin(a) * d, y: 0, z: Math.cos(a) * d };
  const project = (p: V3): V2 =>
    ({ x: (k.focal.x * p.x / p.z + k.principal.x) / k.imageSize.x, y: (k.focal.y * p.y / p.z + k.principal.y) / k.imageSize.y });
  const at = (x: number, y: number): V2 => project({ x: head.x + x, y: head.y + y, z: head.z });
  const c = project(head);
  const det = makeFrameDetections(time, { intrinsics: k });
  if (o.face ?? true) {
    const w = k.focal.x * b.faceWidth / d / k.imageSize.x;
    const h = k.focal.x * b.faceWidth * 1.25 / d / k.imageSize.y;
    det.faces = [makeFaceDetection(NRect.fromCenter(c, { x: w, y: h }), {
      confidence: 0.95, headPose: makeHeadPose(yaw, 0), interocularPx: k.focal.x * b.ipd * Math.cos(yaw) / d,
    })];
  }
  const joints: Partial<Record<BodyJointName, Joint>> = {};
  if (o.pose ?? true) {
    const j = (x: number, y: number): Joint => joint(at(x, y), 0.9);
    joints.nose = j(0, 0.02);
    joints.neck = j(0, 0.18);
    joints.leftShoulder = j(-b.shoulders / 2, 0.22); joints.rightShoulder = j(b.shoulders / 2, 0.22);
    joints.leftHip = j(-0.14, 0.18 + b.torso); joints.rightHip = j(0.14, 0.18 + b.torso);
  }
  const tl = at(-b.boxWidth / 2, -0.15), br = at(b.boxWidth / 2, 0.65);
  det.bodies = [makeBodyDetection(NRect.make(tl.x, tl.y, br.x - tl.x, br.y - tl.y), { joints })];
  return det;
}

/// Runs frames through a tracker; returns the single track's fused distance after each frame.
const distances = (dets: FrameDetections[], t: PersonTracker): number[] =>
  dets.map((d) => { t.update(d, geo); return t.tracks[0]?.distance.x ?? NaN; });

/// Walks from `near` (face visible, scale learned) out to `far` (face gone beyond 2 m); returns the final error with
/// the learned scale and what the population constants alone would give on the last frame.
function walkAway(b: Build, near: number, far: number, fps: number): { learned: number; population: number } {
  const t = new PersonTracker();
  const dets = frames(7, (i, time) => {
    const rel = Math.fround(time - 1000);
    const d = rel < 2 ? near : Math.min(near + (far - near) * (rel - 2) / 3.5, far);
    return frame(time, d, b, { angle: 8, face: d <= 2, pose: i % 2 === 1 });
  }, { fps });
  const ds = distances(dets, t);
  const last = [...dets].reverse().find((d) => Object.keys(d.bodies[0]?.joints ?? {}).length > 0)!;
  const cues = DistanceFusion.cues(null, last.bodies[0], t.tracks[0].headCentre, k);
  const pop = new KalmanCV(far, 0.09, 0.01);
  for (let i = 0; i < 50; i++) DistanceFusion.fuse(pop, cues, new PersonScale());
  return { learned: Math.abs(ds[ds.length - 1] - far) / far, population: Math.abs(pop.x - far) / far };
}

describe('DistanceFusionTests', () => {
  test('fusionConvergesOnEveryCue', () => {
    for (const fps of [15, 30]) {
      const t = new PersonTracker();
      const ds = distances(frames(2, (i, time) => frame(time, 2.2, adult, { angle: 20, pose: i % 2 === 1 }), { fps }), t);
      const last = ds[ds.length - 1];
      expect(Math.abs(last - 2.2) / 2.2, `fps ${fps}: ${last}`).toBeLessThan(0.03);
      expect(t.tracks[0]?.distanceSource, 'the most precise cue present').toBe('ipd');
    }
  });

  test('cueDropoutDoesNotJump', () => {
    // A broad-shouldered adult near (IPD learns their scale), then the face turns past the yaw limit (IPD lost), then
    // the face disappears altogether: no frame-to-frame jump above 5 %.
    for (const fps of [15, 30]) {
      const t = new PersonTracker();
      const dets = frames(5, (i, time) => {
        const rel = time - 1000;
        const yaw = rel < 2 ? 0 : 70 * degToRad;
        return frame(time, 1.3, bigAdult, { angle: -10, face: rel < 3.5, yaw, pose: i % 2 === 1 });
      }, { fps });
      const ds = distances(dets, t);
      for (let i = fps; i < ds.length; i++) {   // after the first second
        expect(Math.abs(ds[i] - ds[i - 1]) / ds[i - 1], `fps ${fps} frame ${i}: ${ds[i - 1]} → ${ds[i]}`).toBeLessThanOrEqual(0.05);
      }
      expect(Math.abs(ds[ds.length - 1] - 1.3) / 1.3).toBeLessThan(0.05);
      const src = t.tracks[0]?.distanceSource;
      expect(src === 'shoulders' || src === 'bodyBox', `face gone: body cues only (${src})`).toBe(true);
    }
  });

  test('learnedScaleCarriesFar', () => {
    for (const fps of [15, 30]) {
      const r = walkAway(bigAdult, 1.0, 3.5, fps);
      expect(r.learned, `fps ${fps}: learned ${r.learned}`).toBeLessThanOrEqual(0.15);
      expect(r.learned, `fps ${fps}`).toBeLessThan(r.population);
    }
  });

  test('childScaleLearnedNear', () => {
    for (const fps of [15, 30]) {
      const r = walkAway(child, 1.0, 3.0, fps);
      expect(r.learned, `fps ${fps}: learned ${r.learned}`).toBeLessThanOrEqual(0.20);
      expect(r.population, `fps ${fps}: the adult constants alone would be off by more`).toBeGreaterThan(0.20);
    }
  });

  test('noLearningWithoutAConfidentNearIPD', () => {
    const s = new PersonScale();
    const learnFrom = (f: FrameDetections): void =>
      DistanceFusion.learn(s, DistanceFusion.cues(f.faces[0], f.bodies[0], NRect.center(f.faces[0].box), k));
    learnFrom(frame(1000, 2.5, child));
    expect(s.shoulderSamples, 'beyond 1.5 m: population constants').toBe(0);
    learnFrom(frame(1000, 1.0, child, { yaw: 40 * degToRad }));
    expect(s.shoulderSamples, 'turned beyond 30°: no learning').toBe(0);
    const near = frame(1000, 1.0, child);
    for (let i = 0; i < 5; i++) learnFrom(near);
    expect(Math.abs(s.shoulderMetres - 0.30 * 0.063 / 0.058), `child shoulders in IPD units: ${s.shoulderMetres}`).toBeLessThan(0.01);
  });

  test('singleShotMeasureStillWorks', () => {
    const f = frame(1000, 1.8, adult);
    const m = DistanceEstimator.measure(f.faces[0], f.bodies[0], k);
    expect(m.source === 'ipd' && Math.abs(m.distance - 1.8) < 0.04).toBe(true);
  });
});
