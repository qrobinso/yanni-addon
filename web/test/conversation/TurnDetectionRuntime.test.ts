// Port of ConversationAudioTests/TurnDetectionRuntimeTests.swift: the runtime end to end with scripted detectors (no
// models, no hardware): frames pushed into the pump → the engine on its chain → a scripted Smart Turn → signals.
import { describe, expect, test } from 'vitest';
import { PlayoutAudibility } from '../../src/conversation/audio/PlayoutAudibility';
import { TurnAudioPump } from '../../src/conversation/audio/TurnAudioPump';
import { TurnDetectionRuntime } from '../../src/conversation/audio/TurnDetectionRuntime';
import { canListen, type TurnSignal } from '../../src/conversation/turn';
import { ScriptedTurnCompletion, ScriptedVoiceActivity } from './support/TurnFakes';

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

describe('TurnDetectionRuntime', () => {
  test('speech then silence ends a turn on a confident verdict', async () => {
    let clock = 1000;
    const pump = new TurnAudioPump(() => clock, { set: () => 1, clear: () => {} });
    const eot = new ScriptedTurnCompletion([{ probability: 0.9 }]);
    // Frames 0–4 quiet, 5–19 speech, then quiet: onset at frame 5, Smart Turn after 6 silent frames.
    const script = [...Array<number>(5).fill(0.02), ...Array<number>(15).fill(0.95)];
    const rt = new TurnDetectionRuntime({
      pump, playout: new PlayoutAudibility(), makeVAD: () => new ScriptedVoiceActivity(script), endOfTurn: eot,
      computeUnits: () => 'wasm', now: () => clock,
    });
    const signals: TurnSignal[] = [];
    rt.onSignal = (s) => signals.push(s);
    expect(rt.status.availability.kind).toBe('notLoaded');
    rt.prepare();
    await waitFor(() => rt.status.availability.kind === 'ready');
    expect(rt.status.availability.kind).toBe('ready');
    expect(eot.prepares).toBe(1);

    pump.noteDiscontinuity('newGeneration');
    rt.setListening(true);
    await rt.idle();
    // 1.28 s of 16 kHz audio in 512-sample frames stamped from now on, ticking every 10 ms.
    const t0 = clock;
    for (let i = 0; i < 40; i++) {
      pump.push(new Float32Array(512).fill(0.01), t0 + (i + 1) * 0.032, 1536);
      for (let k = 0; k < 3; k++) { clock += 0.032 / 3; pump.tick(); }
      await rt.idle();
      if (signals.some((s) => s.kind === 'turnEnded')) break;
    }
    await waitFor(() => signals.some((s) => s.kind === 'turnEnded'));
    rt.setListening(false);
    await rt.idle();

    const first = signals[0];
    expect(first?.kind).toBe('speechStarted');
    if (first?.kind !== 'speechStarted') return;
    expect(first.echoRule).toBe(false);
    expect(Math.abs(first.at - (t0 + 5 * 0.032))).toBeLessThan(0.02);
    expect(signals.filter((s) => s.kind === 'turnEnded').length).toBe(1);
    expect(eot.validCounts.length).toBe(1);
    expect(eot.validCounts[0]).toBeGreaterThan(0);
    expect(rt.status.smartTurnRuns).toBe(1);
    expect(rt.status.computeUnits).toBe('wasm');
    expect(rt.status.micLevelDB).toBeNull();
  });

  test('a VAD that fails to load makes it unavailable', async () => {
    const rt = new TurnDetectionRuntime({
      pump: new TurnAudioPump(), playout: new PlayoutAudibility(),
      makeVAD: () => { throw new Error('boom'); }, endOfTurn: new ScriptedTurnCompletion([]),
    });
    const signals: TurnSignal[] = [];
    rt.onSignal = (s) => signals.push(s);
    rt.prepare();
    await waitFor(() => signals.length > 0);
    expect(signals[0]?.kind).toBe('unavailable');
    await rt.idle();
    expect(rt.status.availability.kind).toBe('unavailable');
    expect(canListen(rt.status.availability)).toBe(false);
  });
});
