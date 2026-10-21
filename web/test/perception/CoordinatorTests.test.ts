// Port of Tests/FacePerceptionTests/CoordinatorTests.swift (ReflexTests + CoordinatorTests).
import { describe, expect, test } from 'vitest';
import type { V2 } from '../../src/core/vec';
import { Attention } from '../../src/engine/modifiers/Attention';
import type { AgentState } from '../../src/engine';
import {
  GestureKind, PerceptionCommand, PerceptionCoordinator, PerceptionReflexes, ReflexBeat, makeGestureObservation,
  makePerceptionSnapshot, makeReflexContext, makeTrackedPerson, reflexImpulseEquals,
  type GestureObservation, type GesturePhase, type PerceptionEvent, type PerceptionSnapshot, type ReflexContext,
  type ReflexImpulse, type TrackedPerson,
} from '../../src/perception';
import { FakeFace, FakeLife, approx } from './TestSupport';

const last = <T>(a: T[]): T | undefined => a[a.length - 1];

describe('ReflexTests', () => {
  function g(kind: GestureKind, o: { person?: number | null; conf?: number; directed?: boolean; distance?: number; at?: V2;
    time?: number; phase?: GesturePhase } = {}): GestureObservation {
    return makeGestureObservation({
      kind, personID: o.person === undefined ? 1 : o.person, hand: 'right', confidence: o.conf ?? 0.9,
      directedAtYanni: o.directed ?? true, at: o.at ?? { x: 0.2, y: 0 }, distance: o.distance ?? 1.5, time: o.time ?? 100,
      phase: o.phase ?? 'instant',
    });
  }
  function ctx(s: AgentState = 'noticing', o: { now?: number; primary?: number | null; bedtime?: boolean; sulking?: boolean;
    arrived?: number | null; alone?: number; busy?: boolean; shape?: boolean; engaged?: number | null } = {}): ReflexContext {
    return makeReflexContext({
      agentState: s, isBedtime: o.bedtime ?? false, isSulking: o.sulking ?? false,
      primaryID: o.primary === undefined ? 1 : o.primary, now: o.now ?? 100, arrivedAt: o.arrived ?? null,
      aloneBeforeArrival: o.alone ?? 0, oneShotBusy: o.busy ?? false, pupilShapeShowing: o.shape ?? false,
      engagedID: o.engaged ?? null,
    });
  }

  test('gatedByState', () => {
    for (const s of ['drowsy', 'asleep', 'halfAwake', 'waking', 'thinking'] as AgentState[]) {
      const r = new PerceptionReflexes();
      expect(r.decide(g(GestureKind.wave), ctx(s)).beat.kind, s).toBe('none');
      expect(r.decide(g(GestureKind.thumbsUp), ctx(s)).beat.kind, s).toBe('none');
    }
    const r = new PerceptionReflexes();
    expect(r.decide(g(GestureKind.wave), ctx('noticing', { bedtime: true })).beat.kind).toBe('none');
    expect(r.decide(g(GestureKind.wave), ctx('noticing', { sulking: true })).beat.kind).toBe('none');
    // Listening: one-shot beats are events only; a directed cue still goes to the arbiter (before speech, §7).
    const q = new PerceptionReflexes();
    expect(q.decide(g(GestureKind.wave), ctx('listening')).beat.kind).toBe('none');
    expect(q.decide(g(GestureKind.openPalm), ctx('listening')).beat.kind).toBe('none');
    expect(q.decide(g(GestureKind.thumbsUp), ctx('listening')).beat.kind, 'thumbs up cue in listening').toBe('cue');
    // Speaking: events only.
    const sp = new PerceptionReflexes();
    expect(sp.decide(g(GestureKind.thumbsUp), ctx('speaking')).beat.kind).toBe('none');
    expect(sp.decide(g(GestureKind.heartHands), ctx('speaking')).beat.kind).toBe('none');
  });

  test('waveDanceCooldownsAndPerkUp', () => {
    const r = new PerceptionReflexes();
    const first = r.decide(g(GestureKind.wave), ctx('idle', { now: 100 }));
    expect(first.beat).toEqual(ReflexBeat.oneShot('dance'));
    expect(first.glanceAt, 'already primary: no glance').toBeNull();
    expect(reflexImpulseEquals(first.impulse, PerceptionReflexes.waveImpulse)).toBe(true);
    expect(r.decide(g(GestureKind.wave), ctx('noticing', { now: 110 })).beat.kind, 'person cooldown 30 s').toBe('none');
    const other = r.decide(g(GestureKind.wave, { person: 2 }), ctx('noticing', { now: 110 }));
    expect(other.beat.kind, 'global cooldown 15 s').toBe('none');
    const later = r.decide(g(GestureKind.wave, { person: 2, at: { x: -0.5, y: 0 } }), ctx('noticing', { now: 120 }));
    expect(later.beat, 'dance still cooling down (45 s)').toEqual(ReflexBeat.oneShot('perkUp'));
    expect(later.glanceAt, "a glance at the waver who isn't primary").toEqual({ x: -0.5, y: 0 });
    const again = r.decide(g(GestureKind.wave), ctx('noticing', { now: 150 }));
    expect(again.beat).toEqual(ReflexBeat.oneShot('dance'));
    expect(again.intensity, "the same person's second wave within 3 min plays at 60 %").toBe(0.6);
    expect(approx(again.impulse?.strength ?? 0, 0.36, 1e-5), 'the impulse fades with it').toBe(true);
  });

  test('waveRequirements', () => {
    const r = new PerceptionReflexes();
    expect(r.decide(g(GestureKind.wave, { directed: false }), ctx()).beat.kind).toBe('none');
    expect(r.decide(g(GestureKind.wave, { distance: 3.8 }), ctx()).beat.kind).toBe('none');
    expect(r.decide(g(GestureKind.wave, { conf: 0.6 }), ctx()).beat.kind).toBe('none');
  });

  test('firstConfidentWaveAfterLongAloneIsADelightCue', () => {
    const r = new PerceptionReflexes();
    const fx = r.decide(g(GestureKind.wave, { conf: 0.95 }), ctx('noticing', { now: 100, arrived: 92, alone: 120 }));
    if (fx.beat.kind !== 'cue') throw new Error('expected a cue');
    const c = fx.beat.cue;
    expect(c.kind).toBe('delight');
    expect(c.source === 'perception' && c.directedAtYanni && c.valence === 0.4 && c.key === 'delight:person-1' && c.hostTime === 100).toBe(true);
    expect(fx.fallback).toBe('perkUp');
    // Only once per arrival, and not after a short absence.
    const q = new PerceptionReflexes();
    expect(q.decide(g(GestureKind.wave, { conf: 0.95 }), ctx('noticing', { now: 100, arrived: 92, alone: 20 })).beat)
      .toEqual(ReflexBeat.oneShot('dance'));
  });

  test('thumbsUpSendsASuccessCue', () => {
    const r = new PerceptionReflexes();
    const fx = r.decide(g(GestureKind.thumbsUp, { conf: 0.85, time: 99.9 }), ctx());
    if (fx.beat.kind !== 'cue') throw new Error('expected a cue');
    const c = fx.beat.cue;
    expect(c.kind === 'success' && c.confidence === 0.85 && c.key === 'success:person-1' && c.hostTime === 99.9).toBe(true);
    expect(fx.fallback).toBe('perkUp');
    expect(r.decide(g(GestureKind.thumbsUp, { conf: 0.7 }), ctx('noticing', { now: 200 })).beat.kind).toBe('none');
    expect(r.decide(g(GestureKind.thumbsUp, { directed: false }), ctx('noticing', { now: 300 })).beat.kind).toBe('none');
  });

  test('openPalmAndPoint', () => {
    const r = new PerceptionReflexes();
    expect(r.decide(g(GestureKind.openPalm), ctx('idle')).beat).toEqual(ReflexBeat.oneShot('perkUp'));
    expect(r.decide(g(GestureKind.openPalm), ctx('idle', { now: 110 })).beat.kind, '20 s cooldown').toBe('none');
    expect(r.decide(g(GestureKind.openPalm), ctx('engaged', { now: 200 })).beat.kind, 'a hi only in idle / noticing').toBe('none');
    expect(r.decide(g(GestureKind.point({ x: -1, y: 0 }), { directed: false }), ctx()).stimulus, 'pointing must be aimed at Yanni').toBeNull();
    const p = r.decide(g(GestureKind.point({ x: -1, y: 0 }), { at: { x: 0.1, y: 0 } }), ctx('noticing', { now: 101 }));
    expect(p.stimulus?.at, 'Yanni looks where you point').toEqual({ x: -0.5, y: 0 });
    expect(p.stimulus?.strength).toBe(0.6);
    expect(r.decide(g(GestureKind.point({ x: -1, y: 0 })), ctx('noticing', { now: 105 })).stimulus, '8 s cooldown').toBeNull();
  });
});

describe('CoordinatorTests', () => {
  const snapshot = (t: number, people: TrackedPerson[], primary: number | null = null, engaged: number | null = null): PerceptionSnapshot =>
    makePerceptionSnapshot({ time: t, people, primaryID: primary, engagedID: engaged });
  const person = (id: number, x: number, o: { d?: number; facing?: number } = {}): TrackedPerson =>
    makeTrackedPerson(id, { position: { x, y: 0 }, distance: o.d ?? 1.2, facing: o.facing ?? 0.8, salience: 0.5 });

  class Clock { now = 100; }

  function rig(offset: V2 = { x: 0, y: 0 }): [PerceptionCoordinator, FakeFace, FakeLife, Clock] {
    const face = new FakeFace(), life = new FakeLife(), clock = new Clock();
    const c = new PerceptionCoordinator(face, life, undefined, () => clock.now);
    c.source = 'camera';
    c.setCameraOffset(offset);
    return [c, face, life, clock];
  }

  function feed(c: PerceptionCoordinator, clock: Clock, snap: PerceptionSnapshot, events: PerceptionEvent[] = []): void {
    clock.now = snap.time + 0.05;
    c.ingest({ snapshot: snap, events }, 'camera');
  }
  const wave = (t: number): GestureObservation => makeGestureObservation({ kind: GestureKind.wave, personID: 1, hand: 'right',
    confidence: 0.9, directedAtYanni: true, at: { x: 0, y: 0 }, distance: 1.2, time: t });

  test('peopleGoToTheEngineWithFacing', () => {
    const [c, face, , clock] = rig();
    feed(c, clock, snapshot(100, [person(1, 0.2, { facing: 0.3 })], 1, null));
    const call = last(face.peopleCalls)!;
    expect(call.people[0]?.facing).toBe(0.3);
    expect(call.primary === 1 && call.engaged === null).toBe(true);
  });

  test('otherSourcesAndStaleSnapshotsAreIgnored', () => {
    const [c, face, , clock] = rig();
    c.ingest({ snapshot: snapshot(100, [person(1, 0)]), events: [] }, 'replay');
    expect(face.peopleCalls).toHaveLength(0);
    clock.now = 101;
    c.ingest({ snapshot: snapshot(100, [person(1, 0)]), events: [] }, 'camera');
    expect(face.peopleCalls, 'older than 250 ms').toHaveLength(0);
    expect(c.staleDropped).toBe(1);
    // Switching to simulated hands the engine back to the gaze pad.
    c.source = 'simulated';
    c.ingest({ snapshot: snapshot(101, [person(1, 0)]), events: [] }, 'simulated');
    expect(last(face.peopleCalls)?.people.length ?? 0).toBe(0);
  });

  test('newcomerGlanceWithGapAndStateRules', () => {
    const [c, face, , clock] = rig();
    const a = person(1, -0.3), b = person(2, 0.5), d = person(3, 0.7);
    feed(c, clock, snapshot(100, [a], 1), [{ kind: 'personEntered', id: 1, at: a.position, distance: 1.2 }]);
    expect(face.glances, 'the first person is just followed').toHaveLength(0);
    feed(c, clock, snapshot(101, [a, b], 1), [{ kind: 'personEntered', id: 2, at: b.position, distance: 1.2 }]);
    expect(face.glances).toHaveLength(1);
    expect(face.glances[0][1]).toBe(0.5);
    feed(c, clock, snapshot(102, [a, b, d], 1), [{ kind: 'personEntered', id: 3, at: d.position, distance: 1.2 }]);
    expect(face.glances, '≥ 4 s between newcomer glances').toHaveLength(1);
    face.agentState = 'thinking';
    feed(c, clock, snapshot(110, [a, b, d, person(4, 0)], 1), [{ kind: 'personEntered', id: 4, at: { x: 0, y: 0 }, distance: 1.2 }]);
    expect(face.glances, 'never while thinking').toHaveLength(1);
    face.agentState = 'listening';
    feed(c, clock, snapshot(120, [a, person(5, 0, { d: 3 })], 1), [{ kind: 'personEntered', id: 5, at: { x: 0, y: 0 }, distance: 3 }]);
    expect(face.glances, 'listening: only newcomers within 2 m').toHaveLength(1);
  });

  test('youreNextGlanceOncePer10sNeverWhileSpeaking', () => {
    const [c, face, , clock] = rig();
    const a = person(1, -0.3), b = person(2, 0.5);
    feed(c, clock, snapshot(100, [a, b], 1, 1), [{ kind: 'wantsTurn', id: 2 }]);
    expect(face.glances).toHaveLength(1);
    expect(face.glances[0][1]).toBe(0.6);
    feed(c, clock, snapshot(105, [a, b], 1, 1), [{ kind: 'wantsTurn', id: 2 }]);
    expect(face.glances).toHaveLength(1);
    face.agentState = 'speaking';
    feed(c, clock, snapshot(120, [a, b], 1, 1), [{ kind: 'wantsTurn', id: 2 }]);
    expect(face.glances).toHaveLength(1);
  });

  test('restGazeOnlyForThePrimaryLeavingAlone', () => {
    const [c, face, , clock] = rig();
    const a = person(1, 0.8), b = person(2, -0.2);
    feed(c, clock, snapshot(100, [a, b], 1));
    feed(c, clock, snapshot(101, [b], 2), [{ kind: 'personOutOfView', id: 1, lastPosition: a.position, distance: 1.2, exitEdge: 'right' }]);
    expect(face.rests, 'someone else is still here').toHaveLength(0);
    feed(c, clock, snapshot(102, [], null), [{ kind: 'personOutOfView', id: 2, lastPosition: b.position, distance: 1.2, exitEdge: null }]);
    expect(face.rests, 'faded in place: no exit edge').toHaveLength(0);
    const [c2, face2, , clock2] = rig();
    feed(c2, clock2, snapshot(100, [a], 1));
    feed(c2, clock2, snapshot(101, [], null), [{ kind: 'personOutOfView', id: 1, lastPosition: a.position, distance: 1.2, exitEdge: 'right' }]);
    const rest = face2.rests[0];
    expect(approx(rest.x, 0.95, 1e-4), `pushed 0.15 toward the edge (${JSON.stringify(rest)})`).toBe(true);
  });

  test('commandPointsAreCorrectedForTheCameraOffset', () => {
    const [c, face, , clock] = rig({ x: 0, y: -0.11 });
    expect(last(face.offsets)).toEqual({ x: 0, y: -0.11 });
    const a = person(1, 0), b = person(2, 0.4, { d: 1 });
    feed(c, clock, snapshot(100, [a], 1));
    feed(c, clock, snapshot(101, [a, b], 1), [{ kind: 'personEntered', id: 2, at: b.position, distance: 1 }]);
    const gl = face.glances[0];
    const corr = Attention.cameraCorrection({ x: 0, y: -0.11 }, 1);
    const expected = { x: 0.4 + corr.x, y: 0 + corr.y };
    expect(approx(gl[0].x, expected.x, 1e-5) && approx(gl[0].y, expected.y, 1e-5)).toBe(true);
    expect(gl[0].y).toBeLessThan(-0.2);
  });

  test('motionStimulusSpacingStateAndActivity', () => {
    const [c, face, life, clock] = rig();
    feed(c, clock, snapshot(100, []), [{ kind: 'motion', at: { x: 0.5, y: -0.3 }, strength: 0.6 }]);
    expect(face.stimuli).toHaveLength(1);
    expect(life.activity, 'strong motion is activity in the daytime').toEqual(['motion']);
    feed(c, clock, snapshot(101, []), [{ kind: 'motion', at: { x: 0.5, y: -0.3 }, strength: 0.3 }]);
    expect(face.stimuli, '≥ 3 s apart').toHaveLength(1);
    expect(life.activity, "weak motion isn't activity").toHaveLength(1);
    face.agentState = 'listening';
    feed(c, clock, snapshot(110, []), [{ kind: 'motion', at: { x: 0, y: 0 }, strength: 0.6 }]);
    expect(face.stimuli, 'never in a conversation state').toHaveLength(1);
    face.agentState = 'idle';
    life.isBedtime = true;
    feed(c, clock, snapshot(120, []), [{ kind: 'motion', at: { x: 0, y: 0 }, strength: 0.9 }]);
    expect(life.activity, 'bedtime: never activity').toHaveLength(2);
  });

  test('gestureReactionsGoThroughTheReflexTable', () => {
    const [c, face, life, clock] = rig();
    const impulses: [ReflexImpulse, string, number][] = [];
    c.onImpulse = (i, why) => { impulses.push([i, why, face.commands.length]); };
    const a = person(1, 0.1);
    const w = makeGestureObservation({ kind: GestureKind.wave, personID: 1, hand: 'right', confidence: 0.9, directedAtYanni: true,
      at: { x: 0.2, y: -0.1 }, distance: 1.2, time: 100 });
    feed(c, clock, snapshot(100, [a], 1), [{ kind: 'gesture', gesture: w }]);
    expect(face.oneShots).toEqual(['dance']);
    // The reflex's impulse goes to the emotion layer before the beat is sent.
    expect(impulses.length === 1 && reflexImpulseEquals(impulses[0][0], PerceptionReflexes.waveImpulse) && impulses[0][1] === 'wave → dance').toBe(true);
    expect(impulses[0][2]).toBeLessThan(face.commands.length);
    expect(life.activity).toEqual(['motion']);
    // One gesture beat per 8 s across everyone: a thumbs up a second later is an event only, with no impulse.
    const early = makeGestureObservation({ kind: GestureKind.thumbsUp, personID: 1, hand: 'right', confidence: 0.9,
      directedAtYanni: true, at: { x: 0, y: 0 }, distance: 1.2, time: 101 });
    feed(c, clock, snapshot(101, [a], 1), [{ kind: 'gesture', gesture: early }]);
    expect(face.cues.length === 0 && impulses.length === 1).toBe(true);
    expect(last(c.reactions)?.outcome.startsWith('thumbsUp: budget')).toBe(true);
    const thumbs = makeGestureObservation({ kind: GestureKind.thumbsUp, personID: 1, hand: 'right', confidence: 0.9,
      directedAtYanni: true, at: { x: 0, y: 0 }, distance: 1.2, time: 110 });
    feed(c, clock, snapshot(110, [a], 1), [{ kind: 'gesture', gesture: thumbs }]);
    const cue = face.cues[0];
    expect(cue.kind === 'success' && cue.source === 'perception' && cue.key === 'success:person-1').toBe(true);
    expect(last(c.reactions)?.outcome).toBe('thumbsUp → success cue');
    // At bedtime nothing happens and nothing counts.
    life.isBedtime = true;
    const before = face.commands.length;
    feed(c, clock, snapshot(200, [a], 1), [{ kind: 'gesture', gesture: wave(200) }]);
    expect(face.commands.length).toBe(before);
    expect(life.activity).toHaveLength(2);
    // Reactions off: events only.
    life.isBedtime = false;
    c.settings = c.settings.with({ gestureReactionsEnabled: false });
    feed(c, clock, snapshot(300, [a], 1), [{ kind: 'gesture', gesture: wave(300) }]);
    expect(face.commands.length).toBe(before);
  });

  test('dryRunIsLevelDriven', () => {
    const [c, face, , clock] = rig();
    const a = person(1, 0);
    face.agentState = 'noticing';
    feed(c, clock, snapshot(100, [a], 1, 1));
    expect(face.agentState).toBe('engaged');
    expect(c.dryRunActive).toBe(true);
    // Still engaged: no repeated writes.
    feed(c, clock, snapshot(101, [a], 1, 1));
    expect(face.stateWrites).toEqual(['engaged']);
    feed(c, clock, snapshot(102, [a], 1, null));
    expect(face.agentState).toBe('noticing');
    // Something else moved Yanni on (the conversation loop): the dry run doesn't touch it.
    face.agentState = 'idle';
    feed(c, clock, snapshot(103, [a], 1, 1));
    face.agentState = 'listening';
    feed(c, clock, snapshot(104, [a], 1, null));
    expect(face.agentState).toBe('listening');
    // Off: never writes.
    const [c2, face2, , clock2] = rig();
    c2.settings = c2.settings.with({ lookToTalkDryRun: false });
    feed(c2, clock2, snapshot(100, [a], 1, 1));
    expect(face2.stateWrites).toHaveLength(0);
    // The conversation loop is live: the app pushing its settings (dry run on) never brings the dry run back.
    const [c3, face3, , clock3] = rig();
    c3.dryRunAllowed = false;
    c3.settings = c3.settings.with({ faceRadius: c3.settings.faceRadius + 0.04, lookToTalkDryRun: true });
    feed(c3, clock3, snapshot(100, [a], 1, 1));
    expect(face3.stateWrites).toHaveLength(0);
  });

  test('engagementDiagnosticsSayWhyNotAtMostEveryFewSeconds', () => {
    const [c, , , clock] = rig();
    const lines: string[] = [];
    c.onDiagnosis = (l) => { lines.push(l); };
    const p = person(1, 0, { d: 2.4 });
    p.gazeSource = { kind: 'headPose' };
    feed(c, clock, snapshot(100, [{ ...p }], 1));
    expect(lines).toEqual(['noticed · too far (2.4 m > 1.6 m)']);
    // Steps closer but looks away: a change, held back until the gap has passed.
    p.distance = 1.0;
    p.lookingAtMe = 0.1;
    feed(c, clock, snapshot(101, [{ ...p }], 1));
    expect(lines).toHaveLength(1);
    feed(c, clock, snapshot(103.1, [{ ...p }], 1));
    expect(last(lines)).toBe('noticed · not facing (looking 0.10 < 0.60, facing 0.80)');
    // The same reason never repeats; engaged says nothing (the engaged event does).
    feed(c, clock, snapshot(110, [{ ...p }], 1));
    feed(c, clock, snapshot(114, [{ ...p }], 1, 1));
    expect(lines).toHaveLength(2);
  });

  test('dryRunNotWhileAsleep', () => {
    const [c, face, life, clock] = rig();
    life.phase = 'halfAwake';
    face.agentState = 'halfAwake';
    feed(c, clock, snapshot(100, [person(1, 0)], 1, 1));
    expect(face.stateWrites, 'the life cycle wakes Yanni on engagement; the dry run waits for awake').toHaveLength(0);
  });

  test('lowModeAndConversationAPIReachTheProcessor', () => {
    const [c, , life] = rig();
    c.mailbox.drain();
    life.cameraMode = 'low';
    c.lifeChanged();
    c.pinTurn(3); c.unpinTurn(); c.noteEngagementOutcome(3, false); c.releaseTurn();
    const cmds = c.mailbox.drain();
    const want: PerceptionCommand[] = [{ kind: 'lowMode', on: true }, { kind: 'pinTurn', id: 3 }, { kind: 'unpinTurn' },
      { kind: 'noteEngagementOutcome', id: 3, spoke: false }, { kind: 'releaseTurn' }];
    expect(cmds.length === want.length && cmds.every((x, i) => PerceptionCommand.equals(x, want[i]))).toBe(true);
  });

  test('eventStreamDeliversToSubscribers', () => {
    const [c, , , clock] = rig();
    const got: PerceptionEvent[] = [];
    c.subscribe((e) => { got.push(e); });
    feed(c, clock, snapshot(100, [person(1, 0)], 1), [{ kind: 'personEntered', id: 1, at: { x: 0, y: 0 }, distance: 1 }]);
    expect(got[0]?.kind).toBe('personEntered');
  });
});
