// Port of Tests/FaceEngineTests/AgentStateTests.swift (the rig lives in ./ASTRig.ts).
import { describe, expect, test } from 'vitest';
import {
  AgentState, AgentStateBehavior, AgentStateProfiles, FaceEngine, Modulation, makePersonTarget, gazeIntentEquals, missingModifiers,
  type OneShotKind,
} from '../../src/engine';
import type { V2 } from '../../src/core/vec';
import { ExpressionMix } from '../../src/model';
import { ASTOneShotProbe, ASTRecorder, ASTRig } from './ASTRig';

describe('AgentState', () => {
  test('everyStateHasAProfile', () => {
    for (const st of AgentState.allCases) {
      expect(AgentStateProfiles.table.get(st), `missing profile for ${st}`).toBeDefined();
    }
  });

  test('profilesAreDistinct', () => {
    const all = AgentState.allCases;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = AgentStateProfiles.profile(all[i]), b = AgentStateProfiles.profile(all[j]);
        expect(!a.mix.equals(b.mix) || !gazeIntentEquals(a.gaze, b.gaze) || a.headTilt !== b.headTilt,
          `${all[i]} and ${all[j]} look the same`).toBe(true);
      }
    }
  });

  test.each(AgentState.allCases)('enteringSetsTargets(%s)', (st) => {
    const asb = new AgentStateBehavior();
    const rig = new ASTRig([asb, new ASTRecorder()]);
    rig.tick();
    rig.setAgentState(st);
    rig.tick();
    const p = AgentStateProfiles.profile(st);
    expect(rig.state.targetMix.equals(p.mix)).toBe(true);
    expect(gazeIntentEquals(rig.state.gazeIntent, p.gaze)).toBe(true);
    expect(Modulation.equals(rig.state.stateModulation, p.modulation)).toBe(true);
    expect(rig.state.breathingDepth).toBe(p.breathingDepth);
    expect(rig.state.targetBrightness).toBe(p.targetBrightness);
    // Every mix resolves against the bundled library (no unknown names).
    for (const e of p.mix.entries) expect(rig.state.library.get(e.name), `${e.name} not in library`).toBeDefined();
  });

  test('keyProfileValues', () => {
    const drowsy = AgentStateProfiles.profile('drowsy');
    expect(drowsy.mix.equals(ExpressionMix.single('Tiredness', 0.6))).toBe(true);
    expect(drowsy.modulation.lidHeaviness).toBe(0.35);
    expect(drowsy.modulation.speed).toBe(0.6);
    expect(Math.abs(drowsy.targetBrightness - 0.6)).toBeLessThan(0.05);

    const asleep = AgentStateProfiles.profile('asleep');
    expect(asleep.mix.equals(ExpressionMix.single('Asleep'))).toBe(true);
    expect(asleep.modulation.blinkRate).toBe(0);
    expect(asleep.breathingDepth).toBe(2.5);
    expect(asleep.targetBrightness).toBe(0.12);
    if (asleep.gaze.kind === 'rest') {
      expect(asleep.gaze.at.y > 0 && Math.abs(asleep.gaze.at.x) < 0.1).toBe(true);
    } else expect.fail('asleep gaze');

    expect(AgentStateProfiles.profile('idle').targetBrightness).toBe(0.85);
    expect(AgentStateProfiles.profile('listening').headTilt).toBe(4);
    expect(AgentStateProfiles.profile('listening').modulation.blinkRate).toBe(0.7);
    expect(AgentStateProfiles.profile('notForMe').gaze.kind).toBe('lookAway');
    expect(AgentStateProfiles.profile('thinking').gaze.kind).toBe('thinking');
    const sg = AgentStateProfiles.profile('sheepish').gaze;
    if (sg.kind === 'rest') expect(sg.at.y).toBeGreaterThan(0.3); else expect.fail('sheepish gaze');
    const sheepish = AgentStateProfiles.profile('sheepish').mix;
    expect(sheepish.entries.some((e) => e.name === 'Embarrassment' && e.weight === 0.6)).toBe(true);
    expect(sheepish.entries.some((e) => e.name === 'Guilt' && e.weight === 0.4)).toBe(true);
  });

  test('entryOneShotsAreRequested', () => {
    const expected: [AgentState, OneShotKind][] = [
      ['engaged', 'perkUp'], ['interrupted', 'sorryBlink'], ['notForMe', 'lookAway'],
      ['confused', 'confusedShake'], ['waking', 'wake'], ['hasMessage', 'perkUp'],
    ];
    for (const [st, kind] of expected) {
      const rec = new ASTRecorder();
      const rig = new ASTRig([new AgentStateBehavior(), rec]);
      rig.tick();
      expect(rec.requests, 'startup idle requests nothing').toEqual([]);
      rig.setAgentState(st);
      rig.tick();
      expect(rec.requests.map((r) => r.kind), st).toEqual([kind]);
    }
    expect(AgentStateProfiles.profile('notForMe').entryOneShotsStateScoped).toBe(true);
    expect(AgentStateProfiles.profile('interrupted').entryOneShotsStateScoped).toBe(false);
  });

  test('detectsDirectStateWritesWithoutChangedFlag', () => {
    const rec = new ASTRecorder();
    const rig = new ASTRig([new AgentStateBehavior(), rec]);
    rig.tick();
    rig.state.agentState = 'confused'; // no agentStateChanged
    rig.tick();
    expect(rig.state.targetMix.equals(ExpressionMix.single('Confusion'))).toBe(true);
    expect(rec.requests.map((r) => r.kind)).toEqual(['confusedShake']);
  });

  test('interruptedReturnsToListeningOnSorryBlinkCompletion', () => {
    const probe = new ASTOneShotProbe();
    const rig = new ASTRig([probe, new AgentStateBehavior(), new ASTRecorder()]);
    rig.tick();
    rig.setAgentState('interrupted');
    rig.run(3);
    expect(rig.state.agentState, 'no timer-based hand-off').toBe('interrupted');
    probe.completeNext = ['sorryBlink'];
    rig.tick();
    expect(rig.state.agentState).toBe('listening');
    expect(rig.state.previousAgentState).toBe('interrupted');
    expect(rig.state.agentStateEnteredAt).toBe(rig.state.time);
    expect(rig.state.targetMix.equals(AgentStateProfiles.profile('listening').mix)).toBe(true);
  });

  test('otherCompletionsDoNotTrigger', () => {
    const probe = new ASTOneShotProbe();
    const rig = new ASTRig([probe, new AgentStateBehavior()]);
    rig.tick();
    rig.setAgentState('interrupted');
    rig.tick();
    probe.completeNext = ['perkUp', 'laugh'];
    rig.run(1);
    expect(rig.state.agentState).toBe('interrupted');
  });

  test('notForMeReturnsToIdleAboutASecondAfterLookAway', () => {
    const probe = new ASTOneShotProbe();
    const rig = new ASTRig([probe, new AgentStateBehavior()]);
    rig.tick();
    rig.setAgentState('notForMe');
    rig.run(2);
    expect(rig.state.agentState).toBe('notForMe');
    probe.completeNext = ['lookAway'];
    rig.tick();
    const doneAt = rig.state.time;
    rig.run(0.9);
    expect(rig.state.agentState).toBe('notForMe');
    rig.run(0.15);
    expect(rig.state.agentState).toBe('idle');
    expect(rig.state.agentStateEnteredAt - doneAt).toBeGreaterThanOrEqual(0.99);
  });

  test('wakingHandsOffToNoticingAndOpensUp', () => {
    const probe = new ASTOneShotProbe();
    const rig = new ASTRig([probe, new AgentStateBehavior()]);
    rig.tick();
    rig.setAgentState('asleep');
    rig.tick();
    rig.setAgentState('waking');
    rig.tick();
    expect(rig.state.targetMix.equals(ExpressionMix.single('Tiredness'))).toBe(true);
    rig.run(1.1);
    expect(rig.state.targetMix.entries[0]?.name, 'stage 2: Tiredness → Neutral').toBe('Neutral');
    expect(rig.state.gazeIntent.kind).toBe('track');
    expect(rig.state.agentState).toBe('waking');
    probe.completeNext = ['wake'];
    rig.tick();
    expect(rig.state.agentState).toBe('noticing');
  });

  test('completionDetectedWhenActiveOneShotDisappears', () => {
    const probe = new ASTOneShotProbe();
    const rig = new ASTRig([probe, new AgentStateBehavior()]);
    rig.tick();
    rig.setAgentState('interrupted');
    probe.active = ['sorryBlink'];
    rig.run(0.4);
    expect(rig.state.agentState).toBe('interrupted');
    probe.active = [];
    rig.tick();
    expect(rig.state.agentState).toBe('listening');
  });

  test('autoTransitionsCanBeDisabled', () => {
    const probe = new ASTOneShotProbe();
    const asb = new AgentStateBehavior();
    asb.autoTransitionsEnabled = false;
    const rig = new ASTRig([probe, asb]);
    rig.tick();
    rig.setAgentState('interrupted');
    rig.tick();
    probe.completeNext = ['sorryBlink'];
    rig.run(12);
    expect(rig.state.agentState).toBe('interrupted');
  });

  test('fallbackHandsOffOnlyAfterTimeout', () => {
    const rig = new ASTRig([new AgentStateBehavior()]);
    rig.tick();
    rig.setAgentState('interrupted');
    rig.run(7.9);
    expect(rig.state.agentState).toBe('interrupted');
    rig.run(0.2);
    expect(rig.state.agentState).toBe('listening');
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8])('drowsySchedulesNodOffs(seed: %i)', (seed) => {
    const rec = new ASTRecorder();
    const rig = new ASTRig([new AgentStateBehavior(), rec], seed);
    rig.tick();
    rig.setAgentState('drowsy');
    rig.tick();
    const entered = rig.state.time;
    rig.run(400, 1 / 30);
    const beats = rec.requests;
    expect(beats.length).toBeGreaterThanOrEqual(8);
    const first = beats[0];
    if (!first) return;
    expect(first.kind).toBe('nodOff');
    expect(first.time - entered >= 15 - 0.05 && first.time - entered <= 40 + 0.05).toBe(true);
    for (let k = 1; k < beats.length; k++) {
      const a = beats[k - 1], b = beats[k];
      expect(b.time - a.time >= 15 - 0.05 && b.time - a.time <= 40 + 0.05).toBe(true);
      expect(a.kind === 'yawn' && b.kind === 'yawn', 'no back-to-back yawns').toBe(false);
    }
    expect(beats.every((b) => b.kind === 'nodOff' || b.kind === 'yawn')).toBe(true);
  });

  test('drowsyYawnsOccasionally', () => {
    let yawns = 0, nods = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const rec = new ASTRecorder();
      const rig = new ASTRig([new AgentStateBehavior(), rec], seed);
      rig.setAgentState('drowsy');
      rig.run(600, 1 / 20);
      yawns += rec.requests.filter((r) => r.kind === 'yawn').length;
      nods += rec.requests.filter((r) => r.kind === 'nodOff').length;
    }
    expect(yawns > 0 && nods > yawns).toBe(true);
  });

  test('speakingGlancesOnlyWithAGroup', () => {
    // One person: no glances.
    {
      const rec = new ASTRecorder();
      const rig = new ASTRig([new AgentStateBehavior(), rec]);
      rig.state.people = [makePersonTarget(1, { x: 0.1, y: 0 })];
      rig.state.primaryPersonID = 1;
      rig.setAgentState('speaking');
      rig.run(60);
      expect(rec.commands).toEqual([]);
    }
    // Three people: glances at the others, never the primary.
    {
      const rec = new ASTRecorder();
      const rig = new ASTRig([new AgentStateBehavior(), rec]);
      const others: V2[] = [{ x: -0.6, y: 0.1 }, { x: 0.7, y: -0.1 }];
      rig.state.people = [makePersonTarget(1, { x: 0.1, y: 0 }),
        makePersonTarget(2, others[0]),
        makePersonTarget(3, others[1])];
      rig.state.primaryPersonID = 1;
      rig.setAgentState('speaking');
      rig.run(60);
      expect(rec.commands.length).toBeGreaterThanOrEqual(5);
      const times: number[] = [];
      for (const { time: t, command: c } of rec.commands) {
        if (c.kind !== 'glance') { expect.fail(`unexpected ${JSON.stringify(c)}`); continue; }
        expect(others.some((o) => o.x === c.at.x && o.y === c.at.y)).toBe(true);
        expect(c.duration >= 0.45 && c.duration <= 0.9).toBe(true);
        times.push(t);
      }
      for (let k = 1; k < times.length; k++) expect(times[k] - times[k - 1]).toBeGreaterThanOrEqual(2.5 - 0.02);
      // Leaving speaking stops glances.
      const n = rec.commands.length;
      rig.setAgentState('listening');
      rig.run(30);
      expect(rec.commands.length).toBe(n);
    }
  });

  test('hasMessagePerksUpPeriodicallyWithCooldown', () => {
    const rec = new ASTRecorder();
    const rig = new ASTRig([new AgentStateBehavior(), rec]);
    rig.setAgentState('hasMessage');
    rig.run(90);
    const perks = rec.requests.filter((r) => r.kind === 'perkUp');
    expect(perks.length).toBeGreaterThanOrEqual(6);
    for (let k = 1; k < perks.length; k++) expect(perks[k].time - perks[k - 1].time).toBeGreaterThanOrEqual(3.5 - 0.02);
  });

  test('listeningTiltsTheHead', () => {
    const rig = new ASTRig([new AgentStateBehavior()]);
    rig.setAgentState('listening');
    rig.run(2);
    expect(Math.abs(rig.state.delta.face('angle') - 4)).toBeLessThan(0.05);
    rig.setAgentState('idle');
    rig.tick();
    expect(rig.state.delta.face('angle'), 'tilt eases back, never snaps').toBeGreaterThan(3.5);
    rig.run(3);
    expect(Math.abs(rig.state.delta.face('angle'))).toBeLessThan(0.05);
  });

  test('speakingPulsesWithSpeech', () => {
    const rig = new ASTRig([new AgentStateBehavior()]);
    rig.setAgentState('speaking');
    rig.state.speechEnvelope = 1;
    rig.run(1);
    expect(Math.abs(rig.state.faceScaleMul.y - 1.03)).toBeLessThan(1e-3);
    rig.state.speechEnvelope = 0;
    rig.tick();
    expect(Math.abs(rig.state.faceScaleMul.y - 1)).toBeLessThan(1e-6);
    rig.setAgentState('idle');
    rig.state.speechEnvelope = 1;
    rig.run(2);
    expect(Math.abs(rig.state.faceScaleMul.y - 1)).toBeLessThan(1e-3);
  });

  // needs WP6 (full default stack: IdleBeats, EdgeAntics, IdleGames, PupilReactions)
  test.skipIf(missingModifiers().length > 0)('fullStackSmokeThroughEveryState', () => {
    const engine = new FaceEngine({ seed: 9 });
    engine.setPeople([makePersonTarget(1, { x: 0, y: 0 }), makePersonTarget(2, { x: 0.5, y: 0 })], 1);
    for (const st of AgentState.allCases) {
      engine.setAgentState(st);
      for (let i = 0; i < 90; i++) {
        const f = engine.tick(1 / 60);
        expect(f.pose.hasNonFinite).toBe(false);
      }
    }
  });
});
