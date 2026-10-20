// Port of FaceEngine/Modifiers/Attention.swift.
import type { V2 } from '../../core/vec';
import type { GazeMoveMode, PersonTarget } from '../Commands';
import { Ease } from '../Easing';
import { makeGazeTarget, type FaceState, type GazeIntent, type GazeTarget } from '../FaceState';
import { GazeOneEuroFilter } from '../GazeOneEuroFilter';
import { GazeClock, gazeClamp, gazeClampEllipse, gazeLength } from '../GazeSupport';
import { Phase, type Modifier } from '../Modifier';

const K = {
  // Idle fixation process (no people).
  fixationMedian: 1.2,
  fixationSigma: 0.5,
  fixationClamp: [0.3, 5] as const,
  microShiftP: 0.65,
  glanceP: 0.25, // remaining 0.10: return toward centre
  microShift: 0.12,
  glanceRadii: { x: 0.9, y: 0.5 },
  interestDecayP: 0.4,
  driftP: 0.08,
  glanceHoldScale: 0.75,
  wanderDistance: 2.0,
  // Idle with people.
  personFixationMedian: 1.4,
  personMicroP: 0.55,
  personHopP: 0.30, // remaining 0.15: glance away
  personMicroShift: { x: 0.06, y: 0.05 },
  personReturnP: 0.6,
  salienceFloor: 0.15,
  // Track.
  saccadeEnter: 0.2,
  saccadeExit: 0.08,
  refractory: 0.18,
  minSaccadeHold: 0.05,
  maxSaccadeHold: 0.5,
  latchLead: 0.12,
  trackOffset: { x: 0.035, y: 0.025 },
  trackOffsetMedian: 0.9,
  // Thinking.
  thinkAnchor: { x: 0.55, y: -0.7 },
  thinkWander: { x: 0.15, y: 0.10 },
  thinkSwitchP: 0.15,
  thinkDistance: 3.0,
  // Look away.
  lookAwayAnchor: { x: 0.7, y: 0.35 },
  lookAwayWander: { x: 0.1, y: 0.08 },
  // Rest.
  restDrift: { x: 0.04, y: 0.03 },
  restCommandTimeout: 20,
  // Commands.
  glanceDuration: [0.4, 0.7] as const,
  returnHold: 0.35,
  overrideReturnHold: 0.4,
} as const;

type Kind = 'idle' | 'track' | 'thinking' | 'rest' | 'lookAway';

const ZERO: Readonly<V2> = Object.freeze({ x: 0, y: 0 });

/// Decides where the eyes should look each frame (`s.gazeTarget`), in priority order:
///
/// 1. a one-shot gaze override (`s.oneShot.gaze`) — idle scheduling pauses while it is active;
/// 2. an active `.glance(at:duration:)` command, then a return;
/// 3. an active `.stimulus(at:strength:)` reaction (decided once, at the event), then loss of interest;
/// 4. the agent state's `s.gazeIntent` (idle fixations / people-hopping, track, thinking, rest, look away).
///
/// Person positions are camera-relative; `s.cameraOffsetMetres` corrects them (`cameraCorrection`).
/// All randomness is drawn at scheduled events, quantised to a 1/60 s grid (see `GazeClock`).
export class Attention implements Modifier {
  readonly name = 'Attention';
  readonly phase = Phase.attention;
  isEnabled = true;

  /// Degrees of visual angle per normalised gaze unit (x, y).
  static readonly gazeUnitDegrees: Readonly<V2> = Object.freeze({ x: 35, y: 25 });

  /// The gaze-space correction for a camera `offset` metres from the screen centre (x + toward the viewer's right,
  /// y + down): `atan(offset / distance)` per axis, in degrees ÷ `gazeUnitDegrees`.
  static cameraCorrection(offset: V2, distance: number): V2 {
    if (!(Number.isFinite(offset.x) && Number.isFinite(offset.y)) || (offset.x === 0 && offset.y === 0)) return { x: 0, y: 0 };
    const d = Number.isFinite(distance) ? Math.max(distance, 0.2) : 1.5;
    const k = 180 / Math.PI;
    return {
      x: Math.atan(offset.x / d) * k / Attention.gazeUnitDegrees.x,
      y: Math.atan(offset.y / d) * k / Attention.gazeUnitDegrees.y,
    };
  }

  /// The person's screen-relative position (camera calibration applied).
  private calibratedPosition(p: PersonTarget, s: FaceState): V2 {
    const c = Attention.cameraCorrection(s.cameraOffsetMetres, p.distance);
    return { x: p.position.x + c.x, y: p.position.y + c.y };
  }

  private static kindOf(i: GazeIntent): Kind { return i.kind; }

  // MARK: State

  private started = false;
  private kind: Kind = 'idle';
  private restIntentPoint: V2 = { x: 0, y: 0 };
  private lastOutput: GazeTarget = makeGazeTarget(ZERO, 'saccade');

  // Fixation (non-person targets).
  private fix: V2 = { x: 0, y: 0 };
  private fixMode: GazeMoveMode = 'saccade';
  private fixDistance: number = K.wanderDistance;
  private prevFix: V2 = { x: 0, y: 0 };
  private lastWasGlance = false;
  private nextEventAt = 0;

  // Smooth drift between fixations.
  private driftActive = false;
  private driftFrom: V2 = { x: 0, y: 0 };
  private driftTo: V2 = { x: 0, y: 0 };
  private driftStart = 0;
  private driftDuration = 1;

  // Following a person.
  private followID: number | null = null;
  private prevFollowID: number | null = null;
  private followOffset: V2 = { x: 0, y: 0 };
  private filter = new GazeOneEuroFilter();
  private filterID: number | null = null;
  private followSaccading = false;
  private followLatched: V2 = { x: 0, y: 0 };
  private forceSaccade = false;
  private lastFollowSaccadeAt = -10;
  // Follow decisions run only on frames that reach a 1/60 s grid point (60 and 120 fps switch identically).
  private lastGridIndex = -Infinity;
  private onGridFrame = true;
  private gridGaze: V2 = { x: 0, y: 0 };
  private nextOffsetAt = 0;

  // Interrupts.
  private glanceActive = false;
  private glancePoint: V2 = { x: 0, y: 0 };
  private glanceEnd = 0;
  private stimActive = false;
  private stimPoint: V2 = { x: 0, y: 0 };
  private stimEnd = 0;
  private stimStrength = 0;
  private lastStimPoint: V2 = { x: 0, y: 0 };
  private lastStimAt = -100;
  private overrideActive = false;

  // `.restGaze(at:)` command.
  private restCommandPoint: V2 | null = null;
  private restCommandAt = 0;

  // Thinking / look-away side (−1 left, +1 right).
  private side = 1;

  // MARK: Update

  update(s: FaceState): void {
    const now = s.time;
    // `s.eyeGaze` is GazeTracking's output from the previous frame; keep it if that frame was a grid frame.
    if (this.onGridFrame) this.gridGaze = { ...s.eyeGaze };
    const gi = Math.floor(now * GazeClock.gridRate + GazeClock.tolerance * GazeClock.gridRate);
    this.onGridFrame = gi !== this.lastGridIndex;
    this.lastGridIndex = gi;
    if (!this.started) {
      this.started = true;
      this.kind = Attention.kindOf(s.gazeIntent);
      if (s.gazeIntent.kind === 'rest') this.restIntentPoint = gazeClamp(s.gazeIntent.at);
      // Schedule from the start of the first frame so the first event lands on the same grid point at any fps.
      this.enterIntent(s, now - s.dt);
    }

    this.processCommands(s);

    const k = Attention.kindOf(s.gazeIntent);
    let restChanged = false;
    if (s.gazeIntent.kind === 'rest') {
      const p = gazeClamp(s.gazeIntent.at);
      if (gazeLength({ x: p.x - this.restIntentPoint.x, y: p.y - this.restIntentPoint.y }) > 1e-4) {
        this.restIntentPoint = p;
        restChanged = true;
      }
    }
    if (k !== this.kind || restChanged) {
      this.kind = k;
      this.enterIntent(s, now);
    }

    // A rest point from `.restGaze` holds until a new target (someone appears) or a long timeout.
    if (this.restCommandPoint !== null && (s.people.length > 0 || now - this.restCommandAt > K.restCommandTimeout)) {
      this.restCommandPoint = null;
      this.nextEventAt = Math.min(this.nextEventAt, GazeClock.at(now, 0.1));
    }

    if (this.glanceActive && GazeClock.due(now, this.glanceEnd)) {
      this.glanceActive = false;
      if (s.oneShot.gaze === null) this.returnFromInterrupt(now);
    }
    if (this.stimActive && GazeClock.due(now, this.stimEnd)) {
      this.stimActive = false;
      if (s.oneShot.gaze === null && !this.glanceActive) this.returnFromInterrupt(now);
    }

    const override = s.oneShot.gaze;
    if (override === null && this.overrideActive) {
      this.overrideActive = false;
      this.returnFromInterrupt(now);
      this.nextEventAt = Math.max(this.nextEventAt, GazeClock.at(now, K.overrideReturnHold));
    }
    const interrupted = override !== null || this.glanceActive || this.stimActive;
    s.gazeInterrupted = interrupted;

    // The underlying behaviour always runs (filters stay current) but only schedules while uninterrupted.
    const underlying = this.updateUnderlying(s, !interrupted);

    if (override !== null) {
      this.overrideActive = true;
      s.gazeTarget = makeGazeTarget(gazeClamp(override.point), override.mode, ZERO, underlying.distance);
    } else if (this.glanceActive) {
      s.gazeTarget = makeGazeTarget(this.glancePoint, 'saccade', ZERO, underlying.distance);
    } else if (this.stimActive) {
      s.gazeTarget = makeGazeTarget(this.stimPoint, 'saccade', ZERO, K.wanderDistance);
    } else {
      s.gazeTarget = underlying;
    }
    this.lastOutput = s.gazeTarget;
  }

  // MARK: Commands

  private processCommands(s: FaceState): void {
    const now = s.time;
    for (const c of s.commands) {
      switch (c.kind) {
        case 'glance': {
          const d = c.duration > 0 ? Math.min(Math.max(c.duration, 0.2), 3) : s.rng.uniform(K.glanceDuration[0], K.glanceDuration[1]);
          this.glanceActive = true;
          this.glancePoint = gazeClamp(c.at);
          this.glanceEnd = GazeClock.at(now, d);
          this.stimActive = false;
          this.restCommandPoint = null;
          this.freezeDrift(now);
          break;
        }
        case 'stimulus': {
          const st = Math.min(Math.max(Number.isFinite(c.strength) ? c.strength : 0, 0), 1);
          const point = gazeClamp(c.at);
          let prob = (0.3 + 0.7 * st) * this.intentStimulusFactor;
          // Habituation: the same spot again soon is less interesting.
          if (now - this.lastStimAt < 4 && gazeLength({ x: point.x - this.lastStimPoint.x, y: point.y - this.lastStimPoint.y }) < 0.3) prob *= 0.4;
          if (this.stimActive && st <= this.stimStrength) prob *= 0.5;
          if (this.glanceActive) prob = 0;
          this.lastStimPoint = point;
          this.lastStimAt = now;
          const roll = s.rng.unit();
          if (roll < prob) {
            const linger = (0.35 + 0.9 * st) * s.rng.uniform(0.75, 1.3);
            this.stimActive = true;
            this.stimPoint = point;
            this.stimStrength = st;
            this.stimEnd = GazeClock.at(now, linger);
            this.restCommandPoint = null;
            this.freezeDrift(now);
          }
          break;
        }
        case 'restGaze': {
          const point = gazeClamp(c.at);
          this.restCommandPoint = point;
          this.restCommandAt = now;
          if ((this.kind === 'idle' || this.kind === 'track') && s.people.length === 0) {
            this.followID = null;
            this.driftActive = false;
            this.fix = point;
            this.fixMode = 'saccade';
            this.fixDistance = K.wanderDistance;
            this.lastWasGlance = false;
            this.nextEventAt = GazeClock.at(now, s.rng.uniform(1.5, 3));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private get intentStimulusFactor(): number {
    switch (this.kind) {
      case 'idle': return 1;
      case 'track': return 0.6;
      case 'thinking': case 'lookAway': return 0.5;
      case 'rest': return 0.3;
    }
  }

  // MARK: Intents

  private enterIntent(s: FaceState, now: number): void {
    this.freezeDrift(now);
    this.fix = { ...this.lastOutput.point };
    this.fixMode = 'saccade';
    this.lastWasGlance = false;
    switch (this.kind) {
      case 'idle':
        this.nextEventAt = GazeClock.at(now, s.rng.uniform(0.15, 0.5));
        break;
      case 'track':
        this.followID = null;
        this.nextOffsetAt = now;
        this.nextEventAt = GazeClock.at(now, s.rng.uniform(0.15, 0.5));
        break;
      case 'thinking':
        this.followID = null;
        if (Math.abs(this.lastOutput.point.x) > 0.2) this.side = this.lastOutput.point.x > 0 ? 1 : -1;
        else this.side = s.rng.chance(0.5) ? 1 : -1;
        this.fix = this.thinkPoint(s);
        this.fixDistance = K.thinkDistance;
        this.nextEventAt = GazeClock.at(now, s.rng.lognormal(1.6, 0.4, [0.7, 4]));
        break;
      case 'rest':
        this.followID = null;
        this.fix = { ...this.restIntentPoint };
        this.fixDistance = K.wanderDistance;
        this.nextEventAt = GazeClock.at(now, s.rng.uniform(1.5, 3));
        break;
      case 'lookAway': {
        this.followID = null;
        const px = this.primaryPosition(s)?.x;
        if (px !== undefined && Math.abs(px) > 0.1) this.side = px > 0 ? -1 : 1;
        else this.side = s.rng.chance(0.5) ? 1 : -1;
        this.fix = this.lookAwayPoint(s);
        this.fixDistance = K.wanderDistance;
        this.nextEventAt = GazeClock.at(now, s.rng.lognormal(2.0, 0.4, [0.8, 5]));
        break;
      }
    }
  }

  private updateUnderlying(s: FaceState, allowEvents: boolean): GazeTarget {
    const now = s.time;
    switch (this.kind) {
      case 'idle':
        return this.updateIdle(s, allowEvents);
      case 'track': {
        const pid = s.primaryPersonID;
        const idx = pid === null ? -1 : s.people.findIndex((p) => p.id === pid);
        if (idx >= 0) {
          if (this.followID !== pid) {
            this.followID = pid;
            this.forceSaccade = true;
            this.lastWasGlance = false;
          }
          if (allowEvents && GazeClock.due(now, this.nextOffsetAt)) {
            const x = s.rng.uniform(-1, 1), y = s.rng.uniform(-1, 1);
            this.followOffset = { x: x * K.trackOffset.x, y: y * K.trackOffset.y };
            this.nextOffsetAt = GazeClock.at(now, s.rng.lognormal(K.trackOffsetMedian, 0.4, [0.4, 2.5]));
          }
          return this.follow(s, idx, allowEvents, true);
        }
        return this.updateIdle(s, allowEvents);
      }
      case 'thinking':
        if (allowEvents && GazeClock.due(now, this.nextEventAt)) {
          if (s.rng.chance(K.thinkSwitchP)) {
            this.side = -this.side;
            this.freezeDrift(now);
            this.fix = this.thinkPoint(s);
            this.fixMode = 'saccade';
          } else {
            const to = this.thinkPoint(s);
            this.startDrift(to, s.rng.uniform(0.9, 1.8), now);
          }
          this.nextEventAt = GazeClock.at(now, s.rng.lognormal(1.6, 0.4, [0.7, 4]) + (this.driftActive ? this.driftDuration : 0));
        }
        return this.fixTarget(now);
      case 'rest':
        if (allowEvents && GazeClock.due(now, this.nextEventAt)) {
          const e = s.rng.inEllipse(K.restDrift.x, K.restDrift.y);
          const to = gazeClamp({ x: this.restIntentPoint.x + e.x, y: this.restIntentPoint.y + e.y });
          const d = s.rng.uniform(1.5, 3);
          this.startDrift(to, d, now);
          this.nextEventAt = GazeClock.at(now, d + s.rng.uniform(1, 2.5));
        }
        return this.fixTarget(now);
      case 'lookAway':
        if (allowEvents && GazeClock.due(now, this.nextEventAt)) {
          const to = this.lookAwayPoint(s);
          const d = s.rng.uniform(1, 2);
          this.startDrift(to, d, now);
          this.nextEventAt = GazeClock.at(now, d + s.rng.lognormal(1.2, 0.4, [0.5, 4]));
        }
        return this.fixTarget(now);
    }
  }

  // MARK: Idle

  private updateIdle(s: FaceState, allowEvents: boolean): GazeTarget {
    const now = s.time;
    let followIdx = -1;
    if (this.followID !== null) {
      const id = this.followID;
      followIdx = s.people.findIndex((p) => p.id === id);
      if (followIdx < 0) {
        // The person we were looking at left: hold where they were, look elsewhere soon.
        this.followID = null;
        this.prevFollowID = null;
        this.freezeDrift(now);
        this.fix = { ...this.lastOutput.point };
        this.fixMode = 'smooth';
        this.fixDistance = K.wanderDistance;
        this.nextEventAt = Math.min(this.nextEventAt, GazeClock.at(now, 0.25));
      }
    }
    if (allowEvents && GazeClock.due(now, this.nextEventAt)) {
      if (s.people.length === 0) this.idleEvent(s);
      else this.peopleEvent(s);
      const id = this.followID;
      followIdx = id !== null ? s.people.findIndex((p) => p.id === id) : -1;
    }
    if (followIdx >= 0) return this.follow(s, followIdx, allowEvents, false);
    return this.fixTarget(now);
  }

  private idleEvent(s: FaceState): void {
    const now = s.time;
    const current = this.currentFixPoint(now);
    const rate = Math.max(s.modulation.glanceRate, 0.1);
    this.fixDistance = K.wanderDistance;

    const rp = this.restCommandPoint;
    if (rp !== null) {
      const e = s.rng.inEllipse(K.restDrift.x, K.restDrift.y);
      this.startDrift(gazeClamp({ x: rp.x + e.x, y: rp.y + e.y }), s.rng.uniform(1.5, 3), now);
      this.nextEventAt = GazeClock.at(now, this.driftDuration + s.rng.uniform(1, 2.5));
      return;
    }

    let next: V2;
    let isGlance = false;
    if (this.lastWasGlance && s.rng.chance(K.interestDecayP)) {
      next = { ...this.prevFix }; // interest decay: back to where we were
    } else {
      const r = s.rng.unit();
      if (r < K.microShiftP) {
        const x = s.rng.uniform(-1, 1), y = s.rng.uniform(-1, 1);
        next = { x: current.x + x * K.microShift, y: current.y + y * K.microShift };
      } else if (r < K.microShiftP + K.glanceP) {
        this.prevFix = current;
        next = s.rng.inEllipse(K.glanceRadii.x, K.glanceRadii.y);
        isGlance = true;
      } else {
        const m = s.rng.uniform(0, 0.3);
        next = { x: current.x * m, y: current.y * m };
      }
    }
    next = gazeClampEllipse(next, K.glanceRadii);
    this.lastWasGlance = isGlance;

    let hold = s.rng.lognormal(K.fixationMedian, K.fixationSigma, K.fixationClamp) / rate;
    if (isGlance) hold *= K.glanceHoldScale;
    if (s.rng.chance(K.driftP)) {
      const dist = gazeLength({ x: next.x - current.x, y: next.y - current.y });
      const d = Math.min(Math.max(0.6 + 1.4 * dist, 0.6), 2.2) * s.rng.uniform(0.85, 1.15);
      this.startDrift(next, d, now);
      hold += d;
    } else {
      this.driftActive = false;
      this.fix = next;
      this.fixMode = 'saccade';
    }
    this.nextEventAt = GazeClock.at(now, hold);
  }

  private randomOffset(s: FaceState, k: V2, scale = 1): V2 {
    const x = s.rng.uniform(-1, 1), y = s.rng.uniform(-1, 1);
    return { x: x * k.x * scale, y: y * k.y * scale };
  }

  private peopleEvent(s: FaceState): void {
    const now = s.time;
    const rate = Math.max(s.modulation.glanceRate, 0.1);
    let isGlance = false;
    if (this.followID === null) {
      const back = this.prevFollowID;
      if (this.lastWasGlance && back !== null && s.people.some((p) => p.id === back) && s.rng.chance(K.personReturnP)) {
        this.followID = back;
      } else {
        this.followID = this.pickPerson(s, null);
      }
      this.followOffset = this.randomOffset(s, K.personMicroShift, 0.5);
      this.forceSaccade = true;
    } else {
      const r = s.rng.unit();
      if (r < K.personMicroP) {
        this.followOffset = this.randomOffset(s, K.personMicroShift);
        this.forceSaccade = true;
      } else if (r < K.personMicroP + K.personHopP) {
        if (s.people.length > 1) {
          this.followID = this.pickPerson(s, this.followID);
          this.followOffset = this.randomOffset(s, K.personMicroShift, 0.5);
        } else {
          this.followOffset = this.randomOffset(s, K.personMicroShift);
        }
        this.forceSaccade = true;
      } else {
        this.prevFollowID = this.followID;
        this.followID = null;
        this.freezeDrift(now);
        this.fix = s.rng.inEllipse(K.glanceRadii.x, K.glanceRadii.y);
        this.fixMode = 'saccade';
        this.fixDistance = K.wanderDistance;
        isGlance = true;
      }
    }
    this.lastWasGlance = isGlance;
    let hold = s.rng.lognormal(K.personFixationMedian, K.fixationSigma, [0.4, 5]) / rate;
    if (isGlance) hold *= 0.6;
    this.nextEventAt = GazeClock.at(now, hold);
  }

  /// Salience-weighted pick (allocation-free).
  private pickPerson(s: FaceState, excluding: number | null): number | null {
    let total = 0;
    for (const p of s.people) if (p.id !== excluding) total += K.salienceFloor + Math.max(p.salience, 0);
    if (!(total > 0)) return s.people.length > 0 ? s.people[0].id : null;
    let x = s.rng.unit() * total;
    let last: number | null = null;
    for (const p of s.people) {
      if (p.id === excluding) continue;
      x -= K.salienceFloor + Math.max(p.salience, 0);
      last = p.id;
      if (x < 0) return p.id;
    }
    return last;
  }

  // MARK: Following

  private follow(s: FaceState, idx: number, logic: boolean, contact: boolean): GazeTarget {
    const now = s.time;
    const person = s.people[idx];
    const position = gazeClamp(this.calibratedPosition(person, s));
    if (this.filterID !== person.id || !this.filter.initialized) {
      this.filter.reset(position);
      this.filterID = person.id;
    } else {
      this.filter.step(position, s.dt);
    }
    const pos = this.filter.value;
    const vel = this.filter.velocity;
    const aim = gazeClamp({ x: pos.x + this.followOffset.x, y: pos.y + this.followOffset.y });
    const distance = Number.isFinite(person.distance) ? Math.max(person.distance, 0.1) : 1.5;
    if (logic && this.onGridFrame) {
      if (this.followSaccading) {
        const since = now - this.lastFollowSaccadeAt;
        const g = this.gridGaze, l = this.followLatched;
        if ((gazeLength({ x: g.x - l.x, y: g.y - l.y }) < K.saccadeExit && since >= K.minSaccadeHold) || since > K.maxSaccadeHold) {
          this.followSaccading = false;
        }
      }
      const err = gazeLength({ x: aim.x - this.gridGaze.x, y: aim.y - this.gridGaze.y });
      if (this.forceSaccade || (!this.followSaccading && err > K.saccadeEnter && now - this.lastFollowSaccadeAt >= K.refractory)) {
        this.forceSaccade = false;
        this.followSaccading = true;
        this.followLatched = gazeClamp({ x: aim.x + vel.x * K.latchLead, y: aim.y + vel.y * K.latchLead });
        this.lastFollowSaccadeAt = now;
      }
    }
    if (this.followSaccading) return makeGazeTarget(this.followLatched, 'saccade', ZERO, distance, contact);
    return makeGazeTarget(aim, 'smooth', vel, distance, contact);
  }

  // MARK: Fixation helpers

  private thinkPoint(s: FaceState): V2 {
    const x = s.rng.uniform(-1, 1), y = s.rng.uniform(-1, 1);
    return gazeClamp({ x: K.thinkAnchor.x * this.side + x * K.thinkWander.x, y: K.thinkAnchor.y + y * K.thinkWander.y });
  }

  private lookAwayPoint(s: FaceState): V2 {
    const x = s.rng.uniform(-1, 1), y = s.rng.uniform(-1, 1);
    return gazeClamp({ x: K.lookAwayAnchor.x * this.side + x * K.lookAwayWander.x, y: K.lookAwayAnchor.y + y * K.lookAwayWander.y });
  }

  private primaryPosition(s: FaceState): V2 | null {
    const pid = s.primaryPersonID;
    if (pid === null) return null;
    const p = s.people.find((q) => q.id === pid);
    return p ? this.calibratedPosition(p, s) : null;
  }

  private currentFixPoint(now: number): V2 {
    if (!this.driftActive) return { ...this.fix };
    const p = Math.fround((now - this.driftStart) / this.driftDuration); // f32: Swift Float progress
    const e = Ease.smootherstep(p);
    return { x: this.driftFrom.x + (this.driftTo.x - this.driftFrom.x) * e, y: this.driftFrom.y + (this.driftTo.y - this.driftFrom.y) * e };
  }

  /// Stops a drift in place (so a following saccade starts from where the drift had got to).
  private freezeDrift(now: number): void {
    if (!this.driftActive) return;
    this.fix = this.currentFixPoint(now);
    this.driftActive = false;
  }

  private startDrift(to: V2, duration: number, now: number): void {
    this.driftFrom = this.currentFixPoint(now);
    this.driftTo = { ...to };
    this.driftStart = now;
    this.driftDuration = Math.fround(Math.max(duration, 0.1)); // f32: a Swift Float
    this.driftActive = true;
    this.fix = { ...to };
    this.fixMode = 'smooth';
  }

  private fixTarget(now: number): GazeTarget {
    if (this.driftActive) {
      const p = Math.fround((now - this.driftStart) / this.driftDuration); // f32: Swift Float progress
      if (p >= 1) {
        this.driftActive = false;
        this.fix = { ...this.driftTo };
        return makeGazeTarget(this.fix, 'smooth', ZERO, this.fixDistance);
      }
      const x = Ease.clamp01(p);
      const e = Ease.smootherstep(x);
      const f = this.driftFrom, t = this.driftTo;
      const dEase = 30 * x * x * (1 - x) * (1 - x); // derivative of smootherstep
      const k = dEase / this.driftDuration;
      return makeGazeTarget({ x: f.x + (t.x - f.x) * e, y: f.y + (t.y - f.y) * e }, 'smooth',
        { x: (t.x - f.x) * k, y: (t.y - f.y) * k }, this.fixDistance);
    }
    return makeGazeTarget(this.fix, this.fixMode, ZERO, this.fixDistance);
  }

  /// Back from a glance / stimulus / override: saccade back to the underlying target, hold a moment.
  private returnFromInterrupt(now: number): void {
    this.freezeDrift(now);
    this.fixMode = 'saccade';
    this.forceSaccade = this.followID !== null;
    this.nextEventAt = Math.max(this.nextEventAt, GazeClock.at(now, K.returnHold));
  }
}
