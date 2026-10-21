// Port of FacePerception/Replay.swift.
import type { V2 } from '../core/vec';
import type { FrameDetections } from './PerceptionTypes';

export interface PerceptionRecordingLabel {
  /// Relative seconds from the first frame.
  start: number;
  end: number;
  /// "looking", "notLooking", "wave", "thumbsUp", …
  label: string;
  person: string | null;
}

/// A recorded (or synthetic) landmark sequence: per-frame detections in the viewer frame, numbers only — never pixels.
export class PerceptionRecording {
  version = 1;
  constructor(
    public name: string,
    /// Camera offset (metres, relative to the drawn face centre) the recording was made with.
    public cameraOffset: V2 = { x: 0, y: 0 },
    public frames: FrameDetections[] = [],
    public labels: PerceptionRecordingLabel[] = [],
  ) {}

  get duration(): number {
    const n = this.frames.length;
    return (n > 0 ? this.frames[n - 1].time : 0) - (n > 0 ? this.frames[0].time : 0);
  }

  // port-note: Swift's Codable JSON (SIMD as arrays); here plain JSON of the same objects (sorted keys aren't kept).
  jsonData(): string {
    return JSON.stringify({ version: this.version, name: this.name, cameraOffset: this.cameraOffset, frames: this.frames,
      labels: this.labels });
  }

  static decode(data: string): PerceptionRecording {
    const o = JSON.parse(data) as { version?: number; name: string; cameraOffset: V2; frames: FrameDetections[];
      labels: PerceptionRecordingLabel[] };
    const r = new PerceptionRecording(o.name, o.cameraOffset, o.frames, o.labels ?? []);
    r.version = o.version ?? 1;
    return r;
  }
}

/// Plays a recording against a clock: frames re-timed so the first one lands at `start`, optionally looping.
export class ReplayPlayer {
  index = 0;
  lap = 0;
  constructor(readonly recording: PerceptionRecording, public start: number, public loop = true) {}

  /// Frames due up to `now` (re-timed), in order. A lap boundary resets nothing; the caller resets the processor
  /// when `lapped` becomes true if it wants independent laps.
  due(now: number): { frames: FrameDetections[]; lapped: boolean } {
    const frames = this.recording.frames;
    if (frames.length === 0) return { frames: [], lapped: false };
    const t0 = frames[0].time;
    const period = this.recording.duration + 1 / 15;
    const out: FrameDetections[] = [];
    let lapped = false;
    for (;;) {
      if (this.index >= frames.length) {
        if (!this.loop) break;
        this.index = 0;
        this.lap += 1;
        lapped = true;
      }
      const due = this.start + this.lap * period + (frames[this.index].time - t0);
      if (!(due <= now)) break;
      out.push({ ...frames[this.index], time: due });
      this.index += 1;
      if (out.length > 64) break;   // never flood after a long pause
    }
    return { frames: out, lapped };
  }

  get isFinished(): boolean { return !this.loop && this.index >= this.recording.frames.length; }
}
