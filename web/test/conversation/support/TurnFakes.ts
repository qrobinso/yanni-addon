// Port of ConversationTestSupport/TurnFakes.swift.
import type { TurnAudioWindow, TurnCompletionDetecting, VoiceActivityDetecting } from '../../../src/conversation/turn';
import { TurnAudioFormat } from '../../../src/conversation/turn';
import type { ConversationTurnDetection } from '../../../src/conversation/core/TurnDetection';
import type { TurnDetectionStatus, TurnSignal, TurnTunables } from '../../../src/conversation/turn';
import { makeTurnDetectionStatus, makeTurnTunables } from '../../../src/conversation/turn';

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

// MARK: - FakeTurnDetection (TurnFakes.swift)


/** The turn detector as the controller sees it: records every call and lets a test play the detector's signals. */
export class FakeTurnDetection implements ConversationTurnDetection {
  onSignal: ((s: TurnSignal) => void) | null = null;
  status: TurnDetectionStatus = makeTurnDetectionStatus({ availability: { kind: 'ready' }, phase: 'off' });
  listening = false;
  listeningChanges: boolean[] = [];
  prepares = 0;
  localAudibleUntil = -Infinity;
  tunables: TurnTunables = makeTurnTunables();
  /** The live mic level the test plays (0…1). */
  inputLevel = 0;

  setListening(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    this.listeningChanges.push(on);
    this.status.phase = on ? 'quiet' : 'off';
  }
  prepare(): void { this.prepares += 1; }
  setLocalSoundAudibleUntil(hostTime: number): void { this.localAudibleUntil = hostTime; }
  setTunables(t: TurnTunables): void { this.tunables = t; }

  emit(s: TurnSignal): void { this.onSignal?.(s); }

  /** A user turn starts; `at` is the onset (start of the confirmed run). */
  speechStarted(at: number, echoRule = false): void { this.emit({ kind: 'speechStarted', at, echoRule }); }

  /** The user's turn ends: speech ended at `speechEnd`, Smart Turn's verdict at `verdictAt`. */
  turnEnded(speechEnd: number, verdictAt: number, p = 0.9, inferenceMs = 12): void {
    this.emit({ kind: 'turnEnded', end: { speechEnd, verdictAt, reason: { kind: 'complete', probability: p }, inferenceMs } });
  }
}
