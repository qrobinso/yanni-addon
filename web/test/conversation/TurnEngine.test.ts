// Port of ConversationTurnTests/TurnEngineTests.swift: the engine with a scripted VAD and Smart Turn on a fake clock.
import { describe, expect, test } from 'vitest';
import {
  EchoWindow, makeTurnTunables, TurnAudioFormat, TurnAudioWindow, TurnDetectionEngine, type SmartTurnRequest,
  type TurnSignal,
} from '../../src/conversation/turn';
import { must, turnEnd } from './support/MachineDriver';
import { ScriptedTurnCompletion, ScriptedVoiceActivity } from './support/TurnFakes';

/** Feeds `seconds` of 16 kHz audio in 10 ms chunks (160 samples), each sample its absolute index as a value. */
class Feeder {
  index = 0;
  echoUntil: (t: number) => number = () => -Infinity;
  private chunk = new Float32Array(160);
  constructor(readonly engine: TurnDetectionEngine, public t: number) {}
  async run(seconds: number): Promise<void> {
    const n = Math.round(seconds / 0.01);
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < 160; i++) this.chunk[i] = this.index + i;
      this.index += 160;
      this.t += 0.01;
      await this.engine.feed(this.chunk, this.t, this.echoUntil(this.t));
      this.engine.tick(this.t);
    }
  }
}

class Rig {
  vad: ScriptedVoiceActivity;
  engine: TurnDetectionEngine;
  feeder: Feeder;
  signals: TurnSignal[] = [];
  requests: [SmartTurnRequest, number][] = [];
  constructor(script: number[]) {
    this.vad = new ScriptedVoiceActivity(script);
    this.engine = new TurnDetectionEngine(this.vad);
    this.feeder = new Feeder(this.engine, 50);
    this.engine.onSignal = (s) => this.signals.push(s);
    this.engine.onSmartTurnRequest = (r, w) => this.requests.push([r, w.validCount]);
    this.engine.micOpened(50);
  }
}

const fill = (p: number, n: number): number[] => Array<number>(n).fill(p);

describe('TurnDetectionEngine', () => {
  test('frames are assembled from odd chunks contiguously', async () => {
    const rig = new Rig([]);
    await rig.feeder.run(1.0); // 16 000 samples = 31 full frames
    expect(rig.vad.frames).toBe(31);
    expect(rig.vad.firstSamples.slice(0, 3)).toEqual([0, 512, 1024]); // contiguous 512-sample frames
  });

  test('onset and turn end through the engine', async () => {
    // 1 s quiet, 1 s speech, then silence.
    const rig = new Rig([...fill(0.02, 31), ...fill(0.9, 31)]);
    await rig.feeder.run(2.0);
    const first = rig.signals[0];
    expect(first).toMatchObject({ kind: 'speechStarted', echoRule: false });
    if (first?.kind !== 'speechStarted') return;
    expect(Math.abs(first.at - (50 + 31 * TurnAudioFormat.frameDuration))).toBeLessThan(0.011); // onset at the run's first frame
    await rig.feeder.run(0.25);
    const [r, valid] = must(rig.requests[0]);
    expect(r.id).toBe(1);
    // Pre-roll 0.5 s + ~1 s of speech + 6 silent frames, at 16 kHz.
    const expected = (r.to - r.from) * 16_000;
    expect(Math.abs(valid - expected)).toBeLessThanOrEqual(16);
    // Run the scripted Smart Turn the way a runtime would, then report back.
    const st = new ScriptedTurnCompletion([{ probability: 0.85 }]);
    const p = await st.completionProbability(new TurnAudioWindow());
    rig.engine.smartTurnFinished(r.id, p, 7, rig.feeder.t);
    const end = must(turnEnd(rig.signals[rig.signals.length - 1]));
    expect(end.reason).toEqual({ kind: 'complete', probability: 0.85 });
    expect(rig.engine.smartTurnRuns).toBe(1);
    expect(rig.engine.lastInferenceMs).toBe(7);
    expect(rig.engine.status({ kind: 'ready' }).phase).toBe('quiet');
  });

  test('barge-in during loud playout starts with the echo rule', async () => {
    // Playout loud until t = 50.5 (+ output latency 10 ms + tail 0.3 s): a strong onset at 50.2 still counts.
    const rig = new Rig([...fill(0.02, 6), ...fill(0.95, 6)]);
    rig.feeder.echoUntil = () => EchoWindow.until(50.5, 0.01, -Infinity, 0.3);
    await rig.feeder.run(0.5);
    const first = rig.signals[0];
    expect(first?.kind).toBe('speechStarted');
    if (first?.kind !== 'speechStarted') return;
    expect(first.echoRule).toBe(true);
    expect(Math.abs(first.at - (50 + 6 * TurnAudioFormat.frameDuration))).toBeLessThan(1e-6);
    expect(rig.engine.status({ kind: 'ready' }).echoActive).toBe(false); // inside the turn the normal rule applies
  });

  test('echo window takes the latest sound plus the tail', () => {
    expect(EchoWindow.until(10, 0.02, 9, 0.3)).toBeCloseTo(10.32, 12);
    expect(EchoWindow.until(-Infinity, 0.02, 9, 0.3)).toBeCloseTo(9.3, 12);
    expect(EchoWindow.until(-Infinity, 0, -Infinity, 0.3)).toBe(-Infinity);
  });

  test('VAD state resets after five seconds of silence outside a turn', async () => {
    const rig = new Rig([]);
    const before = rig.vad.resets;
    await rig.feeder.run(5.2);
    expect(rig.vad.resets).toBe(before + 1);
  });

  test('repeated VAD failures report unavailable once', async () => {
    const rig = new Rig([]);
    rig.vad.failing = new Set(Array.from({ length: 40 }, (_, i) => i));
    await rig.feeder.run(1.0);
    expect(rig.signals).toEqual([{ kind: 'unavailable', reason: 'voice activity model failed' }]);
  });

  test('mic closed mid-utterance discards', async () => {
    const rig = new Rig(fill(0.9, 10));
    await rig.feeder.run(0.2);
    rig.engine.micClosed(rig.feeder.t);
    await rig.feeder.run(4);
    expect(rig.signals.length).toBe(2);
    expect(rig.signals[0].kind).toBe('speechStarted');
    expect(rig.signals[1].kind).toBe('turnDiscarded');
    expect(rig.requests).toEqual([]); // no Smart Turn, no turn end
  });

  test('Smart Turn never sees audio before a gap', async () => {
    const rig = new Rig(fill(0.9, 31));
    await rig.feeder.run(0.5);
    rig.engine.gap(rig.feeder.t);
    const gapAt = rig.feeder.index;
    await rig.feeder.run(1.0);
    const [, valid] = must(rig.requests[0]);
    expect(valid).toBeLessThanOrEqual(rig.feeder.index - gapAt);
    expect(rig.engine.gaps).toBe(1);
  });

  test('tunables are clamped on the way in', () => {
    const rig = new Rig([]);
    rig.engine.tunables = makeTurnTunables({ vadThreshold: 2, stopSecs: NaN });
    expect(rig.engine.tunables.vadThreshold).toBe(0.9);
    expect(rig.engine.tunables.stopSecs).toBe(0.2);
  });
});
