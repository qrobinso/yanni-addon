// Port of FacePerception/PersonFeatureStream.swift.
import type { V2 } from '../core/vec';
import type { BodyJointName, Chirality } from './PerceptionTypes';

/// The body joints the gesture rules read, in a fixed order (index into `JointSet`).
export type StreamJoint = number;
const BODY: readonly BodyJointName[] = ['nose', 'neck', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
  'leftWrist', 'rightWrist', 'leftHip', 'rightHip'];
export const StreamJoint = {
  nose: 0, neck: 1, leftShoulder: 2, rightShoulder: 3, leftElbow: 4, rightElbow: 5, leftWrist: 6, rightWrist: 7,
  leftHip: 8, rightHip: 9,
  allCases: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as readonly StreamJoint[],
  body: (j: StreamJoint): BodyJointName => BODY[j],
  wrist: (c: Chirality): StreamJoint => c === 'left' ? 6 : 7,
  elbow: (c: Chirality): StreamJoint => c === 'left' ? 4 : 5,
  shoulder: (c: Chirality): StreamJoint => c === 'left' ? 2 : 3,
} as const;

/// Ten joints with a validity mask.
export class JointSet {
  p: V2[] = Array.from({ length: 10 }, () => ({ x: 0, y: 0 }));
  mask = 0;

  get(j: StreamJoint): V2 | null { return (this.mask & (1 << j)) !== 0 ? this.p[j] : null; }
  set(j: StreamJoint, v: V2 | null): void {
    if (v !== null) { this.p[j] = { x: v.x, y: v.y }; this.mask |= 1 << j; } else { this.mask &= ~(1 << j); }
  }
  raw(i: number): V2 { return this.p[i]; }
  setRaw(i: number, v: V2): void { this.p[i] = v; }
  copy(): JointSet { const o = new JointSet(); o.mask = this.mask; o.p = this.p.map((v) => ({ x: v.x, y: v.y })); return o; }
  equals(o: JointSet): boolean { return this.mask === o.mask && this.p.every((v, i) => v.x === o.p[i].x && v.y === o.p[i].y); }

  /// Linear interpolation of the joints valid in both.
  static lerp(a: JointSet, b: JointSet, f: number): JointSet {
    const o = new JointSet();
    o.mask = a.mask & b.mask;
    for (let i = 0; i < 10; i++) {
      if ((o.mask & (1 << i)) === 0) continue;
      const p = a.raw(i), q = b.raw(i);
      o.setRaw(i, { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f });
    }
    return o;
  }
}

/// One body-pose reading (absolute metres in the image plane at the person's distance; x right, y down).
export interface BodyKey { t: number; joints: JointSet }

/// One face reading. Head pitch relative to the head → camera ray (degrees, + down) and yaw (degrees).
export interface FaceKey { t: number; pitch: number; yaw: number; openness: number }

/// One 15 Hz sample of a person (design §4.2).
export class FeatureSample {
  t = 0;
  /// Absolute joints (metres); `body` false = no body-pose reading near this time (a masked sample).
  joints = new JointSet();
  body = false;
  face = false;
  pitch = 0;
  yaw = 0;
  openness = 0;

  /// Shoulder centre (absolute metres), the body's reference point.
  get centre(): V2 | null {
    const l = this.joints.get(StreamJoint.leftShoulder), r = this.joints.get(StreamJoint.rightShoulder);
    if (l === null || r === null) return this.joints.get(StreamJoint.neck);
    return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  }

  get shoulderWidth(): number | null {
    const l = this.joints.get(StreamJoint.leftShoulder), r = this.joints.get(StreamJoint.rightShoulder);
    return l === null || r === null ? null : Math.abs(l.x - r.x);
  }

  get hipCentre(): V2 | null {
    const l = this.joints.get(StreamJoint.leftHip), r = this.joints.get(StreamJoint.rightHip);
    return l === null || r === null ? null : { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  }

  /// A joint relative to the shoulder centre.
  rel(j: StreamJoint): V2 | null {
    const p = this.joints.get(j), c = this.centre;
    return p === null || c === null ? null : { x: p.x - c.x, y: p.y - c.y };
  }
}

/// A person's features resampled to a fixed 15 Hz grid (design §4.2): linear interpolation between readings up to
/// `maxGap` (150 ms) apart, a masked sample beyond. A grid time is emitted once both channels are resolved there, so
/// the stream lags the newest frame by at most `maxGap`. A fixed ring (`capacity` samples, ≈ 4.3 s).
export class PersonFeatureStream {
  static readonly rate = 15;
  static readonly step = 1 / 15;
  static readonly maxGap = 0.15;
  static readonly capacity = 64;

  private ring: FeatureSample[] = Array.from({ length: PersonFeatureStream.capacity }, () => new FeatureSample());
  private head = 0;
  count = 0;
  private prevBody: BodyKey | null = null;
  private lastBody: BodyKey | null = null;
  private prevFace: FaceKey | null = null;
  private lastFace: FaceKey | null = null;
  private nextGrid: number | null = null;

  reset(): void {
    this.head = 0; this.count = 0; this.prevBody = null; this.lastBody = null; this.prevFace = null; this.lastFace = null;
    this.nextGrid = null;
  }

  /// The `k`-th newest sample (0 = newest).
  back(k: number): FeatureSample {
    const C = PersonFeatureStream.capacity;
    return this.ring[(this.head - 1 - k + C * 2) % C];
  }

  get newest(): FeatureSample | null { return this.count > 0 ? this.back(0) : null; }

  /// Feeds this frame's readings (either may be null) and emits every grid sample now resolved. Returns how many.
  advance(now: number, body: BodyKey | null, face: FaceKey | null): number {
    const S = PersonFeatureStream;
    if (body !== null) { this.prevBody = this.lastBody; this.lastBody = body; if (this.nextGrid === null) this.nextGrid = S.grid(body.t); }
    if (face !== null) { this.prevFace = this.lastFace; this.lastFace = face; if (this.nextGrid === null) this.nextGrid = S.grid(face.t); }
    if (this.nextGrid === null) return 0;
    let g = this.nextGrid;
    // After a long silence, skip ahead (never emit more than a ring's worth at once).
    if (now - g > S.capacity * S.step) g = S.grid(now - 0.5);
    let emitted = 0;
    while (g <= now + 1e-9) {
      const b = this.resolveBody(g, now), f = this.resolveFace(g, now);
      if (b === undefined || f === undefined) break;
      const s = new FeatureSample();
      s.t = g;
      if (b !== null) { s.joints = b; s.body = b.mask !== 0; }
      if (f !== null) { s.face = true; s.pitch = f.pitch; s.yaw = f.yaw; s.openness = f.openness; }
      this.ring[this.head] = s;
      this.head = (this.head + 1) % S.capacity;
      this.count = Math.min(this.count + 1, S.capacity);
      emitted += 1;
      g += S.step;
    }
    this.nextGrid = g;
    return emitted;
  }

  /// Swift `grid(atOrAfter:)`.
  static grid(t: number): number { return Math.ceil(t * PersonFeatureStream.rate) / PersonFeatureStream.rate; }

  // port-note: Swift `JointSet??` → `undefined` = not resolved yet (wait), `null` = resolved with no data.
  private resolveBody(g: number, now: number): JointSet | null | undefined {
    const S = PersonFeatureStream;
    const last = this.lastBody;
    if (last === null) return null;
    if (last.t < g - 1e-9) {
      // A later reading could still bracket `g` only if this one is recent enough; else there is no data here.
      return last.t < g - S.maxGap || now - g > S.maxGap ? null : undefined;
    }
    const prev = this.prevBody;
    if (prev !== null && prev.t <= g + 1e-9) {
      if (!(last.t - prev.t <= S.maxGap + 1e-6)) return null;
      const f = last.t > prev.t ? (g - prev.t) / (last.t - prev.t) : 1;
      return JointSet.lerp(prev.joints, last.joints, f);
    }
    if (prev !== null && Math.abs(prev.t - g) <= S.step / 2) return prev.joints.copy();
    return Math.abs(last.t - g) <= S.step / 2 ? last.joints.copy() : null;
  }

  private resolveFace(g: number, now: number): FaceKey | null | undefined {
    const S = PersonFeatureStream;
    const last = this.lastFace;
    if (last === null) return null;
    if (last.t < g - 1e-9) {
      return last.t < g - S.maxGap || now - g > S.maxGap ? null : undefined;
    }
    const prev = this.prevFace;
    if (prev !== null && prev.t <= g + 1e-9) {
      if (!(last.t - prev.t <= S.maxGap + 1e-6)) return null;
      const f = last.t > prev.t ? (g - prev.t) / (last.t - prev.t) : 1;
      return { t: g, pitch: prev.pitch + (last.pitch - prev.pitch) * f, yaw: prev.yaw + (last.yaw - prev.yaw) * f,
        openness: prev.openness + (last.openness - prev.openness) * f };
    }
    if (prev !== null && Math.abs(prev.t - g) <= S.step / 2) return prev;
    return Math.abs(last.t - g) <= S.step / 2 ? last : null;
  }
}
