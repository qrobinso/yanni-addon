// Port of FacePerception/FeatureRecordingSession.swift.
import { CameraGeometry } from './CameraGeometry';
import { FeatureFrameCodec, type FeatureFrame } from './FeatureFrameCodec';
import { FeatureRecordingHeader, type RecordingSessionType } from './FeatureRecordFormat';
import {
  FeatureRecordingStore, bytesText, joinPath, makeSessionLabel, makeSessionLabels,
  type RecordingFileSystem, type SessionLabels,
} from './FeatureRecordingStore';
import type { RecordedEvent } from './FeatureRecordingWriter';
import { StageTimings } from './HarnessTiming';
import { PerceptionProcessor } from './PerceptionProcessor';
import { PerceptionSettings } from './PerceptionSettings';
import { PerceptionRecording } from './Replay';

/// A whole recorded session read back (the viewer, the evaluator, the replay source). Reads recorder v2 session
/// folders and v1 single-file recordings (`PerceptionRecording` JSON).
export class FeatureRecordingSession {
  constructor(
    public header: FeatureRecordingHeader,
    public frames: FeatureFrame[],
    public events: RecordedEvent[] = [],
    public labels: SessionLabels = makeSessionLabels(),
    /// Where it came from (a folder for v2, a file for v1).
    public url: string | null = null,
  ) {}

  get duration(): number {
    const n = this.frames.length;
    return n === 0 ? 0 : this.frames[n - 1].detections.time - this.frames[0].detections.time;
  }

  /// Reads a v2 folder or a v1 `.json` file.
  static load(fs: RecordingFileSystem, url: string): FeatureRecordingSession {
    if (!fs.isDirectory(url)) {
      const d = fs.read(url);
      if (d === null) throw new Error(`no recording at ${url}`);
      return FeatureRecordingSession.fromV1(PerceptionRecording.decode(bytesText(d)), url);
    }
    const hd = fs.read(joinPath(url, 'header.json'));
    if (hd === null) throw new Error(`no header.json in ${url}`);
    const header = FeatureRecordingHeader.decode(bytesText(hd));
    const files = fs.list(url).filter((f) => f.startsWith('chunk-') && f.endsWith('.yfr')).sort();
    const frames: FeatureFrame[] = [];
    for (const f of files) {
      frames.push(...FeatureFrameCodec.decodeChunk(fs.read(joinPath(url, f)) ?? new Uint8Array(0), header.layout, header.intrinsics));
    }
    const events: RecordedEvent[] = [];
    const ev = fs.read(joinPath(url, 'events.jsonl'));
    if (ev !== null) {
      for (const line of bytesText(ev).split('\n')) {
        if (line === '') continue;
        try { events.push(JSON.parse(line) as RecordedEvent); } catch { /* skip an unreadable line */ }
      }
    }
    return new FeatureRecordingSession(header, frames, events, FeatureRecordingStore.loadLabels(fs, url), url);
  }

  /// A v1 recording (detections only, labels relative to the first frame) as a session.
  static fromV1(r: PerceptionRecording, url: string | null = null): FeatureRecordingSession {
    const t0 = r.frames[0]?.time ?? 0;
    const h = new FeatureRecordingHeader(r.name, 'free', [], new Date(0), t0);
    h.platform = 'v1';
    h.cameraOffset = { ...r.cameraOffset };
    if (r.frames.length > 0) h.intrinsics = r.frames[0].intrinsics;
    h.framesWritten = r.frames.length;
    const frames = r.frames.map((f): FeatureFrame => ({
      detections: { ...f, motion: null }, people: [], primaryID: null, engagedID: null, stages: new StageTimings(), tier: 0,
    }));
    const labels = r.labels.map((l) => makeSessionLabel(t0 + l.start, t0 + l.end, l.label, { person: l.person }));
    return new FeatureRecordingSession(h, frames, [], makeSessionLabels(labels), url);
  }

  /// The detections as a v1 recording (the replay player and golden tools take this shape).
  asPerceptionRecording(): PerceptionRecording {
    const t0 = this.frames[0]?.detections.time ?? this.header.startHostTime;
    const labels = this.labels.labels.map((l) => ({ start: l.start - t0, end: l.end - t0, label: l.label, person: l.person }));
    return new PerceptionRecording(this.header.id, { ...this.header.cameraOffset }, this.frames.map((f) => f.detections), labels);
  }

  /// A synthetic (or v1) recording as a session, for tests and the evaluator's self-check: the detections run
  /// through a fresh processor so the per-person outputs are filled in.
  static synthetic(r: PerceptionRecording, type: RecordingSessionType, platform = 'synthetic',
    settings: PerceptionSettings = new PerceptionSettings()): FeatureRecordingSession {
    const s = FeatureRecordingSession.fromV1(r);
    s.header.sessionType = type;
    s.header.platform = platform;
    const proc = new PerceptionProcessor(settings, new CameraGeometry(undefined, r.cameraOffset), 3);
    for (const f of s.frames) {
      const det = { ...f.detections, bodies: f.detections.bodies.map((b) => ({ ...b, appearance: null })) };
      f.detections = det;
      const out = proc.process(det);
      f.people = out.snapshot.people;
      f.primaryID = out.snapshot.primaryID;
      f.engagedID = out.snapshot.engagedID;
    }
    return s;
  }
}
