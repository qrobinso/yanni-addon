// Port of FacePerception/Tracker.swift.
//
// port-note: Swift `Track` is a value type; here it is a class mutated in place. Every place the Swift copies state
// that both sides keep (the Kalman filters into `cxObs` / `cyObs`) copies explicitly, and vectors are always replaced,
// never mutated, because several fields start out sharing one value.
import type { V2 } from '../core/vec';
import { CameraGeometry } from './CameraGeometry';
import { DistanceEstimator, KalmanCV } from './Distance';
import { DistanceFusion, PersonScale } from './DistanceFusion';
import { Hungarian } from './Hungarian';
import { NRect, makeTrackedPerson, vlength2 } from './PerceptionTypes';
import type {
  BodyDetection, CameraIntrinsics, DistanceSource, ExitEdge, FaceDetection, FrameDetections, PerceptionEvent,
  TrackState, TrackedPerson,
} from './PerceptionTypes';
import { AssociationGeometry, EngagedProtection, ObsRing, Skeleton, obsEntryHeadBox } from './TrackerAssociation';

const add2 = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub2 = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
const scale2 = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });

/// Tracker tunables.
export interface TrackerParams {
  /// Tentative → confirmed after `confirmHits` hits within `confirmWindow` analysed frames.
  confirmHits: number;
  confirmWindow: number;
  /// Coast on misses this long (seconds) before deleting.
  coastMax: number;
  /// Coasting people stay in the visible list this long.
  visibleCoast: number;
  /// A new track within this long of a deletion, near the exit point, takes the old ID back.
  reentryWindow: number;
  /// Re-entry radius (gaze units) around the exit point.
  reentryRadius: number;
  /// Max appearance (histogram) distance for re-entry and as an association term.
  reentryAppearance: number;
  /// Association gate (round 1).
  costGate: number;
  /// Last-observation recovery (round 2): minimum IoU between an unmatched track's last observed box and a detection.
  recoveryIoU: number;
  /// A re-association after at least this many missed analysed frames re-runs the Kalman over a virtual linear
  /// trajectory from the last observation (observation-centric re-update).
  reupdateAfterMisses: number;
  /// Engaged-person protection: the global assignment may move the engaged person's track off its own best match
  /// only once it has preferred that for this long (seconds).
  protectionPersist: number;
  /// Static face: no movement beyond `staticJitter`, `staticSizeJitter` (relative) and no openness change beyond
  /// `staticOpenness` for `staticSeconds` (or `staticSuspectSeconds` inside a region already found static).
  staticSeconds: number;
  staticSuspectSeconds: number;
  staticJitter: number;
  staticSizeJitter: number;
  staticOpenness: number;
  /// Beyond this distance a face needs a body box to count as present.
  faceOnlyMaxDistance: number;
  /// Maximum tracks kept (tier).
  maxTracks: number;
}
export const makeTrackerParams = (o: Partial<TrackerParams> = {}): TrackerParams => ({
  confirmHits: 2, confirmWindow: 3, coastMax: 1.0, visibleCoast: 0.3, reentryWindow: 3, reentryRadius: 0.25,
  reentryAppearance: 0.35, costGate: 1.2, recoveryIoU: 0.3, reupdateAfterMisses: 2, protectionPersist: 0.5,
  staticSeconds: 30, staticSuspectSeconds: 3, staticJitter: 0.005, staticSizeJitter: 0.03, staticOpenness: 0.04,
  faceOnlyMaxDistance: 1.0, maxTracks: 6, ...o,
});

/// One association input: a face and / or an upper-body box that belong together.
export class Observation {
  constructor(readonly face: FaceDetection | null, readonly body: BodyDetection | null) {}

  /// The head region: the face box, or the top of the body box.
  get headBox(): NRect {
    if (this.face !== null) return this.face.box;
    const b = this.body!.box;
    return { x: b.x + b.w * 0.3, y: b.y, w: b.w * 0.4, h: b.h * 0.3 };
  }
  get appearance(): number[] | null { return this.body?.appearance ?? null; }
}

/// One internal track.
export class Track {
  key: number;                 // internal key (tentative tracks have no public ID yet)
  id: number | null = null;    // public ID (set at confirmation)
  state: TrackState = 'tentative';
  hits = 1;
  framesSinceBirth = 0;
  cx: KalmanCV; cy: KalmanCV;
  headSize: V2;
  bodyBox: NRect | null;
  faceBox: NRect | null;
  face: FaceDetection | null;
  body: BodyDetection | null;
  appearance: number[] | null;
  firstSeen: number;
  lastSeen: number;
  lastPredict: number;
  lastBodySeen = -Infinity;
  distance: KalmanCV;
  distanceSource: DistanceSource = 'prior';
  announced = false;
  visible = false;
  lastVisiblePosition: V2 = { x: 0.5, y: 0.5 };
  exitEdge: ExitEdge | null = null;
  // Static-face check.
  anchorTime: number;
  anchorCentre: V2;
  anchorSize: V2;
  anchorOpenness: number | null;
  isStatic = false;
  suspect = false;
  /// Has moved or blinked at least once since it appeared (a poster never does); engagement needs it.
  live = false;
  hitThisFrame = true;
  // Association state (design §9).
  /// The last four observations (direction cost, last-observation recovery, re-update).
  ring = new ObsRing();
  /// The last observed skeleton (OKS cost).
  skeleton: Skeleton | null = null;
  /// Upper-body box height and aspect (w / h), smoothed, and its centre's offset from the observed head centre.
  boxHeight: number | null = null;
  boxAspect: number | null = null;
  bodyOffset: V2 = { x: 0, y: 0 };
  /// The position filters right after the last real observation (observation-centric re-update).
  cxObs: KalmanCV | null = null;
  cyObs: KalmanCV | null = null;
  /// Consecutive analysed frames without a match before this one.
  missedFrames = 0;
  /// The person's own body dimensions for the distance cues.
  scale = new PersonScale();

  constructor(o: {
    key: number; cx: KalmanCV; cy: KalmanCV; headSize: V2; bodyBox: NRect | null; faceBox: NRect | null;
    face: FaceDetection | null; body: BodyDetection | null; appearance: number[] | null; firstSeen: number;
    lastSeen: number; lastPredict: number; distance: KalmanCV; anchorTime: number; anchorCentre: V2; anchorSize: V2;
    anchorOpenness: number | null;
  }) {
    this.key = o.key; this.cx = o.cx; this.cy = o.cy; this.headSize = o.headSize; this.bodyBox = o.bodyBox;
    this.faceBox = o.faceBox; this.face = o.face; this.body = o.body; this.appearance = o.appearance;
    this.firstSeen = o.firstSeen; this.lastSeen = o.lastSeen; this.lastPredict = o.lastPredict; this.distance = o.distance;
    this.anchorTime = o.anchorTime; this.anchorCentre = o.anchorCentre; this.anchorSize = o.anchorSize;
    this.anchorOpenness = o.anchorOpenness;
  }

  get headCentre(): V2 { return { x: this.cx.x, y: this.cy.x }; }
  get headBox(): NRect { return NRect.fromCenter(this.headCentre, this.headSize); }
  get velocity(): V2 { return { x: this.cx.v, y: this.cy.v }; }
  /// The upper-body box predicted for this frame (last size, moved with the head filter).
  get predictedBodyBox(): NRect | null {
    const h = this.boxHeight, a = this.boxAspect;
    if (this.bodyBox === null || h === null || a === null) return this.bodyBox;
    return NRect.fromCenter(add2(this.headCentre, this.bodyOffset), { x: h * a, y: h });
  }
}

/// A deleted track waiting out its re-entry window.
export interface Departed {
  id: number;
  deletedAt: number;
  exitPoint: V2;      // viewer frame
  exitGaze: V2;
  exitEdge: ExitEdge | null;
  appearance: number[] | null;
}

/// One visible person as the tracker sees them (Swift: a labelled tuple).
export interface VisiblePerson {
  person: TrackedPerson;
  face: FaceDetection | null;
  body: BodyDetection | null;
  fresh: boolean;
  live: boolean;
}

/// Multi-person tracker: constant-velocity Kalman per person (head centre in the viewer frame + fused distance),
/// association in rounds (Hungarian on height-modulated IoU, centre distance, direction, skeleton OKS, appearance and
/// size; then last-observation recovery; then births), observation-centric re-update after misses, engaged-person
/// protection, tentative → confirmed → coasting, a re-entry window, static-face suppression. Deterministic.
///
/// Not built: the ByteTrack-style low-confidence pass (design §9).
export class PersonTracker {
  params: TrackerParams;
  /// The engaged person's ID (set by the processor each frame): their track is protected from swaps.
  protectedID: number | null = null;
  protection = new EngagedProtection();
  tracks: Track[] = [];
  departed: Departed[] = [];
  suppression: NRect[] = [];
  nextID = 1;
  nextKey = 1;

  constructor(params: TrackerParams = makeTrackerParams()) { this.params = params; }

  /// Frames on which the global assignment wanted to move the protected (engaged) track off its own best match.
  get protectionConflicts(): number { return this.protection.conflicts; }

  /// Session-wide regions where a static face was found.
  get suppressionRegions(): NRect[] { return this.suppression; }

  /// Pairs faces with upper-body boxes: a face belongs to the body whose box contains its centre horizontally and in
  /// its upper 60 % (the nearest such body; one face per body). Unpaired faces and bodies stand alone.
  static associate(faces: readonly FaceDetection[], bodies: readonly BodyDetection[]): Observation[] {
    const used = new Set<number>();
    const obs: Observation[] = [];
    for (const f of [...faces].sort((a, b) => NRect.area(b.box) - NRect.area(a.box))) {
      const c = NRect.center(f.box);
      let best: [number, number] | null = null;
      bodies.forEach((b, i) => {
        if (used.has(i)) return;
        const inside = c.x >= b.box.x && c.x <= NRect.maxX(b.box) && c.y >= b.box.y && c.y <= b.box.y + 0.6 * b.box.h;
        if (!inside) return;
        const off = Math.abs(c.x - NRect.center(b.box).x);
        if (best === null || off < best[1]) best = [i, off];
      });
      const bi = (best as [number, number] | null)?.[0] ?? null;
      if (bi !== null) { used.add(bi); obs.push(new Observation(f, bodies[bi])); } else obs.push(new Observation(f, null));
    }
    bodies.forEach((b, i) => { if (!used.has(i)) obs.push(new Observation(null, b)); });
    return obs;
  }

  static appearanceDistance(a: readonly number[] | null, b: readonly number[] | null): number | null {
    if (a === null || b === null || a.length !== b.length || a.length === 0) return null;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / 2;
  }

  /// Round-1 cost: `1 − HMIoU + 0.5·centre/diag + 0.2·Δθ_dir/π + 0.3·(1 − OKS) + 0.3·d_hist + 0.3·|log area ratio|/2`.
  /// Terms whose inputs are missing (no skeleton, no histogram, no direction yet) are left out.
  cost(t: Track, o: Observation, skeleton: Skeleton | null = null, imageSize: V2 = { x: 1920, y: 1440 }): number {
    const oh = o.headBox, th = t.headBox;
    let overlap = AssociationGeometry.hmiou(th, oh);
    const pb = t.predictedBodyBox, ob = o.body?.box ?? null;
    if (pb !== null && ob !== null) overlap = Math.max(overlap, AssociationGeometry.hmiou(pb, ob));
    const diag = Math.max(Math.max(NRect.diagonal(th), NRect.diagonal(oh)), 0.02);
    const centre = vlength2(sub2(t.headCentre, NRect.center(oh))) / diag;
    let ratio: number;
    if (pb !== null && ob !== null) ratio = Math.abs(Math.log(Math.max(NRect.area(ob), 1e-6) / Math.max(NRect.area(pb), 1e-6))) / 2;
    else ratio = Math.abs(Math.log(Math.max(NRect.area(oh), 1e-6) / Math.max(NRect.area(th), 1e-6))) / 2;
    let c = 1 - overlap + 0.5 * centre + 0.3 * ratio;
    const last = t.ring.last, old = t.ring.back(Math.min(3, t.ring.count - 1));
    if (t.ring.count >= 2 && last !== null && old !== null) {
      c += 0.2 * AssociationGeometry.directionTerm(sub2(last.head, old.head), sub2(NRect.center(oh), last.head));
    }
    const ts = t.skeleton;
    if (ts !== null && skeleton !== null && ob !== null) {
      const oks = ts.oks(sub2(t.headCentre, ts.head), skeleton, imageSize, NRect.area(ob) * imageSize.x * imageSize.y);
      if (oks !== null) c += 0.3 * (1 - oks);
    }
    const d = PersonTracker.appearanceDistance(t.appearance, o.appearance);
    if (d !== null) c += 0.3 * d;
    return c;
  }

  /// Round-2 overlap: the track's last observed box (not its prediction) against the detection.
  recoveryIoU(t: Track, o: Observation): number {
    const last = t.ring.last;
    if (last === null) return 0;
    let v = NRect.iou(obsEntryHeadBox(last), o.headBox);
    if (last.body !== null && o.body !== null) v = Math.max(v, NRect.iou(last.body, o.body.box));
    return v;
  }

  /// Advances to the frame: predict, associate, update, confirm, coast, delete, re-entry and static checks.
  /// Returns the tracker events (entered, out of view, left, static).
  update(det: FrameDetections, geometry: CameraGeometry): PerceptionEvent[] {
    const now = det.time;
    const p = this.params;
    const events: PerceptionEvent[] = [];

    // Predict.
    for (const t of this.tracks) {
      const dt = Math.max(now - t.lastPredict, 0);
      t.cx.predict(dt); t.cy.predict(dt); t.distance.predict(dt);
      t.lastPredict = now;
      t.hitThisFrame = false;
      t.framesSinceBirth += 1;
    }

    // Associate, round 1: every track (confirmed first, so an established person keeps priority over a tentative
    // duplicate) against every observation, with engaged-person protection.
    const obs = PersonTracker.associate(det.faces, det.bodies);
    const matchedObs = new Array<boolean>(obs.length).fill(false);
    const matchedTrack = new Array<boolean>(this.tracks.length).fill(false);
    if (this.tracks.length > 0 && obs.length > 0) {
      const tr = this.tracks;
      const rank = (i: number): number => tr[i].id !== null ? 0 : 1;
      const order = tr.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || tr[a].key - tr[b].key);
      const skeletons = obs.map((o) => Skeleton.make(o.body, NRect.center(o.headBox)));
      const size = det.intrinsics.imageSize;
      const matrix = order.map((ti) => obs.map((o, j) => this.cost(tr[ti], o, skeletons[j], size)));
      const pid = this.protectedID;
      const pr = pid === null ? -1 : order.findIndex((i) => tr[i].id === pid);
      const assignment = this.protection.resolve(matrix, pr < 0 ? null : pr, pid, p.costGate, now, p.protectionPersist);
      assignment.forEach((col, row) => {
        if (col === null) return;
        this.apply(obs[col], order[row], now, det.intrinsics);
        matchedObs[col] = true;
        matchedTrack[order[row]] = true;
      });
    }
    // Round 2: last-observation recovery (IoU only) for the tracks and observations round 1 left over.
    const leftTracks = this.tracks.map((_, i) => i).filter((i) => !matchedTrack[i] && this.tracks[i].ring.count > 0);
    const leftObs = obs.map((_, i) => i).filter((i) => !matchedObs[i]);
    if (leftTracks.length > 0 && leftObs.length > 0) {
      const matrix = leftTracks.map((ti) => leftObs.map((j) => 1 - this.recoveryIoU(this.tracks[ti], obs[j])));
      Hungarian.assign(matrix, 1 - p.recoveryIoU).forEach((col, row) => {
        if (col === null) return;
        this.apply(obs[leftObs[col]], leftTracks[row], now, det.intrinsics);
        matchedObs[leftObs[col]] = true;
      });
    }
    // Round 3: births.
    for (let j = 0; j < obs.length; j++) {
      if (matchedObs[j]) continue;
      if (!(this.tracks.length < p.maxTracks * 2)) break;
      this.tracks.push(this.makeTrack(obs[j], now, det.intrinsics));
    }

    // States, confirmation, deletion.
    const keep: Track[] = [];
    for (const t of this.tracks) {
      t.missedFrames = t.hitThisFrame ? 0 : t.missedFrames + 1;
      if (t.hitThisFrame) {
        if (t.state === 'tentative') {
          if (t.hits >= p.confirmHits) this.confirm(t, now, geometry);
        } else {
          t.state = 'confirmed';
        }
      } else if (t.state === 'tentative') {
        if (t.framesSinceBirth >= p.confirmWindow - 1 && t.hits < p.confirmHits) continue;
      } else {
        t.state = 'coasting';
        if (now - t.lastSeen > p.coastMax) {
          if (t.announced && t.id !== null) {
            if (t.visible) events.push(this.outOfView(t, geometry));
            this.departed.push({ id: t.id, deletedAt: now, exitPoint: t.lastVisiblePosition,
              exitGaze: geometry.gazePosition(t.lastVisiblePosition), exitEdge: t.exitEdge, appearance: t.appearance });
          }
          continue;
        }
      }
      keep.push(t);
    }
    this.tracks = keep;

    this.mergeDuplicates(now, geometry, events);
    this.updateStatic(now, events);

    // Visibility (engine list) and out-of-view events.
    for (const t of this.tracks) {
      const vis = this.isVisible(t, now);
      if (vis && !t.announced && t.id !== null) {
        t.announced = true;
        events.push({ kind: 'personEntered', id: t.id, at: geometry.gazePosition(t.headCentre), distance: t.distance.x });
      }
      if (vis) t.lastVisiblePosition = t.headCentre;
      if (t.visible && !vis && t.announced) events.push(this.outOfView(t, geometry));
      t.visible = vis;
    }

    // Departed tracks whose re-entry window closed: gone for good.
    const still: Departed[] = [];
    for (const d of this.departed) {
      if (now - d.deletedAt > p.reentryWindow) {
        events.push({ kind: 'personLeft', id: d.id, lastPosition: d.exitGaze, exitEdge: d.exitEdge });
      } else {
        still.push(d);
      }
    }
    this.departed = still;
    return events;
  }

  isVisible(t: Track, now: number): boolean {
    if (t.id === null || t.isStatic) return false;
    switch (t.state) {
      case 'tentative': return false;
      case 'confirmed': break;
      case 'coasting': if (now - t.lastSeen > this.params.visibleCoast) return false;
    }
    // Beyond 1 m a face alone is not enough (photos, screens): presence needs a body box.
    if (t.distance.x > this.params.faceOnlyMaxDistance && now - t.lastBodySeen > this.params.coastMax) return false;
    return true;
  }

  private outOfView(t: Track, geometry: CameraGeometry): PerceptionEvent {
    // Where they were heading: the last position pushed along the velocity for up to the visible coast.
    const p = add2(t.lastVisiblePosition, scale2(t.velocity, this.params.visibleCoast));
    t.exitEdge = CameraGeometry.edge(p, 0.1);
    return { kind: 'personOutOfView', id: t.id ?? -1, lastPosition: geometry.gazePosition(t.lastVisiblePosition),
      distance: t.distance.x, exitEdge: t.exitEdge };
  }

  private makeTrack(o: Observation, now: number, intrinsics: CameraIntrinsics): Track {
    const h = o.headBox;
    const c = NRect.center(h), s = NRect.size(h);
    const m = DistanceEstimator.measure(o.face, o.body, intrinsics);
    const t = new Track({
      key: this.nextKey, cx: new KalmanCV(c.x, 0.5, 0.0001, 0.0004), cy: new KalmanCV(c.y, 0.5, 0.0001, 0.0004),
      headSize: s, bodyBox: o.body?.box ?? null, faceBox: o.face?.box ?? null, face: o.face, body: o.body,
      appearance: o.appearance, firstSeen: now, lastSeen: now, lastPredict: now,
      distance: new KalmanCV(m.distance, 0.09, 0.01 * m.distance * m.distance, 0.04),
      anchorTime: now, anchorCentre: c, anchorSize: s, anchorOpenness: o.face?.eyes?.openness ?? null,
    });
    this.nextKey += 1;
    t.distanceSource = m.source;
    if (o.body !== null) t.lastBodySeen = now;
    t.framesSinceBirth = 0;
    t.cxObs = t.cx.copy(); t.cyObs = t.cy.copy();
    PersonTracker.noteObservation(o, h, now, t);
    DistanceFusion.learn(t.scale, DistanceFusion.cues(o.face, o.body, c, intrinsics));
    t.suspect = this.suppression.some((r) => NRect.iou(r, h) > 0.3 || NRect.contains(r, c));
    return t;
  }

  /// Ring, body-box size, body offset and skeleton from an observation.
  private static noteObservation(o: Observation, h: NRect, now: number, t: Track): void {
    const c = NRect.center(h);
    t.ring.push({ time: now, head: c, headSize: NRect.size(h), body: o.body?.box ?? null });
    const b = o.body;
    if (b === null) return;
    const height = Math.max(b.box.h, 1e-4), aspect = b.box.w / height;
    t.boxHeight = t.boxHeight === null ? height : t.boxHeight + (height - t.boxHeight) * 0.5;
    t.boxAspect = t.boxAspect === null ? aspect : t.boxAspect + (aspect - t.boxAspect) * 0.5;
    t.bodyOffset = sub2(NRect.center(b.box), c);
    const s = Skeleton.make(b, c);
    if (s !== null) t.skeleton = s;
  }

  /// Observation-centric re-update: after ≥ `reupdateAfterMisses` missed frames, restart the position filters from
  /// their state at the last observation and feed them a linear virtual trajectory to the new observation (at evenly
  /// spaced virtual frame times), so the velocity reflects where the person really went.
  private reupdate(i: number, p: V2, now: number): void {
    const t = this.tracks[i];
    const last = t.ring.last;
    if (t.missedFrames < this.params.reupdateAfterMisses || last === null || t.cxObs === null || t.cyObs === null ||
      !(now > last.time)) return;
    const cx = t.cxObs.copy(), cy = t.cyObs.copy();
    const m = Math.min(t.missedFrames, 60);
    const step = (now - last.time) / (m + 1);
    for (let k = 1; k <= m; k++) {
      const f = k / (m + 1);
      cx.predict(step); cy.predict(step);
      cx.update(last.head.x + (p.x - last.head.x) * f); cy.update(last.head.y + (p.y - last.head.y) * f);
    }
    cx.predict(step); cy.predict(step);
    t.cx = cx; t.cy = cy;
  }

  private apply(o: Observation, i: number, now: number, intrinsics: CameraIntrinsics): void {
    const h = o.headBox;
    const c = NRect.center(h), s = NRect.size(h);
    this.reupdate(i, c, now);
    const t = this.tracks[i];
    t.cx.update(c.x);
    t.cy.update(c.y);
    t.cxObs = t.cx.copy(); t.cyObs = t.cy.copy();
    PersonTracker.noteObservation(o, h, now, t);
    t.headSize = add2(t.headSize, scale2(sub2(s, t.headSize), 0.5));
    t.faceBox = o.face?.box ?? null;
    t.face = o.face;
    if (o.body !== null) { t.bodyBox = o.body.box; t.body = o.body; t.lastBodySeen = now; }
    else if (now - t.lastBodySeen > this.params.coastMax) {
      t.bodyBox = null; t.body = null; t.skeleton = null;
      t.boxHeight = null; t.boxAspect = null;
    }
    const a = o.appearance;
    if (a !== null) {
      const old = t.appearance;
      t.appearance = old !== null && old.length === a.length ? old.map((v, k) => v * 0.8 + a[k] * 0.2) : a;
    }
    const cues = DistanceFusion.cues(o.face, o.body, c, intrinsics);
    const src = DistanceFusion.fuse(t.distance, cues, t.scale);
    if (src !== null) t.distanceSource = src;
    DistanceFusion.learn(t.scale, cues);
    t.lastSeen = now;
    t.hits += 1;
    t.hitThisFrame = true;
  }

  private confirm(t: Track, now: number, geometry: CameraGeometry): void {
    t.state = 'confirmed';
    // Re-entry: someone who left within the window, near where they left (or from the same edge), who looks alike.
    const g = geometry.gazePosition(t.headCentre);
    const entryEdge = CameraGeometry.edge(t.headCentre, 0.12);
    let best: [number, number] | null = null;
    this.departed.forEach((d, k) => {
      if (!(now - d.deletedAt <= this.params.reentryWindow)) return;
      const dist = vlength2(sub2(g, d.exitGaze));
      const sameEdge = d.exitEdge !== null && d.exitEdge === entryEdge;
      if (!(dist <= this.params.reentryRadius || sameEdge)) return;
      const a = PersonTracker.appearanceDistance(d.appearance, t.appearance);
      if (a !== null && a > this.params.reentryAppearance) return;
      if (best === null || dist < best[1]) best = [k, dist];
    });
    const bk = (best as [number, number] | null)?.[0] ?? null;
    if (bk !== null) {
      t.id = this.departed[bk].id;
      t.announced = true;      // personEntered is not re-fired
      this.departed.splice(bk, 1);
    } else {
      t.id = this.nextID;
      this.nextID += 1;
    }
  }

  /// A face-only track that turns out to be the same person as a body track (or two tracks on one head) merges into
  /// the older ID.
  private mergeDuplicates(now: number, geometry: CameraGeometry, events: PerceptionEvent[]): void {
    const tr = this.tracks;
    if (tr.length <= 1) return;
    const removed = new Set<number>();
    for (let i = 0; i < tr.length; i++) {
      for (let j = i + 1; j < tr.length; j++) {
        if (removed.has(i) || removed.has(j)) continue;
        const a = tr[i], b = tr[j];
        if (!(a.hitThisFrame && b.hitThisFrame)) continue;
        // Two faces (or two bodies) detected in the same frame are two people, however much they overlap: never a
        // duplicate.
        if ((a.face !== null && b.face !== null) || (a.lastBodySeen === now && b.lastBodySeen === now)) continue;
        const headOverlap = NRect.iou(a.headBox, b.headBox) > 0.4;
        const faceInBody = ((): boolean => {
          if (a.bodyBox !== null && b.bodyBox === null && b.faceBox !== null) {
            const bb = a.bodyBox, hc = b.headCentre;
            return NRect.contains(bb, hc) && hc.y < bb.y + 0.6 * bb.h;
          }
          if (b.bodyBox !== null && a.bodyBox === null && a.faceBox !== null) {
            const bb = b.bodyBox, hc = a.headCentre;
            return NRect.contains(bb, hc) && hc.y < bb.y + 0.6 * bb.h;
          }
          return false;
        })();
        if (!(headOverlap || faceInBody)) continue;
        // Keep the older (lower public ID, or confirmed over tentative).
        const ai = a.id ?? Number.MAX_SAFE_INTEGER, bi = b.id ?? Number.MAX_SAFE_INTEGER;
        const aOlder = ai < bi || (ai === bi && a.key < b.key);
        const [keepIdx, dropIdx] = aOlder ? [i, j] : [j, i];
        const k = tr[keepIdx];
        const d = tr[dropIdx];
        if (k.faceBox === null && d.faceBox !== null) { k.faceBox = d.faceBox; k.face = d.face; }
        if (k.bodyBox === null && d.bodyBox !== null) { k.bodyBox = d.bodyBox; k.body = d.body; k.lastBodySeen = d.lastBodySeen; }
        if (d.announced && d.id !== null) {
          events.push({ kind: 'personLeft', id: d.id, lastPosition: geometry.gazePosition(d.headCentre), exitEdge: null });
        }
        removed.add(dropIdx);
      }
    }
    if (removed.size > 0) this.tracks = tr.filter((_, i) => !removed.has(i));
  }

  private updateStatic(now: number, events: PerceptionEvent[]): void {
    const p = this.params;
    for (const t of this.tracks) {
      if (!t.hitThisFrame) continue;
      const c = t.headCentre, s = t.headSize;
      const moved = Math.abs(c.x - t.anchorCentre.x) > p.staticJitter || Math.abs(c.y - t.anchorCentre.y) > p.staticJitter;
      const resized = Math.abs(s.x - t.anchorSize.x) > p.staticSizeJitter * Math.max(t.anchorSize.x, 1e-3);
      let blinked = false;
      const o = t.face?.eyes?.openness;
      if (o !== undefined) {
        if (t.anchorOpenness !== null) blinked = Math.abs(o - t.anchorOpenness) > p.staticOpenness; else t.anchorOpenness = o;
      }
      if (moved || resized || blinked) {
        if (t.isStatic) t.isStatic = false;
        t.live = true;
        t.anchorTime = now; t.anchorCentre = c; t.anchorSize = s; t.anchorOpenness = t.face?.eyes?.openness ?? null;
      } else if (!t.isStatic) {
        const need = t.suspect ? p.staticSuspectSeconds : p.staticSeconds;
        if (now - t.anchorTime >= need) {
          t.isStatic = true;
          const region = NRect.insetBy(t.headBox, 0.2);
          if (!this.suppression.some((r) => NRect.iou(r, region) > 0.5)) this.suppression.push(region);
          if (t.id !== null) events.push({ kind: 'staticFaceSuppressed', id: t.id });
        }
      }
    }
  }

  /// Tracks visible to the engine (confirmed + short coasting, not static), as partially filled people.
  visiblePeople(geometry: CameraGeometry): VisiblePerson[] {
    const out: VisiblePerson[] = [];
    for (const t of this.tracks) {
      if (!t.visible || t.id === null) continue;
      const pos = geometry.gazePosition(t.headCentre);
      const ahead = geometry.gazePosition(add2(t.headCentre, scale2(t.velocity, 0.1)));
      const person = makeTrackedPerson(t.id, {
        state: t.state, bodyBox: t.bodyBox, faceBox: t.faceBox, position: pos,
        positionMetres: geometry.cameraPoint(t.headCentre, t.distance.x), velocity: { x: (ahead.x - pos.x) / 0.1, y: (ahead.y - pos.y) / 0.1 },
        distance: t.distance.x, distanceSource: t.distanceSource,
        headPose: t.hitThisFrame ? t.face?.headPose ?? null : null, firstSeen: t.firstSeen, lastSeen: t.lastSeen,
      });
      out.push({ person, face: t.hitThisFrame ? t.face : null, body: t.hitThisFrame ? t.body : null,
        fresh: t.hitThisFrame, live: t.live });
    }
    return out;
  }

  /// Track IDs currently static (excluded).
  get staticIDs(): number[] { return this.tracks.filter((t) => t.isStatic && t.id !== null).map((t) => t.id as number); }

  /// Forgets everything (source change, perception off). Departed people get no `personLeft`.
  reset(): void {
    this.tracks = []; this.departed = [];
    this.protection.preferSince = null;
  }

  /// Live track count by state (status page).
  get counts(): { tentative: number; confirmed: number; coasting: number } {
    const n = (s: TrackState): number => this.tracks.filter((t) => t.state === s).length;
    return { tentative: n('tentative'), confirmed: n('confirmed'), coasting: n('coasting') };
  }
}
