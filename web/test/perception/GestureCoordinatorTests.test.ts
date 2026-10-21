// Port of Tests/FacePerceptionTests/GestureCoordinatorTests.swift: the coordinator's side of the gesture reactions
// (fallbacks, edge antics, the high-five, the dance along, and the engagement hold's verdict).
import { describe, expect, test } from 'vitest';
import { OneShotLibrary } from '../../src/engine';
import {
  GestureKind, PerceptionCoordinator, PerceptionReflexes, makeGestureObservation, makePerceptionSnapshot,
  makeTrackedPerson, reflexImpulseEquals, type GesturePhase, type PerceptionEvent, type ReflexImpulse,
} from '../../src/perception';
import { FakeFace, FakeLife } from './TestSupport';

const last = <T>(a: T[]): T | undefined => a[a.length - 1];

describe('GestureCoordinatorTests', () => {
  class Clock { now = 100; }

  function rig(): [PerceptionCoordinator, FakeFace, FakeLife, Clock] {
    const face = new FakeFace(), life = new FakeLife(), clock = new Clock();
    const c = new PerceptionCoordinator(face, life, undefined, () => clock.now);
    c.source = 'camera';
    c.mailbox.drain();
    return [c, face, life, clock];
  }

  function feed(c: PerceptionCoordinator, clock: Clock, t: number, engaged: number | null = null, events: PerceptionEvent[] = []): void {
    clock.now = t + 0.02;
    const p = makeTrackedPerson(1, { position: { x: 0.1, y: 0 }, distance: 1.2, facing: 1, salience: 0.5 });
    c.ingest({ snapshot: makePerceptionSnapshot({ time: t, people: [p], primaryID: 1, engagedID: engaged }), events }, 'camera');
  }

  const gesture = (k: GestureKind, t: number, phase: GesturePhase = 'instant', distance = 1.2): PerceptionEvent => ({
    kind: 'gesture', gesture: makeGestureObservation({ kind: k, personID: 1, hand: 'right', confidence: 0.9, directedAtYanni: true,
      at: { x: 0.1, y: 0 }, distance, time: t, phase }),
  });

  test('cueTurnedDownForRarityPlaysTheFallback', () => {
    const [c, face, , clock] = rig();
    feed(c, clock, 100, null, [gesture(GestureKind.heartHands, 100)]);
    expect(face.cues[0]?.kind === 'affection' && face.cues[0]?.key === 'affection:person-1').toBe(true);
    expect(face.cues[0].id).not.toBe(0);
    face.arbiterSays('habituated');
    feed(c, clock, 100.1);
    expect(face.allOneShots).toEqual(['delightedSquint']);
    expect(last(c.reactions)?.outcome).toBe('heartHands → delightedSquint (cue habituated)');
    // Turned down because of the moment: nothing instead.
    const [c2, face2, , clock2] = rig();
    feed(c2, clock2, 100, null, [gesture(GestureKind.armsUp, 100)]);
    face2.arbiterSays('bedtime');
    feed(c2, clock2, 100.1);
    expect(face2.allOneShots).toHaveLength(0);
  });

  test('edgeAnticRefusedByTheEnginePlaysTheFallback', () => {
    const [c, face, , clock] = rig();
    face.agentState = 'idle';
    face.anticsAllowed = false;
    feed(c, clock, 100, null, [gesture(GestureKind.byeWave(1), 100, 'instant', 2.5)]);
    expect(face.antics).toHaveLength(0);
    expect(face.allOneShots).toEqual(['delightedSquint']);
    const [c2, face2, , clock2] = rig();
    face2.agentState = 'idle';
    feed(c2, clock2, 100, null, [gesture(GestureKind.byeWave(-1), 100, 'instant', 2.5)]);
    expect(face2.antics[0]).toEqual(['pretendExit', -1]);
  });

  test('highFiveTouchWindowAndConfirmation', () => {
    const [c, face, life, clock] = rig();
    const impulses: ReflexImpulse[] = [];
    c.onImpulse = (i) => { impulses.push(i); };
    feed(c, clock, 100, null, [gesture(GestureKind.highFive, 100, 'started', 0.9)]);
    expect(face.friendlyTouchUntil).toEqual([100.8]);
    expect(impulses, 'an approaching palm alone is nothing').toHaveLength(0);
    face.highFives = 1;
    feed(c, clock, 100.4);
    expect(impulses.length === 1 && reflexImpulseEquals(impulses[0], PerceptionReflexes.highFiveImpulse)).toBe(true);
    expect(life.activity).toEqual(['motion']);
    expect(last(c.reactions)?.event).toBe('gesture.highFive');
  });

  test('dancingNotesThenOneDanceAlong', () => {
    const [c, face, , clock] = rig();
    feed(c, clock, 100, null, [gesture(GestureKind.dancing, 100, 'started', 2)]);
    expect(face.cues[0]?.kind).toBe('music');
    face.arbiterSays('accepted');
    feed(c, clock, 101);
    expect(face.allOneShots).toHaveLength(0);
    feed(c, clock, 102.5);
    expect(face.allOneShots).toEqual(['dance']);
    // A turned-down note cue plays the dance at once, and no second one.
    const [c2, face2, , clock2] = rig();
    feed(c2, clock2, 100, null, [gesture(GestureKind.dancing, 100, 'started', 2)]);
    face2.arbiterSays('globalCooldown');
    feed(c2, clock2, 100.1);
    feed(c2, clock2, 103);
    expect(face2.allOneShots).toEqual(['dance']);
  });

  test('softNodMirrorAndHabituatedIntensity', () => {
    const [c, face, , clock] = rig();
    face.agentState = 'followUp';
    feed(c, clock, 100, 1, [gesture(GestureKind.nod, 100)]);
    expect(face.requests[0]?.kind === 'nodYes' && face.requests[0]?.softVoice === true).toBe(true);
  });

  test('directedGestureInRangeReportsTheBeatForTheEngagementHold', () => {
    const [c, , , clock] = rig();
    feed(c, clock, 100, null, [gesture(GestureKind.clap, 100)]);
    const cmds = c.mailbox.drain();
    const expected = 100 + OneShotLibrary.spec('laugh').duration;
    expect(cmds.some((x) => x.kind === 'gestureBeat' && x.id === 1 && x.until !== null && Math.abs(x.until - expected) < 1e-6)).toBe(true);
    // No beat (budget): the hold ends now.
    feed(c, clock, 101, null, [gesture(GestureKind.peace, 101)]);
    expect(c.mailbox.drain().some((x) => x.kind === 'gestureBeat' && x.id === 1 && x.until === null)).toBe(true);
    // Out of engagement range: nothing to hold.
    feed(c, clock, 120, null, [gesture(GestureKind.thumbsDown, 120, 'instant', 2.5)]);
    expect(c.mailbox.drain()).toHaveLength(0);
  });
});
