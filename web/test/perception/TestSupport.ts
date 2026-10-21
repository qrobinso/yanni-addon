// Port of Tests/FacePerceptionTests/TestSupport.swift.
import type { V2 } from '../../src/core/vec';
import { roundSwift } from '../../src/core/vec';
import {
  PupilReactionEvent,
  type AgentState, type FaceCommand, type OneShotKind, type OneShotRequest, type PersonTarget, type PupilReactionReason,
  type ReactionCue,
} from '../../src/engine';
import { ReactionCueKind } from '../../src/engine';
import type { ActivityKind, CameraMode, LifePhase } from '../../src/life';
import { CameraGeometry } from '../../src/perception/CameraGeometry';
import { PerceptionCoordinator, type PerceptionFace, type PerceptionLife } from '../../src/perception/PerceptionCoordinator';
import { PerceptionProcessor } from '../../src/perception/PerceptionProcessor';
import { PerceptionSettings } from '../../src/perception/PerceptionSettings';
import {
  NRect, PerceptionEvent, makeBodyDetection, makeEyeObservation, makeFaceDetection, makeHeadPose,
  PerceptionTier, type BodyDetection, type FaceDetection, type FrameDetections, type HeadPose,
} from '../../src/perception/PerceptionTypes';
import type { SyntheticScene } from '../../src/perception/SyntheticScenes';
import {
  FeatureRecordingHeader, FeatureRecordingSession, FeatureRecordingWriter, MemoryFileSystem, RecordedEvent,
  RecordingLimits, StageTimings, makePerceptionSnapshot, makeRecordingParticipant,
  type RecordingParticipant, type RecordingStatus,
} from '../../src/perception';

/// Records everything the coordinator does to the face.
export class FakeFace implements PerceptionFace {
  agentState: AgentState = 'idle';
  sulking = false;
  commands: FaceCommand[] = [];
  peopleCalls: { people: PersonTarget[]; primary: number | null; engaged: number | null }[] = [];
  stateWrites: AgentState[] = [];
  offsets: V2[] = [];

  busy = false;
  shapeShowing = false;
  arbiter: { serial: number; events: PupilReactionEvent[] } = { serial: 0, events: [] };
  highFives = 0;
  anticsAllowed = true;
  antics: [OneShotKind, number][] = [];
  friendlyTouchUntil: number[] = [];

  get perceptionAgentState(): AgentState { return this.agentState; }
  get perceptionIsSulking(): boolean { return this.sulking; }
  get perceptionOneShotBusy(): boolean { return this.busy; }
  get perceptionPupilShapeShowing(): boolean { return this.shapeShowing; }
  get perceptionArbiterEvents(): { serial: number; events: PupilReactionEvent[] } { return this.arbiter; }
  get perceptionHighFiveCount(): number { return this.highFives; }
  playPerceptionEdgeAntic(kind: OneShotKind, side: number): boolean {
    if (!this.anticsAllowed) return false;
    this.antics.push([kind, side]);
    return true;
  }
  noteFriendlyTouch(hostTime: number): void { this.friendlyTouchUntil.push(hostTime); }

  /// The arbiter's verdict on the last cue sent (tests of the fallback path).
  arbiterSays(reason: PupilReactionReason): void {
    const c = this.cues[this.cues.length - 1];
    if (c === undefined) return;
    const e = new PupilReactionEvent(this.arbiter.serial + 1, 0,
      { kind: 'decision', cue: c, oneShot: ReactionCueKind.oneShot(c.kind), reason });
    this.arbiter = { serial: this.arbiter.serial + 1, events: [...this.arbiter.events, e] };
  }
  /// One-shots requested by kind, including `play` requests (intensity, soft voice).
  get allOneShots(): OneShotKind[] {
    const o: OneShotKind[] = [];
    for (const c of this.commands) {
      if (c.kind === 'playOneShot') o.push(c.oneShot);
      else if (c.kind === 'play') o.push(c.request.kind);
    }
    return o;
  }
  get requests(): OneShotRequest[] { return this.commands.flatMap((c) => c.kind === 'play' ? [c.request] : []); }
  setPeople(people: PersonTarget[], primary: number | null, engaged: number | null): void { this.peopleCalls.push({ people, primary, engaged }); }
  send(command: FaceCommand): void { this.commands.push(command); }
  setAgentState(s: AgentState): void { this.agentState = s; this.stateWrites.push(s); }
  setCameraOffset(metres: V2): void { this.offsets.push(metres); }

  get glances(): [V2, number][] { return this.commands.flatMap((c) => c.kind === 'glance' ? [[c.at, c.duration] as [V2, number]] : []); }
  get stimuli(): [V2, number][] { return this.commands.flatMap((c) => c.kind === 'stimulus' ? [[c.at, c.strength] as [V2, number]] : []); }
  get rests(): V2[] { return this.commands.flatMap((c) => c.kind === 'restGaze' ? [c.at] : []); }
  get oneShots(): OneShotKind[] { return this.commands.flatMap((c) => c.kind === 'playOneShot' ? [c.oneShot] : []); }
  get cues(): ReactionCue[] { return this.commands.flatMap((c) => c.kind === 'reactionCue' ? [c.cue] : []); }
}

export class FakeLife implements PerceptionLife {
  cameraMode: CameraMode = 'normal';
  isBedtime = false;
  phase: LifePhase = 'awake';
  activity: ActivityKind[] = [];
  noteActivity(kind: ActivityKind): void { this.activity.push(kind); }
}

/// A processor + coordinator rig that plays frames with a matching fake clock.
export class PipelineRig {
  processor: PerceptionProcessor;
  readonly face = new FakeFace();
  readonly life = new FakeLife();
  readonly coordinator: PerceptionCoordinator;
  readonly clockBox = { now: 1000 };
  events: { frame: number; event: PerceptionEvent }[] = [];
  frame = 0;

  constructor(o: { settings?: PerceptionSettings; cameraOffset?: V2; tier?: PerceptionTier } = {}) {
    const settings = o.settings ?? new PerceptionSettings();
    const cameraOffset = o.cameraOffset ?? { x: 0, y: -0.11 };
    this.processor = new PerceptionProcessor(settings, new CameraGeometry(undefined, cameraOffset), o.tier ?? 3);
    const box = this.clockBox;
    this.coordinator = new PerceptionCoordinator(this.face, this.life, settings, () => box.now);
    this.coordinator.source = 'replay';
    this.coordinator.setCameraOffset(cameraOffset);
    this.coordinator.onEvent = (e) => { this.events.push({ frame: this.frame, event: e }); };
    this.processor.apply(this.coordinator.mailbox.drain());
  }

  play(det: FrameDetections): void {
    this.clockBox.now = det.time;
    this.processor.apply(this.coordinator.mailbox.drain());
    const out = this.processor.process(det);
    this.coordinator.ingest(out, 'replay');
    this.frame += 1;
  }

  playScene(scene: SyntheticScene): void {
    for (const f of scene.recording().frames) this.play(f);
  }

  get names(): string[] { return this.events.map((e) => PerceptionEvent.name(e.event)).filter((n) => n !== 'cameraStatus'); }
}

// MARK: - Builders

export function face(c: V2, o: { size?: number; pose?: HeadPose | null; openness?: number } = {}): FaceDetection {
  const size = o.size ?? 0.06;
  return makeFaceDetection(NRect.fromCenter(c, { x: size, y: size * 1.3 }), {
    headPose: o.pose === undefined ? makeHeadPose(0, 0) : o.pose,
    eyes: makeEyeObservation({ x: 0, y: 0 }, 20, 0.9, o.openness ?? 0.3),
  });
}

export function body(c: V2, o: { width?: number; appearance?: number[] | null } = {}): BodyDetection {
  const width = o.width ?? 0.2;
  return makeBodyDetection(NRect.make(c.x - width / 2, c.y - width * 0.3, width, width * 1.6), { appearance: o.appearance ?? null });
}

/// Frames at `fps` from `t0` for `seconds`.
export function frames(seconds: number, make: (i: number, t: number) => FrameDetections,
  o: { fps?: number; t0?: number } = {}): FrameDetections[] {
  const fps = o.fps ?? 15, t0 = o.t0 ?? 1000;
  const n = roundSwift(seconds * fps);
  return Array.from({ length: n }, (_, i) => make(i, t0 + i / fps));
}

export const approx = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

// MARK: - Recorder helpers (Swift: RecorderTests' statics, `typealias T = RecorderTests` in the privacy tests)

export const T = {
  participant: (p: string, child = false, by = 'self'): RecordingParticipant =>
    makeRecordingParticipant(p, new Date(1_800_000_000 * 1000), { isChild: child, consentedBy: by }),

  header(id: string, declared: string[] = ['P1'], start: number, date: Date = new Date()): FeatureRecordingHeader {
    const h = new FeatureRecordingHeader(id, 'scripted', declared.map((p) => T.participant(p)), date, start);
    h.platform = 'test';
    return h;
  },

  /// Writes a session's frames through a real writer and reads the folder back.
  roundTrip(s: FeatureRecordingSession, declared: string[]): [FeatureRecordingSession, RecordingStatus, MemoryFileSystem] {
    const fs = new MemoryFileSystem();
    const dir = 'tmp/s1';
    const w = new FeatureRecordingWriter(fs, dir, T.header('s1', declared, s.frames[0]?.detections.time ?? 0), RecordingLimits.maxTotalBytes);
    const stages = new StageTimings();
    stages.rects = 3.25; stages.landmarks = 1.5; stages.logic = 0.4;
    for (const f of s.frames) {
      const snap = makePerceptionSnapshot({ time: f.detections.time, people: f.people, primaryID: f.primaryID, engagedID: f.engagedID });
      w.offer(f.detections, snap, stages, PerceptionTier.standard);
      w.note(RecordedEvent.make(f.detections.time, 'tick'));
      w.flush();                                                        // deterministic: no ring overflow
    }
    w.flush();
    const status = w.status;
    w.finish('test');
    return [FeatureRecordingSession.load(fs, dir), status, fs];
  },
};

