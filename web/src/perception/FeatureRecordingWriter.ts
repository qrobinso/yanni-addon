// Port of FacePerception/FeatureRecordingWriter.swift, with FeatureRecordingWriter+IO.swift (`drain`, `rotate`,
// `finish`, `flush`) folded into the class.
//
// port-note: the Swift writer guards its state with a Mutex and writes on a utility queue. Here the single thread
// owns the state (the "lock" is always available) and the drain runs as a microtask against the injected
// `RecordingFileSystem`; `flush()` drains at once.
import { FeatureFrameCodec } from './FeatureFrameCodec';
import { FeatureRecordingHeader } from './FeatureRecordFormat';
import { joinPath, textBytes, type RecordingFileSystem } from './FeatureRecordingStore';
import type { StageTimings } from './HarnessTiming';
import { PerceptionEvent, type FrameDetections, type PerceptionSnapshot, type PerceptionTier } from './PerceptionTypes';
import { RecordingGate, RecordingLimits, type RecordingFrameDecision } from './RecordingConsent';

/// One logged event of a session (`events.jsonl`): perception events and reflex decisions, names and numbers only.
export interface RecordedEvent {
  /// Host-clock seconds.
  t: number;
  /// `PerceptionEvent.name` ("engaged", "gesture.wave", …) or "reaction".
  name: string;
  person?: number;
  confidence?: number;
  directed?: boolean;
  /// The reflex decision ("wave → dance", "thumbsUp: not directed").
  note?: string;
}

export const RecordedEvent = {
  make: (t: number, name: string, o: Omit<RecordedEvent, 't' | 'name'> = {}): RecordedEvent => ({ t, name, ...o }),
  of(e: PerceptionEvent, t: number, note: string | null): RecordedEvent {
    const r: RecordedEvent = { t, name: PerceptionEvent.name(e) };
    switch (e.kind) {
      case 'personEntered': case 'personOutOfView': case 'personLeft': case 'lookingAtMe': case 'engaged':
      case 'disengaged': case 'wantsTurn': case 'staticFaceSuppressed':
        r.person = e.id; break;
      case 'primaryChanged': if (e.to !== null) r.person = e.to; break;
      case 'gesture':
        if (e.gesture.personID !== null) r.person = e.gesture.personID;
        r.confidence = e.gesture.confidence; r.directed = e.gesture.directedAtYanni; break;
      default: break;
    }
    if (note !== null) r.note = note;
    return r;
  },
  /// Swift's `sortedKeys` JSON line.
  json(e: RecordedEvent): string {
    const o = e as unknown as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, o[k]])));
  },
} as const;

/// Live state of a running session (Status card, banner).
export interface RecordingStatus {
  state: 'recording' | 'paused' | 'stopped';
  framesWritten: number;
  framesPausedUndeclared: number;
  framesDropped: number;
  bytes: number;
  elapsed: number;
  stopReason: string | null;
}
export const makeRecordingStatus = (): RecordingStatus =>
  ({ state: 'recording', framesWritten: 0, framesPausedUndeclared: 0, framesDropped: 0, bytes: 0, elapsed: 0, stopReason: null });

const pad4 = (n: number): string => String(n).padStart(4, '0');

/// Streams one session to `<directory>/`: `header.json`, `chunk-NNNN.yfr` (one per 60 s), and `events.jsonl`. The
/// analysis loop calls `offer` (if the ring is full the frame is dropped and counted). Frames are written only while
/// the people in view do not outnumber the declared participants; caps stop the session.
export class FeatureRecordingWriter {
  private _header: FeatureRecordingHeader;
  private ring: { time: number; bytes: Uint8Array }[] = [];
  private events: RecordedEvent[] = [];
  private _status = makeRecordingStatus();
  private drainScheduled = false;
  private finished = false;
  // IO.
  private chunk: string | null = null;
  private chunkIndex = -1;
  private chunkStart = -Infinity;

  /// Creates the session folder and writes the header.
  constructor(readonly fs: RecordingFileSystem, readonly directory: string, header: FeatureRecordingHeader,
    /// Bytes this session may use (the 2 GB device cap minus what is already stored).
    readonly byteBudget: number) {
    this._header = header.copy();
    FeatureRecordingWriter.writeHeader(fs, this._header, directory);
    fs.write(joinPath(directory, 'events.jsonl'), new Uint8Array(0));
  }

  static writeHeader(fs: RecordingFileSystem, h: FeatureRecordingHeader, dir: string): void {
    fs.write(joinPath(dir, 'header.json'), textBytes(h.encode()));
  }

  get status(): RecordingStatus { return { ...this._status }; }
  get header(): FeatureRecordingHeader { return this._header.copy(); }

  /// One analysed frame. Returns what happened to it (null once stopped).
  offer(det: FrameDetections, snapshot: PerceptionSnapshot, stages: StageTimings, tier: PerceptionTier): RecordingFrameDecision | null {
    const s = this._status;
    if (this.finished || s.state === 'stopped') return null;
    const d = RecordingGate.decide(RecordingGate.peopleInView(det, snapshot), this._header.participants.length,
      det.time - this._header.startHostTime, s.bytes, this.byteBudget);
    s.elapsed = Math.max(det.time - this._header.startHostTime, 0);
    switch (d.kind) {
      case 'write': s.state = 'recording'; break;
      case 'pauseUndeclared': s.state = 'paused'; s.framesPausedUndeclared += 1; break;
      case 'stop': s.state = 'stopped'; s.stopReason = d.reason; break;
    }
    if (d.kind !== 'write') return d;
    const bytes = FeatureFrameCodec.record(det, snapshot, stages, tier, this._header.layout);
    if (this.ring.length >= RecordingLimits.ringCapacity) { s.framesDropped += 1; return d; }
    this.ring.push({ time: det.time, bytes });
    s.bytes += bytes.length;
    this.schedule();
    return d;
  }

  /// A perception event or reflex decision. Dropped while paused or stopped (it could be a visitor's).
  note(e: RecordedEvent): void {
    if (this.finished || this._status.state !== 'recording') return;
    this.events.push(e);
    this.schedule();
  }

  private schedule(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => this.drain());
  }

  // MARK: FeatureRecordingWriter+IO.swift

  /// Writes everything waiting.
  drain(): void {
    const frames = this.ring, events = this.events;
    this.ring = [];
    this.events = [];
    this.drainScheduled = false;
    for (const f of frames) {
      if (this.chunk === null || f.time - this.chunkStart >= RecordingLimits.chunkSeconds) this.rotate(f.time);
      this.fs.append(this.chunk!, f.bytes);
    }
    if (frames.length > 0) this._status.framesWritten += frames.length;
    if (events.length === 0) return;
    this.fs.append(joinPath(this.directory, 'events.jsonl'), textBytes(events.map((e) => RecordedEvent.json(e) + '\n').join('')));
  }

  private rotate(time: number): void {
    this.chunkIndex += 1;
    this.chunkStart = time;
    this.chunk = joinPath(this.directory, `chunk-${pad4(this.chunkIndex)}.yfr`);
    this.fs.write(this.chunk, FeatureFrameCodec.chunkPreamble(this._header.layout));
  }

  /// Stops the session: writes what is waiting, closes the files and rewrites the header with the totals.
  /// Idempotent; returns the final header.
  finish(reason: string, endDate: Date = new Date()): FeatureRecordingHeader {
    if (this.finished) return this.header;
    this.finished = true;
    this.drain();
    this.chunk = null;
    const s = this._status, h = this._header;
    s.state = 'stopped';
    if (s.stopReason === null) s.stopReason = reason;
    h.endDate = endDate;
    h.framesWritten = s.framesWritten;
    h.framesPausedUndeclared = s.framesPausedUndeclared;
    h.framesDropped = s.framesDropped;
    h.stopReason = s.stopReason;
    FeatureRecordingWriter.writeHeader(this.fs, h, this.directory);
    return h.copy();
  }

  /// Writes everything offered so far (tests).
  flush(): void { this.drain(); }
}
