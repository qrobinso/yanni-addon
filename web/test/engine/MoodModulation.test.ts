// Port of Tests/FaceEngineTests/MoodModulationTests.swift.
import { describe, expect, test } from 'vitest';
import { AgentStateBehavior, AgentStateProfiles, Modulation, Mood, MoodModulation } from '../../src/engine';
import { ASTRig } from './ASTRig';

describe('MoodModulation', () => {
  test.each([Mood.make(0, 0, 0), Mood.make(0.8, 0.6, 0.2), Mood.make(-0.5, -0.8, -0.3), Mood.make(-0.9, 0.9, 0.9)])(
    'formulas %o', (m) => {
      const o = MoodModulation.moodModulation(m);
      const p = m.pleasure, a = m.arousal;
      expect(Math.abs(o.speed - (1 + 0.35 * a))).toBeLessThan(1e-6);
      expect(Math.abs(o.intensity - (0.9 + 0.2 * Math.abs(p) + 0.1 * a))).toBeLessThan(1e-6);
      expect(Math.abs(o.blinkRate - (1 - 0.3 * a))).toBeLessThan(1e-6);
      expect(Math.abs(o.lidHeaviness - Math.max(0, -a) * 0.25)).toBeLessThan(1e-6);
      expect(Math.abs(o.glanceRate - (1 + 0.6 * a))).toBeLessThan(1e-6);
      expect(Math.abs(o.bounciness - Math.max(p, 0) * Math.max(a, 0))).toBeLessThan(1e-6);
    });

  test('combinesWithStateModulation', () => {
    const mood = Mood.make(0.5, -0.4, 0);
    const drowsy = AgentStateProfiles.profile('drowsy').modulation;
    const m = MoodModulation.moodModulation(mood);
    const c = MoodModulation.combined(mood, drowsy);
    expect(Math.abs(c.speed - m.speed * 0.6)).toBeLessThan(1e-6);
    expect(Math.abs(c.lidHeaviness - (m.lidHeaviness + 0.35))).toBeLessThan(1e-6);
    expect(Math.abs(c.glanceRate - m.glanceRate * 0.3)).toBeLessThan(1e-6);
    expect(Math.abs(c.blinkDuration - m.blinkDuration * 1.6)).toBeLessThan(1e-6);
    const asleep = MoodModulation.combined(Mood.playful, AgentStateProfiles.profile('asleep').modulation);
    expect(asleep.blinkRate).toBe(0);
    const heavy = Modulation.make(); heavy.lidHeaviness = 2; heavy.bounciness = 3;
    const clamped = MoodModulation.combined(Mood.make(1, -1, 0), heavy);
    expect(clamped.lidHeaviness <= 0.9 && clamped.bounciness <= 1).toBe(true);
  });

  test('moodChangesAreSmooth', () => {
    const rig = new ASTRig([new MoodModulation()]);
    rig.state.mood = Mood.make(0, 0, 0);
    rig.tick();
    expect(Math.abs(rig.state.modulation.speed - 1), 'first frame snaps').toBeLessThan(1e-6);
    rig.state.mood = Mood.make(0.8, 1, 0);
    rig.state.elasticity = 1; // neutral style: no extra springiness on top of mood
    const target = MoodModulation.combined(rig.state.mood, Modulation.make());
    let prev = rig.state.modulation.speed;
    let maxStep = 0;
    rig.run(0.1, 1 / 60, (r) => {
      maxStep = Math.max(maxStep, Math.abs(r.state.modulation.speed - prev)); prev = r.state.modulation.speed;
    });
    expect(rig.state.modulation.speed, 'not jumped yet').toBeLessThan(target.speed - 0.05);
    expect(maxStep).toBeLessThan(0.05);
    rig.run(1.0);
    expect(Math.abs(rig.state.modulation.speed - target.speed)).toBeLessThan(0.01);
    expect(Math.abs(rig.state.modulation.bounciness - target.bounciness)).toBeLessThan(0.01);
    expect(rig.state.modulation.speed, 'critically damped: no overshoot').toBeLessThanOrEqual(target.speed + 1e-4);
  });

  test('stateBlinkSuppressionReachesExactlyZero', () => {
    const rig = new ASTRig([new AgentStateBehavior(), new MoodModulation()]);
    rig.tick();
    rig.setAgentState('asleep');
    rig.run(2);
    expect(rig.state.modulation.blinkRate).toBe(0);
    expect(rig.state.modulation.speed).toBeLessThan(0.6);
  });

  function envelope(dt: number, level: number, start: number, seconds: number): number {
    const rig = new ASTRig([new MoodModulation()]);
    rig.state.speechEnvelope = start;
    rig.state.speechLevel = level;
    rig.run(seconds, dt);
    return rig.state.speechEnvelope;
  }

  test('speechEnvelopeAttackAndRelease', () => {
    // One time constant → 1 − 1/e of the way.
    const up = envelope(0.005, 1, 0, 0.03);
    expect(Math.abs(up - (1 - Math.exp(-1)))).toBeLessThan(0.01);
    const down = envelope(0.005, 0, 1, 0.12);
    expect(Math.abs(down - Math.exp(-1))).toBeLessThan(0.01);
    // Frame-rate independent.
    expect(Math.abs(envelope(1 / 60, 1, 0, 0.05) - envelope(1 / 120, 1, 0, 0.05))).toBeLessThan(1e-4);
    expect(Math.abs(envelope(1 / 60, 0, 1, 0.25) - envelope(1 / 120, 0, 1, 0.25))).toBeLessThan(1e-4);
  });
});
