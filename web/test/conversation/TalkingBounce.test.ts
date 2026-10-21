// Port of Tests/ConversationCoreTests/TalkingBounceTests.swift.
// The controller turns the Spoken voice's playout envelope into face cues every frame (talking bounce).
import { describe, expect, test } from 'vitest';
import type { VocalSync } from '../../src/engine/modifiers/VocalSync';
import { Rig } from './support/Rig';

/** Feeds 5 Hz syllables (5 ms envelope, audible 20 ms ahead of each frame) for `seconds`. */
function speak(rig: Rig, seconds: number): void {
  const t0 = rig.clock.now + 0.05;
  let fed = 0;
  const n = Math.trunc(seconds / Rig.dt);
  for (let i = 0; i < n; i++) {
    while (t0 + fed <= rig.clock.now + Rig.dt + 0.02) {
      const u = fed % 0.2;
      const level = fed > seconds - 0.3 ? 0 : (u < 0.03 ? 0.35 + 10 * u : (u < 0.14 ? 0.65 : 0.35));
      rig.audio.envelope.push([level, t0 + fed]);
      fed += 0.005;
    }
    rig.frame();
  }
}

const vocalSync = (rig: Rig): VocalSync => rig.engine.director.modifier('VocalSync') as unknown as VocalSync;

describe('ControllerTalkingBounceTests', () => {
  test('playoutSyllablesBecomeFaceCues', () => {
    const rig = new Rig();
    speak(rig, 2.0);
    const vs = vocalSync(rig);
    // 5 Hz for 1.7 s of sound: 9 syllables, each one face cue; several hop.
    expect(vs.activations).toBe(9);
    expect(vs.hopCount).toBeGreaterThanOrEqual(4);
  });

  test('staleEnvelopeIsDroppedNotReplayed', () => {
    const rig = new Rig();
    rig.run(1);
    // Levels from a second ago (an undrained stretch): no cue fires for them.
    for (let i = 0; i < 200; i++) {
      const t = rig.clock.now - 1.2 + i * 0.005;
      const u = (i * 0.005) % 0.2;
      rig.audio.envelope.push([u < 0.03 ? 0.35 + 10 * u : 0.65, t]);
    }
    rig.run(0.5);
    expect(vocalSync(rig).activations).toBe(0);
  });
});
