// The replay people source (Swift app's PerceptionModel.startReplay / replayTick): a recording — the synthetic
// Simulator demo or a recorded session — played against the clock through a fresh processor, looping. The caller ticks
// it (15 Hz) with the coordinator's mailbox and ingests each output as `replay`.
import { CameraGeometry } from './CameraGeometry';
import { PerceptionProcessor, type PerceptionCommand } from './PerceptionProcessor';
import type { PerceptionSettings } from './PerceptionSettings';
import type { FrameDetections, PerceptionOutput, PerceptionTier } from './PerceptionTypes';
import { ReplayPlayer, type PerceptionRecording } from './Replay';

export class ReplaySource {
  readonly player: ReplayPlayer;
  readonly processor: PerceptionProcessor;

  constructor(readonly recording: PerceptionRecording, settings: PerceptionSettings, tier: PerceptionTier, start: number, loop = true) {
    this.player = new ReplayPlayer(recording, start, loop);
    this.processor = new PerceptionProcessor(settings, new CameraGeometry(undefined, recording.cameraOffset), tier);
  }

  /// The frames due by `now`, processed. `commands` is the coordinator's mailbox, drained by the caller.
  tick(now: number, commands: PerceptionCommand[]): { out: PerceptionOutput; detections: FrameDetections }[] {
    const { frames, lapped } = this.player.due(now);
    // The recording carries its own camera offset; the device's offset is for the engine.
    let pre = this.processor.apply(commands.filter((c) => c.kind !== 'cameraOffset'));
    if (lapped) pre = [...pre, ...this.processor.reset()];
    return frames.map((f) => {
      const out = this.processor.process(f);
      out.events = [...pre, ...out.events];
      pre = [];
      return { out, detections: f };
    });
  }
}
