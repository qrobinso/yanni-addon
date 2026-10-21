// Port of Tests/FaceVoiceTests/TouchVoiceTests.swift.
// Taps go through the real engine (TouchReactions → OneShotSampler → startedOneShots) and the director's
// auto-vocalization path; these check the right chirps come out.
import { describe, expect, test } from 'vitest';
import type { V2 } from '../../src/core/vec';
import { FaceCommand, FaceEngine } from '../../src/engine';
import type { TouchReactions } from '../../src/engine/modifiers/TouchReactions';
import { PhraseGenerator, VoiceDirector, VoiceRenderer, type VoiceReaction } from '../../src/voice';
import { FakeOutput, Rig, started } from './support';

class TouchRig {
  readonly engine: FaceEngine;
  readonly output = new FakeOutput();
  readonly director: VoiceDirector;
  now = 1000;
  /// Every auto phrase scheduled, in order.
  reactions: { time: number; reaction: VoiceReaction }[] = [];
  private lastID: number | null = null;

  constructor(seed: bigint = 3n) {
    this.engine = new FaceEngine({ seed });
    // Keep the test about taps: no spontaneous idle beats.
    const ib = this.engine.director.modifier('IdleBeats');
    if (ib) ib.isEnabled = false;
    this.director = new VoiceDirector(this.engine, new VoiceRenderer(48_000), null, new PhraseGenerator(undefined, 7n));
    this.director.output = this.output;
    this.director.clock = () => this.now;
    this.frame();
  }

  get touch(): TouchReactions { return this.engine.director.modifier('TouchReactions') as unknown as TouchReactions; }

  frame(): void {
    this.now += 1.0 / 60.0;
    this.engine.tick(1.0 / 60.0, this.now);
    this.director.afterFrame(this.now);
    const p = this.director.lastPhrase;
    if (p && p.id !== this.lastID) {
      this.lastID = p.id;
      this.reactions.push({ time: this.now, reaction: p.reaction });
    }
  }

  advance(seconds: number): void {
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) this.frame();
  }

  tap(p: V2 = { x: 0.3, y: 0 }): void {
    this.engine.send(FaceCommand.tap(p));
    this.frame();
  }
}

describe('TouchVoiceTests', () => {
  test('startledWakeSaysEep', () => {
    const rig = new TouchRig();
    rig.engine.setAgentState('asleep');
    rig.advance(2);
    rig.reactions = [];
    rig.touch.forceStartle = true;
    rig.tap();
    rig.advance(0.5);
    expect(rig.reactions[0]?.reaction, JSON.stringify(rig.reactions)).toBe('startled');
    expect(rig.reactions.length, 'one chirp for the wake (noticing has no entry sound)').toBe(1);
  });

  test('gentleWakeIsSleepy', () => {
    const rig = new TouchRig();
    rig.engine.setAgentState('asleep');
    rig.advance(2);
    rig.reactions = [];
    rig.touch.forceStartle = false;
    rig.tap();
    rig.advance(1);
    expect(rig.reactions.map((r) => r.reaction), JSON.stringify(rig.reactions)).toEqual(['sleepy']);
  });

  /// Rapid tapping (a child at ~4 Hz): the friendly chirp on the first tap must not swallow the "hmph"
  /// that follows well within the 1.5 s global auto interval.
  test('rapidTapsStillGetTheHmph', () => {
    for (const seed of [1n, 2n, 3n, 4n]) {
      const rig = new TouchRig(seed);
      rig.advance(1);
      for (let i = 0; i < 5; i++) {
        rig.tap();
        rig.advance(0.25);
      }
      rig.advance(1);
      const r = rig.reactions.map((x) => x.reaction);
      expect((['engaged', 'delighted', 'curious'] as (VoiceReaction | undefined)[]).includes(r[0]),
        `seed ${seed}: friendly first: ${r}`).toBe(true);
      expect(r.includes('hmph'), `seed ${seed}: ${r}`).toBe(true);
    }
  });

  test('idleAmbientChirpsAreRareButTapsStillChirp', () => {
    const rig = new Rig();
    rig.engine.setAgentState('idle');
    rig.frame();
    rig.injector.queued = [started('curiousTilt', rig.now)];
    rig.frame();
    const first = rig.director.lastPhrase?.id;
    expect(first, 'the first ambient chirp plays').toBeDefined();
    rig.advance(5);
    rig.injector.queued = [started('doubleTake', rig.now)];
    rig.frame();
    expect(rig.director.lastPhrase?.id, 'a second ambient one-shot within a minute is silent').toBe(first);
    rig.advance(VoiceDirector.idleAmbientInterval);
    rig.injector.queued = [started('doubleTake', rig.now)];
    rig.frame();
    expect(rig.director.lastPhrase?.id, 'after the interval it may chirp again').not.toBe(first);
  });

  test('noticingIsQuietToo', () => {
    const rig = new Rig();
    rig.engine.setAgentState('noticing');
    rig.frame();
    rig.injector.queued = [started('curiousTilt', rig.now)];
    rig.frame();
    const first = rig.director.lastPhrase?.id;
    expect(first).toBeDefined();
    rig.advance(10);
    rig.injector.queued = [started('crossEyed', rig.now)];
    rig.frame();
    expect(rig.director.lastPhrase?.id, "someone passing by doesn't make Yanni chatter").toBe(first);
    rig.advance(1);
    rig.injector.queued = [started('bigSurprise', rig.now)];
    rig.frame();
    expect(rig.director.lastPhrase?.id, 'a startle always sounds').not.toBe(first);
  });

  test('urgentIntervalStillSpacesPhrases', () => {
    const rig = new Rig();
    rig.injector.queued = [started('perkUp', rig.now)];
    rig.frame();
    const first = rig.director.lastPhrase?.id;
    expect(first).toBeDefined();
    // 0.3 s later: even a hmph waits (urgent interval 0.6 s).
    rig.advance(0.3);
    rig.injector.queued = [started('mockOffense', rig.now)];
    rig.frame();
    expect(rig.director.lastPhrase?.id).toBe(first);
    // 0.7 s after the first: a hmph is allowed, a non-urgent reaction is not.
    rig.advance(0.4);
    rig.injector.queued = [started('laugh', rig.now)];
    rig.frame();
    expect(rig.director.lastPhrase?.id).toBe(first);
    rig.injector.queued = [started('mockOffense', rig.now)];
    rig.frame();
    expect(rig.director.lastPhrase?.reaction).toBe('hmph');
  });
});
