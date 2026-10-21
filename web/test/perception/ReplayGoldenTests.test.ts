// Port of Tests/FacePerceptionTests/ReplayGoldenTests.swift (ReplayGoldenTests + ProcessorTests).
//
// Synthetic recordings replayed through tracker → eye contact → engagement → gestures → coordinator (fake engine),
// compared with golden event lists: same types in the same order, each within ±2 frames. Set YANNI_GOLDEN_PRINT=1 to
// print the current lists.
import { describe, expect, test } from 'vitest';
import {
  PerceptionEvent, PerceptionRecording, PerceptionSettings, ReplayPlayer, SyntheticScenes, type SyntheticScene,
} from '../../src/perception';
import { PipelineRig } from './TestSupport';

type Golden = [number, string][];

function run(s: SyntheticScene): PipelineRig {
  const rig = new PipelineRig({ cameraOffset: s.cameraOffset });
  rig.playScene(s);
  return rig;
}

function observed(rig: PipelineRig): Golden {
  return rig.events.map((e) => [e.frame, PerceptionEvent.name(e.event)] as [number, string])
    .filter(([, n]) => n !== 'cameraStatus' && n !== 'lookingAtMe');
}

function check(s: SyntheticScene, golden: Golden): PipelineRig {
  const rig = run(s);
  const got = observed(rig);
  if (process.env.YANNI_GOLDEN_PRINT === '1') {
    console.log(`GOLDEN ${s.name}: ` + got.map(([f, n]) => `(${f}, "${n}")`).join(', '));
  }
  expect(got.map(([, n]) => n), `${s.name}: event types / order (got ${JSON.stringify(got)})`).toEqual(golden.map(([, n]) => n));
  if (got.length === golden.length) {
    got.forEach(([f, n], i) => {
      expect(Math.abs(f - golden[i][0]), `${s.name}: ${n} at frame ${f}, golden ${golden[i][0]}`).toBeLessThanOrEqual(2);
    });
  }
  return rig;
}

describe('ReplayGoldenTests', () => {
  test('passerBy', () => {
    const rig = check(SyntheticScenes.passerBy, [[1, 'personEntered'], [1, 'primaryChanged'], [94, 'personOutOfView'], [94, 'primaryChanged']]);
    expect(rig.face.rests, 'the gaze rests where they left').toHaveLength(1);
    expect(rig.face.stateWrites, 'never engaged').toHaveLength(0);
  });

  test('glanceOnly', () => {
    const rig = check(SyntheticScenes.glanceOnly, [[1, 'personEntered'], [1, 'primaryChanged']]);
    expect(rig.events.some((e) => e.event.kind === 'engaged')).toBe(false);
  });

  test('sitAndLook', () => {
    const rig = check(SyntheticScenes.sitAndLook, [[1, 'personEntered'], [1, 'primaryChanged'], [38, 'engaged'], [123, 'disengaged']]);
    expect(rig.face.stateWrites, 'look-to-talk dry run').toEqual(['engaged', 'noticing']);
    const looks = rig.events.flatMap((e) => e.event.kind === 'lookingAtMe' ? [e.event.seconds] : []);
    expect(looks).toEqual([0.5, 1, 2]);
  });

  test('twoPeopleEngage', () => {
    const rig = check(SyntheticScenes.twoPeopleEngage, [
      [1, 'personEntered'], [1, 'personEntered'], [1, 'primaryChanged'], [30, 'engaged'], [39, 'wantsTurn'],
      [130, 'disengaged'], [130, 'engaged'], [130, 'primaryChanged'],
    ]);
    const engaged = rig.events.flatMap((e) => e.event.kind === 'engaged' ? [e.event.id] : []);
    expect(engaged, 'first come holds the turn; the waiter takes it on release').toEqual([1, 2]);
    expect(rig.face.glances, "newcomer glance + you're-next glance").toHaveLength(2);
  });

  test('childAtOneMetre', () => {
    check(SyntheticScenes.childAtOneMetre, [[1, 'personEntered'], [1, 'primaryChanged'], [30, 'engaged']]);
  });

  test('waveWhileWalkingPastGetsNoReaction', () => {
    // One continued wave is one gesture (the event layer's hysteresis), and it isn't aimed at Yanni.
    const rig = check(SyntheticScenes.waveWalkingPast, [
      [1, 'personEntered'], [1, 'primaryChanged'], [49, 'gesture.wave'], [94, 'personOutOfView'], [94, 'primaryChanged'],
    ]);
    expect(rig.face.oneShots).toHaveLength(0);
    expect(rig.coordinator.reactions.every((r) => r.outcome === 'wave: not aimed at Yanni')).toBe(true);
  });

  test('waveAtYanniDances', () => {
    const rig = check(SyntheticScenes.waveAtYanni, [[1, 'personEntered'], [1, 'primaryChanged'], [16, 'engaged'], [33, 'gesture.wave']]);
    expect(rig.face.oneShots).toEqual(['dance']);
  });

  test('thumbsUpSendsASuccessCue', () => {
    const rig = check(SyntheticScenes.thumbsUp, [[1, 'personEntered'], [1, 'primaryChanged'], [16, 'engaged'], [30, 'gesture.thumbsUp']]);
    const cue = rig.face.cues[0];
    expect(cue !== undefined && cue.kind === 'success' && cue.source === 'perception' && cue.key === 'success:person-1').toBe(true);
  });

  test('pointLeftLooksLeft', () => {
    // Pointing must be aimed at Yanni: they look at it first (and engage), then point and look there.
    const rig = check(SyntheticScenes.pointLeft, [[1, 'personEntered'], [1, 'primaryChanged'], [16, 'engaged'],
      [30, 'gesture.point'], [58, 'disengaged']]);
    const s = rig.face.stimuli[0];
    expect(s).toBeDefined();
    expect(s[0].x).toBeLessThan(-0.5);
  });

  test('talkingWithHandsIsNotAWave', () => {
    // A palm that happens to hold still while talking is an event, never aimed at Yanni: no reaction.
    const rig = check(SyntheticScenes.talkingWithHands, [[1, 'personEntered'], [1, 'primaryChanged'], [72, 'gesture.openPalm']]);
    expect(rig.face.commands.length === 0 || rig.face.allOneShots.length === 0).toBe(true);
    expect(rig.events.some((e) => PerceptionEvent.name(e.event) === 'gesture.wave')).toBe(false);
  });

  test('posterNeverEngagesAndIsSuppressed', () => {
    const rig = check(SyntheticScenes.poster, [
      [1, 'personEntered'], [1, 'primaryChanged'], [300, 'staticFaceSuppressed'], [300, 'personOutOfView'], [300, 'primaryChanged'],
    ]);
    expect(rig.face.stateWrites).toHaveLength(0);
  });

  test('motionWithNobodyAround', () => {
    const rig = check(SyntheticScenes.motionOnly, [[30, 'motion'], [45, 'motion']]);
    expect(rig.face.stimuli, 'stimuli at least 3 s apart').toHaveLength(1);
  });

  test('simulatorDemo', () => {
    const rig = check(SyntheticScenes.simulatorDemo, [
      [1, 'personEntered'], [1, 'primaryChanged'], [90, 'engaged'], [115, 'gesture.wave'],
      [172, 'gesture.thumbsUp'], [243, 'disengaged'], [259, 'personOutOfView'], [259, 'primaryChanged'],
      [285, 'motion'], [286, 'personEntered'], [286, 'primaryChanged'], [316, 'personLeft'],
      [394, 'personOutOfView'], [394, 'primaryChanged'], [405, 'motion'], [420, 'motion'],
    ]);
    const ids = new Set(rig.events.flatMap((e) => e.event.kind === 'personEntered' ? [e.event.id] : []));
    expect([...ids].sort(), 'a different-looking person from the same edge is someone new').toEqual([1, 2]);
  });

  // MARK: Recording and player

  test('recordingRoundTripsAsJSON', () => {
    const rec = SyntheticScenes.thumbsUp.recording();
    const back = PerceptionRecording.decode(rec.jsonData());
    expect(back).toEqual(rec);
    expect(Math.abs(rec.duration - 5)).toBeLessThan(0.1);
  });

  test('playerRetimesAndLoops', () => {
    const rec = SyntheticScenes.glanceOnly.recording();
    rec.frames = rec.frames.slice(0, 15);   // 1 s
    const p = new ReplayPlayer(rec, 50, true);
    const a = p.due(50.5);
    expect(a.frames).toHaveLength(8);
    expect(a.frames[0].time).toBe(50);
    const b = p.due(51.2);
    expect(b.lapped).toBe(true);
    expect(b.frames[b.frames.length - 1].time).toBeLessThanOrEqual(51.2);
    const once = new ReplayPlayer(rec, 0, false);
    once.due(10);
    expect(once.isFinished).toBe(true);
  });
});

describe('ProcessorTests', () => {
  test('lowModeStopsEyeContactAndGestures', () => {
    const rig = new PipelineRig({ cameraOffset: { x: 0, y: -0.11 } });
    rig.life.cameraMode = 'low';
    rig.coordinator.lifeChanged();
    rig.playScene(SyntheticScenes.waveAtYanni);
    expect(rig.events.some((e) => e.event.kind === 'engaged' || e.event.kind === 'gesture')).toBe(false);
    expect(rig.events.some((e) => e.event.kind === 'personEntered'), 'presence still reported').toBe(true);
  });

  test('maxPeopleLimitsTheList', () => {
    const rig = new PipelineRig({ settings: new PerceptionSettings({ maxPeople: 1 }) });
    rig.playScene(SyntheticScenes.twoPeopleEngage);
    expect(rig.face.peopleCalls.every((c) => c.people.length <= 1)).toBe(true);
  });

  test('facingReachesTheEngine', () => {
    const rig = new PipelineRig({ cameraOffset: { x: 0, y: -0.11 } });
    rig.playScene(SyntheticScenes.sitAndLook);
    const facing = rig.face.peopleCalls.flatMap((c) => c.people.length > 0 ? [c.people[0].facing] : []);
    expect(Math.max(...facing), 'looking at the eyes: facing').toBeGreaterThan(0.9);
    expect(facing[facing.length - 1], 'turned 45° away: not facing').toBeLessThan(0.5);
  });

  test('pinThroughTheCoordinatorHoldsTheTurn', () => {
    const rig = new PipelineRig({ cameraOffset: { x: 0, y: -0.11 } });
    const frames = SyntheticScenes.sitAndLook.recording().frames;
    for (const f of frames.slice(0, 45)) rig.play(f);
    expect(rig.processor.engagement.engagedID).toBe(1);
    rig.coordinator.pinTurn(1);
    for (const f of frames.slice(45)) rig.play(f);
    expect(rig.events.some((e) => e.event.kind === 'disengaged'), "pinned: looking away doesn't release").toBe(false);
    rig.coordinator.unpinTurn();
    const last = frames[frames.length - 1];
    for (let i = 1; i <= 60; i++) rig.play({ ...last, time: last.time + i / 15 });
    expect(rig.events.some((e) => e.event.kind === 'disengaged')).toBe(true);
  });

  test('sourceChangeResetsEverything', () => {
    const rig = new PipelineRig({ cameraOffset: { x: 0, y: -0.11 } });
    rig.playScene(SyntheticScenes.thumbsUp);
    rig.coordinator.source = 'camera';
    rig.processor.apply(rig.coordinator.mailbox.drain());
    expect(rig.processor.engagement.engagedID).toBeNull();
    expect(rig.face.agentState, 'the dry run hands back').toBe('noticing');
    expect(rig.face.peopleCalls[rig.face.peopleCalls.length - 1]?.people).toEqual([]);
  });
});
