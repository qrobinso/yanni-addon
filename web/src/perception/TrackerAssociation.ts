// Port of FacePerception/TrackerAssociation.swift.
//
// Association building blocks for `PersonTracker` (design §9): the per-track observation ring, the last skeleton
// (for OKS), the box geometry terms and engaged-person protection.
import type { V2 } from '../core/vec';
import { Hungarian } from './Hungarian';
import { NRect, clamp, smoothstep, vdot2, vlength2 } from './PerceptionTypes';
import type { BodyDetection, BodyJointName } from './PerceptionTypes';

/// One past observation of a track.
export interface ObsEntry {
  time: number;
  /// Observed head centre (viewer frame).
  head: V2;
  headSize: V2;
  body: NRect | null;
}
export const makeObsEntry = (o: Partial<ObsEntry> = {}): ObsEntry =>
  ({ time: 0, head: { x: 0, y: 0 }, headSize: { x: 0, y: 0 }, body: null, ...o });
/// The box used for last-observation recovery.
export const obsEntryHeadBox = (e: ObsEntry): NRect => NRect.fromCenter(e.head, e.headSize);

/// The last four observations of a track (a fixed ring). Entries are never mutated after a push.
export class ObsRing {
  static readonly capacity = 4;
  private e: ObsEntry[] = [makeObsEntry(), makeObsEntry(), makeObsEntry(), makeObsEntry()];
  count = 0;
  private next = 0;

  copy(): ObsRing {
    const r = new ObsRing();
    r.e = [...this.e]; r.count = this.count; r.next = this.next;
    return r;
  }

  push(e: ObsEntry): void {
    this.e[this.next] = e;
    this.next = (this.next + 1) % ObsRing.capacity;
    this.count = Math.min(this.count + 1, ObsRing.capacity);
  }

  /// `back(0)` is the latest observation, `back(3)` the oldest kept.
  back(k: number): ObsEntry | null {
    if (k < 0 || k >= this.count) return null;
    return this.e[(this.next - 1 - k + 2 * ObsRing.capacity) % ObsRing.capacity];
  }

  get last(): ObsEntry | null { return this.back(0); }
}

/// The joints the OKS cost compares (nose, shoulders, elbows, wrists, hips) with COCO's per-keypoint σ.
export class Skeleton {
  static readonly joints: readonly BodyJointName[] = ['nose', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
    'leftWrist', 'rightWrist', 'leftHip', 'rightHip'];
  /// COCO keypoint sigmas for the same joints.
  static readonly sigmas: readonly number[] = [0.026, 0.079, 0.079, 0.072, 0.072, 0.062, 0.062, 0.107, 0.107];
  static readonly minConfidence = 0.3;
  static readonly minShared = 3;

  x: number[] = new Array<number>(16).fill(0);
  y: number[] = new Array<number>(16).fill(0);
  c: number[] = new Array<number>(16).fill(0);
  /// The track's head centre when the skeleton was observed (the skeleton moves with the predicted head).
  head: V2 = { x: 0, y: 0 };

  private constructor() {}

  /// The skeleton of a body detection, or null with fewer than `minShared` confident joints (Swift's failable init).
  static make(body: BodyDetection | null, head: V2): Skeleton | null {
    if (body === null || Object.keys(body.joints).length === 0) return null;
    const s = new Skeleton();
    let n = 0;
    Skeleton.joints.forEach((name, i) => {
      const j = body.joints[name];
      if (j === undefined || !(j.c >= Skeleton.minConfidence)) return;
      s.x[i] = j.p.x; s.y[i] = j.p.y; s.c[i] = j.c;
      n += 1;
    });
    if (n < Skeleton.minShared) return null;
    s.head = head;
    return s;
  }

  /// Object keypoint similarity between this skeleton moved by `shift` and `other`, in pixels with the scale `area`
  /// (square pixels): mean over shared confident joints of exp(−d² / (2·area·(2σ)²)). Null with fewer than
  /// `minShared` joints confident in both.
  oks(shift: V2, other: Skeleton, imageSize: V2, area: number): number | null {
    if (!(area > 0)) return null;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < Skeleton.joints.length; i++) {
      if (!(this.c[i] >= Skeleton.minConfidence && other.c[i] >= Skeleton.minConfidence)) continue;
      const dx = (this.x[i] + shift.x - other.x[i]) * imageSize.x;
      const dy = (this.y[i] + shift.y - other.y[i]) * imageSize.y;
      const k = 2 * Skeleton.sigmas[i];
      sum += Math.exp(-(dx * dx + dy * dy) / (2 * area * k * k));
      n += 1;
    }
    return n >= Skeleton.minShared ? sum / n : null;
  }
}

export const AssociationGeometry = {
  /// Height-modulated IoU: IoU × (vertical overlap / vertical union).
  hmiou(a: NRect, b: NRect): number {
    const iou = NRect.iou(a, b);
    if (!(iou > 0)) return 0;
    const overlap = Math.max(0, Math.min(NRect.maxY(a), NRect.maxY(b)) - Math.max(a.y, b.y));
    const union = Math.max(NRect.maxY(a), NRect.maxY(b)) - Math.min(a.y, b.y);
    return union > 0 ? iou * overlap / union : 0;
  },

  /// Δθ_dir / π in 0…1: the angle between the track's recent direction and the track → detection direction, faded
  /// out when either movement is too small to have a direction.
  directionTerm(track: V2, toDetection: V2): number {
    const lt = vlength2(track), ld = vlength2(toDetection);
    const weight = smoothstep(0.004, 0.012, lt) * smoothstep(0.003, 0.010, ld);
    if (!(weight > 0)) return 0;
    const cosA = clamp(vdot2(track, toDetection) / (lt * ld), -1, 1);
    return weight * Math.acos(cosA) / Math.PI;
  },
} as const;

/// Engaged-person protection (design §9): the global assignment may not move the engaged person's track off its own
/// best detection unless the global solution has preferred that for `persist` seconds in a row.
export class EngagedProtection {
  protectedRowID: number | null = null;
  preferSince: number | null = null;
  /// Frames on which the global assignment disagreed with the protected track's own best match.
  conflicts = 0;

  resolve(cost: readonly (readonly number[])[], protectedRow: number | null, protectedID: number | null, gate: number,
    now: number, persist: number): (number | null)[] {
    const global = Hungarian.assign(cost, gate);
    if (protectedID !== this.protectedRowID) { this.protectedRowID = protectedID; this.preferSince = null; }
    const r = protectedRow;
    if (r === null || r >= cost.length) { this.preferSince = null; return global; }
    let greedy: number | null = null;
    cost[r].forEach((v, c) => { if (v <= gate && (greedy === null || v < cost[r][greedy])) greedy = c; });
    const g = greedy as number | null;
    if (g === null || global[r] === g) { this.preferSince = null; return global; }
    this.conflicts += 1;
    const since = this.preferSince ?? now;
    this.preferSince = since;
    if (now - since >= persist - 1e-6) return global;
    // Keep the protected track on its own best; solve everyone else without that row and column.
    const forced = cost.map((row) => [...row]);
    for (let i = 0; i < forced.length; i++) if (i !== r) forced[i][g] = Infinity;
    for (let c = 0; c < forced[r].length; c++) if (c !== g) forced[r][c] = Infinity;
    return Hungarian.assign(forced, gate);
  }
}
