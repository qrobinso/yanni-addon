// The replay people source (Swift PerceptionModel.startReplay / replayTick) drives the coordinator to the same events
// as the synthetic-scene replay tests' rig, from the scene itself and from the same scene recorded to a session.
import { describe, expect, test } from 'vitest';
import {
  FeatureRecordingSession, PerceptionCoordinator, PerceptionEvent, PerceptionSettings, ReplaySource, SyntheticScenes,
  type PerceptionRecording, type SyntheticScene,
} from '../../src/perception';
import { FakeFace, FakeLife, PipelineRig, T } from './TestSupport';

type Ev = [number, string];
const keep = (n: string) => n !== 'cameraStatus' && n !== 'lookingAtMe';

function viaRig(s: SyntheticScene, rec: PerceptionRecording = s.recording()): Ev[] {
  const rig = new PipelineRig({ cameraOffset: s.cameraOffset });
  for (const f of rec.frames) rig.play(f);
  return rig.events.map((e) => [e.frame, PerceptionEvent.name(e.event)] as Ev).filter(([, n]) => keep(n));
}

/** Ticks a ReplaySource at each frame's time into a coordinator, as startPerception's 15 Hz timer does. */
function viaReplay(rec: PerceptionRecording, cameraOffset = rec.cameraOffset): { events: Ev[]; face: FakeFace } {
  const face = new FakeFace(), clock = { now: rec.frames[0].time };
  const settings = new PerceptionSettings();
  const c = new PerceptionCoordinator(face, new FakeLife(), settings, () => clock.now);
  c.source = 'replay';
  c.setCameraOffset(cameraOffset);
  let frame = 0;
  const events: Ev[] = [];
  c.onEvent = (e) => events.push([frame, PerceptionEvent.name(e)]);
  // One pass (the live source loops; a lap resets the processor, which the rig never does).
  const src = new ReplaySource(rec, settings, 3, rec.frames[0].time, false);
  for (const f of rec.frames) {
    clock.now = f.time;
    for (const { out } of src.tick(f.time, c.mailbox.drain())) { c.ingest(out, 'replay'); frame += 1; }
  }
  return { events: events.filter(([, n]) => keep(n)), face };
}

const scenes = [SyntheticScenes.passerBy, SyntheticScenes.sitAndLook, SyntheticScenes.twoPeopleEngage,
  SyntheticScenes.waveWalkingPast, SyntheticScenes.waveAtYanni, SyntheticScenes.simulatorDemo];

describe('ReplaySourceTests', () => {
  test.each(scenes.map((s) => [s.name, s] as const))('%s: the replay source gives the rig\'s events', (_n, s) => {
    const got = viaReplay(s.recording(), s.cameraOffset).events;
    expect(got).toEqual(viaRig(s));
    expect(got.length).toBeGreaterThan(0);
  });

  test.each(scenes.map((s) => [s.name, s] as const))('%s: a recorded session replays to the same events (±2 frames)', (_n, s) => {
    const session = FeatureRecordingSession.synthetic(s.recording(), 'scripted');
    const [back] = T.roundTrip(session, ['P1', 'P2', 'P3']);
    const rec = back.asPerceptionRecording();
    rec.cameraOffset = s.cameraOffset;
    // The recorder never keeps the motion grid or the torso colours (numbers about bodies only): the reference is
    // the rig on the same frames without them.
    const got = viaReplay(rec).events, want = viaRig(s, session.asPerceptionRecording()).filter(([, n]) => n !== 'motion');
    expect(got.map(([, n]) => n)).toEqual(want.map(([, n]) => n));
    got.forEach(([f], i) => expect(Math.abs(f - want[i][0])).toBeLessThanOrEqual(2));
  });

  test('the replay ignores the device camera offset (the recording carries its own) and laps reset the processor', () => {
    const s = SyntheticScenes.sitAndLook;
    const rec = s.recording();
    const settings = new PerceptionSettings();
    const src = new ReplaySource(rec, settings, 3, 0);
    src.tick(0, [{ kind: 'cameraOffset', offset: { x: 0.25, y: 0.25 } }]);
    expect(src.processor.geometry.cameraOffset).toEqual(rec.cameraOffset);
    // Past the end the player laps (frames come at most 65 per tick, as after a long pause).
    for (let t = 0; t <= rec.duration + 0.2; t += 1 / 15) src.tick(t, []);
    expect(src.player.lap).toBe(1);
  });
});
