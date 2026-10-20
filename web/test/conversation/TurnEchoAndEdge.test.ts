// Port of ConversationTurnTests/TurnEchoAndEdgeTests.swift: echo self-trigger rejection, speech after a turn, the mic
// gate, gaps and frame-rate independence (design §6.3, §6.5, §7, §16).
import { describe, expect, test } from 'vitest';
import { SplitMix64 } from '../../src/core/random';
import type { LocalTurnEnd, SmartTurnRequest, TurnPhase } from '../../src/conversation/turn';
import { approx, MachineDriver, must, sig, turnEnd } from './support/MachineDriver';

describe('turn echo rule and edges', () => {
  test('echo rule needs the boosted threshold and three frames', () => {
    const d = new MachineDriver();
    const echo = d.t + 10;
    expect(d.repeated(0.8, 5, echo)).toEqual([]); // 0.8 < 0.85 while Yanni is audible
    expect(d.machine.lastEchoActive).toBe(true);
    const at = d.t;
    expect(d.repeated(0.9, 2, echo)).toEqual([]); // two frames aren't enough under the echo rule
    expect(d.frames([0.9], echo)).toEqual([{ kind: 'signal', signal: { kind: 'speechStarted', at, echoRule: true } }]);
  });

  test('a run passing only the normal rule is a self-trigger rejection', () => {
    const d = new MachineDriver();
    const echo = d.t + 10;
    d.frames([0.75, 0.8, 0.78], echo);
    const s = sig(d.frames([0.1], echo)[0]);
    expect(s?.kind).toBe('selfTriggerRejected');
    if (s?.kind !== 'selfTriggerRejected') return;
    expect(approx(s.at, 100)).toBe(true);
    expect(s.peak).toBe(0.8);
    expect(d.machine.phase).toBe('quiet');
    // A single residue frame never counts (it wouldn't have passed the normal rule either).
    d.frames([0.8, 0.1], echo);
    expect(d.signals.filter((x) => x.kind === 'selfTriggerRejected').length).toBe(1);
  });

  test('echo rule ends at echoUntil', () => {
    const d = new MachineDriver();
    const echo = d.t + 0.1;
    d.repeated(0.05, 4, echo); // past echoUntil now
    const at = d.t;
    expect(d.frames([0.7, 0.7], echo)).toEqual([{ kind: 'signal', signal: { kind: 'speechStarted', at, echoRule: false } }]);
  });

  test('inside a turn the normal rule applies', () => {
    const d = new MachineDriver();
    d.startTurn();
    d.repeated(0.7, 5, d.t + 10);
    expect(d.machine.phase).toBe('speech'); // 0.7 is speech inside a turn even while echo is flagged
    expect(d.machine.lastEchoActive).toBe(false);
  });

  test('speech after a turn starts a new turn that does not reach back', () => {
    const d = new MachineDriver();
    d.repeated(0.05, 40);
    d.startTurn();
    const r = must(d.pauseUntilRequest());
    const endAt = d.t;
    d.machine.smartTurnResult(r.id, 0.9, 5, endAt);
    d.repeated(0.05, 3);
    const at = d.t;
    expect(d.frames([0.9, 0.9])).toEqual([{ kind: 'signal', signal: { kind: 'speechStarted', at, echoRule: false } }]);
    expect(approx(d.machine.turnStart, endAt)).toBe(true); // pre-roll stops at the previous turn's end
    const r2 = must(d.pauseUntilRequest());
    expect(r2.from).toBeGreaterThanOrEqual(endAt);
    expect(d.signals.filter((s) => s.kind === 'speechStarted').length).toBe(2);
  });

  test.each<TurnPhase>(['speech', 'waitingStop', 'evaluating', 'incomplete'])(
    'mic gated mid-utterance (%s) discards without a turn end', (phase) => {
      const d = new MachineDriver();
      d.startTurn();
      let request: SmartTurnRequest | null = null;
      if (phase === 'waitingStop') d.repeated(0.05, 2);
      if (phase === 'evaluating') request = d.pauseUntilRequest();
      if (phase === 'incomplete') {
        request = must(d.pauseUntilRequest());
        d.machine.smartTurnResult(request.id, 0.1, 5, d.t);
      }
      expect(d.machine.phase).toBe(phase);
      expect(d.machine.micClosed(d.t)).toEqual({ kind: 'signal', signal: { kind: 'turnDiscarded', at: d.t } });
      expect(d.machine.phase).toBe('off');
      if (request) expect(d.machine.smartTurnResult(request.id, 0.99, 5, d.t)).toBeNull();
      expect(d.machine.tick(d.t + 10)).toBeNull();
      expect(d.repeated(0.9, 5)).toEqual([]); // no frames are processed while off
      expect(d.signals.some((s) => s.kind === 'turnEnded')).toBe(false);
    });

  test('mic closed outside a turn says nothing', () => {
    const d = new MachineDriver();
    expect(d.machine.micClosed(d.t)).toBeNull();
  });

  test('a gap inside a turn counts as silence', () => {
    const d = new MachineDriver();
    d.startTurn();
    const r = must(d.pauseUntilRequest());
    const speechEnd = must(d.machine.speechEnd);
    d.machine.smartTurnResult(r.id, 0.1, 5, d.t);
    expect(d.machine.gap(speechEnd + 1)).toBeNull();
    expect(d.machine.phase).toBe('incomplete'); // the turn stays
    expect(turnEnd(sig(d.machine.gap(speechEnd + 3)))?.reason).toEqual({ kind: 'silenceFallback' });
  });

  test('a gap in quiet resets the onset run', () => {
    const d = new MachineDriver();
    d.frames([0.9]);
    d.machine.gap(d.t);
    expect(d.frames([0.9])).toEqual([]);
    expect(d.machine.phase).toBe('quiet');
  });

  test('tick- and frame-driven timeouts agree', () => {
    function incompleteDriver(): [MachineDriver, number] {
      const d = new MachineDriver();
      d.startTurn();
      const r = must(d.pauseUntilRequest());
      d.machine.smartTurnResult(r.id, 0.1, 5, d.t);
      return [d, must(d.machine.speechEnd)];
    }
    const [byFrames, end1] = incompleteDriver();
    let framed: LocalTurnEnd | null = null;
    while (framed === null && byFrames.t < end1 + 4) framed = turnEnd(sig(byFrames.repeated(0.05, 1)[0]));
    const [byTicks, end2] = incompleteDriver();
    let ticked: LocalTurnEnd | null = null;
    let now = byTicks.t;
    while (ticked === null && now < end2 + 4) { now += 0.01; ticked = turnEnd(sig(byTicks.machine.tick(now))); }
    const f = must(framed), t = must(ticked);
    expect(f.reason.kind === 'silenceFallback' && t.reason.kind === 'silenceFallback').toBe(true);
    expect(Math.abs((f.verdictAt - f.speechEnd) - (t.verdictAt - t.speechEnd))).toBeLessThanOrEqual(MachineDriver.frame);
  });

  test('seeded noise never starts a turn', () => {
    // 10 min of frames: background noise below the silent threshold, and residue under the echo rule just below the
    // boosted threshold. Neither may start a turn (spike M1 in miniature).
    // port-note: Swift's Float.random(in:using:) sequence isn't reproduced; the property doesn't depend on it.
    const rng = new SplitMix64(0x5eed);
    const d = new MachineDriver();
    const frames = Math.floor(600 / MachineDriver.frame);
    for (let i = 0; i < frames; i++) {
      const echo = i % 2000 < 1000;
      const p = Math.fround(echo ? rng.uniform(0, 0.84) : rng.uniform(0, 0.44));
      d.frames([p], echo ? d.t + 1 : -Infinity);
    }
    expect(d.signals.some((s) => s.kind === 'speechStarted')).toBe(false);
    expect(d.signals.some((s) => s.kind === 'selfTriggerRejected')).toBe(true); // residue that would pass the normal rule
  });
});
