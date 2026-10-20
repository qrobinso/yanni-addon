// Port of Tests/FaceEngineTests/HighFiveTests.swift.
import { describe, expect, test } from 'vitest';
import {
  FaceCommand, FaceEngine, Phase, type AgentState, type FaceState, type Modifier, type OneShotKind, type OneShotRequest,
} from '../../src/engine';
import type { TouchReactions } from '../../src/engine/modifiers/TouchReactions';

/// Records every one-shot request (plain and with options) made this frame before the sampler consumes it.
class PlayRequestTap implements Modifier {
  readonly name = 'PlayRequestTap';
  readonly phase = Phase.behaviour;
  isEnabled = true;
  plain: OneShotKind[] = [];
  play: OneShotRequest[] = [];
  update(s: FaceState): void {
    this.plain.push(...s.oneShotRequests);
    this.play.push(...s.oneShotPlayRequests.map((r) => ({ ...r })));
  }
  clear(): void { this.plain = []; this.play = []; }
}

class Rig {
  readonly engine: FaceEngine;
  readonly log = new PlayRequestTap();
  host = 500;

  constructor(state: AgentState = 'idle') {
    const mods = FaceEngine.makeDefaultModifiers();
    const i = mods.findIndex((m) => m.name === 'OneShotSampler');
    mods.splice(i, 0, this.log);
    this.engine = new FaceEngine({ seed: 3, modifiers: mods });
    const ib = this.engine.director.modifier('IdleBeats');
    if (ib) ib.isEnabled = false;
    this.engine.setAgentState(state);
    this.run(1);
    this.log.clear();
  }

  get touch(): TouchReactions { return this.engine.director.modifier('TouchReactions') as TouchReactions; }

  tick(dt = 1.0 / 60): void {
    this.host += dt;
    this.engine.tick(dt, this.host);
  }

  run(seconds: number, dt = 1.0 / 60): void {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) this.tick(dt);
  }

  tap(): void {
    this.engine.send(FaceCommand.tap({ x: 0.4, y: -0.2 }));
    this.tick();
  }
}

/// The touch-confirmed high-five (perception upgrade §6.6): a tap inside the friendly-touch window.
describe('HighFive', () => {
  test('tapInsideTheWindowIsAHighFive', () => {
    const rig = new Rig();
    rig.engine.noteFriendlyTouch(rig.host + 0.8);
    rig.run(0.3);
    rig.tap();
    expect(rig.log.play.some((r) => r.kind === 'delightedSquint' && r.intensity === 1.2)).toBe(true);
    expect(rig.log.plain, `no poke reaction: ${rig.log.plain}`).toEqual([]);
    expect(rig.engine.state.startedOneShots.some((o) => o.kind === 'delightedSquint')).toBe(true);
    expect(rig.touch.annoyance).toBe(0);
    expect(rig.touch.tapCount).toBe(1);
    expect(rig.touch.highFiveCount === 1 && rig.engine.highFiveCount === 1).toBe(true);
    expect(rig.touch.lastHighFiveAt).toBe(rig.engine.state.time);
    // The flinch stays: the face dips on the following frames.
    let minScale = 1;
    for (let i = 0; i < 12; i++) { rig.tick(); minScale = Math.min(minScale, rig.engine.state.faceScaleMul.y); }
    expect(minScale, `flinch recoil (${minScale})`).toBeLessThan(0.99);
  });

  test('theWindowIsOneUseThenTapsArePokes', () => {
    const rig = new Rig();
    rig.engine.noteFriendlyTouch(rig.host + 0.8);
    rig.tap();
    rig.log.clear();
    rig.run(0.1);
    rig.tap(); // still inside the 0.8 s, but the window is spent
    expect(rig.touch.highFiveCount).toBe(1);
    expect(rig.touch.annoyance).toBeGreaterThan(0.9);
    expect(rig.log.play.some((r) => r.kind === 'delightedSquint')).toBe(false);
    expect(rig.log.plain.every((k) => (['perkUp', 'curiousTilt', 'delightedSquint'] as OneShotKind[]).includes(k))).toBe(true);
  });

  test('windowExpires', () => {
    const rig = new Rig();
    rig.engine.noteFriendlyTouch(rig.host + 0.8);
    rig.run(0.9);
    rig.tap();
    expect(rig.touch.highFiveCount).toBe(0);
    expect(rig.touch.annoyance).toBeGreaterThan(0.9);
    expect(rig.log.play).toEqual([]);
  });

  test('withoutHostTimeUntilIsSecondsFromNow', () => {
    const e = new FaceEngine({ seed: 3 });
    for (let i = 0; i < 30; i++) e.tick(1.0 / 60);
    e.noteFriendlyTouch(0.5);
    for (let i = 0; i < 20; i++) e.tick(1.0 / 60);
    e.send(FaceCommand.tap({ x: 0, y: 0 }));
    e.tick(1.0 / 60);
    expect(e.highFiveCount).toBe(1);
    e.noteFriendlyTouch(0.2);
    for (let i = 0; i < 20; i++) e.tick(1.0 / 60);
    e.send(FaceCommand.tap({ x: 0, y: 0 }));
    e.tick(1.0 / 60);
    expect(e.highFiveCount, 'expired').toBe(1);
  });

  test('pastOrNonFiniteWindowsDoNothing', () => {
    const rig = new Rig();
    rig.engine.noteFriendlyTouch(rig.host - 1);
    rig.tap();
    rig.engine.noteFriendlyTouch(NaN);
    rig.run(0.2);
    rig.tap();
    expect(rig.touch.highFiveCount).toBe(0);
  });

  test('conversationTapInsideTheWindowAddsNoAnnoyance', () => {
    const rig = new Rig('thinking');
    rig.engine.noteFriendlyTouch(rig.host + 0.8);
    rig.tap();
    expect(rig.touch.annoyance).toBe(0);
    expect(rig.touch.highFiveCount).toBe(0);
    expect(rig.log.play.length === 0 && rig.log.plain.length === 0).toBe(true);
    rig.tap(); // spent: an ordinary conversation tap
    expect(rig.touch.annoyance).toBeGreaterThan(0.9);
  });

  test('sulkingTapIsNotAHighFive', () => {
    const rig = new Rig();
    for (let i = 0; i < 5; i++) rig.tap();
    expect(rig.touch.isSulking).toBe(true);
    rig.engine.noteFriendlyTouch(rig.host + 0.8);
    rig.tap();
    expect(rig.touch.highFiveCount).toBe(0);
  });
});
