// Port of ConversationTurnTests/TurnStateMachineTests.swift: every transition (design §6.3, §16).
import { describe, expect, test } from 'vitest';
import {
  echoMinSpeechFrames, makeTurnTunables, minSpeechFrames, stopFrames, tunableThreshold,
} from '../../src/conversation/turn';
import { approx, MachineDriver, must, req, sig, turnEnd } from './support/MachineDriver';

describe('TurnStateMachine', () => {
  test('defaults match the design', () => {
    const t = makeTurnTunables();
    expect(t.vadThreshold).toBe(0.6);
    expect(minSpeechFrames(t)).toBe(2);
    expect(tunableThreshold(t, true)).toBe(0.85);
    expect(echoMinSpeechFrames(t)).toBe(3);
    expect(t.echoTail).toBe(0.3);
    expect(t.stopSecs).toBe(0.2);
    expect(stopFrames(t)).toBe(6);
    expect([t.completionThreshold, t.fallbackSilence, t.preRoll, t.smartTurnTimeout]).toEqual([0.5, 3, 0.5, 0.5]);
  });

  test('onset needs two speech frames and starts at the run', () => {
    const d = new MachineDriver();
    expect(d.frames([0.9])).toEqual([]); // one frame isn't speech
    expect(d.frames([0.1])).toEqual([]);
    expect(d.machine.phase).toBe('quiet');
    const at = d.t;
    expect(d.frames([0.9, 0.95])).toEqual([{ kind: 'signal', signal: { kind: 'speechStarted', at, echoRule: false } }]);
    expect(d.machine.phase).toBe('speech');
    expect(approx(d.machine.turnStart, Math.max(at - 0.5, 100))).toBe(true); // pre-roll, never before the mic opened
  });

  test('in-between frames neither start nor break a run', () => {
    const d = new MachineDriver();
    const at = d.t;
    expect(d.frames([0.9, 0.5])).toEqual([]); // 0.5 is between 0.45 and 0.6: no count
    expect(sig(d.frames([0.9])[0])).toEqual({ kind: 'speechStarted', at, echoRule: false }); // and no break
    expect(d.frames([0.5, 0.5, 0.5])).toEqual([]);
    expect(d.machine.phase).toBe('speech'); // in-between frames don't end speech
  });

  test('pause then complete ends the turn', () => {
    const d = new MachineDriver();
    d.repeated(0.05, 40); // 1.28 s of quiet first: the pre-roll is a full 0.5 s
    const onset = d.startTurn();
    d.repeated(0.9, 10);
    const speechEnd = d.t;
    const silent = d.repeated(0.05, 6);
    expect(silent.length).toBe(1);
    const r = must(req(silent[0]));
    expect(r.id).toBe(1);
    expect(approx(r.from, onset - 0.5)).toBe(true); // the request covers the pre-roll
    expect(approx(r.to, speechEnd + 6 * MachineDriver.frame)).toBe(true);
    expect(d.machine.phase).toBe('evaluating');
    const end = must(turnEnd(sig(d.machine.smartTurnResult(1, 0.8, 9, r.to + 0.01))));
    expect(approx(end.speechEnd, speechEnd)).toBe(true);
    expect(end.reason).toEqual({ kind: 'complete', probability: 0.8 });
    expect(end.inferenceMs).toBe(9);
    expect(approx(end.verdictAt, r.to + 0.01)).toBe(true);
    expect(d.machine.phase).toBe('quiet');
  });

  test('pause incomplete, then more speech, then complete', () => {
    const d = new MachineDriver();
    d.startTurn();
    const r1 = must(d.pauseUntilRequest());
    expect(d.machine.smartTurnResult(r1.id, 0.2, 11, d.t)).toEqual({
      kind: 'signal', signal: { kind: 'pause', pause: { probability: 0.2, inferenceMs: 11 } },
    });
    expect(d.machine.phase).toBe('incomplete');
    expect(d.frames([0.9])).toEqual([]);
    expect(d.machine.phase).toBe('incomplete'); // one frame doesn't resume
    expect(d.frames([0.9])).toEqual([]); // resuming sends no second speech start
    expect(d.machine.phase).toBe('speech');
    const r2 = must(d.pauseUntilRequest());
    expect(r2.id).toBe(r1.id + 1);
    expect(approx(r2.from, r1.from)).toBe(true); // Smart Turn re-runs on the whole turn
    expect(sig(d.machine.smartTurnResult(r2.id, 0.9, 8, d.t))?.kind).toBe('turnEnded');
    expect(d.signals.filter((s) => s.kind === 'speechStarted').length).toBe(1);
  });

  test('speech during evaluation makes the result stale', () => {
    const d = new MachineDriver();
    d.startTurn();
    const r1 = must(d.pauseUntilRequest());
    d.repeated(0.9, 2);
    expect(d.machine.phase).toBe('speech');
    expect(d.machine.smartTurnResult(r1.id, 0.99, 5, d.t)).toBeNull();
    expect(d.machine.phase).toBe('speech');
    const r2 = must(d.pauseUntilRequest());
    expect(d.machine.smartTurnResult(r1.id, 0.99, 5, d.t)).toBeNull(); // old id
    expect(sig(d.machine.smartTurnResult(r2.id, 0.99, 5, d.t))?.kind).toBe('turnEnded');
  });

  test('fallback ends the turn exactly three seconds after speech end', () => {
    const d = new MachineDriver();
    d.startTurn();
    d.repeated(0.9, 5);
    const speechEnd = d.t;
    const r = must(d.pauseUntilRequest(0));
    d.machine.smartTurnResult(r.id, 0.1, 10, d.t);
    expect(d.machine.tick(speechEnd + 2.999)).toBeNull();
    const end = must(turnEnd(sig(d.machine.tick(speechEnd + 3))));
    expect(end.reason).toEqual({ kind: 'silenceFallback' });
    expect(approx(end.speechEnd, speechEnd) && approx(end.verdictAt, speechEnd + 3)).toBe(true);
    expect(end.inferenceMs).toBe(10);
    expect(d.machine.phase).toBe('quiet');
  });

  test('failed Smart Turn falls back to silence', () => {
    const d = new MachineDriver();
    d.startTurn();
    const r = must(d.pauseUntilRequest());
    const speechEnd = must(d.machine.speechEnd);
    expect(d.machine.smartTurnFailed(r.id, d.t)).toEqual({
      kind: 'signal', signal: { kind: 'pause', pause: { probability: null, inferenceMs: null } },
    });
    expect(d.machine.phase).toBe('incomplete');
    expect(turnEnd(sig(d.machine.tick(speechEnd + 3)))?.reason).toEqual({ kind: 'silenceFallback' });
  });

  test('timed-out Smart Turn falls back to silence', () => {
    const d = new MachineDriver();
    d.startTurn();
    const r = must(d.pauseUntilRequest());
    const speechEnd = must(d.machine.speechEnd);
    expect(d.machine.tick(r.to + 0.49)).toBeNull();
    expect(d.machine.tick(r.to + 0.5)).toEqual({
      kind: 'signal', signal: { kind: 'pause', pause: { probability: null, inferenceMs: null } },
    });
    expect(d.machine.smartTurnResult(r.id, 0.9, 600, r.to + 0.6)).toBeNull(); // a result after the timeout is stale
    expect(sig(d.machine.tick(speechEnd + 3))?.kind).toBe('turnEnded');
  });
});
