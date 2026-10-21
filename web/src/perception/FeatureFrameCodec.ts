// Port of FacePerception/FeatureFrameCodec.swift, with FeatureFrameDecoding.swift (`decode`, `decodeChunk`,
// `record`, `chunkPreamble`) folded into `FeatureFrameCodec`.
import { StageTimings } from './HarnessTiming';
import { FeatureRecordLayout, Half } from './FeatureRecordFormat';
import {
  BodyJointName, GazeSource, HandJointName, NRect, joint, makeBodyDetection, makeEyeObservation, makeFaceDetection,
  makeFrameDetections, makeHandDetection, makeHeadPose, makeTrackedPerson,
  type CameraIntrinsics, type DistanceSource, type EyeGazeSource, type FrameDetections, type PerceptionSnapshot,
  type TrackState, type TrackedPerson,
} from './PerceptionTypes';

/// One decoded frame record: the detections as the processor saw them (no motion grid, no colour histogram), the
/// processor's per-person outputs, and the frame's stage timings.
export interface FeatureFrame {
  detections: FrameDetections;
  people: TrackedPerson[];
  primaryID: number | null;
  engagedID: number | null;
  stages: StageTimings;
  tier: number;
}
export const featureFrameTime = (f: FeatureFrame): number => f.detections.time;

export type FeatureRecordError = 'truncated' | 'badMagic' | 'badLayout';
export class FeatureRecordFormatError extends Error {
  constructor(readonly code: FeatureRecordError) { super(`feature record: ${code}`); }
}

const scratch = new DataView(new ArrayBuffer(8));

/// Little-endian byte writer.
export class ByteSink {
  bytes: number[] = [];
  u8(v: number): void { this.bytes.push(v & 0xff); }
  u16(v: number): void { this.bytes.push(v & 0xff, (v >>> 8) & 0xff); }
  u32(v: number): void { for (let i = 0; i < 4; i++) this.bytes.push((v >>> (8 * i)) & 0xff); }
  i32(v: number): void { this.u32(v >>> 0); }
  f64(v: number): void { scratch.setFloat64(0, v, true); for (let i = 0; i < 8; i++) this.bytes.push(scratch.getUint8(i)); }
  h(v: number | null | undefined): void { this.u16(Half.bits(v ?? NaN)); }
}

/// Little-endian byte reader.
export class ByteSource {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  get remaining(): number { return this.bytes.length - this.at; }
  need(n: number): void { if (this.remaining < n) throw new FeatureRecordFormatError('truncated'); }
  u8(): number { this.need(1); return this.bytes[this.at++]; }
  u16(): number { this.need(2); const v = this.bytes[this.at] | (this.bytes[this.at + 1] << 8); this.at += 2; return v; }
  u32(): number {
    this.need(4);
    const b = this.bytes, a = this.at;
    this.at += 4;
    return (b[a] | (b[a + 1] << 8) | (b[a + 2] << 16) | (b[a + 3] << 24)) >>> 0;
  }
  i32(): number { return this.u32() | 0; }
  f64(): number {
    this.need(8);
    for (let i = 0; i < 8; i++) scratch.setUint8(i, this.bytes[this.at + i]);
    this.at += 8;
    return scratch.getFloat64(0, true);
  }
  h(): number { return Half.float(this.u16()); }
  halves(n: number): number[] { return Array.from({ length: n }, () => this.h()); }
}

const clampU8 = (v: number): number => Math.min(Math.max(Math.trunc(v), 0), 255);
const clampI32 = (v: number): number => Math.min(Math.max(Math.trunc(v), -2147483648), 2147483647);

/// Encodes and decodes frame records with a `FeatureRecordLayout`. The writer always writes the current layout; the
/// reader maps fields by name, so it reads any layout version.
export const FeatureFrameCodec = {
  /// File magic of a chunk ("YFR2") followed by the UInt16 layout version.
  magic: [0x59, 0x46, 0x52, 0x32] as readonly number[],

  /// One frame body (without its length prefix).
  encode(det: FrameDetections, s: PerceptionSnapshot, stages: StageTimings, tier: number, l: FeatureRecordLayout, o: ByteSink): void {
    o.f64(det.time);
    o.u8((det.handsRan ? 1 : 0) | (det.bodyPoseRan ? 2 : 0));
    o.u8(clampU8(tier));
    o.u8(Math.min(det.faces.length, 255)); o.u8(Math.min(det.bodies.length, 255));
    o.u8(Math.min(det.hands.length, 255)); o.u8(Math.min(s.people.length, 255));
    o.u8(l.stages.length);
    o.i32(s.primaryID ?? -1); o.i32(s.engagedID ?? -1);
    for (const v of stages.values.slice(0, l.stages.length)) o.h(v);
    for (const f of det.faces.slice(0, 255)) {
      o.h(f.box.x); o.h(f.box.y); o.h(f.box.w); o.h(f.box.h); o.h(f.confidence);
      o.h(f.headPose?.yaw); o.h(f.headPose?.pitch); o.h(f.headPose?.roll);
      o.h(f.eyes?.pupilOffset.x); o.h(f.eyes?.pupilOffset.y); o.h(f.eyes?.eyeWidthPx); o.h(f.eyes?.confidence);
      o.h(f.eyes?.openness); o.h(f.interocularPx); o.h(f.gaze?.yaw); o.h(f.gaze?.pitch); o.h(f.gaze?.confidence);
    }
    for (const b of det.bodies.slice(0, 255)) {
      o.h(b.box.x); o.h(b.box.y); o.h(b.box.w); o.h(b.box.h); o.h(b.confidence);
      for (const n of BodyJointName.allCases) { const j = b.joints[n]; o.h(j?.p.x); o.h(j?.p.y); o.h(j?.c); }
    }
    for (const hd of det.hands.slice(0, 255)) {
      o.h(hd.chirality === null ? -1 : hd.chirality === 'left' ? 0 : 1); o.h(hd.confidence);
      for (const n of HandJointName.allCases) { const j = hd.joints[n]; o.h(j?.p.x); o.h(j?.p.y); o.h(j?.c); }
    }
    for (const p of s.people.slice(0, 255)) {
      o.i32(clampI32(p.id));
      o.h(l.trackStates.indexOf(p.state));
      o.h(p.bodyBox?.x); o.h(p.bodyBox?.y); o.h(p.bodyBox?.w); o.h(p.bodyBox?.h);
      o.h(p.faceBox?.x); o.h(p.faceBox?.y); o.h(p.faceBox?.w); o.h(p.faceBox?.h);
      o.h(p.position.x); o.h(p.position.y);
      o.h(p.positionMetres.x); o.h(p.positionMetres.y); o.h(p.positionMetres.z);
      o.h(p.distance); o.h(l.distanceSources.indexOf(p.distanceSource));
      o.h(p.headPose?.yaw); o.h(p.headPose?.pitch); o.h(p.headPose?.roll);
      o.h(p.facing); o.h(p.lookingAtMe); o.h(FeatureFrameCodec.gazeCode(p.gazeSource, l));
      o.h(p.gazeErrorDegrees); o.h(p.toleranceDegrees);
      o.h(p.lookingFor); o.h(p.dwell); o.h(p.dwellNeeded); o.h(p.salience);
      o.h(p.engaged ? 1 : 0); o.h(p.isStatic ? 1 : 0);
    }
  },

  gazeCode(g: GazeSource, l: FeatureRecordLayout): number {
    const name = g.kind === 'eyes' ? `eyes.${g.source}` : g.kind;
    return l.gazeSources.indexOf(name);
  },

  gazeSource(code: number, l: FeatureRecordLayout): GazeSource {
    if (!(Number.isFinite(code) && code >= 0 && Math.trunc(code) < l.gazeSources.length)) return GazeSource.none;
    const name = l.gazeSources[Math.trunc(code)];
    if (name === 'headPose') return GazeSource.headPose;
    if (name.startsWith('eyes.')) {
      const s = name.slice(5);
      if (s === 'vision' || s === 'mediaPipe' || s === 'pupilFinder') return GazeSource.eyes(s as EyeGazeSource);
    }
    return GazeSource.none;
  },

  // MARK: FeatureFrameDecoding.swift

  /// Decodes one frame body written with `layout`; fields are mapped by name (missing fields read as absent).
  decode(body: Uint8Array, l: FeatureRecordLayout, intrinsics: CameraIntrinsics): FeatureFrame {
    const r = new ByteSource(body);
    const time = r.f64();
    const flags = r.u8();
    const tier = r.u8();
    const nF = r.u8(), nB = r.u8(), nH = r.u8(), nP = r.u8(), nS = r.u8();
    const primary = r.i32(), engaged = r.i32();
    const stageValues = r.halves(nS);
    const stageByName: number[] = [];
    for (const name of StageTimings.names) {
      const i = l.stages.indexOf(name);
      stageByName.push(i >= 0 ? (i < stageValues.length ? stageValues[i] : 0) : 0);
    }
    const det = makeFrameDetections(time, { intrinsics, handsRan: (flags & 1) !== 0, bodyPoseRan: (flags & 2) !== 0 });

    const fields = (names: string[], values: number[]): ((n: string) => number | null) => {
      const map = new Map<string, number>();
      names.forEach((n, i) => { if (i < values.length && !Number.isNaN(values[i])) map.set(n, values[i]); });
      return (n) => map.get(n) ?? null;
    };
    for (let k = 0; k < nF; k++) {
      const v = fields(l.face, r.halves(l.face.length));
      const f = makeFaceDetection(NRect.make(v('x') ?? 0, v('y') ?? 0, v('w') ?? 0, v('h') ?? 0), { confidence: v('conf') ?? 0 });
      const y = v('yaw'), p = v('pitch');
      if (y !== null && p !== null) f.headPose = makeHeadPose(y, p, v('roll') ?? 0);
      const px = v('pupilX'), py = v('pupilY'), w = v('eyeWidthPx');
      if (px !== null && py !== null && w !== null) {
        f.eyes = makeEyeObservation({ x: px, y: py }, w, v('eyeConf') ?? 0, v('openness') ?? 0.3);
      }
      f.interocularPx = v('ipdPx');
      const gy = v('gazeYaw'), gp = v('gazePitch');
      if (gy !== null && gp !== null) f.gaze = { yaw: gy, pitch: gp, confidence: v('gazeConf') ?? 0, source: 'vision' };
      det.faces.push(f);
    }
    for (let k = 0; k < nB; k++) {
      const v = fields(l.body, r.halves(l.body.length));
      const b = makeBodyDetection(NRect.make(v('x') ?? 0, v('y') ?? 0, v('w') ?? 0, v('h') ?? 0), { confidence: v('conf') ?? 0 });
      for (const n of BodyJointName.allCases) {
        const x = v(`${n}.x`), y = v(`${n}.y`);
        if (x !== null && y !== null) b.joints[n] = joint({ x, y }, v(`${n}.c`) ?? 0);
      }
      det.bodies.push(b);
    }
    for (let k = 0; k < nH; k++) {
      const v = fields(l.hand, r.halves(l.hand.length));
      const h = makeHandDetection({}, null, v('conf') ?? 0);
      const c = v('chirality');
      if (c !== null && c >= 0) h.chirality = c < 0.5 ? 'left' : 'right';
      for (const n of HandJointName.allCases) {
        const x = v(`${n}.x`), y = v(`${n}.y`);
        if (x !== null && y !== null) h.joints[n] = joint({ x, y }, v(`${n}.c`) ?? 0);
      }
      det.hands.push(h);
    }
    const people: TrackedPerson[] = [];
    for (let k = 0; k < nP; k++) {
      const id = r.i32();
      const v = fields(l.person, r.halves(l.person.length));
      const box = (p: string): NRect | null => {
        const x = v(p + 'X'), y = v(p + 'Y'), w = v(p + 'W'), h = v(p + 'H');
        return x !== null && y !== null && w !== null && h !== null ? NRect.make(x, y, w, h) : null;
      };
      const code = (name: string, table: string[]): string | null => {
        const c = v(name);
        return c !== null && c >= 0 && Math.trunc(c) < table.length ? table[Math.trunc(c)] : null;
      };
      const p = makeTrackedPerson(id);
      const st = code('state', l.trackStates);
      p.state = st === 'tentative' || st === 'confirmed' || st === 'coasting' ? st as TrackState : 'confirmed';
      p.bodyBox = box('body'); p.faceBox = box('face');
      p.position = { x: v('posX') ?? 0, y: v('posY') ?? 0 };
      p.positionMetres = { x: v('mX') ?? 0, y: v('mY') ?? 0, z: v('mZ') ?? 1.5 };
      p.distance = v('distance') ?? 1.5;
      const ds = code('distanceSource', l.distanceSources);
      p.distanceSource = ds !== null && ['ipd', 'faceWidth', 'shoulders', 'torso', 'bodyBox', 'prior'].includes(ds)
        ? ds as DistanceSource : 'prior';
      const y = v('yaw'), pt = v('pitch');
      if (y !== null && pt !== null) p.headPose = makeHeadPose(y, pt, v('roll') ?? 0);
      p.facing = v('facing') ?? 0;
      p.lookingAtMe = v('lookingAtMe') ?? 0;
      p.gazeSource = FeatureFrameCodec.gazeSource(v('gazeSource') ?? -1, l);
      p.gazeErrorDegrees = v('gazeErrorDeg'); p.toleranceDegrees = v('toleranceDeg');
      p.lookingFor = v('lookingFor') ?? 0; p.dwell = v('dwell') ?? 0;
      p.dwellNeeded = v('dwellNeeded') ?? 1; p.salience = v('salience') ?? 0;
      p.engaged = (v('engaged') ?? 0) > 0.5; p.isStatic = (v('static') ?? 0) > 0.5;
      people.push(p);
    }
    if (r.remaining !== 0) throw new FeatureRecordFormatError('badLayout');
    return {
      detections: det, people, primaryID: primary < 0 ? null : primary, engagedID: engaged < 0 ? null : engaged,
      stages: StageTimings.fromValues(stageByName), tier,
    };
  },

  /// Reads every frame of one chunk file's bytes.
  decodeChunk(bytes: Uint8Array, layout: FeatureRecordLayout, intrinsics: CameraIntrinsics): FeatureFrame[] {
    const r = new ByteSource(bytes);
    r.need(6);
    if (!FeatureFrameCodec.magic.every((b, i) => bytes[i] === b)) throw new FeatureRecordFormatError('badMagic');
    r.at = 4;
    r.u16();
    const out: FeatureFrame[] = [];
    while (r.remaining > 0) {
      const n = r.u32();
      r.need(n);
      out.push(FeatureFrameCodec.decode(bytes.subarray(r.at, r.at + n), layout, intrinsics));
      r.at += n;
    }
    return out;
  },

  /// One complete record (length prefix + body) for a chunk file.
  record(det: FrameDetections, snapshot: PerceptionSnapshot, stages: StageTimings, tier: number, layout: FeatureRecordLayout): Uint8Array {
    const out = new ByteSink();
    out.u32(0);
    FeatureFrameCodec.encode(det, snapshot, stages, tier, layout, out);
    const n = out.bytes.length - 4;
    for (let i = 0; i < 4; i++) out.bytes[i] = (n >>> (8 * i)) & 0xff;
    return Uint8Array.from(out.bytes);
  },

  chunkPreamble(layout: FeatureRecordLayout): Uint8Array {
    const s = new ByteSink();
    s.bytes = [...FeatureFrameCodec.magic];
    s.u16(layout.version);
    return Uint8Array.from(s.bytes);
  },
};
