// Port of ConversationTestSupport/TurnFakes.swift (the detector fakes; FakeTurnDetection comes with the controller).
import type { TurnAudioWindow, TurnCompletionDetecting, VoiceActivityDetecting } from '../../../src/conversation/turn';
import { TurnAudioFormat } from '../../../src/conversation/turn';

/** A VAD that returns scripted probabilities, one per frame, then `idle` (deterministic, synchronous). */
export class ScriptedVoiceActivity implements VoiceActivityDetecting {
  /** Frames to fail (throw) by index. */
  failing = new Set<number>();
  frames = 0;
  resets = 0;
  /** The first sample of each frame (proves contiguity in tests). */
  firstSamples: number[] = [];
  constructor(public script: number[] = [], public idle = 0.02) {}

  speechProbability(frame: Float32Array): number {
    const i = this.frames++;
    if (frame.length !== TurnAudioFormat.frameSamples) throw new Error('bad frame size');
    this.firstSamples.push(frame[0]);
    if (this.failing.has(i)) throw new Error('scripted failure');
    return i < this.script.length ? this.script[i] : this.idle;
  }

  reset(): void {
    this.resets += 1;
  }
}

export interface Verdict { probability: number; latencyMs?: number; fails?: boolean }

/** A Smart Turn stand-in with scripted verdicts and latencies. Records what each window held. */
export class ScriptedTurnCompletion implements TurnCompletionDetecting {
  validCounts: number[] = [];
  prepares = 0;
  constructor(private verdicts: Verdict[]) {}

  async prepare(): Promise<void> {
    this.prepares += 1;
  }

  async completionProbability(window: TurnAudioWindow): Promise<number> {
    this.validCounts.push(window.validCount);
    const v = this.verdicts.shift() ?? { probability: 0.9 };
    if (v.latencyMs) await new Promise((r) => setTimeout(r, v.latencyMs));
    if (v.fails) throw new Error('scripted failure');
    return v.probability;
  }
}
