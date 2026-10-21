// Port of FacePerception/SyntheticScenes.swift, SyntheticScenes+Gestures.swift (the gesture scenes, folded into
// `SyntheticScenes` below) and SyntheticGroundTruth.swift (`SyntheticScene.groundTruth` / `session()`, folded into
// the class).
//
// Synthetic people for tests, golden replays and the replay source. Each frame is rendered from simple 3-D geometry
// through the same camera model the real pipeline uses, so the detections are exactly consistent.
import type { V2, V3 } from '../core/vec';
import { roundSwift } from '../core/vec';
import { CameraGeometry } from './CameraGeometry';
import { DistanceEstimator } from './Distance';
import { EyeContact, m3mul, m3mulv, m3transpose, makeEyeContactParams } from './EyeContact';
import { FeatureRecordingSession } from './FeatureRecordingSession';
import type { RecordingSessionType } from './FeatureRecordFormat';
import { makeSessionLabel, makeSessionLabels, type SessionLabel, type SessionLabels } from './FeatureRecordingStore';
import {
  CameraIntrinsics, NRect, degToRad, joint, makeBodyDetection, makeEyeObservation, makeFaceDetection,
  makeFrameDetections, makeHandDetection, makeHeadPose, makeMotionGrid, vnormalize3,
  type BodyJointName, type Chirality, type FrameDetections, type HandJointName, type Joint,
} from './PerceptionTypes';
import { PerceptionRecording } from './Replay';
import { SyntheticArms } from './SyntheticArms';

export type LookTarget =
  /** At Yanni's eyes on screen. */
  | { kind: 'eyes' }
  /** Into the camera lens. */
  | { kind: 'lens' }
  /** Turned away by this many degrees (yaw) from looking at the eyes. */
  | { kind: 'away'; degrees: number }
  /** Facing their walking direction, not the screen (head turned ≈ 80°). */
  | { kind: 'passing' };

export const LookTarget = {
  eyes: { kind: 'eyes' } as LookTarget,
  lens: { kind: 'lens' } as LookTarget,
  away: (degrees: number): LookTarget => ({ kind: 'away', degrees }),
  passing: { kind: 'passing' } as LookTarget,
} as const;

export type SyntheticGesture =
  | { kind: 'wave' } | { kind: 'thumbsUp' }
  /** Fist with the thumb sideways (near-miss for thumbs up). */
  | { kind: 'thumbSideways' }
  | { kind: 'openPalm' }
  /** Pointing in this viewer-frame direction (x right, y down). */
  | { kind: 'point'; direction: V2 }
  /** Talking with the hands at chest height (near-miss for waves). */
  | { kind: 'talkingHands' }
  /** Scratching the head (near-miss for waves: small, fast). */
  | { kind: 'scratch' }
  /** The same motion as a wave (the processor decides hello vs bye from the context). */
  | { kind: 'byeWave' } | { kind: 'thumbsDown' } | { kind: 'peace' }
  /** A fist (a hard negative: never reacted to). */
  | { kind: 'fist' }
  /** Pointing with a straight arm (body pose only; far away). */
  | { kind: 'farPoint'; direction: V2 }
  | { kind: 'clap' }
  /** Both arms shoot up ("yay!"). */
  | { kind: 'armsUp' }
  /** A slow stretch, elbows bent (near-miss for arms up). */
  | { kind: 'stretch' }
  /** Nodding (±6°, 2 Hz) and small talking nods (±2°, near-miss). */
  | { kind: 'nod' } | { kind: 'smallNods' }
  /** Dancing on the spot: a 2 Hz bob, a hip sway and rhythmic arms. */
  | { kind: 'dance' }
  /** Arms swinging while walking (near-miss for clap and dance). */
  | { kind: 'walkingArms' }
  /** Hands to the face, hidden 0.5–1.7 s, then the reveal. */
  | { kind: 'peekaboo' }
  /** One hand over the mouth (near-miss for peekaboo). */
  | { kind: 'yawnCover' }
  | { kind: 'heartHands' }
  /** An open palm pushed toward the screen (the high-five approach). */
  | { kind: 'highFive' };

type Plain = Exclude<SyntheticGesture['kind'], 'point' | 'farPoint'>;
const plain = (kind: Plain): SyntheticGesture => ({ kind }) as SyntheticGesture;

export const SyntheticGesture = {
  wave: plain('wave'), thumbsUp: plain('thumbsUp'), thumbSideways: plain('thumbSideways'), openPalm: plain('openPalm'),
  point: (direction: V2): SyntheticGesture => ({ kind: 'point', direction }),
  talkingHands: plain('talkingHands'), scratch: plain('scratch'), byeWave: plain('byeWave'),
  thumbsDown: plain('thumbsDown'), peace: plain('peace'), fist: plain('fist'),
  farPoint: (direction: V2): SyntheticGesture => ({ kind: 'farPoint', direction }),
  clap: plain('clap'), armsUp: plain('armsUp'), stretch: plain('stretch'), nod: plain('nod'),
  smallNods: plain('smallNods'), dance: plain('dance'), walkingArms: plain('walkingArms'), peekaboo: plain('peekaboo'),
  yawnCover: plain('yawnCover'), heartHands: plain('heartHands'), highFive: plain('highFive'),
  /// Swift's `"\(gesture)"` (e.g. `farPoint(SIMD2<Float>(-1.0, 0.0))`).
  describe(g: SyntheticGesture): string {
    if (g.kind === 'point' || g.kind === 'farPoint') {
      const f = (v: number): string => Number.isInteger(v) ? v.toFixed(1) : String(v);
      return `${g.kind}(SIMD2<Float>(${f(g.direction.x)}, ${f(g.direction.y)}))`;
    }
    return g.kind;
  },
} as const;

export interface PathKey { t: number; angle: number; distance: number }
export interface LookKey { t: number; look: LookTarget }
export interface GestureKey { start: number; end: number; gesture: SyntheticGesture; hand: Chirality }

/// One synthetic person.
export class SyntheticPerson {
  /// Keyframes: (time from scene start, horizontal angle in degrees across the view (+ = viewer's right), distance
  /// in metres). Linear in between.
  path: PathKey[];
  enter: number;
  exit: number;
  /// Keyframes of where they look (held until the next).
  looks: LookKey[];
  gestures: GestureKey[];
  hasBody: boolean;
  faceWidth: number;
  /// Head height relative to the camera (metres, + down).
  headHeight: number;
  /// A photo / poster: never blinks, never moves.
  isStatic: boolean;
  appearance: number[] | null;

  constructor(o: {
    path: [number, number, number][]; enter?: number; exit?: number; looks?: [number, LookTarget][];
    gestures?: [number, number, SyntheticGesture, Chirality][]; hasBody?: boolean; faceWidth?: number;
    headHeight?: number; isStatic?: boolean; appearance?: number[] | null;
  }) {
    this.path = o.path.map(([t, angle, distance]) => ({ t, angle, distance }));
    this.enter = o.enter ?? 0;
    this.exit = o.exit ?? Infinity;
    this.looks = (o.looks ?? [[0, LookTarget.passing]]).map(([t, look]) => ({ t, look }));
    this.gestures = (o.gestures ?? []).map(([start, end, gesture, hand]) => ({ start, end, gesture, hand }));
    this.hasBody = o.hasBody ?? true;
    this.faceWidth = o.faceWidth ?? 0.145;
    this.headHeight = o.headHeight ?? 0;
    this.isStatic = o.isStatic ?? false;
    this.appearance = o.appearance ?? null;
  }

  at(t: number): { angle: number; distance: number } {
    const first = this.path[0];
    if (first === undefined) return { angle: 0, distance: 1.5 };
    if (t <= first.t) return { angle: first.angle, distance: first.distance };
    for (let i = 1; i < this.path.length; i++) {
      const a = this.path[i - 1], b = this.path[i];
      if (t <= b.t) {
        const f = (t - a.t) / Math.max(b.t - a.t, 1e-6);
        return { angle: a.angle + (b.angle - a.angle) * f, distance: a.distance + (b.distance - a.distance) * f };
      }
    }
    const last = this.path[this.path.length - 1];
    return { angle: last.angle, distance: last.distance };
  }

  look(t: number): LookTarget {
    for (let i = this.looks.length - 1; i >= 0; i--) if (this.looks[i].t <= t) return this.looks[i].look;
    return LookTarget.passing;
  }

  gesture(t: number): { gesture: SyntheticGesture; hand: Chirality; t: number } | null {
    const g = this.gestures.find((x) => t >= x.start && t < x.end);
    return g ? { gesture: g.gesture, hand: g.hand, t: t - g.start } : null;
  }
}

export interface MotionBlob { start: number; end: number; at: V2 }

/// A synthetic scene rendered to detections.
export class SyntheticScene {
  name: string;
  duration: number;
  fps: number;
  intrinsics: CameraIntrinsics = CameraIntrinsics.typicalLandscape;
  cameraOffset: V2 = { x: 0, y: -0.11 };
  people: SyntheticPerson[];
  /// Unexplained motion: a blob at a viewer-frame point during [start, end).
  motion: MotionBlob[] = [];
  /// A flickering region (a TV) that should be ignored once the baseline learns it.
  flicker: NRect | null = null;
  startTime = 1000;

  constructor(name: string, duration: number, people: SyntheticPerson[], fps = 15) {
    this.name = name; this.duration = duration; this.people = people; this.fps = fps;
  }

  get geometry(): CameraGeometry { return new CameraGeometry(this.intrinsics, this.cameraOffset); }

  project(p: V3): V2 {
    const k = this.intrinsics;
    const z = Math.max(p.z, 0.05);
    return { x: (k.focal.x * p.x / z + k.principal.x) / k.imageSize.x, y: (k.focal.y * p.y / z + k.principal.y) / k.imageSize.y };
  }

  /// The recording (every frame of the scene).
  recording(): PerceptionRecording {
    const frames: FrameDetections[] = [];
    const n = roundSwift(this.duration * this.fps);
    for (let i = 0; i < n; i++) frames.push(this.frame(i));
    return new PerceptionRecording(this.name, this.cameraOffset, frames);
  }

  /// Frame `i` of the scene.
  frame(i: number): FrameDetections {
    const t = i / this.fps;
    const det = makeFrameDetections(this.startTime + t, { intrinsics: this.intrinsics });
    det.handsRan = i % 2 === 0;
    det.bodyPoseRan = i % 2 === 1;
    const geo = this.geometry;
    const luma: number[] = new Array(32 * 24).fill(0.4);
    const paint = (r: NRect, v: number): void => {
      for (let row = 0; row < 24; row++) {
        for (let col = 0; col < 32; col++) {
          const c = { x: (col + 0.5) / 32, y: (row + 0.5) / 24 };
          if (NRect.contains(r, c)) luma[row * 32 + col] = v;
        }
      }
    };
    const project = (p: V3): V2 => this.project(p);
    for (const p of this.people) {
      if (!(t >= p.enter && t < p.exit)) continue;
      const { angle, distance: d } = p.at(t);
      const a = angle * degToRad;
      const gst = p.gesture(t);
      // What a gesture does to the head: a bob (dancing, walking), a nod's pitch, hands hiding the face.
      let bob = 0, pitchOffset = 0;
      let faceHidden = false;
      if (gst !== null) {
        const w = gst.t;
        switch (gst.gesture.kind) {
          case 'dance': bob = 0.04 * Math.sin(w * 2 * Math.PI / 0.5); break;
          case 'walkingArms': bob = 0.015 * Math.sin(w * 2 * Math.PI / 0.5); break;
          case 'nod': pitchOffset = 6 * degToRad * Math.sin(w * 2 * Math.PI * 2); break;
          case 'smallNods': pitchOffset = 2 * degToRad * Math.sin(w * 2 * Math.PI * 2); break;
          case 'peekaboo': faceHidden = gst.t >= 0.5 && gst.t < 1.7; break;
          default: break;
        }
      }
      const head: V3 = { x: Math.sin(a) * d, y: p.headHeight + bob, z: Math.cos(a) * d };
      const centre = this.project(head);
      if (!(centre.x > -0.05 && centre.x < 1.05)) continue;

      // Where they look → head pose (70 %) + eyes (the rest), in the composed frame.
      let target: V3;
      const look = p.look(t);
      switch (look.kind) {
        case 'eyes': target = geo.faceTarget; break;
        case 'lens': target = { x: 0, y: 0, z: 0 }; break;
        case 'away': case 'passing': {
          const toEyes = vnormalize3(sub(geo.faceTarget, head));
          const ang = EyeContact.angles(toEyes);
          const side = (p.path[p.path.length - 1]?.angle ?? 0) >= (p.path[0]?.angle ?? 0) ? 1 : -1;
          const yaw = look.kind === 'away' ? ang.x + look.degrees * degToRad : ang.x + side * 80 * degToRad;
          target = add(head, EyeContact.direction(yaw, ang.y));
          break;
        }
      }
      const g = vnormalize3(sub(target, head));
      const rRay = EyeContact.rayFrame(head);
      const local = EyeContact.angles(m3TMul(rRay, g));
      const pose = makeHeadPose(local.x * 0.7, local.y * 0.7 + pitchOffset, 0);
      const rHead = m3Mul(rRay, EyeContact.rotation(pose));
      const eyeAng = EyeContact.angles(m3TMul(rHead, g));
      const gainDeg = makeEyeContactParams().visionEyeGainDegrees;
      const pupil = { x: eyeAng.x / (gainDeg.x * degToRad), y: eyeAng.y / (gainDeg.y * degToRad) };

      const fx = this.intrinsics.focal.x;
      const faceWPx = fx * p.faceWidth / d;
      const faceW = faceWPx / this.intrinsics.imageSize.x;
      const faceH = faceWPx * 1.25 / this.intrinsics.imageSize.y;
      const faceVisible = Math.abs(pose.yaw) < 75 * degToRad && !faceHidden;
      const blink = !p.isStatic && (t % 3.7) < 0.12;
      const openness = blink ? 0.05 : 0.3;
      if (faceVisible) {
        const eyes = makeEyeObservation(pupil, fx * 0.03 / d, 0.9, openness);
        det.faces.push(makeFaceDetection(NRect.fromCenter(centre, { x: faceW, y: faceH }), {
          confidence: 0.95, headPose: pose, eyes,
          interocularPx: fx * DistanceEstimator.interpupillaryMetres * Math.cos(pose.yaw) / d,
        }));
      }

      // Arms and hands.
      const joints: Partial<Record<BodyJointName, Joint>> = {};
      const j = (off: V3): Joint => joint(project(add(head, off)), 0.9);
      joints.nose = j({ x: 0, y: 0.02, z: -0.08 });
      joints.neck = j({ x: 0, y: 0.2, z: 0 });
      joints.leftShoulder = j({ x: -0.2, y: 0.25, z: 0 });     // the person's left is the viewer frame's −x (mirror)
      joints.rightShoulder = j({ x: 0.2, y: 0.25, z: 0 });
      let hipSway = 0;
      if (gst !== null && gst.gesture.kind === 'dance') hipSway = 0.05 * Math.sin(gst.t * 2 * Math.PI / 1.0);
      joints.leftHip = j({ x: -0.14 + hipSway, y: 0.72 - bob, z: 0 });
      joints.rightHip = j({ x: 0.14 + hipSway, y: 0.72 - bob, z: 0 });
      const arms = new SyntheticArms();
      if (gst !== null) arms.pose(gst.gesture, gst.hand, gst.t);
      joints.leftWrist = j(arms.wrists[0]); joints.rightWrist = j(arms.wrists[1]);
      joints.leftElbow = j(arms.elbows[0]); joints.rightElbow = j(arms.elbows[1]);

      if (p.hasBody) {
        const tl = project(add(head, { x: -0.275, y: -0.15, z: 0 })), br = project(add(head, { x: 0.275, y: 0.65, z: 0 }));
        const box = NRect.make(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        det.bodies.push(makeBodyDetection(box, { confidence: 0.9, joints: det.bodyPoseRan ? joints : {}, appearance: p.appearance }));
        paint(box, 0.55 + 0.05 * Math.sin(t * 3 + angle));
      }
      if (det.handsRan && d <= 3) {
        for (const h of arms.hands) {
          det.hands.push(HandModel.detection(h.shape, h.side, h.rotation, add(head, h.wrist), project));
        }
      }
    }
    for (const m of this.motion) {
      if (!(t >= m.start && t < m.end)) continue;
      const phase = i % 2;
      paint(NRect.fromCenter({ x: m.at.x + 0.02 * phase, y: m.at.y }, { x: 0.14, y: 0.18 }), 0.85 - 0.3 * phase);
    }
    if (this.flicker !== null) paint(this.flicker, i % 2 === 0 ? 0.2 : 0.7);
    det.motion = makeMotionGrid(32, 24, luma);
    return det;
  }

  // MARK: SyntheticGroundTruth.swift

  /// Ground-truth labels from the scene's script (host-clock seconds): each gesture window under its gesture name
  /// (near-misses as "none:…"), and each look at the eyes or the lens as "looking" with the floor distance.
  get groundTruth(): SessionLabels {
    const labels: SessionLabel[] = [];
    this.people.forEach((p, i) => {
      const who = `P${i + 1}`;
      for (const g of p.gestures) {
        let name: string;
        switch (g.gesture.kind) {
          case 'wave': name = 'wave'; break;
          case 'thumbsUp': name = 'thumbsUp'; break;
          case 'openPalm': name = 'openPalm'; break;
          case 'point': name = 'point'; break;
          default: name = `none:${SyntheticGesture.describe(g.gesture)}`;
        }
        labels.push(makeSessionLabel(this.startTime + g.start, this.startTime + Math.min(g.end, this.duration), name,
          { person: who, distance: p.at(g.start).distance }));
      }
      p.looks.forEach((l, k) => {
        if (!(l.look.kind === 'eyes' || l.look.kind === 'lens')) return;
        const end = Math.min(k + 1 < p.looks.length ? p.looks[k + 1].t : this.duration, Math.min(p.exit, this.duration));
        const start = Math.max(l.t, p.enter);
        if (!(end > start)) return;
        labels.push(makeSessionLabel(this.startTime + start, this.startTime + end, 'looking',
          { person: who, distance: p.at(start).distance }));
      });
    });
    return makeSessionLabels(labels);
  }

  /// The scene as a labelled synthetic session.
  session(type: RecordingSessionType = 'scripted'): FeatureRecordingSession {
    const s = FeatureRecordingSession.synthetic(this.recording(), type);
    s.labels = this.groundTruth;
    return s;
  }
}

// simd's `a + b`, `a - b`, `m * n` and `m.transpose * v`.
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const m3Mul = m3mul;
const m3TMul = (a: number[], v: V3): V3 => m3mulv(m3transpose(a), v);

/// A 21-joint hand in metres (fingers up, viewer frame x right, y down), placed and projected.
export type HandModelShape = 'open' | 'relaxed' | 'fist' | 'thumbsUp' | 'thumbSideways' | 'point' | 'peace' | 'heartHalf';

export const HandModel = {
  /// Local joint positions for a right hand with the palm toward the camera (a left hand is mirrored).
  local(shape: HandModelShape): Partial<Record<HandJointName, V2>> {
    const j: Partial<Record<HandJointName, V2>> = { wrist: { x: 0, y: 0 } };
    const mcps: [HandJointName, HandJointName, HandJointName, HandJointName, number, number, number][] = [
      ['indexMCP', 'indexPIP', 'indexDIP', 'indexTip', -0.03, 0.075, -10],
      ['middleMCP', 'middlePIP', 'middleDIP', 'middleTip', -0.01, 0.08, -3],
      ['ringMCP', 'ringPIP', 'ringDIP', 'ringTip', 0.01, 0.075, 4],
      ['littleMCP', 'littlePIP', 'littleDIP', 'littleTip', 0.03, 0.06, 12],
    ];
    const at = (b: V2, x: number, y: number): V2 => ({ x: b.x + x, y: b.y + y });
    mcps.forEach(([mcp, pip, dip, tip, x, len, spread], n) => {
      const base = { x, y: n === 3 ? -0.08 : -0.09 };
      j[mcp] = base;
      let extended: boolean;
      switch (shape) {
        case 'open': extended = true; break;
        case 'relaxed': case 'peace': extended = n < 2; break;
        case 'point': extended = n === 0; break;
        default: extended = false;
      }
      if (shape === 'heartHalf' && n === 0) {
        // The index curves over and in, to meet the other hand's.
        j[pip] = at(base, -0.02, -0.035); j[dip] = at(base, -0.035, -0.045); j[tip] = at(base, -0.05, -0.035);
      } else if (extended) {
        const a = (shape === 'peace' ? (n === 0 ? -12 : 12) : spread) * degToRad;
        const dir = { x: Math.sin(a), y: -Math.cos(a) };
        j[pip] = at(base, dir.x * len * 0.45, dir.y * len * 0.45);
        j[dip] = at(base, dir.x * len * 0.75, dir.y * len * 0.75);
        j[tip] = at(base, dir.x * len, dir.y * len);
      } else {
        // Curled: the finger folds back toward the palm.
        j[pip] = at(base, 0, -0.025); j[dip] = at(base, 0, -0.01); j[tip] = at(base, 0, 0.02);
      }
    });
    const thumb = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]): void => {
      j.thumbCMC = { x: a[0], y: a[1] }; j.thumbMP = { x: b[0], y: b[1] };
      j.thumbIP = { x: c[0], y: c[1] }; j.thumbTip = { x: d[0], y: d[1] };
    };
    switch (shape) {
      case 'open': case 'relaxed': thumb([-0.025, -0.02], [-0.05, -0.04], [-0.072, -0.058], [-0.095, -0.075]); break;
      case 'thumbsUp': thumb([-0.03, -0.04], [-0.035, -0.09], [-0.036, -0.12], [-0.037, -0.155]); break;
      case 'thumbSideways': thumb([-0.03, -0.04], [-0.05, -0.07], [-0.08, -0.07], [-0.11, -0.072]); break;
      case 'fist': case 'point': case 'peace': thumb([-0.025, -0.03], [-0.03, -0.05], [-0.02, -0.065], [-0.01, -0.07]); break;
      // The thumb reaches in and down, to meet the other hand's under the index tips.
      case 'heartHalf': thumb([-0.025, -0.02], [-0.045, -0.025], [-0.065, -0.025], [-0.085, -0.02]); break;
    }
    return j;
  },

  /// A detection: the local hand mirrored for the left hand, rotated (radians, clockwise from fingers-up), placed at
  /// `wrist` (camera space) and projected.
  detection(shape: HandModelShape, chirality: Chirality, rotation: number, wrist: V3, project: (p: V3) => V2) {
    const c = Math.cos(rotation), s = Math.sin(rotation);
    const joints: Partial<Record<HandJointName, Joint>> = {};
    // port-note: Swift iterates a dictionary (unordered); the result is a dictionary too, so order doesn't matter.
    for (const [name, p0] of Object.entries(HandModel.local(shape)) as [HandJointName, V2][]) {
      const p = { x: chirality === 'left' ? -p0.x : p0.x, y: p0.y };
      const r = { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
      joints[name] = joint(project({ x: wrist.x + r.x, y: wrist.y + r.y, z: wrist.z }), 0.9);
    }
    return makeHandDetection(joints, chirality, 0.9);
  },
} as const;

const P = (o: ConstructorParameters<typeof SyntheticPerson>[0]): SyntheticPerson => new SyntheticPerson(o);
const G = SyntheticGesture;
const L = LookTarget;

function one(name: string, duration: number, gestures: [number, number, SyntheticGesture, Chirality][],
  o: { distance?: number; angle?: number; looks?: [number, LookTarget][] } = {}): SyntheticScene {
  return new SyntheticScene(name, duration, [
    P({ path: [[0, o.angle ?? 0, o.distance ?? 1.2]], looks: o.looks ?? [[0, L.eyes]], gestures }),
  ]);
}

/// The named scenes behind the golden replay tests and the replay source. Getters: a fresh scene per read (Swift
/// `static var`).
export const SyntheticScenes = {
  /// Walks across at 2.5 m without looking.
  get passerBy() {
    return new SyntheticScene('passer-by', 9, [P({ path: [[0, -50, 2.5], [6, 50, 2.5]], enter: 0, exit: 6 })]);
  },
  /// Stands at 1.2 m and glances at the eyes for 0.6 s twice.
  get glanceOnly() {
    return new SyntheticScene('glance-only', 8, [
      P({ path: [[0, 10, 1.2]], looks: [[0, L.away(40)], [2, L.eyes], [2.6, L.away(40)], [4.5, L.eyes], [5.1, L.away(-40)]] }),
    ]);
  },
  /// Sits at 1 m and looks at Yanni for 4 s, then looks away.
  get sitAndLook() {
    return new SyntheticScene('sit-and-look', 10, [
      P({ path: [[0, -5, 1.0]], looks: [[0, L.away(45)], [1.5, L.eyes], [5.5, L.away(45)]] }),
    ]);
  },
  /// Two people look at once; the first keeps the turn, the second waits, then takes it.
  get twoPeopleEngage() {
    return new SyntheticScene('two-people-engage', 12, [
      P({ path: [[0, -20, 1.1]], looks: [[0, L.away(40)], [1, L.eyes], [6, L.away(50)]], appearance: [0.8, 0.1, 0.1, 0] }),
      P({ path: [[0, 22, 1.3]], looks: [[0, L.away(-40)], [1.6, L.eyes]], appearance: [0, 0.1, 0.1, 0.8] }),
    ]);
  },
  /// A child (small face, lower head) at 1 m looking.
  get childAtOneMetre() {
    return new SyntheticScene('child-at-1m', 6, [
      P({ path: [[0, 5, 1.0]], looks: [[0, L.away(40)], [1, L.eyes]], faceWidth: 0.12, headHeight: 0.35 }),
    ]);
  },
  /// Waves while walking past, not looking: no reaction.
  get waveWalkingPast() {
    return new SyntheticScene('wave-walking-past', 8, [
      P({ path: [[0, -40, 2.0], [6, 40, 2.0]], enter: 0, exit: 6, looks: [[0, L.passing]], gestures: [[2, 4, G.wave, 'right']] }),
    ]);
  },
  /// Looks at Yanni and waves.
  get waveAtYanni() {
    return new SyntheticScene('wave-at-yanni', 6, [
      P({ path: [[0, 0, 1.5]], looks: [[0, L.eyes]], gestures: [[1.5, 4, G.wave, 'right']] }),
    ]);
  },
  get thumbsUp() {
    return new SyntheticScene('thumbs-up', 5, [
      P({ path: [[0, 0, 1.2]], looks: [[0, L.eyes]], gestures: [[1.5, 3, G.thumbsUp, 'right']] }),
    ]);
  },
  /// Looks at Yanni, then points to their left (the viewer frame's −x) and looks there.
  get pointLeft() {
    return new SyntheticScene('point-left', 5, [
      P({ path: [[0, 0, 1.4]], looks: [[0, L.eyes], [1.2, L.away(-30)]], gestures: [[1.5, 3, G.point({ x: -1, y: 0 }), 'left']] }),
    ]);
  },
  /// Talks with their hands at chest height while looking elsewhere: no waves.
  get talkingWithHands() {
    return new SyntheticScene('talking-with-hands', 8, [
      P({ path: [[0, 10, 1.3]], looks: [[0, L.away(35)]], gestures: [[0.5, 7.5, G.talkingHands, 'right']] }),
    ]);
  },
  /// A poster of a face on the wall at 0.8 m: never moves or blinks.
  get poster() {
    const s = new SyntheticScene('poster', 40, [
      P({ path: [[0, 25, 0.8]], looks: [[0, L.lens]], hasBody: false, isStatic: true }),
    ]);
    s.fps = 10;
    return s;
  },
  /// Motion with nobody around (a curtain moving in a corner).
  get motionOnly() {
    const s = new SyntheticScene('motion-only', 6, []);
    s.motion = [{ start: 2, end: 3, at: { x: 0.8, y: 0.3 } }];
    return s;
  },
  /// A long loop: someone walks in, looks, waves, gives a thumbs up, leaves; then a passer-by.
  get simulatorDemo() {
    const s = new SyntheticScene('simulator-demo', 30, [
      P({
        path: [[0, -55, 2.2], [3, -10, 1.2], [14, -10, 1.2], [17, 55, 2.0]], enter: 0, exit: 17,
        looks: [[0, L.passing], [3, L.away(30)], [5, L.eyes], [13.5, L.away(40)], [14, L.passing]],
        gestures: [[7, 9, G.wave, 'right'], [11, 12.5, G.thumbsUp, 'right']], appearance: [0.7, 0.2, 0.1, 0],
      }),
      P({ path: [[19, 55, 2.8], [26, -55, 2.8]], enter: 19, exit: 26, appearance: [0, 0.1, 0.2, 0.7] }),
    ]);
    s.motion = [{ start: 27, end: 28, at: { x: 0.15, y: 0.25 } }];
    return s;
  },

  get all(): SyntheticScene[] {
    const S = SyntheticScenes;
    return [S.passerBy, S.glanceOnly, S.sitAndLook, S.twoPeopleEngage, S.childAtOneMetre, S.waveWalkingPast,
      S.waveAtYanni, S.thumbsUp, S.pointLeft, S.talkingWithHands, S.poster, S.motionOnly, S.simulatorDemo];
  },

  // MARK: SyntheticScenes+Gestures.swift — one scene per curated gesture plus their near-misses (design §14).

  one,
  get clapAtYanni() { return one('clap-at-yanni', 5, [[1.5, 3.5, G.clap, 'right']]); },
  /// Applauding the TV: the same clap, looking away the whole time (no reaction).
  get applaudingTV() { return one('applauding-tv', 5, [[1.5, 3.5, G.clap, 'right']], { looks: [[0, L.away(50)]] }); },
  get armsUpAtYanni() { return one('arms-up', 5, [[1.5, 3, G.armsUp, 'right']], { distance: 2 }); },
  /// A slow stretch with bent elbows: not arms up.
  get stretching() { return one('stretching', 7, [[1.5, 5.5, G.stretch, 'right']], { distance: 1.5 }); },
  get nodding() { return one('nodding', 5, [[1.5, 3.5, G.nod, 'right']], { distance: 1.1 }); },
  /// Small talking nods (±2°): not a nod.
  get smallNods() { return one('small-nods', 5, [[1, 4.5, G.smallNods, 'right']], { distance: 1.1 }); },
  /// Nodding while walking past: walking is not nodding.
  get nodWhileWalking() {
    return new SyntheticScene('nod-walking', 6, [
      P({ path: [[0, -50, 1.4], [5, 50, 1.4]], enter: 0, exit: 5, looks: [[0, L.eyes]], gestures: [[1, 4.5, G.nod, 'right']] }),
    ]);
  },
  get dancing() { return one('dancing', 13, [[1, 8, G.dance, 'right']], { distance: 2 }); },
  /// Walking past with swinging arms: not dancing, not clapping.
  get walkingArms() {
    return new SyntheticScene('walking-arms', 7, [
      P({ path: [[0, -45, 2.2], [6.5, 45, 2.2]], looks: [[0, L.away(20)]], gestures: [[0, 6.5, G.walkingArms, 'right']] }),
    ]);
  },
  /// Looks at Yanni, hides behind both hands, reveals.
  get peekaboo() { return one('peekaboo', 5, [[1.5, 3.8, G.peekaboo, 'right']], { distance: 1.1 }); },
  /// The same cover without a look first (looking at someone else): no reaction.
  get peekabooWithoutLook() {
    return one('peekaboo-no-look', 5, [[1.5, 3.8, G.peekaboo, 'right']], { distance: 1.1, looks: [[0, L.away(60)], [3.3, L.eyes]] });
  },
  /// Covering a yawn with one hand: not peekaboo.
  get yawnCover() { return one('yawn-cover', 5, [[1.5, 3.5, G.yawnCover, 'right']], { distance: 1.1 }); },
  /// The engagement-hold golden (design §7): looks at Yanni at 1 m and makes heart hands.
  get heartHandsAtOneMetre() {
    return one('heart-hands-1m', 6, [[1.0, 3.5, G.heartHands, 'right']], { distance: 1, looks: [[0, L.away(40)], [0.5, L.eyes]] });
  },
  get thumbsDown() { return one('thumbs-down', 5, [[1.5, 3, G.thumbsDown, 'right']]); },
  get peace() { return one('peace', 5, [[1.5, 3, G.peace, 'right']]); },
  get fistHeld() { return one('fist', 5, [[1.5, 4, G.fist, 'right']]); },
  get highFiveApproach() { return one('high-five', 4, [[1.5, 2.3, G.highFive, 'right']], { distance: 0.9 }); },
  /// Waves while walking out to the right after looking: a bye.
  get byeWaveLeaving() {
    return new SyntheticScene('bye-wave', 6, [
      P({ path: [[0, 0, 1.8], [1.5, 0, 1.8], [5, 48, 2.0]], enter: 0, exit: 5.5, looks: [[0, L.eyes]], gestures: [[2.6, 4.6, G.byeWave, 'right']] }),
    ]);
  },
  get farPoint() {
    return one('far-point', 5, [[1.5, 3.5, G.farPoint({ x: -1, y: 0 }), 'left']], { distance: 3, looks: [[0, L.eyes], [1.4, L.away(-25)]] });
  },
  /// A busy "none" scene: talking with hands while facing a friend, walking past with swinging arms, applauding the
  /// TV, a fist on the remote. Must produce zero gesture beats.
  get busyNone() {
    const s = new SyntheticScene('busy-none', 12, [
      P({ path: [[0, -25, 1.3]], looks: [[0, L.away(-45)]], gestures: [[0.5, 11.5, G.talkingHands, 'right']], appearance: [0.8, 0.1, 0.1, 0] }),
      P({ path: [[0, 20, 1.5]], looks: [[0, L.away(50)]], gestures: [[1, 4, G.clap, 'right'], [5, 11, G.fist, 'left']], appearance: [0, 0.8, 0.1, 0.1] }),
      P({ path: [[2, 55, 2.6], [9, -55, 2.6]], enter: 2, exit: 9, looks: [[0, L.passing]], gestures: [[2, 9, G.walkingArms, 'right']], appearance: [0, 0.1, 0.1, 0.8] }),
    ]);
    s.fps = 15;
    return s;
  },

  get gestureScenes(): SyntheticScene[] {
    const S = SyntheticScenes;
    return [S.clapAtYanni, S.applaudingTV, S.armsUpAtYanni, S.stretching, S.nodding, S.smallNods, S.nodWhileWalking,
      S.dancing, S.walkingArms, S.peekaboo, S.peekabooWithoutLook, S.yawnCover, S.heartHandsAtOneMetre, S.thumbsDown,
      S.peace, S.fistHeld, S.highFiveApproach, S.byeWaveLeaving, S.farPoint, S.busyNone];
  },
};
