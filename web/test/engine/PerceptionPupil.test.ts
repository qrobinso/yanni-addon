// Port of Tests/FaceEngineTests/PerceptionPupilTests.swift.
// The arbiter's perception exceptions (perception upgrade §7) and the engine's perception read-outs.
import { describe, expect, test } from 'vitest';
import { FaceFrame, PupilShape } from '../../src/model';
import {
  FaceCommand, FaceEngine, OneShotSampler, PupilReactions, type AgentState, type ReactionCue, type ReactionCueKind,
} from '../../src/engine';
import { ShapeRig, cue, hasDefaultPupils, rig as makeRig, send } from './ShapeRig';

const perception = (kind: ReactionCueKind = 'delight', directed = true): ReactionCue =>
  cue(kind, { directed, source: 'perception' });

const interrupted = (rig: ShapeRig): boolean => rig.arbiter.events.some((e) => e.what.kind === 'interrupted');

describe('PerceptionPupilTests', () => {
  // MARK: Listening before speech

  test('directedPerceptionCuePlaysEarlyInListening', () => {
    const rig = makeRig('listening');   // 0.25 s into listening
    expect(send(rig, perception())).toBe('accepted');
    rig.run(0.6);
    expect(FaceFrame.shape(rig.frame, 'left') === PupilShape.star || FaceFrame.shape(rig.frame, 'right') === PupilShape.star).toBe(true);
  });

  test('undirectedPerceptionCueStillNotInListening', () => {
    const rig = makeRig('listening');
    expect(send(rig, perception('delight', false))).toBe('notAboutYanni');
  });

  test('perceptionCueAfterTheWindowIsNotAboutYanni', () => {
    const rig = makeRig('listening');
    rig.run(PupilReactions.perceptionListeningWindow);
    expect(send(rig, perception())).toBe('notAboutYanni');
    expect(send(rig, cue('delight')), 'conversation cues unchanged').toBe('accepted');
  });

  test('debugCueStillNotInListening', () => {
    const rig = makeRig('listening');
    expect(send(rig, cue('delight', { source: 'debug' }))).toBe('notAboutYanni');
  });

  // MARK: Gesture engagement hold

  test.each(['engaged', 'listening'] as AgentState[])('directedPerceptionShapeFinishesThroughEngagement(%s)', (to) => {
    const rig = makeRig('idle');
    expect(send(rig, perception('affection'))).toBe('accepted');
    rig.run(0.5);
    rig.engine.setAgentState(to);
    rig.run(0.25);
    expect(FaceFrame.shape(rig.frame, 'left'), `still showing after ${to} started`).toBe(PupilShape.heart);
    expect(interrupted(rig)).toBe(false);
    if (to === 'engaged') {
      rig.engine.setAgentState('listening');
      rig.run(0.1);
      expect(interrupted(rig)).toBe(false);
    }
    rig.run(2.5);
    expect(hasDefaultPupils(rig.frame), 'ends on its own').toBe(true);
  });

  test('conversationShapeIsStillCutByEngagement', () => {
    const rig = makeRig('idle');
    expect(send(rig, cue('affection'))).toBe('accepted');
    rig.run(0.5);
    rig.engine.setAgentState('engaged');
    rig.run(0.25);
    expect(hasDefaultPupils(rig.frame)).toBe(true);
    expect(interrupted(rig)).toBe(true);
  });

  test('blockedStateStillInterruptsAHeldShape', () => {
    const rig = makeRig('idle');
    expect(send(rig, perception('affection'))).toBe('accepted');
    rig.run(0.5);
    rig.engine.setAgentState('notForMe');
    rig.run(0.25);
    expect(hasDefaultPupils(rig.frame)).toBe(true);
    expect(interrupted(rig)).toBe(true);
  });

  test('urgentOneShotStillInterruptsAHeldShape', () => {
    const rig = makeRig('idle');
    expect(send(rig, perception('affection'))).toBe('accepted');
    rig.run(0.5);
    rig.engine.send(FaceCommand.playOneShot('bigSurprise'));
    rig.run(0.3);
    expect(interrupted(rig)).toBe(true);
  });

  // MARK: Read-outs

  test('perceptionReadOuts', () => {
    const rig = makeRig('idle');
    const e = rig.engine;
    expect(!e.oneShotBusyForPerception && !e.pupilShapeShowing).toBe(true);
    const before = e.pupilReactionEvents;
    expect(send(rig, cue('delight'))).toBe('accepted');
    const after = e.pupilReactionEvents;
    expect(after.serial === before.serial + 1 && after.events.at(-1)?.serial === after.serial).toBe(true);
    rig.run(0.3);
    expect(e.pupilShapeShowing && !e.oneShotBusyForPerception, 'a shape is not busy').toBe(true);
    rig.run(3);
    e.send(FaceCommand.playOneShot('delightedSquint'));
    rig.tick();
    expect(e.oneShotBusyForPerception, 'idle beats are not busy').toBe(false);
    rig.run(3);
    e.send(FaceCommand.playOneShot('laugh'));
    rig.tick();
    expect(e.oneShotBusyForPerception).toBe(true);
    const bare = new FaceEngine({ modifiers: [new OneShotSampler()] });
    expect(bare.pupilReactionEvents.serial === 0 && bare.pupilReactionEvents.events.length === 0).toBe(true);
  });
});
