// Port of FacePerception/PerceptionProcessor.swift.
import type { V3 } from '../core/vec';
import { CameraGeometry } from './CameraGeometry';
import { EngagementManager, PrimarySelector, makeEngagementParams, type EngagementInput } from './Engagement';
import { AsymmetricSmoother, EyeContact, type EyeContactParams } from './EyeContact';
import { GestureRecognizer } from './GestureRecognizer';
import type { GesturePerson } from './Gestures';
import { MotionDetector } from './Motion';
import { PerceptionSettings } from './PerceptionSettings';
import {
  NRect, makePerceptionSnapshot, makePerceptionStats,
  type FrameDetections, type GazeSource, type GestureDecision, type GestureObservation, type PerceptionEvent,
  type PerceptionOutput, type PerceptionTier, type TrackedPerson,
} from './PerceptionTypes';
import { StagePlan, VacancyScheduler, type PressureLevel } from './TierPolicy';
import { PersonTracker } from './Tracker';

/// Commands for the processor from the app (the conversation loop, settings, the life cycle).
export type PerceptionCommand =
  | { kind: 'pinTurn'; id: number }
  | { kind: 'unpinTurn' }
  | { kind: 'noteEngagementOutcome'; id: number; spoke: boolean }
  | { kind: 'releaseTurn' }
  | { kind: 'reset' }
  | { kind: 'settings'; settings: PerceptionSettings }
  | { kind: 'cameraOffset'; offset: { x: number; y: number } }
  | { kind: 'tier'; tier: PerceptionTier }
  | { kind: 'lowMode'; on: boolean }
  /** The pressure level (the room-empty delay shortens under pressure). */
  | { kind: 'pressure'; level: PressureLevel }
  /** The coordinator's verdict on a directed gesture within engagement range (design §7): its beat plays until
   *  `until` (host seconds), or null when no beat plays — the engagement hold ends then. */
  | { kind: 'gestureBeat'; id: number; until: number | null };

export const PerceptionCommand = {
  equals(a: PerceptionCommand, b: PerceptionCommand): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'settings') return a.settings.equals((b as typeof a).settings);
    if (a.kind === 'cameraOffset') {
      const o = (b as typeof a).offset;
      return a.offset.x === o.x && a.offset.y === o.y;
    }
    return JSON.stringify(a) === JSON.stringify(b);
  },
} as const;

/// The mailbox the processor drains at the start of every frame.
// port-note: Swift's is a Mutex-guarded box shared across threads; the browser runs everything on one thread.
export class PerceptionMailbox {
  private box: PerceptionCommand[] = [];
  post(c: PerceptionCommand): void { this.box.push(c); }
  drain(): PerceptionCommand[] { const v = this.box; this.box = []; return v; }
}

interface ReadingValues { theta: number; max: number; source: GazeSource; gaze: V3; required: V3 }

/// The whole per-frame logic: tracker → eye contact → engagement → gestures → salience / primary → motion →
/// snapshot and events. Synchronous, owned by the analysis loop (or a test).
export class PerceptionProcessor {
  settings: PerceptionSettings;
  geometry: CameraGeometry;
  tier: PerceptionTier;
  lowMode = false;
  /// Room-empty duty cycle (awake): the pipeline runs `StagePlan.vacant` while `vacancy.isVacant`.
  vacancy = new VacancyScheduler();
  tracker: PersonTracker;
  engagement: EngagementManager;
  primary = new PrimarySelector();
  gestures: GestureRecognizer;
  motion = new MotionDetector();
  eyeParams: EyeContactParams;
  smoothers = new Map<number, AsymmetricSmoother>();
  facing = new Map<number, number>();
  lastReading = new Map<number, number>();
  lastReadingValues = new Map<number, ReadingValues>();
  lastLookAbove = new Map<number, number>();
  /// Last time each person's `lookingAtMe` was at or above the engagement enter level (the aimed-at gate).
  lastLookEnter = new Map<number, number>();
  lastTime: number | null = null;
  frameIndex = 0;

  constructor(settings: PerceptionSettings = new PerceptionSettings(), geometry: CameraGeometry = new CameraGeometry(),
    tier: PerceptionTier = 3) {
    const s = settings.validated();
    this.settings = s;
    // port-note: Swift copies the geometry struct; the processor mutates its own (intrinsics, offset).
    this.geometry = geometry.copy();
    this.tier = tier;
    this.tracker = new PersonTracker();
    this.engagement = new EngagementManager(s.engagementParams);
    this.gestures = new GestureRecognizer(s.gestureParams(tier));
    this.eyeParams = s.eyeContactParams;
    this.applyLimits();
  }

  applyLimits(): void {
    this.tracker.params.maxTracks = Math.min(this.settings.maxPeople, StagePlan.plan(this.tier).maxPeople);
  }

  // MARK: Commands

  /// Applies app commands; returns any events they cause (a released turn).
  apply(commands: PerceptionCommand[]): PerceptionEvent[] {
    const ev: PerceptionEvent[] = [];
    for (const c of commands) {
      switch (c.kind) {
        case 'pinTurn': this.engagement.pinTurn(c.id); break;
        case 'unpinTurn': this.engagement.unpinTurn(); break;
        case 'noteEngagementOutcome': this.engagement.noteEngagementOutcome(c.id, c.spoke); break;
        case 'releaseTurn': ev.push(...this.engagement.releaseTurn()); break;
        case 'reset': ev.push(...this.reset()); break;
        case 'settings':
          this.settings = c.settings.validated();
          this.engagement.params = this.settings.engagementParams;
          this.gestures.params = this.settings.gestureParams(this.tier);
          this.eyeParams = this.settings.eyeContactParams;
          this.applyLimits();
          break;
        case 'cameraOffset': this.geometry.cameraOffset = { ...c.offset }; break;
        case 'tier':
          this.tier = c.tier;
          this.gestures.params = this.settings.gestureParams(c.tier);
          this.applyLimits();
          break;
        case 'lowMode': this.lowMode = c.on; break;
        case 'pressure': this.vacancy.after = VacancyScheduler.after(c.level); break;
        case 'gestureBeat':
          if (c.until !== null) this.engagement.holdForGesture(c.id, c.until, true); else this.engagement.releaseGestureHold(c.id);
          break;
      }
    }
    return ev;
  }

  /// Forgets everyone (source change, perception off).
  reset(): PerceptionEvent[] {
    const ev = this.engagement.reset();
    const p = this.primary.primaryID;
    if (p !== null) ev.push({ kind: 'primaryChanged', from: p, to: null });
    this.tracker.reset(); this.primary.reset(); this.gestures.reset(); this.motion.reset(); this.vacancy.reset();
    this.smoothers.clear(); this.facing.clear(); this.lastReading.clear(); this.lastLookAbove.clear(); this.lastLookEnter.clear();
    this.lastTime = null;
    return ev;
  }

  // MARK: Per frame

  process(det: FrameDetections): PerceptionOutput {
    const now = det.time;
    const dt = Math.min(Math.max(now - (this.lastTime ?? now), 0), 0.5);
    this.lastTime = now;
    this.frameIndex += 1;
    this.geometry.intrinsics = det.intrinsics;
    this.tracker.protectedID = this.engagement.engagedID;
    const events: PerceptionEvent[] = this.tracker.update(det, this.geometry);
    const ep = this.settings.engagementParams;

    // Eye contact per visible person.
    const visible = this.tracker.visiblePeople(this.geometry);
    let people: TrackedPerson[] = [];
    const inputs: EngagementInput[] = [];
    const gesturePeople: GesturePerson[] = [];
    const imageH = det.intrinsics.imageSize.y;
    for (const v of visible) {
      const p: TrackedPerson = { ...v.person };
      const id = p.id;
      let smoother = this.smoothers.get(id);
      if (smoother === undefined) { smoother = new AsymmetricSmoother(); this.smoothers.set(id, smoother); }
      let hasReading = false;
      let eyes = false;
      let headAngle = 180;
      const r = !this.lowMode && v.face !== null ? EyeContact.evaluate(v.face, p.positionMetres, this.geometry, this.eyeParams) : null;
      if (r !== null) {
        hasReading = true;
        smoother.step(r.level, dt);
        this.facing.set(id, r.facing);
        this.lastReading.set(id, now);
        this.lastReadingValues.set(id, { theta: r.thetaDegrees, max: r.thetaMaxDegrees, source: r.source, gaze: r.gaze, required: r.required });
        headAngle = r.headToCameraDegrees;
        if (r.source.kind === 'eyes') eyes = true;
      } else if (now - (this.lastReading.get(id) ?? -Infinity) > ep.dropoutTolerance) {
        smoother.step(0, dt);
        this.facing.set(id, (this.facing.get(id) ?? 0) * Math.exp(-dt / 0.5));
        this.lastReadingValues.delete(id);
      }
      p.lookingAtMe = smoother.value;
      p.facing = this.facing.get(id) ?? 0;
      const rv = this.lastReadingValues.get(id);
      if (rv !== undefined) {
        p.gazeErrorDegrees = rv.theta; p.toleranceDegrees = rv.max; p.gazeSource = rv.source;
        p.gazeVector = rv.gaze; p.requiredVector = rv.required;
      }
      if (p.lookingAtMe >= ep.exit) this.lastLookAbove.set(id, now);
      if (p.lookingAtMe >= ep.enter) this.lastLookEnter.set(id, now);
      people.push(p);
      inputs.push({
        id, lookingAtMe: p.lookingAtMe, hasReading, eyes, distance: p.distance, faceHeightPx: (v.face?.box.h ?? 0) * imageH,
        headAngleDegrees: headAngle, live: v.live,
      });
      const head = p.faceBox !== null ? NRect.center(p.faceBox)
        : p.bodyBox !== null ? { x: NRect.center(p.bodyBox).x, y: p.bodyBox.y + p.bodyBox.h * 0.15 } : { x: 0.5, y: 0.5 };
      const rel = this.engagement.releasedAt.get(id);
      const released = rel !== undefined ? now - rel <= this.gestures.params.byeReleaseWindow : false;
      gesturePeople.push({
        id, headCentre: head, bodyBox: p.bodyBox, faceBox: p.faceBox, body: v.body, face: v.face, distance: p.distance,
        position: p.position, velocity: p.velocity, positionMetres: p.positionMetres, facing: p.facing,
        lastLook: this.lastLookEnter.get(id) ?? -Infinity, engaged: id === this.engagement.engagedID,
        primary: id === this.primary.primaryID, releasedRecently: released,
      });
    }

    // Gestures (primary only on the lower tiers), before engagement: an aimed gesture candidate holds the person's
    // engagement so its beat plays first (design §7).
    let started: GestureObservation[] = [];
    let decisions: GestureDecision[] = [];
    let rois: NRect[] = [];
    let held: number[] = [];
    if (!this.lowMode) {
      const plan = StagePlan.plan(this.tier);
      const gp = plan.gesturesPrimaryOnly ? gesturePeople.filter((q) => q.id === this.primary.primaryID) : gesturePeople;
      if (plan.handPose || plan.bodyPose) {
        this.gestures.update(det, gp, this.geometry);
        started = [...this.gestures.observations];
        decisions = [...this.gestures.decisions];
        rois = [...this.gestures.wristROIs];
        held = [...this.gestures.heldIDs];
        for (const g of started) {
          events.push({ kind: 'gesture', gesture: g });
          const id = g.personID;
          if (id === null) continue;
          this.primary.noteGesture(id, now);
          // A directed gesture within engagement range holds the engagement until the coordinator's verdict (its
          // beat's end, or no beat) arrives, capped by the engagement manager.
          if (g.directedAtYanni && g.phase !== 'ended' && g.distance <= this.settings.engageMaxDistance) {
            this.engagement.holdForGesture(id, now + makeEngagementParams().gestureHoldCap, false);
          }
        }
      }
    }

    // Engagement.
    const eng = this.engagement.update(inputs, now, dt, held);
    events.push(...eng.events);
    for (const p of people) {
      const o = eng.out.get(p.id);
      if (o !== undefined) { p.lookingFor = o.lookingFor; p.dwell = o.dwell; p.dwellNeeded = o.dwellNeeded; }
      p.engaged = p.id === this.engagement.engagedID;
    }

    // Salience and primary.
    for (const p of people) p.salience = this.primary.salience(p, now, p.engaged);
    const limit = Math.min(this.settings.maxPeople, StagePlan.plan(this.tier).maxPeople);
    if (people.length > limit) {
      people.sort((a, b) => ((b.engaged ? 2 : 0) + b.salience) - ((a.engaged ? 2 : 0) + a.salience));
      people = people.slice(0, limit);
    }
    people.sort((a, b) => a.id - b.id);
    const pe = this.primary.update(people, this.engagement.engagedID, now);
    if (pe !== null) events.push(pe);

    // Motion not explained by people.
    let moved = false;
    const grid = det.motion;
    if (!this.lowMode && grid !== null) {
      const boxes: NRect[] = [];
      for (const p of people) {
        if (p.bodyBox !== null) boxes.push(p.bodyBox);
        else if (p.faceBox !== null) boxes.push(NRect.insetBy(p.faceBox, 0.6));
      }
      const m = this.motion.update(grid, now, boxes, this.geometry);
      if (m !== null) { events.push(m); moved = true; }
    }
    this.vacancy.note(moved || det.bodies.length > 0 || det.faces.length > 0 || people.length > 0, now);

    // Drop smoothing state for people no longer tracked.
    if (this.frameIndex % 30 === 0) {
      const live = new Set(people.map((p) => p.id));
      for (const id of [...this.smoothers.keys()]) {
        if (live.has(id) || !(now - (this.lastReading.get(id) ?? -Infinity) > 10)) continue;
        this.smoothers.delete(id); this.facing.delete(id); this.lastReading.delete(id); this.lastLookAbove.delete(id);
        this.lastReadingValues.delete(id); this.lastLookEnter.delete(id);
      }
    }

    const stats = makePerceptionStats();
    stats.tier = this.tier;
    stats.lowMode = this.lowMode;
    stats.vacant = !this.lowMode && this.vacancy.isVacant(now);
    stats.faces = det.faces.length;
    stats.facesWithEyes = det.faces.filter((f) => f.eyes !== null || f.gaze !== null).length;
    stats.bodies = det.bodies.length;
    stats.hands = det.hands.length;
    stats.falseEngagementsPerHour = this.engagement.falseEngagementsPerHour;
    const snap = makePerceptionSnapshot({
      time: now, people, primaryID: this.primary.primaryID, engagedID: this.engagement.engagedID,
      waitingIDs: [...this.engagement.waiting], turnPinned: this.engagement.pinned, gestures: started, stats,
      gestureDecisions: decisions, wristROIs: rois,
    });
    return { snapshot: snap, events };
  }
}
