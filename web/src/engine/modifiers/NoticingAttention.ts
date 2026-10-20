// Port of FaceEngine/Modifiers/NoticingAttention.swift.
import type { V2, V4 } from '../../core/vec';
import type { Mood } from '../AgentState';
import type { GazeMoveMode, PersonTarget } from '../Commands';
import { OneShotOutput, makeGazeTarget, type FaceState } from '../FaceState';
import { gazeClamp, gazeLength } from '../GazeSupport';
import { Phase, type Modifier } from '../Modifier';
import { OneShotKindSet, OneShotRequest, isIdleGame, isPupilShape, makeOneShotCancel } from '../OneShots';
import { NoticingBeatCurves } from './NoticingBeatCurves';
import { BeatPose } from './ThinkingBeatCurves';
import { ThinkingBeats } from './ThinkingBeats';

// f32: Swift draws and adds these as Float; durations and clamp bounds that land on the 1/60 s frame grid tie with
// the frame time, so they must round as Float does or an event fires a frame early.
const f32 = Math.fround;

/// Where Yanni's interest is while noticing someone (noticing attention design §2).
export type NoticingInterest = 'inactive' | 'watching' | 'distracted' | 'checkIn';

/// What made Yanni snap back to watching (Tune read-out, tests).
export type NoticingSnap = 'facing' | 'engaged' | 'gesture' | 'approach' | 'tap' | 'newcomer';

/// Yanni's own thing while bored of watching someone (noticing attention design §3).
export type NoticingBeat = 'lookAround' | 'fly' | 'sigh' | 'lookDown' | 'hum' | 'pupilPlay' | 'sleepyDrift';

const BEATS: readonly NoticingBeat[] = ['lookAround', 'fly', 'sigh', 'lookDown', 'hum', 'pupilPlay', 'sleepyDrift'];

export const NoticingBeat = {
  allCases: BEATS,
  duration(b: NoticingBeat): number {
    switch (b) {
      case 'lookAround': return 3.4;
      case 'fly': return 2.9;
      case 'sigh': return 2.4;
      case 'lookDown': return 2.8;
      case 'hum': return 3.2;
      case 'pupilPlay': return 1.9;
      case 'sleepyDrift': return 3.6;
    }
  },
  /// Reduce Motion keeps only these (slow wander, no darting, no convergence).
  isGentle: (b: NoticingBeat): boolean => b !== 'fly' && b !== 'pupilPlay',
  /// A bedtime night wake and sleepy, sad or grumpy moods keep only these.
  isCalm: (b: NoticingBeat): boolean => NoticingBeat.isGentle(b) && b !== 'hum',
  /// Weighted by liveliness; dropped under heavy resource pressure.
  isFunny: (b: NoticingBeat): boolean => b === 'fly' || b === 'pupilPlay' || b === 'hum',
} as const;

export interface NoticingParams { side: number; amp: number; v: V4 }
const makeParams = (): NoticingParams => ({ side: 1, amp: 1, v: { x: 0.5, y: 0.5, z: 0.5, w: 0.5 } });

/// Attention phase, right after Attention: the noticing attention cycle (noticing attention design). While noticing
/// with the primary person in view, Yanni watches them (Attention's track plus an occasional short look-away), its
/// interest decays after a patience of 6–15 s (× mood), then it gets distracted and plays its own beats, checks in with
/// a quick look back every few seconds, and snaps back to watching with a silent "oh!" perk when the person faces it,
/// is engaged, gestures, approaches, taps, or someone new arrives. It never fights anything: only in `.noticing`,
/// never over a one-shot's gaze or Attention's glance / stimulus, a beat never starts over another one-shot.
export class NoticingAttention implements Modifier {
  readonly name = 'NoticingAttention';
  readonly phase = Phase.attention;
  isEnabled = true;

  // MARK: Tunables

  static readonly patience = [6, 15] as const;
  static readonly patienceClamp = [4, 20] as const;
  static readonly rekindlePatience = [4, 8] as const;
  static readonly facingThreshold = 0.35;
  static readonly facingHold = 3;
  static readonly lookAwayMedian = 3.8;
  static readonly lookAwayHold = [0.35, 0.7] as const;
  static readonly lookAwayReach = [0.35, 0.6] as const;
  static readonly lookAwaySettle = 1.5;
  static readonly gapMedian = 1.1;
  static readonly firstBeatDelay = [0.4, 0.9] as const;
  static readonly checkInMedian = 4.5;
  static readonly shortCheckIn = [0.6, 1.1] as const;
  static readonly longCheckIn = [1.8, 3.2] as const;
  static readonly longCheckInP = 0.3;
  static readonly checkInPerkP = 0.35;
  static readonly rekindleP = 0.4;
  static readonly approachSpeed = 0.45;
  static readonly approachCloser = 0.35;
  static readonly busyRetry = 0.4;
  static readonly releaseDuration = 0.12;
  static readonly snapPerkDuration = 0.55;
  static readonly checkInPerkDuration = 0.45;
  static readonly noteEyesGap = 120;

  /// The resource governor's rate (0.2…1): gaps ÷ rate; below 0.5 no funny beats.
  private _rate = 1;
  get rate(): number { return this._rate; }
  set rate(v: number) { this._rate = Number.isFinite(v) ? Math.min(Math.max(v, 0.2), 1) : 1; }

  // MARK: Read-outs (tests, Tune)

  interest: NoticingInterest = 'inactive';
  current: NoticingBeat | null = null;
  lastBeat: NoticingBeat | null = null;
  lastSnap: NoticingSnap | null = null;
  snapCount = 0;
  checkInCount = 0;
  /// Engine time interest decays (while watching).
  boredAt = Infinity;
  /// This frame's pose contribution.
  lastOutput = new OneShotOutput();
  /// True when this frame's gaze target is the modifier's own (a look-away or a distraction).
  ownsGaze = false;

  // MARK: State

  private wasActive = false;
  private prevBeat: NoticingBeat | null = null;
  private stateAt = 0;
  private nextLookAwayAt = Infinity;
  private lookAwayUntil = -Infinity;
  private lookAwayPoint: V2 = { x: 0, y: 0 };
  private beatT = 0;
  private p: NoticingParams = makeParams();
  private releasedAt: number | null = null;
  private nextBeatAt = Infinity;
  private nextCheckInAt = Infinity;
  private checkInUntil = 0;
  private checkInLong = false;
  private ownPoint: V2 = { x: 0, y: 0 };
  private beatFrom: V2 = { x: 0, y: 0 };
  private lastBeatGaze: V2 = { x: 0, y: 0 };
  private ownedLastFrame = false;
  private perkAt = -Infinity;
  private perkAmp = 0;
  private perkDuration = 0;
  private lastNoteEyesAt = -Infinity;
  // Triggers.
  private primaryID: number | null = null;
  private maxSeenID = Number.MIN_SAFE_INTEGER; // Swift Int.min sentinel
  private lastDistance = NaN;
  private approach = 0;
  private refDistance = NaN;
  private pending: NoticingBeat | null = null;
  /// Fly fixations (offsets from the start point), refilled in place at each fly.
  flyPath: V2[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));

  /// Plays one beat now (Tune), turning distracted first if needed.
  play(beat: NoticingBeat): void { this.pending = beat; }

  update(s: FaceState): void {
    const person = this.primary(s);
    const active = s.agentState === 'noticing' && person !== null;
    if (!active) {
      if (this.wasActive) this.leave(s);
      this.wasActive = false;
      this.apply(s, null);
      return;
    }
    if (person === null) return;
    if (!this.wasActive) this.enter(s, person);
    this.wasActive = true;
    this.triggers(s, person);
    this.step(s, person);
    this.apply(s, person);
  }

  // MARK: Inputs

  private primary(s: FaceState): PersonTarget | null {
    const id = s.primaryPersonID;
    if (id === null) return null;
    for (const p of s.people) if (p.id === id) return p;
    return null;
  }

  private facing(p: PersonTarget): boolean { return Math.max(p.facing, p.lookingAtMe) >= NoticingAttention.facingThreshold; }

  private engaged(s: FaceState): boolean {
    const id = s.engagedPersonID;
    if (id === null) return false;
    return s.people.some((p) => p.id === id);
  }

  private triggers(s: FaceState, person: PersonTarget): void {
    // Approach speed: smoothed distance rate (camera updates arrive in steps).
    const d = Number.isFinite(person.distance) ? person.distance : 1.5;
    if (Number.isFinite(this.lastDistance) && s.dt > 0) {
      const raw = (this.lastDistance - d) / s.dt;
      this.approach += (Math.min(Math.max(raw, -20), 20) - this.approach) * Math.min(s.dt / 0.35, 1);
    }
    this.lastDistance = d;
    let snap: NoticingSnap | null = null;
    let newcomer = person.id !== this.primaryID && this.primaryID !== null;
    for (const p of s.people) {
      if (p.id > this.maxSeenID) {
        if (this.maxSeenID !== Number.MIN_SAFE_INTEGER) newcomer = true;
        this.maxSeenID = p.id;
      }
    }
    this.primaryID = person.id;
    if (newcomer) snap = 'newcomer';
    for (const c of s.commands) {
      if (c.kind === 'tap') snap = 'tap';
      else if (c.kind === 'attend') snap = 'gesture';
    }
    if (this.approach > NoticingAttention.approachSpeed
      || (Number.isFinite(this.refDistance) && this.refDistance - d > NoticingAttention.approachCloser)) {
      snap = snap ?? 'approach';
    }
    if (this.facing(person)) snap = snap ?? 'facing';
    if (this.engaged(s)) snap = snap ?? 'engaged';
    if (snap !== null) this.snapBack(snap, s, person);
  }

  // MARK: State machine

  /// An idle game stops the moment the person deserves the eyes (it springs home; Attention takes the gaze).
  private cancelGame(s: FaceState): void {
    if (s.activeOneShots.some(isIdleGame) && s.oneShotCancels.length < 8) {
      s.oneShotCancels.push(makeOneShotCancel(OneShotKindSet.idleGames));
    }
  }

  private enter(s: FaceState, person: PersonTarget): void {
    this.cancelGame(s);
    this.primaryID = person.id;
    for (const p of s.people) this.maxSeenID = Math.max(this.maxSeenID, p.id);
    this.lastDistance = person.distance;
    this.approach = 0;
    this.startWatching(s, NoticingAttention.patience);
    this.lastSnap = null;
  }

  private leave(s: FaceState): void {
    this.interest = 'inactive';
    this.boredAt = Infinity;
    this.lookAwayUntil = -Infinity;
    this.nextBeatAt = Infinity;
    this.pending = null;
    if (this.current !== null && this.releasedAt === null) this.releasedAt = s.time;
    this.primaryID = null;
  }

  private startWatching(s: FaceState, range: readonly [number, number]): void {
    const N = NoticingAttention;
    this.interest = 'watching';
    this.stateAt = s.time;
    const pt = s.rng.uniform(range[0], range[1]) * N.patienceScale(s.mood);
    this.boredAt = s.time + f32(Math.min(Math.max(pt, N.patienceClamp[0]), N.patienceClamp[1]));
    this.refDistance = NaN;
    this.lookAwayUntil = -Infinity;
    this.scheduleLookAway(s, N.lookAwaySettle);
    this.nextBeatAt = Infinity;
    this.nextCheckInAt = Infinity;
  }

  private snapBack(r: NoticingSnap, s: FaceState, _person: PersonTarget): void {
    const N = NoticingAttention;
    const now = s.time;
    this.cancelGame(s);
    if (this.interest === 'watching') {
      // Already watching: interest is refreshed (facing holds it while it lasts).
      this.boredAt = Math.max(this.boredAt, now + (r === 'facing' || r === 'engaged' ? N.facingHold : N.patience[0]));
      if (this.lookAwayUntil > now) this.lookAwayUntil = now;
      if (r === 'facing' || r === 'engaged') this.nextLookAwayAt = Math.max(this.nextLookAwayAt, now + N.lookAwaySettle);
      return;
    }
    const wasDistracted = this.interest === 'distracted';
    if (this.current !== null && this.releasedAt === null) this.releasedAt = now;
    this.pending = null;
    this.lastSnap = r;
    this.snapCount += 1;
    this.startWatching(s, N.patience);
    // The silent "oh!": full from a distraction, smaller in the middle of a check-in.
    this.perkAt = now;
    this.perkDuration = N.snapPerkDuration;
    this.perkAmp = (wasDistracted ? 1 : 0.6) * this.moodAmplitude(s) * (s.isBedtime ? 0.6 : 1);
  }

  private step(s: FaceState, person: PersonTarget): void {
    const N = NoticingAttention;
    const now = s.time;
    const b0 = this.pending;
    if (b0 !== null && (this.interest !== 'distracted' || this.current === null)) {
      if (this.interest !== 'distracted') this.becomeDistracted(s);
      if (this.current === null) { this.pending = null; this.start(b0, s); }
    }
    switch (this.interest) {
      case 'inactive':
        break;
      case 'watching':
        if (now >= this.boredAt) {
          this.becomeDistracted(s);
        } else if (now >= this.nextLookAwayAt && this.lookAwayUntil < now && !this.facing(person)) {
          if (s.activeOneShots.length === 0) {
            const hold = f32(s.rng.uniform(N.lookAwayHold[0], N.lookAwayHold[1]) * (s.reduceMotion ? 1.8 : 1));
            const a = s.rng.uniform(0, 2 * Math.PI);
            const reach = s.rng.uniform(N.lookAwayReach[0], N.lookAwayReach[1]);
            const pt = s.gazeTarget.point;
            let dir = { x: Math.cos(a), y: Math.sin(a) * 0.7 };
            // Away from the edge, into the room.
            if (gazeLength({ x: pt.x + dir.x * reach, y: pt.y + dir.y * reach }) > 0.95) dir = { x: -dir.x, y: -dir.y };
            this.lookAwayPoint = gazeClamp({ x: pt.x + dir.x * reach, y: pt.y + dir.y * reach }, 0.95);
            this.lookAwayUntil = now + hold;
            this.scheduleLookAway(s, hold);
          } else {
            this.nextLookAwayAt = now + N.busyRetry;
          }
        }
        break;
      case 'distracted':
        // An idle game is Yanni's own thing too: it plays out uninterrupted (no check-in, no beat over it).
        if (s.activeOneShots.some(isIdleGame)) {
          if (this.current !== null && this.releasedAt === null) this.releasedAt = now;
          this.nextCheckInAt = Math.max(this.nextCheckInAt, now + N.busyRetry);
        } else if (this.current === null && now >= this.nextCheckInAt) {
          this.interest = 'checkIn';
          this.stateAt = now;
          this.checkInCount += 1;
          this.checkInLong = s.rng.chance(N.longCheckInP);
          const r = this.checkInLong ? N.longCheckIn : N.shortCheckIn;
          this.checkInUntil = now + f32(s.rng.uniform(r[0], r[1]));
          if (s.rng.chance(N.isCalm(s) ? 0.15 : N.checkInPerkP)) {
            this.perkAt = now;
            this.perkDuration = N.checkInPerkDuration;
            this.perkAmp = 0.5 * this.moodAmplitude(s) * s.motionScale;
          }
        } else if (this.current === null && now >= this.nextBeatAt) {
          if (s.activeOneShots.length > 0) {
            this.nextBeatAt = now + N.busyRetry;
          } else {
            const b = this.pick(s);
            if (b !== null) this.start(b, s);
            else this.nextBeatAt = now + 1;
          }
        }
        break;
      case 'checkIn':
        if (now >= this.checkInUntil) {
          if (this.checkInLong && s.rng.chance(N.rekindleP)) {
            this.startWatching(s, N.rekindlePatience);
          } else {
            this.interest = 'distracted';
            this.stateAt = now;
            // Back to what it was doing, or somewhere new.
            if (s.rng.chance(0.5)) this.ownPoint = this.roomPoint(s, s.gazeTarget.point);
            this.nextBeatAt = now + f32(s.rng.uniform(N.firstBeatDelay[0], N.firstBeatDelay[1]));
            this.scheduleCheckIn(s);
          }
        }
        break;
    }
  }

  private becomeDistracted(s: FaceState): void {
    const N = NoticingAttention;
    this.interest = 'distracted';
    this.stateAt = s.time;
    this.boredAt = Infinity;
    this.lookAwayUntil = -Infinity;
    this.refDistance = this.lastDistance;
    this.ownPoint = this.roomPoint(s, s.gazeTarget.point);
    this.nextBeatAt = s.time + f32(s.rng.uniform(N.firstBeatDelay[0], N.firstBeatDelay[1]));
    this.scheduleCheckIn(s);
  }

  private scheduleLookAway(s: FaceState, after: number): void {
    const N = NoticingAttention;
    const m = N.lookAwayMedian * (N.isGrumpy(s.mood) ? 0.6 : 1) / Math.max(this._rate, 0.2);
    this.nextLookAwayAt = s.time + after + f32(s.rng.lognormal(m, 0.4, [2, 8]));
  }

  private scheduleCheckIn(s: FaceState): void {
    const N = NoticingAttention;
    const m = N.checkInMedian * (N.isGrumpy(s.mood) ? 1.4 : 1);
    this.nextCheckInAt = s.time + f32(s.rng.lognormal(m, 0.35, [2.5, 9]));
  }

  /// Somewhere in the room away from `from` (the person): the other side, a random height.
  private roomPoint(s: FaceState, from: V2): V2 {
    const side = from.x > 0.1 ? -1 : (from.x < -0.1 ? 1 : (s.rng.chance(0.5) ? 1 : -1));
    const x = side * s.rng.uniform(0.35, 0.75);
    return { x, y: s.rng.uniform(-0.4, 0.35) };
  }

  // MARK: Beats

  private allowed(b: NoticingBeat, s: FaceState): boolean {
    const N = NoticingAttention;
    if (s.reduceMotion && !NoticingBeat.isGentle(b)) return false;
    if (N.isCalm(s) && !NoticingBeat.isCalm(b)) return false;
    if (this._rate < 0.5 && NoticingBeat.isFunny(b)) return false;
    if (b === 'sleepyDrift' && !(N.isTired(s.mood) || s.isBedtime)) return false;
    return true;
  }

  private weight(b: NoticingBeat, s: FaceState): number {
    const w = b === 'sleepyDrift' ? 2 : (NoticingBeat.isFunny(b) ? NoticingAttention.liveliness(s.mood) : 1);
    return b === this.prevBeat ? w * 0.3 : w; // the one before last comes back less often
  }

  /// Weighted pick (no allocation), never the last beat.
  private pick(s: FaceState): NoticingBeat | null {
    let total = 0;
    for (const b of BEATS) if (b !== this.lastBeat && this.allowed(b, s)) total += this.weight(b, s);
    if (!(total > 0)) return null;
    let x = s.rng.unit() * total;
    let last: NoticingBeat | null = null;
    for (const b of BEATS) {
      if (b === this.lastBeat || !this.allowed(b, s)) continue;
      x -= this.weight(b, s);
      last = b;
      if (x < 0) return b;
    }
    return last;
  }

  private start(b: NoticingBeat, s: FaceState): void {
    const N = NoticingAttention;
    this.current = b;
    this.prevBeat = this.lastBeat;
    this.lastBeat = b;
    this.beatT = 0;
    this.releasedAt = null;
    this.beatFrom = { ...this.ownPoint };
    const p = makeParams();
    p.side = this.ownPoint.x >= 0 ? 1 : -1;
    p.amp = this.moodAmplitude(s) * s.motionScale * (N.isCalm(s) ? 0.8 : 1);
    const vx = s.rng.unit(), vy = s.rng.unit(), vz = s.rng.unit(), vw = s.rng.unit();
    p.v = { x: vx, y: vy, z: vz, w: vw };
    this.p = p;
    if (b === 'fly') NoticingBeatCurves.fillFlyPath(this.flyPath, this.ownPoint, s.rng);
    if (b === 'hum' && s.pupilSettings.enabled && !s.isBedtime && !s.reduceMotion
      && s.time - this.lastNoteEyesAt >= N.noteEyesGap && !s.activeOneShots.some(isPupilShape)
      && s.rng.chance(1.0 / 3.0)) {
      // Humming with little notes in its eyes; the voice may chirp only if its idle rules allow it.
      this.lastNoteEyesAt = s.time;
      s.oneShotPlayRequests.push(OneShotRequest.make('noteEyes', { intensity: 0.5, softVoice: true }));
    }
  }

  private finish(s: FaceState): void {
    const N = NoticingAttention;
    const cut = this.releasedAt !== null;
    this.current = null;
    this.releasedAt = null;
    if (!cut) this.ownPoint = gazeClamp(this.lastBeatGaze, 0.95);
    if (this.interest !== 'distracted') return;
    const m = N.gapMedian * (N.isCalm(s) ? 1.5 : 1) / Math.max(N.liveliness(s.mood) * this._rate, 0.2);
    this.nextBeatAt = s.time + f32(s.rng.lognormal(m, 0.4, [0.4, 4]));
  }

  // MARK: Mood

  /// 0.5…1.5: how lively it is.
  static liveliness(m: Mood): number { return ThinkingBeats.liveliness(m); }
  static isGrumpy(m: Mood): boolean { return m.pleasure < -0.3; }
  static isTired(m: Mood): boolean { return m.arousal < -0.3; }
  static isCalm(s: FaceState): boolean { return ThinkingBeats.isCalm(s); }

  /// Curious, playful moods stay interested a little longer; grumpy and tired ones get bored sooner.
  static patienceScale(m: Mood): number {
    const N = NoticingAttention;
    return (0.7 + 0.3 * N.liveliness(m)) * (N.isGrumpy(m) ? 0.75 : 1) * (N.isTired(m) ? 0.85 : 1);
  }

  private moodAmplitude(s: FaceState): number {
    return Math.min(Math.max(0.8 + 0.2 * NoticingAttention.liveliness(s.mood), 0.85), 1.1);
  }

  // MARK: Output

  private apply(s: FaceState, person: PersonTarget | null): void {
    const N = NoticingAttention;
    s.noticingWatching = this.interest === 'watching' || this.interest === 'checkIn';
    this.lastOutput = new OneShotOutput();
    this.ownsGaze = false;
    const o = new OneShotOutput();
    let gaze: V2 | null = null;
    let continuous = false;
    let distance = 2;

    const b = this.current;
    if (b !== null) {
      let gain = 1;
      let live = true;
      if (this.releasedAt !== null) {
        gain = f32(1 - f32(s.time - this.releasedAt) / f32(N.releaseDuration));
        if (gain <= 0) { this.finish(s); live = false; }
      } else {
        this.beatT = f32(this.beatT + s.dt);
        if (this.beatT >= f32(NoticingBeat.duration(b))) { this.finish(s); live = false; }
      }
      if (live) {
        const pose = new BeatPose();
        NoticingBeatCurves.sample(b, this.beatT, this.p, this.beatFrom, this.flyPath, pose);
        addScaled(o, pose.o, gain);
        if (this.releasedAt === null) {
          gaze = pose.gaze;
          this.lastBeatGaze = { ...pose.gaze };
          continuous = pose.continuous;
          if (b === 'fly') distance = 0.5;
        }
      }
    }
    // Perks (snap back, check-in): small, silent, own curve.
    const pt = f32(s.time - this.perkAt);
    if (pt >= 0 && pt < f32(this.perkDuration)) {
      const pose = new BeatPose();
      NoticingBeatCurves.perk(pt, this.perkDuration, this.perkAmp * s.motionScale, pose);
      addScaled(o, pose.o, 1);
    }
    const so = s.oneShot;
    so.delta.addInPlace(o.delta);
    const l = so.lidCoverage, ol = o.lidCoverage;
    so.lidCoverage = { x: l.x + ol.x, y: l.y + ol.y, z: l.z + ol.z, w: l.w + ol.w };
    const bd = so.browDelta.raw, ob = o.browDelta.raw;
    for (let i = 0; i < bd.length; i++) bd[i] += ob[i];
    so.blink = o.blink >= so.blink ? o.blink : so.blink;
    so.faceScaleMul = { x: so.faceScaleMul.x * o.faceScaleMul.x, y: so.faceScaleMul.y * o.faceScaleMul.y };
    const e = so.eyeScaleMul, oe = o.eyeScaleMul;
    so.eyeScaleMul = { x: e.x * oe.x, y: e.y * oe.y, z: e.z * oe.z, w: e.w * oe.w };
    so.pupilSizeMul = { x: so.pupilSizeMul.x * o.pupilSizeMul.x, y: so.pupilSizeMul.y * o.pupilSizeMul.y };
    this.lastOutput = o;

    // Gaze: never over a one-shot's gaze or Attention's glance / stimulus.
    const owned = this.ownedLastFrame;
    this.ownedLastFrame = false;
    if (s.oneShot.gaze !== null || s.gazeInterrupted || person === null) return;
    if (this.interest === 'distracted') {
      if (gaze === null) { gaze = this.ownPoint; continuous = false; }
    } else if (this.interest === 'watching' && s.time < this.lookAwayUntil) {
      gaze = this.lookAwayPoint;
      continuous = false;
    }
    if (gaze === null) {
      // Handing back: straight to the person as a saccade (Attention may be mid-pursuit).
      if (owned) s.gazeTarget = { ...s.gazeTarget, mode: 'saccade' };
      return;
    }
    // Steps are saccades, paths pursuit (the first frame off the person is a saccade); Reduce Motion glides.
    const mode: GazeMoveMode = s.reduceMotion || (continuous && owned) ? 'smooth' : 'saccade';
    s.gazeTarget = makeGazeTarget(gazeClamp(gaze), mode, { x: 0, y: 0 }, distance);
    this.ownsGaze = true;
    this.ownedLastFrame = true;
  }
}

/// `o += x · gain` (Swift `NoticingAttention.add`): additive lanes scaled, multiplicative ones eased from 1.
function addScaled(o: OneShotOutput, x: OneShotOutput, gain: number): void {
  const d = o.delta.raw, xd = x.delta.raw;
  for (let i = 0; i < d.length; i++) d[i] += xd[i] * gain;
  const l = o.lidCoverage, xl = x.lidCoverage;
  o.lidCoverage = { x: l.x + xl.x * gain, y: l.y + xl.y * gain, z: l.z + xl.z * gain, w: l.w + xl.w * gain };
  const b = o.browDelta.raw, xb = x.browDelta.raw;
  for (let i = 0; i < b.length; i++) b[i] += xb[i] * gain;
  const xbk = x.blink * gain;
  o.blink = xbk >= o.blink ? xbk : o.blink;
  o.faceScaleMul = { x: o.faceScaleMul.x * (1 + (x.faceScaleMul.x - 1) * gain), y: o.faceScaleMul.y * (1 + (x.faceScaleMul.y - 1) * gain) };
  const e = o.eyeScaleMul, xe = x.eyeScaleMul;
  o.eyeScaleMul = {
    x: e.x * (1 + (xe.x - 1) * gain), y: e.y * (1 + (xe.y - 1) * gain),
    z: e.z * (1 + (xe.z - 1) * gain), w: e.w * (1 + (xe.w - 1) * gain),
  };
  o.pupilSizeMul = { x: o.pupilSizeMul.x * (1 + (x.pupilSizeMul.x - 1) * gain), y: o.pupilSizeMul.y * (1 + (x.pupilSizeMul.y - 1) * gain) };
}
