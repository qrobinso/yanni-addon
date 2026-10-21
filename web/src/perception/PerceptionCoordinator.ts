// Port of FacePerception/PerceptionCoordinator.swift, with PerceptionCoordinator+Gestures.swift (`handleGesture`,
// `play`, `pollReactions`, the gesture `note`) folded into the class.
//
// port-note: the Swift processor runs off the main actor and talks to the coordinator through the mailbox; in the
// browser everything runs on one thread (the MediaPipe front end calls in per analysed frame). The ordering is kept:
// the frame loop drains `mailbox` into `PerceptionProcessor.apply` before each `process`, then calls `ingest`.
import type { V2 } from '../core/vec';
import {
  FaceCommand, OneShotLibrary, OneShotRequest, makePersonTarget,
  type AgentState, type FaceEngine, type OneShotKind, type PersonTarget, type PupilReactionEvent, type PupilReactionReason,
} from '../engine';
import type { ActivityKind, CameraMode, LifeCycleController, LifePhase } from '../life';
import { CameraGeometry } from './CameraGeometry';
import { PerceptionMailbox } from './PerceptionProcessor';
import { PerceptionReflexes } from './PerceptionReflexTable';
import { makeReflexContext, type ReflexImpulse } from './PerceptionReflexes';
import { PerceptionSettings } from './PerceptionSettings';
import {
  CameraStatus, PerceptionEvent, clamp, fmt, makeGestureObservation, makePerceptionSnapshot,
  type GestureDecision, type GestureObservation, type PerceptionOutput, type PerceptionSnapshot, type PerceptionTier,
} from './PerceptionTypes';

/// What the coordinator needs from the face (the engine through `perceptionFace(engine)`; tests use a fake).
export interface PerceptionFace {
  readonly perceptionAgentState: AgentState;
  readonly perceptionIsSulking: boolean;
  setPeople(people: PersonTarget[], primary: number | null, engaged: number | null): void;
  send(command: FaceCommand): void;
  setAgentState(s: AgentState): void;
  setCameraOffset(metres: V2): void;
  /// A conversation beat, answer, edge antic or another perception beat is playing (idle beats and pupil shapes
  /// don't count).
  readonly perceptionOneShotBusy: boolean;
  readonly perceptionPupilShapeShowing: boolean;
  /// The pupil arbiter's recent decisions (the coordinator plays a row's fallback when a cue is turned down for rarity).
  readonly perceptionArbiterEvents: { serial: number; events: PupilReactionEvent[] };
  /// High-fives confirmed by a tap so far (TouchReactions).
  readonly perceptionHighFiveCount: number;
  /// Plays a screen-edge antic if the engine's antic gating allows it now; false (nothing happens) otherwise.
  playPerceptionEdgeAntic(kind: OneShotKind, side: number): boolean;
  /// A tap before `hostTime` (host seconds) is a high-five, not a poke.
  noteFriendlyTouch(hostTime: number): void;
}

/// What the coordinator needs from the life cycle (`LifeCycleController` conforms as is; tests use a fake).
export interface PerceptionLife {
  readonly cameraMode: CameraMode;
  readonly isBedtime: boolean;
  readonly phase: LifePhase;
  noteActivity(kind: ActivityKind): void;
}

/// Swift `extension FaceEngine: PerceptionFace`: the engine seen through the protocol.
export function perceptionFace(engine: FaceEngine): PerceptionFace {
  return {
    get perceptionAgentState() { return engine.state.agentState; },
    get perceptionIsSulking() {
      return (engine.director.modifier('TouchReactions') as unknown as { isSulking?: boolean } | undefined)?.isSulking ?? false;
    },
    setPeople: (people, primary, engaged) => engine.setPeople(people, primary, engaged),
    send: (c) => engine.send(c),
    setAgentState: (s) => engine.setAgentState(s),
    setCameraOffset: (m) => engine.setCameraOffset(m),
    get perceptionOneShotBusy() { return engine.oneShotBusyForPerception; },
    get perceptionPupilShapeShowing() { return engine.pupilShapeShowing; },
    get perceptionArbiterEvents() { return engine.pupilReactionEvents; },
    get perceptionHighFiveCount() { return engine.highFiveCount; },
    playPerceptionEdgeAntic: (k, side) => engine.playPerceptionEdgeAntic(k, side),
    noteFriendlyTouch: (t) => engine.noteFriendlyTouch(t),
  };
}

/// Swift `extension LifeCycleController: PerceptionLife {}` (a compile-time check: it conforms structurally).
export const perceptionLife = (life: LifeCycleController): PerceptionLife => life;

/// Where the people the face sees come from. One selector, owned by the coordinator.
/// camera: the front camera · replay: a recorded (synthetic) landmark sequence through the real tracker and
/// engagement · simulated: the preview's gaze pad (the coordinator doesn't touch the engine's people).
export type PeopleSource = 'camera' | 'replay' | 'simulated';
export const PeopleSource = { allCases: ['camera', 'replay', 'simulated'] as readonly PeopleSource[] } as const;

/// One entry in the reaction log (what the coordinator did with an event, or why it didn't).
export interface PerceptionReaction { event: string; outcome: string }

type Blocker = 'asleep' | 'tooFar' | 'noReading' | 'notLooking' | 'dwelling';

/// Cues waiting for the arbiter's verdict (their row's fallback plays if it turns them down for rarity).
interface PendingCue { id: number; fallback: OneShotKind | null; intensity: number; deadline: number; gesture: string }
/// A second beat due later (dancing's dance along), cancelled if its cue was turned down.
interface PendingBeat { due: number; kind: OneShotKind; cueID: number; gesture: string }

const defaultClock = (): number => performance.now() / 1000;

/// Glue between perception and the rest of the app: applies snapshots to the engine (people, primary, engaged),
/// turns events into glances, rest gaze, stimuli and gesture reflexes, reports activity to the life cycle (daytime
/// only), runs the look-to-talk dry run, and broadcasts events. It never touches the per-display-frame path.
export class PerceptionCoordinator {
  readonly mailbox = new PerceptionMailbox();

  // Tunables.
  static readonly maxSnapshotAge = 0.25;
  static readonly newcomerGlanceGap = 4;
  static readonly newcomerGlance = 0.5;
  static readonly listeningNewcomerMaxDistance = 2;
  static readonly wantsTurnGlance = 0.6;
  static readonly wantsTurnGap = 10;
  static readonly restPush = 0.15;
  static readonly stimulusGap = 3;
  static readonly strongMotion = 0.5;
  static readonly conversationStates: ReadonlySet<AgentState> =
    new Set<AgentState>(['engaged', 'listening', 'thinking', 'speaking', 'followUp', 'interrupted']);
  /// Diagnostics lines at most this often (seconds).
  static readonly diagnosisGap = 3;
  /// Arbiter reasons that are about rarity: the row's fallback beat plays instead (design §6.6). Never for bedtime,
  /// sulking or the state.
  static readonly fallbackReasons: ReadonlySet<PupilReactionReason> = new Set<PupilReactionReason>(
    ['globalCooldown', 'shapeCooldown', 'habituated', 'repeatKey', 'recentCancel', 'queueFull']);

  /// The latest applied snapshot (4 Hz pollers read this).
  latest: PerceptionSnapshot = makePerceptionSnapshot();
  /// Camera offset relative to the drawn face centre (metres) pushed to the engine and the processor.
  cameraOffset: V2 = { x: 0, y: 0 };
  /// Called for every event, with what the coordinator did about it (Dev Status log).
  onEvent: ((e: PerceptionEvent, note: string | null) => void) | null = null;
  /// A reflex's emotion impulse with its reason (the app routes it to the emotion layer). Called before the beat.
  onImpulse: ((i: ReflexImpulse, reason: string) => void) | null = null;
  /// Gesture-layer rejections (precedence, no onset, …) for the People log.
  onGestureDecision: ((d: GestureDecision) => void) | null = null;
  /// Why the primary person isn't engaged, when it changes and at most once per `diagnosisGap` (the People log).
  onDiagnosis: ((line: string) => void) | null = null;
  /// Recent reaction decisions (newest last, ≤ 20).
  reactions: PerceptionReaction[] = [];
  cameraStatus: CameraStatus = CameraStatus.stopped;
  /// Snapshots dropped as stale (older than `maxSnapshotAge`).
  staleDropped = 0;
  /// True while the dry run holds the agent state in engaged.
  dryRunActive = false;

  reflexes = new PerceptionReflexes();
  pendingCues: PendingCue[] = [];
  pendingBeats: PendingBeat[] = [];
  nextCueID = 1;
  lastArbiterSerial = 0;
  lastHighFiveCount: number | null = null;
  highFiveArmedFor: { id: number | null; until: number } | null = null;
  lastNewcomerGlance = -Infinity;
  lastWantsTurnGlance = new Map<number, number>();
  lastStimulus = -Infinity;
  lastPrimary: number | null = null;
  positions = new Map<number, { p: V2; d: number }>();
  arrivals = new Map<number, { at: number; alone: number }>();
  emptySince: number | null;
  lastBlocker: Blocker | null = null;
  lastDiagnosisAt = -Infinity;

  private _settings: PerceptionSettings;
  private _source: PeopleSource = 'simulated';
  private _dryRunAllowed = true;
  private subscribers = new Set<(e: PerceptionEvent) => void>();

  constructor(readonly face: PerceptionFace, readonly life: PerceptionLife | null,
    settings: PerceptionSettings = new PerceptionSettings(), public clock: () => number = defaultClock) {
    this._settings = settings.validated();
    this.emptySince = clock();
    this.mailbox.post({ kind: 'settings', settings: this._settings });
  }

  // port-note: Swift `didSet` observers become setters. Assign a new value (`c.settings = c.settings.with({…})`);
  // mutating the returned object in place changes it without posting it to the processor.
  get settings(): PerceptionSettings { return this._settings; }
  set settings(v: PerceptionSettings) {
    const old = this._settings;
    this._settings = v.validated();
    if (!this._settings.equals(old)) this.mailbox.post({ kind: 'settings', settings: this._settings });
    if (!this._settings.lookToTalkDryRun && old.lookToTalkDryRun) this.endDryRun();
  }

  /// The active people source. Changing it clears the people (unless simulated) and resets the processor.
  get source(): PeopleSource { return this._source; }
  set source(v: PeopleSource) {
    const old = this._source;
    this._source = v;
    if (v === old) return;
    this.mailbox.post({ kind: 'reset' });
    this.endDryRun();
    if (old !== 'simulated') this.face.setPeople([], null, null);
    this.latest = makePerceptionSnapshot();
    this.lastPrimary = null;
    this.emit({ kind: 'cameraStatus', status: CameraStatus.stopped });
  }

  /// The conversation loop's say: false while it is live (it owns the engaged state then). Kept apart from
  /// `settings`, which the app reassigns from its persisted copy on every change.
  get dryRunAllowed(): boolean { return this._dryRunAllowed; }
  set dryRunAllowed(v: boolean) {
    this._dryRunAllowed = v;
    if (v) this.applyDryRun(); else this.endDryRun();
  }

  // MARK: Event stream

  // port-note: Swift hands out an AsyncStream per subscriber; here a listener, removed by the returned function.
  subscribe(listener: (e: PerceptionEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  emit(e: PerceptionEvent, note: string | null = null): void {
    for (const s of this.subscribers) s(e);
    this.onEvent?.(e, note);
    if (note !== null) this.addReaction({ event: PerceptionEvent.name(e), outcome: note });
  }

  private addReaction(r: PerceptionReaction): void {
    this.reactions.push(r);
    if (this.reactions.length > 20) this.reactions.splice(0, this.reactions.length - 20);
  }

  // MARK: Conversation-loop API

  /// Keep the turn through look-aways while a conversation runs.
  pinTurn(id: number): void { this.mailbox.post({ kind: 'pinTurn', id }); }
  unpinTurn(): void { this.mailbox.post({ kind: 'unpinTurn' }); }
  /// Whether an engagement led to speech (false-engagement damping and the per-hour count).
  noteEngagementOutcome(id: number, spoke: boolean): void { this.mailbox.post({ kind: 'noteEngagementOutcome', id, spoke }); }
  /// End the current turn (the conversation finished).
  releaseTurn(): void { this.mailbox.post({ kind: 'releaseTurn' }); }

  // MARK: Inputs from the app

  /// The camera offset relative to the drawn face centre. Pushed to the engine and the processor alike.
  setCameraOffset(o: V2): void {
    const v = Number.isFinite(o.x) && Number.isFinite(o.y) ? { x: o.x, y: o.y } : { x: 0, y: 0 };
    if (v.x === this.cameraOffset.x && v.y === this.cameraOffset.y) return;
    this.cameraOffset = v;
    this.face.setCameraOffset({ ...v });
    this.mailbox.post({ kind: 'cameraOffset', offset: { ...v } });
  }

  /// Re-reads the life cycle (camera mode) — call on every phase change and at start.
  lifeChanged(): void {
    if (this.life === null) return;
    this.mailbox.post({ kind: 'lowMode', on: this.life.cameraMode === 'low' });
    this.applyDryRun();
  }

  noteCameraStatus(s: CameraStatus): void {
    if (CameraStatus.equals(s, this.cameraStatus)) return;
    this.cameraStatus = s;
    this.emit({ kind: 'cameraStatus', status: s });
  }

  noteTierChange(from: PerceptionTier, to: PerceptionTier, reason: string): void {
    this.mailbox.post({ kind: 'tier', tier: to });
    this.emit({ kind: 'tierChanged', from, to, reason });
  }

  // MARK: Snapshots

  /// Applies one analysed frame from `src` (ignored unless it is the active source).
  ingest(out: PerceptionOutput, src: PeopleSource): void {
    if (!(src === this._source && src !== 'simulated')) return;
    const now = this.clock();
    const snap = out.snapshot;
    const stale = now - snap.time > PerceptionCoordinator.maxSnapshotAge;
    if (stale) this.staleDropped += 1;

    if (!stale) {
      // port-note: Swift reuses one array and hands the face a value copy; here a fresh array per call.
      const targets = snap.people.map((p) => makePersonTarget(p.id, p.position, p.distance, p.salience, p.facing, p.lookingAtMe));
      this.face.setPeople(targets, snap.primaryID, snap.engagedID);
      this.latest = snap;
      this.diagnose(snap);
    } else {
      this.latest = { ...this.latest, engagedID: snap.engagedID };
    }
    for (const p of snap.people) this.positions.set(p.id, { p: p.position, d: p.distance });
    if (snap.people.length === 0) this.emptySince = this.emptySince ?? snap.time;

    for (const e of out.events) this.handle(e, snap, stale);
    for (const d of snap.gestureDecisions) if (d.reason !== 'fired') this.onGestureDecision?.(d);
    this.pollReactions(snap, stale);
    this.lastPrimary = snap.primaryID;
    if (snap.people.length > 0) this.emptySince = null;
    this.applyDryRun();
  }

  get agentState(): AgentState { return this.face.perceptionAgentState; }
  get awake(): boolean { return this.life !== null ? this.life.phase === 'awake' : true; }
  get bedtime(): boolean { return this.life?.isBedtime ?? false; }

  screen(p: V2, distance: number): V2 {
    return new CameraGeometry(undefined, this.cameraOffset).screenRelative(p, distance);
  }

  private handle(e: PerceptionEvent, snap: PerceptionSnapshot, stale: boolean): void {
    const C = PerceptionCoordinator;
    const now = snap.time;
    const st = this.agentState;
    switch (e.kind) {
      case 'personEntered': {
        const alone = this.emptySince !== null ? Math.max(now - this.emptySince, 0) : 0;
        this.arrivals.set(e.id, { at: now, alone });
        let note: string | null = null;
        const other = (snap.primaryID !== null && snap.primaryID !== e.id) || (snap.engagedID !== null && snap.engagedID !== e.id);
        if (other && !stale && this.awake) {
          if (st === 'thinking') note = 'no newcomer glance (thinking)';
          else if (st === 'listening' && e.distance > C.listeningNewcomerMaxDistance) note = 'no newcomer glance (listening, far)';
          else if (now - this.lastNewcomerGlance < C.newcomerGlanceGap) note = 'no newcomer glance (gap)';
          else {
            this.lastNewcomerGlance = now;
            this.face.send(FaceCommand.glance(this.screen(e.at, e.distance), C.newcomerGlance));
            note = 'newcomer glance';
          }
        }
        this.emit(e, note);
        break;
      }
      case 'wantsTurn': {
        let note = 'no glance';
        if (st === 'speaking') note = 'no glance (speaking)';
        else if (!this.awake || stale) note = 'no glance';
        else if (now - (this.lastWantsTurnGlance.get(e.id) ?? -Infinity) < C.wantsTurnGap) note = 'no glance (gap)';
        else {
          const p = snap.people.find((q) => q.id === e.id);
          if (p !== undefined) {
            this.lastWantsTurnGlance.set(e.id, now);
            this.face.send(FaceCommand.glance(this.screen(p.position, p.distance), C.wantsTurnGlance));
            note = "you're-next glance";
          }
        }
        this.emit(e, note);
        break;
      }
      case 'personOutOfView': {
        let note: string | null = null;
        const edge = e.exitEdge;
        if (e.id === this.lastPrimary && edge !== null && snap.people.length === 0 && this.awake) {
          const p = { ...e.lastPosition };
          switch (edge) {
            case 'left': p.x -= C.restPush; break;
            case 'right': p.x += C.restPush; break;
            case 'top': p.y -= C.restPush; break;
            case 'bottom': p.y += C.restPush; break;
          }
          this.face.send(FaceCommand.restGaze(this.screen({ x: clamp(p.x, -1, 1), y: clamp(p.y, -1, 1) }, e.distance)));
          note = `rest gaze at the ${edge} edge`;
        }
        this.emit(e, note);
        break;
      }
      case 'personLeft':
        this.positions.delete(e.id);
        this.arrivals.delete(e.id);
        this.lastWantsTurnGlance.delete(e.id);
        this.emit(e);
        break;
      case 'motion': {
        let note = 'ignored';
        const engaged = snap.engagedID !== null || C.conversationStates.has(st);
        if (!engaged && !stale && (st === 'idle' || st === 'noticing') && now - this.lastStimulus >= C.stimulusGap) {
          this.lastStimulus = now;
          this.face.send(FaceCommand.stimulus(this.screen(e.at, 2.5), e.strength));
          note = 'stimulus';
        }
        if (e.strength >= C.strongMotion && !this.bedtime) {
          this.life?.noteActivity('motion');
          note += ' · activity';
        }
        this.emit(e, note);
        break;
      }
      case 'gesture':
        this.handleGesture(e.gesture, e, snap, stale);
        break;
      default:
        this.emit(e);
    }
  }

  // MARK: Engagement diagnostics

  private diagnose(snap: PerceptionSnapshot): void {
    const onDiagnosis = this.onDiagnosis;
    if (onDiagnosis === null) return;
    const k = this._settings.engagementParams;
    let blocker: Blocker | null = null;
    const p = snap.engagedID === null ? snap.people.find((q) => q.id === snap.primaryID) ?? null : null;
    if (p !== null) {
      if (snap.stats.lowMode) blocker = 'asleep';
      else if (p.distance > k.maxDistance) blocker = 'tooFar';
      else if (p.gazeSource.kind === 'none') blocker = 'noReading';
      else if (p.lookingAtMe < k.enter) blocker = 'notLooking';
      else blocker = 'dwelling';
    }
    if (blocker === this.lastBlocker) return;
    if (blocker === null || p === null) { this.lastBlocker = null; return; }   // nobody, or engaged: the events say it
    if (!(snap.time - this.lastDiagnosisAt >= PerceptionCoordinator.diagnosisGap)) return;
    this.lastBlocker = blocker;
    this.lastDiagnosisAt = snap.time;
    switch (blocker) {
      case 'asleep': onDiagnosis('noticed · asleep (low rate, no eye contact until awake)'); break;
      case 'tooFar': onDiagnosis(`noticed · too far (${fmt(p.distance, 1)} m > ${fmt(k.maxDistance, 1)} m)`); break;
      case 'noReading': onDiagnosis('noticed · no face reading (face hidden, turned away or too small)'); break;
      case 'notLooking':
        onDiagnosis(`noticed · not facing (looking ${fmt(p.lookingAtMe, 2)} < ${fmt(k.enter, 2)}, facing ${fmt(p.facing, 2)})`);
        break;
      case 'dwelling': onDiagnosis(`noticed · looking (dwell ${fmt(p.dwell, 1)} / ${fmt(p.dwellNeeded, 1)} s)`); break;
    }
  }

  // MARK: Look-to-talk dry run

  /// Level-driven: while someone is engaged and Yanni is idle or noticing, show engaged; when nobody is engaged and
  /// the dry run put it there, go back to noticing. Only while the conversation loop is dormant (`dryRunAllowed`).
  applyDryRun(): void {
    if (!(this._settings.lookToTalkDryRun && this._dryRunAllowed && this._source !== 'simulated')) return;
    const st = this.agentState;
    if (this.latest.engagedID !== null) {
      if ((st === 'idle' || st === 'noticing') && this.awake) {
        this.face.setAgentState('engaged');
        this.dryRunActive = true;
      }
    } else if (this.dryRunActive) {
      if (st === 'engaged') this.face.setAgentState('noticing');
      this.dryRunActive = false;
    }
  }

  private endDryRun(): void {
    if (this.dryRunActive && this.agentState === 'engaged') this.face.setAgentState('noticing');
    this.dryRunActive = false;
  }

  // MARK: PerceptionCoordinator+Gestures.swift
  //
  // Gesture reactions: the reflex table's decision → glance, stimulus, impulse, then the beat (one-shot, cue with its
  // fallback, or edge antic with its fallback); the engagement hold's verdict back to the processor; the high-five's
  // touch window and confirmation; the dance along after the note eyes.

  handleGesture(g: GestureObservation, e: PerceptionEvent, snap: PerceptionSnapshot, stale: boolean): void {
    const now = snap.time;
    const holdsEngagement = g.directedAtYanni && g.phase !== 'ended' && g.distance <= this._settings.engageMaxDistance;
    if (!this._settings.gestureReactionsEnabled || stale) {
      if (holdsEngagement && g.personID !== null) this.mailbox.post({ kind: 'gestureBeat', id: g.personID, until: null });
      this.emit(e, stale ? 'stale' : 'reactions off');
      return;
    }
    const arrival = g.personID !== null ? this.arrivals.get(g.personID) : undefined;
    const ctx = makeReflexContext({
      agentState: this.agentState, isBedtime: this.bedtime, isSulking: this.face.perceptionIsSulking,
      primaryID: snap.primaryID, now, arrivedAt: arrival?.at ?? null, aloneBeforeArrival: arrival?.alone ?? 0,
      oneShotBusy: this.face.perceptionOneShotBusy, pupilShapeShowing: this.face.perceptionPupilShapeShowing,
      engagedID: snap.engagedID,
    });
    const fx = this.reflexes.decide(g, ctx);
    let note = fx.reason;
    if (g.phase !== 'ended' && !this.bedtime) this.face.send(FaceCommand.attend(g.personID));   // noticing: worth watching
    // Gaze first, then the impulse (the emotion layer), then the beat.
    if (fx.glanceAt !== null) this.face.send(FaceCommand.glance(this.screen(fx.glanceAt, g.distance), 0.5));
    if (fx.stimulus !== null) this.face.send(FaceCommand.stimulus(this.screen(fx.stimulus.at, g.distance), fx.stimulus.strength));
    if (fx.impulse !== null) this.onImpulse?.(fx.impulse, fx.reason);
    let beatSeconds: number | null = null;
    const beat = fx.beat;
    switch (beat.kind) {
      case 'none': break;
      case 'oneShot':
        this.play(beat.oneShot, fx.intensity, fx.softVoice);
        beatSeconds = OneShotLibrary.spec(beat.oneShot).duration;
        break;
      case 'cue': {
        const c = { ...beat.cue, id: this.nextCueID };
        this.nextCueID += 1;
        this.pendingCues.push({ id: c.id, fallback: fx.fallback, intensity: fx.intensity, deadline: now + 6, gesture: g.kind.kind });
        if (this.pendingCues.length > 8) this.pendingCues.shift();
        this.face.send(FaceCommand.reactionCue(c));
        if (fx.followUp !== null) {
          this.pendingBeats.push({ due: now + fx.followUp.after, kind: fx.followUp.kind, cueID: c.id, gesture: g.kind.kind });
        }
        beatSeconds = 2;
        break;
      }
      case 'edgeAntic':
        if (this.face.playPerceptionEdgeAntic(beat.oneShot, beat.side)) {
          beatSeconds = 2.5;
        } else if (fx.fallback !== null) {
          const fb = fx.fallback;
          this.play(fb, fx.intensity, false);
          note = `${g.kind.kind} → ${fb} (antic not allowed now)`;
          beatSeconds = OneShotLibrary.spec(fb).duration;
        }
        break;
    }
    if (fx.friendlyTouchUntil !== null) {
      const until = fx.friendlyTouchUntil;
      this.face.noteFriendlyTouch(until);
      this.highFiveArmedFor = { id: g.personID, until };
      beatSeconds = until - now;
    }
    if (holdsEngagement && g.personID !== null) {
      this.mailbox.post({ kind: 'gestureBeat', id: g.personID, until: beatSeconds !== null ? now + beatSeconds : null });
    }
    if (fx.activity && !this.bedtime && g.directedAtYanni) this.life?.noteActivity('motion');
    this.emit(e, note);
  }

  play(k: OneShotKind, intensity: number, softVoice: boolean): void {
    if (intensity < 1 || softVoice) {
      this.face.send(FaceCommand.play(OneShotRequest.make(k, { intensity, softVoice })));
    } else {
      this.face.send(FaceCommand.playOneShot(k));
    }
  }

  /// Per ingest: the arbiter's verdicts on our cues (fallbacks), due follow-up beats, a confirmed high-five.
  pollReactions(snap: PerceptionSnapshot, stale: boolean): void {
    const now = snap.time;
    const arb = this.face.perceptionArbiterEvents;
    if (arb.serial !== this.lastArbiterSerial) {
      const since = this.lastArbiterSerial;
      this.lastArbiterSerial = arb.serial;
      for (const ev of arb.events) {
        if (!(ev.serial > since)) continue;
        const w = ev.what;
        if (w.kind !== 'decision' || w.cue.source !== 'perception' || w.reason === 'waiting') continue;
        const i = this.pendingCues.findIndex((q) => q.id === w.cue.id);
        if (i < 0) continue;
        const p = this.pendingCues.splice(i, 1)[0];
        if (w.reason === 'accepted') continue;
        this.pendingBeats = this.pendingBeats.filter((b) => b.cueID !== p.id);
        if (PerceptionCoordinator.fallbackReasons.has(w.reason) && p.fallback !== null && !this.face.perceptionOneShotBusy) {
          this.play(p.fallback, p.intensity, false);
          this.note(`${p.gesture} → ${p.fallback} (cue ${w.reason})`);
        } else {
          this.note(`${p.gesture}: cue ${w.reason}`);
        }
      }
    }
    this.pendingCues = this.pendingCues.filter((q) => !(now > q.deadline));
    // Follow-up beats (the dance along): only if it's still a good moment.
    let i = 0;
    while (i < this.pendingBeats.length) {
      const b = this.pendingBeats[i];
      if (!(now >= b.due)) { i += 1; continue; }
      this.pendingBeats.splice(i, 1);
      const st = this.agentState;
      if (PerceptionReflexes.beatStates.has(st) && !this.bedtime && !this.face.perceptionIsSulking && !stale) {
        if (this.face.perceptionOneShotBusy && !this.face.perceptionPupilShapeShowing) {
          this.note(`${b.gesture}: ${b.kind} dropped (busy)`);
        } else {
          this.face.send(FaceCommand.playOneShot(b.kind));
          this.note(`${b.gesture} → ${b.kind} (along)`);
        }
      }
    }
    // A tap inside the friendly-touch window was a high-five (the engine already played the big squint).
    const count = this.face.perceptionHighFiveCount;
    const last = this.lastHighFiveCount, armed = this.highFiveArmedFor;
    if (last !== null && count > last && armed !== null) {
      const p = armed.id !== null ? snap.people.find((q) => q.id === armed.id) : undefined;
      const g = makeGestureObservation({
        kind: { kind: 'highFive' }, personID: armed.id, hand: null, confidence: 1, directedAtYanni: true,
        at: p?.position ?? { x: 0, y: 0 }, distance: p?.distance ?? 1, time: now, source: { kind: 'touch' },
      });
      const ctx = makeReflexContext({
        agentState: this.agentState, isBedtime: this.bedtime, isSulking: this.face.perceptionIsSulking,
        primaryID: snap.primaryID, now, engagedID: snap.engagedID,
      });
      const fx = this.reflexes.decide(g, ctx);
      if (fx.impulse !== null) this.onImpulse?.(fx.impulse, fx.reason);
      if (fx.activity && !this.bedtime) this.life?.noteActivity('motion');
      this.highFiveArmedFor = null;
      this.emit({ kind: 'gesture', gesture: g }, fx.reason);
    }
    this.lastHighFiveCount = count;
  }

  private note(outcome: string): void { this.addReaction({ event: 'gesture', outcome }); }
}
