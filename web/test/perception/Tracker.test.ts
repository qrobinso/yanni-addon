// Port of Tests/FacePerceptionTests/TrackerTests.swift: deterministic tracker tests on synthetic boxes.
import { describe, expect, test } from 'vitest';
import type { V2 } from '../../src/core/vec';
import { CameraGeometry } from '../../src/perception/CameraGeometry';
import { Hungarian } from '../../src/perception/Hungarian';
import { NRect, joint, makeBodyDetection, makeFrameDetections } from '../../src/perception/PerceptionTypes';
import type { BodyDetection, BodyJointName, FaceDetection, FrameDetections, Joint, PerceptionEvent } from '../../src/perception/PerceptionTypes';
import { PersonTracker } from '../../src/perception/Tracker';
import { EngagedProtection } from '../../src/perception/TrackerAssociation';
import { face, frames } from './TestSupport';

const geo = new CameraGeometry();
const FD = (time: number, faces: FaceDetection[] = [], bodies: BodyDetection[] = []): FrameDetections =>
  makeFrameDetections(time, { faces, bodies });

/// A face + body detection with its head at `c` (viewer frame), sized for ~1.5 m.
function person(c: V2, appearance: number[] | null = null, size = 0.06): [FaceDetection, BodyDetection] {
  const f = face(c, { size });
  const b = makeBodyDetection(NRect.make(c.x - size * 1.8, c.y - size * 0.8, size * 3.6, size * 7), { appearance });
  return [f, b];
}

type Log = [number, PerceptionEvent, number[]][];
function run(tracker: PersonTracker, dets: FrameDetections[]): Log {
  const log: Log = [];
  dets.forEach((d, i) => {
    const ev = tracker.update(d, geo);
    const ids = tracker.visiblePeople(geo).map((p) => p.person.id);
    for (const e of ev) log.push([i, e, ids]);
    if (ev.length === 0) log.push([i, { kind: 'cameraStatus', status: { kind: 'running' } }, ids]);   // marker
  });
  return log;
}
const idSet = (log: Log): number[] => [...new Set(log.flatMap((l) => l[2]))].sort((a, b) => a - b);
const has = (log: Log, kind: PerceptionEvent['kind']): boolean => log.some((l) => l[1].kind === kind);
const ofKind = (log: Log, kind: PerceptionEvent['kind']): Log => log.filter((l) => l[1].kind === kind);
const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);

/// A face + body with an upper-body skeleton (when `pose`), head at `c`, sized like `person`.
function skeletal(c: V2, size = 0.06, appearance: number[] | null = [0.5, 0.5, 0, 0], pose = true): [FaceDetection, BodyDetection] {
  const [f, b] = person(c, appearance, size);
  if (!pose) return [f, b];
  const m = size / 0.145, my = m * 4 / 3;          // metres → normalised units at this distance
  const j = (x: number, y: number): Joint => joint({ x: c.x + x * m, y: c.y + y * my }, 0.9);
  const joints: Partial<Record<BodyJointName, Joint>> = {
    nose: j(0, 0.02), neck: j(0, 0.2), leftShoulder: j(-0.2, 0.25), rightShoulder: j(0.2, 0.25),
    leftElbow: j(-0.25, 0.55), rightElbow: j(0.25, 0.55), leftWrist: j(-0.25, 0.8), rightWrist: j(0.25, 0.8),
    leftHip: j(-0.14, 0.72), rightHip: j(0.14, 0.72),
  };
  return [{ ...f, confidence: 0.95 }, { ...b, joints }];
}

function crossing(appearance: boolean): { left: Set<number>; right: Set<number> } {
  const t = new PersonTracker();
  // A walks right, B walks left; they cross in the middle at t ≈ 2 s (B a little farther: smaller).
  const dets = frames(4, (i, time) => {
    const s = i / 60;
    const a = person({ x: 0.2 + 0.6 * s, y: 0.42 }, appearance ? [1, 0, 0, 0] : null, 0.06);
    const b = person({ x: 0.8 - 0.6 * s, y: 0.38 }, appearance ? [0, 0, 0, 1] : null, 0.05);
    return FD(time, [a[0], b[0]], [a[1], b[1]]);
  });
  const aIDs = new Set<number>(), bIDs = new Set<number>();
  dets.forEach((d, i) => {
    t.update(d, geo);
    if (i <= 3) return;
    const s = i / 60;
    for (const p of t.visiblePeople(geo)) {
      const fb = p.person.faceBox;
      if (fb === null) continue;
      const ax = 0.2 + 0.6 * s, bx = 0.8 - 0.6 * s;
      if (!(Math.abs(ax - bx) > 0.08)) continue;   // ambiguous while overlapping
      const cx = NRect.center(fb).x;
      if (Math.abs(cx - ax) < Math.abs(cx - bx)) aIDs.add(p.person.id); else bIDs.add(p.person.id);
    }
  });
  return { left: aIDs, right: bIDs };
}

/// Two people in the same clothes cross; the IDs seen on each side (only while well apart).
function sameColourCrossing(fps: number, t: PersonTracker, protectFirst = false): { a: Set<number>; b: Set<number> } {
  const aIDs = new Set<number>(), bIDs = new Set<number>();
  const dets = frames(4, (i, time) => {
    const s = (time - 1000) / 4;
    const a = skeletal({ x: 0.25 + 0.5 * s, y: 0.40 }, undefined, undefined, i % 2 === 1);
    const b = skeletal({ x: 0.75 - 0.5 * s, y: 0.41 }, undefined, undefined, i % 2 === 1);
    return FD(time, [a[0], b[0]], [a[1], b[1]]);
  }, { fps });
  for (const d of dets) {
    t.update(d, geo);
    const s = (d.time - 1000) / 4;
    const ax = 0.25 + 0.5 * s, bx = 0.75 - 0.5 * s;
    if (protectFirst && t.protectedID === null) {
      // Protect whoever is on A's side once IDs exist.
      t.protectedID = t.visiblePeople(geo).find((p) => {
        const fb = p.person.faceBox;
        return fb !== null && Math.abs(NRect.center(fb).x - ax) < Math.abs(NRect.center(fb).x - bx);
      })?.person.id ?? null;
    }
    if (!(Math.abs(ax - bx) > 0.08)) continue;
    for (const p of t.visiblePeople(geo)) {
      const fb = p.person.faceBox;
      if (fb === null) continue;
      const cx = NRect.center(fb).x;
      if (Math.abs(cx - ax) < Math.abs(cx - bx)) aIDs.add(p.person.id); else bIDs.add(p.person.id);
    }
  }
  return { a: aIDs, b: bIDs };
}

describe('TrackerTests', () => {
  test('steadyWalkKeepsOneID', () => {
    const t = new PersonTracker();
    const dets = frames(4, (i, time) => { const [f, b] = person({ x: 0.15 + i * 0.012, y: 0.4 }); return FD(time, [f], [b]); });
    const seen = new Set<number>();
    let entered = 0;
    for (const d of dets) {
      for (const e of t.update(d, geo)) if (e.kind === 'personEntered') entered += 1;
      for (const p of t.visiblePeople(geo)) seen.add(p.person.id);
    }
    expect(sorted(seen)).toEqual([1]);
    expect(entered).toBe(1);
  });

  test('crossingKeepsIDs', () => {
    for (const app of [true, false]) {
      const r = crossing(app);
      expect(r.left.size === 1 && r.right.size === 1 && sorted(r.left)[0] !== sorted(r.right)[0], `appearance ${app}`).toBe(true);
    }
  });

  test('occlusionCoastsAndRecovers', () => {
    const t = new PersonTracker();
    // Visible 1 s, hidden 0.8 s, visible again near the same place.
    const dets = frames(3, (_, time) => {
      const hidden = time >= 1001 && time < 1001.8;
      const [f, b] = person({ x: 0.5, y: 0.4 });
      return FD(time, hidden ? [] : [f], hidden ? [] : [b]);
    });
    const log = run(t, dets);
    expect(idSet(log)).toEqual([1]);
    expect(has(log, 'personLeft')).toBe(false);
    // Out of view after the 0.3 s visible coast, back in view without a new personEntered.
    const outs = ofKind(log, 'personOutOfView');
    expect(outs.length).toBe(1);
    expect(ofKind(log, 'personEntered').length).toBe(1);
    expect(Math.abs(outs[0][0] / 15 - 1.3), 'out of view ≈ 0.3 s after the last sighting').toBeLessThan(0.1);
  });

  test('reentryReusesIDWithinWindow', () => {
    const t = new PersonTracker();
    // Leaves through the right edge, back 2.5 s later at the same edge.
    const dets = frames(8, (_, time) => {
      const rel = time - 1000;
      if (rel < 1.5) { const [f, b] = person({ x: 0.8 + rel * 0.1, y: 0.4 }); return FD(time, [f], [b]); }
      if (rel < 4.0) return FD(time);
      const [f, b] = person({ x: 0.94, y: 0.4 });
      return FD(time, [f], [b]);
    });
    const log = run(t, dets);
    expect(idSet(log)).toEqual([1]);
    expect(has(log, 'personLeft')).toBe(false);
    expect(ofKind(log, 'personEntered').length).toBe(1);
    const out = ofKind(log, 'personOutOfView')[0]?.[1];
    expect(out?.kind === 'personOutOfView' ? out.exitEdge : 'no out-of-view').toBe('right');
  });

  test('lateReturnGetsNewIDAndLeftFiresOnce', () => {
    const t = new PersonTracker();
    const dets = frames(9, (_, time) => {
      const rel = time - 1000;
      if (rel < 1) { const [f, b] = person({ x: 0.5, y: 0.4 }); return FD(time, [f], [b]); }
      if (rel < 6.5) return FD(time);
      const [f, b] = person({ x: 0.5, y: 0.4 });
      return FD(time, [f], [b]);
    });
    const log = run(t, dets);
    const lefts = ofKind(log, 'personLeft');
    expect(lefts.length).toBe(1);
    const at = lefts[0][0] / 15;
    expect(Math.abs(at - (1 + 1.0 + 3)), `personLeft once the re-entry window closes: 1 s coast + 3 s (${at})`).toBeLessThan(0.15);
    expect(idSet(log), 'a new ID, never reused').toEqual([1, 2]);
  });

  test('singleFrameFalsePositivesNeverVisible', () => {
    const t = new PersonTracker();
    const dets = frames(3, (i, time) => {
      // A flicker every 5th frame in different places.
      if (i % 5 !== 0) return FD(time);
      return FD(time, [face({ x: (i % 7) / 7, y: 0.5 })]);
    });
    const log = run(t, dets);
    expect(log.every((l) => l[2].length === 0)).toBe(true);
    expect(has(log, 'personEntered')).toBe(false);
  });

  test('faceOnlyBeyondOneMetreNeedsABody', () => {
    const t = new PersonTracker();
    // A small face (≈ 2.5 m) with no body: never present. Near (0.6 m) face-only: present.
    for (const d of frames(1, (_, time) => FD(time, [face({ x: 0.3, y: 0.4 }, { size: 0.03 })]))) t.update(d, geo);
    expect(t.visiblePeople(geo).length).toBe(0);
    const t2 = new PersonTracker();
    for (const d of frames(1, (_, time) => FD(time, [face({ x: 0.5, y: 0.45 }, { size: 0.16 })]))) t2.update(d, geo);
    expect(t2.visiblePeople(geo).length).toBe(1);
  });

  test('faceOnlyTrackKeepsItsIDWhenTheBodyAppears', () => {
    const t = new PersonTracker();
    const dets = frames(2, (_, time) => {
      const f = face({ x: 0.5, y: 0.45 }, { size: 0.16 });
      if (time - 1000 < 1) return FD(time, [f]);
      return FD(time, [f], [makeBodyDetection(NRect.make(0.2, 0.3, 0.6, 0.7))]);
    });
    expect(idSet(run(t, dets))).toEqual([1]);
  });

  test('staticFaceIsSuppressed', () => {
    const t = new PersonTracker();
    // A poster at 0.8 m: identical box, no blinks, for 32 s (10 fps).
    const dets = frames(32, (_, time) => FD(time, [face({ x: 0.3, y: 0.4 }, { size: 0.12 })]), { fps: 10 });
    let suppressedAt: number | null = null;
    for (const d of dets) for (const e of t.update(d, geo)) if (e.kind === 'staticFaceSuppressed') suppressedAt = d.time - 1000;
    expect(suppressedAt).not.toBeNull();
    expect(Math.abs(suppressedAt! - 30)).toBeLessThan(0.3);
    expect(t.visiblePeople(geo).length).toBe(0);
    expect(t.suppressionRegions.length).toBe(1);

    // A real person standing still but blinking is never static.
    const real = new PersonTracker();
    const blinking = frames(35, (i, time) =>
      FD(time, [face({ x: 0.3, y: 0.4 }, { size: 0.12, openness: i % 40 < 2 ? 0.05 : 0.3 })]), { fps: 10 });
    for (const d of blinking) real.update(d, geo);
    expect(real.visiblePeople(geo).length).toBe(1);
  });

  test('staticRegionIsSuspectForNewTracks', () => {
    const t = new PersonTracker();
    const poster = (time: number): FrameDetections => FD(time, [face({ x: 0.3, y: 0.4 }, { size: 0.12 })]);
    for (const d of frames(31, (_, time) => poster(time), { fps: 10 })) t.update(d, geo);
    // The poster's track is lost (lighting), then re-detected: static again after only the suspect time.
    for (const d of frames(6, (_, time) => FD(time), { fps: 10, t0: 1031 })) t.update(d, geo);
    let again: number | null = null;
    for (const d of frames(5, (_, time) => poster(time), { fps: 10, t0: 1037 })) {
      for (const e of t.update(d, geo)) if (e.kind === 'staticFaceSuppressed') again = d.time - 1037;
    }
    expect(again).not.toBeNull();
    expect(again!).toBeLessThan(3.5);
  });

  test('hungarianFindsTheCheapestAssignment', () => {
    expect(Hungarian.assign([[4, 1, 3], [2, 0, 5], [3, 2, 2]])).toEqual([1, 0, 2]);
    expect(Hungarian.assign([[0.2, 5], [5, 1.5]], 1.2)).toEqual([0, null]);
    expect(Hungarian.assign([[1], [0.5]])).toEqual([null, 0]);
  });

  test('associationPairsFacesWithUpperBodies', () => {
    const f1 = face({ x: 0.3, y: 0.3 }), f2 = face({ x: 0.8, y: 0.3 });
    const b1 = makeBodyDetection(NRect.make(0.2, 0.2, 0.2, 0.5));
    const b2 = makeBodyDetection(NRect.make(0.5, 0.0, 0.2, 0.2));   // face centre outside → unpaired
    const obs = PersonTracker.associate([f1, f2], [b1, b2]);
    expect(obs.length).toBe(3);
    expect(obs.some((o) => o.face === f1 && o.body === b1)).toBe(true);
    expect(obs.some((o) => o.face === f2 && o.body === null)).toBe(true);
    expect(obs.some((o) => o.face === null && o.body === b2)).toBe(true);
  });

  // MARK: - Association rounds, re-update, protection (design §9)

  test('sameColourCrossingKeepsIDs', () => {
    for (const fps of [15, 30]) {
      const r = sameColourCrossing(fps, new PersonTracker());
      expect(r.a.size === 1 && r.b.size === 1 && sorted(r.a)[0] !== sorted(r.b)[0], `fps ${fps}`).toBe(true);
    }
  });

  test('protectedPersonNeverSwapsInACrossing', () => {
    for (const fps of [15, 30]) {
      const t = new PersonTracker();
      const r = sameColourCrossing(fps, t, true);
      const pid = t.protectedID;
      expect(pid).not.toBeNull();
      expect(sorted(r.a), `fps ${fps}: the engaged ID stays on its own body`).toEqual([pid]);
      expect(r.b.has(pid!)).toBe(false);
    }
  });

  test('protectionKeepsTheGreedyMatchUntilThePreferencePersists', () => {
    // Row 0 (protected) is cheapest on column 0, but the global optimum moves it to column 1.
    const cost = [[0.5, 0.6], [0.55, 1.5]];
    expect(Hungarian.assign(cost, 1.2)).toEqual([1, 0]);
    const p = new EngagedProtection();
    let frame = 0;
    while (frame / 15 < 0.45) {
      expect(p.resolve(cost, 0, 7, 1.2, frame / 15, 0.5)).toEqual([0, null]);
      frame += 1;
    }
    expect(p.resolve(cost, 0, 7, 1.2, 0.5, 0.5), 'preferred for 0.5 s: accepted').toEqual([1, 0]);
    expect(p.conflicts).toBe(frame + 1);
    // One agreeing frame resets the clock.
    p.resolve([[0.1, 2], [2, 0.1]], 0, 7, 1.2, 0.6, 0.5);
    expect(p.resolve(cost, 0, 7, 1.2, 0.7, 0.5)).toEqual([0, null]);
    // A different protected person restarts it too; no protected row: the plain global assignment.
    expect(p.resolve(cost, 0, 8, 1.2, 1.3, 0.5)).toEqual([0, null]);
    expect(p.resolve(cost, null, null, 1.2, 1.4, 0.5)).toEqual([1, 0]);
  });

  test('longOcclusionWhileMovingRecoversWithSaneVelocity', () => {
    for (const fps of [15, 30]) {
      for (const hidden of [0.6, 0.9]) {
        const t = new PersonTracker();
        const v = 0.12;     // normalised units per second
        const dets = frames(3, (i, time) => {
          const rel = time - 1000;
          if (rel >= 1 && rel < 1 + hidden) return FD(time);
          const [f, b] = skeletal({ x: 0.2 + v * rel, y: 0.4 }, undefined, undefined, i % 2 === 1);
          return FD(time, [f], [b]);
        }, { fps });
        const ids = new Set<number>();
        let recovered: V2 | null = null;
        for (const d of dets) {
          t.update(d, geo);
          for (const tr of t.tracks) if (tr.id !== null) ids.add(tr.id);
          if (recovered === null && d.time - 1000 >= 1 + hidden - 1e-6) recovered = t.tracks[0]?.velocity ?? null;
        }
        expect(sorted(ids), `fps ${fps} hidden ${hidden}`).toEqual([1]);
        expect(recovered).not.toBeNull();
        const vel = recovered!;
        expect(Math.abs(vel.x - v) < 0.4 * v && Math.abs(vel.y) < 0.03, `fps ${fps} hidden ${hidden}: velocity ${vel.x},${vel.y}`).toBe(true);
      }
    }
  });

  /// Walks right, then during the occlusion slows to 0.3 of the speed; on recovery the velocity reflects the slower
  /// virtual trajectory, not the coasting one.
  test('reupdateReplacesTheCoastingVelocity', () => {
    for (const fps of [15, 30]) {
      const t = new PersonTracker();
      const v = 0.15;
      const dets = frames(2.2, (i, time) => {
        const rel = Math.fround(time - 1000);   // f32: Swift's Float(time - 1000) makes frame 27 (1.8 s) visible
        if (rel >= 1 && rel < Math.fround(1.8)) return FD(time);
        const x = rel < 1 ? 0.2 + v * rel : 0.2 + v + 0.3 * v * (rel - 1);
        const [f, b] = skeletal({ x, y: 0.4 }, undefined, undefined, i % 2 === 1);
        return FD(time, [f], [b]);
      }, { fps });
      let recovered: number | null = null;
      for (const d of dets) {
        t.update(d, geo);
        if (recovered === null && d.time - 1000 >= 1.8 - 1e-6) recovered = t.tracks[0]?.velocity.x ?? null;
      }
      expect(recovered).not.toBeNull();
      expect(recovered!, `fps ${fps}: velocity follows the observations (0.3·v), not the coast (v)`).toBeLessThan(0.6 * v);
      expect(t.tracks.filter((tr) => tr.id !== null).map((tr) => tr.id)).toEqual([1]);
    }
  });

  test('personWhoStopsWhileOccludedIsRecoveredFromTheLastObservation', () => {
    for (const fps of [15, 30]) {
      const t = new PersonTracker();
      // Walks right fast and stops the moment they are hidden (0.9 s); reappears where they stopped.
      const v = 0.3;
      const dets = frames(3, (i, time) => {
        const rel = time - 1000;
        if (rel >= 1 && rel < 1.9) return FD(time);
        const x = 0.15 + v * Math.min(rel, 1 - 1 / fps);
        const [f, b] = skeletal({ x, y: 0.4 }, undefined, undefined, i % 2 === 1);
        return FD(time, [f], [b]);
      }, { fps });
      const ids = new Set<number>();
      const after: number[] = [];
      for (const d of dets) {
        t.update(d, geo);
        for (const tr of t.tracks) if (tr.id !== null) ids.add(tr.id);
        const tr = t.tracks.find((x) => x.id === 1);
        if (d.time - 1000 >= 1.9 - 1e-6 && tr !== undefined) after.push(tr.velocity.x);
      }
      expect(sorted(ids), `fps ${fps}: same ID, no new person`).toEqual([1]);
      expect(after.length > 3 && Math.abs(after[3]) < 0.1, `fps ${fps}: velocity settles (${after.slice(0, 6)})`).toBe(true);
      expect(t.tracks.length).toBe(1);
    }
  });
});
