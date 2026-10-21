// Port of FacePerception/Engagement.swift.
import { clamp, vlength2 } from './PerceptionTypes';
import type { DisengageReason, PerceptionEvent, TrackedPerson } from './PerceptionTypes';

/// Look-to-talk tunables (from `PerceptionSettings`).
export interface EngagementParams {
  /// Eye-contact hysteresis on `lookingAtMe`.
  enter: number;
  exit: number;
  /// Dwell to engage (seconds): eyes / head-pose fallback.
  dwell: number;
  dwellHeadOnly: number;
  /// Blinks and detection dropouts up to this long don't break contact.
  dropoutTolerance: number;
  /// After a longer look-away the dwell decays at this multiple of the rise rate.
  decayRate: number;
  /// "A few feet": no engagement beyond this distance.
  maxDistance: number;
  /// Face quality: box at least this tall (pixels) and the head within this angle of the camera.
  minFacePx: number;
  maxHeadAngleDegrees: number;
  /// Release outside a conversation: not looking this long, out of range this long, gone this long.
  releaseAfter: number;
  outOfRangeRelease: number;
  goneRelease: number;
  /// The same person within this long of a release re-engages with `reengageDwell`.
  reengageWindow: number;
  reengageDwell: number;
  /// A waiter still looking (≥ `waiterMinLooking`) within this long of the release takes the turn at once.
  waiterGrace: number;
  waiterMinLooking: number;
  /// False-engagement damping: after this many engagements in a row without speech, the person's dwell is multiplied
  /// by `dampingFactor` for `dampingSeconds`.
  dampingAfter: number;
  dampingFactor: number;
  dampingSeconds: number;
  /// `lookingAtMe(id, seconds)` milestones.
  milestones: number[];
  /// Engagement hold for a directed gesture (design §7): at most this long from when it first holds back an
  /// engagement; an engagement within `gestureStartedWindow` after a directed gesture beat is gesture-started.
  gestureHoldCap: number;
  gestureStartedWindow: number;
}
export const makeEngagementParams = (o: Partial<EngagementParams> = {}): EngagementParams => ({
  enter: 0.6, exit: 0.35, dwell: 1.0, dwellHeadOnly: 1.4, dropoutTolerance: 0.2, decayRate: 2, maxDistance: 1.6,
  minFacePx: 48, maxHeadAngleDegrees: 50, releaseAfter: 2.5, outOfRangeRelease: 2, goneRelease: 0.5,
  reengageWindow: 4, reengageDwell: 0.5, waiterGrace: 3, waiterMinLooking: 0.35, dampingAfter: 2, dampingFactor: 2,
  dampingSeconds: 120, milestones: [0.5, 1, 2, 5], gestureHoldCap: 1.5, gestureStartedWindow: 3, ...o,
});

/// Per-person engagement inputs for one frame.
export interface EngagementInput {
  id: number;
  lookingAtMe: number;
  /// A fresh eye-contact reading this frame (false: detection dropout, the level is held).
  hasReading: boolean;
  eyes: boolean;
  distance: number;
  faceHeightPx: number;
  headAngleDegrees: number;
  /// The track has moved or blinked since it appeared (posters and photos never engage).
  live: boolean;
}
export const makeEngagementInput = (o: Omit<EngagementInput, 'live'> & { live?: boolean }): EngagementInput =>
  ({ live: true, ...o });

/// Per-person engagement read-outs for one frame.
export interface EngagementOutput { lookingFor: number; dwell: number; dwellNeeded: number }

interface Person {
  contact: boolean;
  acc: number;
  lastContact: number;
  lookingStart: number | null;
  nextMilestone: number;
  lastAboveWaiter: number;
  lastLooking: number;   // last time lookingAtMe ≥ exit
  outOfRangeSince: number | null;
  lastSeen: number;
  metRuleAt: number | null;
}
const makePerson = (): Person => ({
  contact: false, acc: 0, lastContact: -Infinity, lookingStart: null, nextMilestone: 0, lastAboveWaiter: -Infinity,
  lastLooking: -Infinity, outOfRangeSince: null, lastSeen: 0, metRuleAt: null,
});

/// Gesture holds: until when (host seconds), when the hold first held back an engagement, and whether a beat is
/// playing (vs. the provisional hold until the coordinator's verdict).
interface GestureHold { until: number; blockingSince: number | null; beat: boolean }

/// Who is looking (dwell, hysteresis) and who holds the turn (first come, first served, a FIFO of waiters).
/// Synchronous and deterministic.
///
/// port-note: Swift dictionaries iterate in no fixed order; the Maps here iterate in insertion order. The only
/// order-dependent spot (candidates) is sorted with full tie-breaks, so results match.
export class EngagementManager {
  params: EngagementParams;
  people = new Map<number, Person>();
  engagedID: number | null = null;
  waiting: number[] = [];
  pinned = false;
  turnSerial = 0;
  wantsTurnFired = new Map<number, number>();     // id → turn serial
  releasedAt = new Map<number, number>();
  noSpeech = new Map<number, number>();
  dampedUntil = new Map<number, number>();
  falseEngagements: number[] = [];
  lastRelease = -Infinity;
  now = 0;
  start: number | null = null;
  unpinnedAt = -Infinity;
  holds = new Map<number, GestureHold>();
  lastGestureBeat = new Map<number, number>();
  /// Whether each person's current (or last) engagement was gesture-started.
  gestureStarted = new Map<number, boolean>();
  /// Read-out: engagements released by a gesture hold (tests, status).
  gestureHoldReleases = 0;

  constructor(params: EngagementParams = makeEngagementParams()) { this.params = params; }

  // MARK: Conversation-loop API (applied by the processor)

  /// Holds the turn through look-aways and range changes (a conversation is under way).
  pinTurn(id: number): void {
    if (id !== this.engagedID) return;
    this.pinned = true;
  }

  /// Normal release rules resume (their timers restart now).
  unpinTurn(): void {
    if (!this.pinned) return;
    this.pinned = false;
    this.unpinnedAt = this.now;
    const p = this.engagedID === null ? undefined : this.people.get(this.engagedID);
    if (p !== undefined) { p.lastLooking = this.now; p.outOfRangeSince = null; }
  }

  /// Ends the current turn.
  releaseTurn(): PerceptionEvent[] {
    if (this.engagedID === null) return [];
    return this.release(this.engagedID, 'released');
  }

  /// The conversation loop says whether an engagement led to speech. Two in a row without speech double that
  /// person's dwell for `dampingSeconds`; each one without speech counts toward false engagements per hour.
  noteEngagementOutcome(id: number, spoke: boolean): void {
    if (spoke) {
      this.noSpeech.set(id, 0);
      this.gestureStarted.set(id, false);
      return;
    }
    // A gesture-started engagement is not a "no speech" engagement: no count, no damping (design §7).
    if (this.gestureStarted.get(id) === true) { this.gestureStarted.set(id, false); return; }
    this.falseEngagements.push(this.now);
    const n = (this.noSpeech.get(id) ?? 0) + 1;
    if (n >= this.params.dampingAfter) {
      this.dampedUntil.set(id, this.now + this.params.dampingSeconds);
      this.noSpeech.set(id, 0);
    } else {
      this.noSpeech.set(id, n);
    }
  }

  /// False engagements in the last hour (scaled up while the session is younger than an hour).
  get falseEngagementsPerHour(): number {
    const recent = this.falseEngagements.filter((t) => this.now - t <= 3600).length;
    const span = Math.min(Math.max(this.now - (this.start ?? this.now), 60), 3600);
    return recent * 3600 / span;
  }

  isDamped(id: number): boolean { return (this.dampedUntil.get(id) ?? -Infinity) > this.now; }

  /// Holds `id`'s engagement for a directed gesture until `until` (host seconds; capped at `gestureHoldCap` from when it
  /// first holds an engagement back). `beat`: the coordinator's beat is playing (vs. a provisional hold).
  holdForGesture(id: number, until: number, beat: boolean): void {
    const h = this.holds.get(id);
    if (h !== undefined && h.until >= this.now) {
      h.until = beat ? until : Math.max(h.until, until);
      h.beat = h.beat || beat;
    } else {
      this.holds.set(id, { until, blockingSince: null, beat });
    }
    if (beat) this.lastGestureBeat.set(id, this.now);
  }

  /// The gesture's beat didn't play: the hold ends now.
  releaseGestureHold(id: number): void {
    const h = this.holds.get(id);
    if (h === undefined) return;
    h.until = Math.min(h.until, this.now - 1e-6);
  }

  /// Whether `id`'s engagement is held now (starting the cap clock the first time it holds one back).
  isHeld(id: number, candidate: boolean): boolean {
    const h = this.holds.get(id) ?? { until: -Infinity, blockingSince: null, beat: false };
    if (!(candidate || this.now <= h.until)) { this.holds.delete(id); return false; }
    const since = h.blockingSince ?? this.now;
    h.blockingSince = since;
    this.holds.set(id, h);
    return this.now - since < this.params.gestureHoldCap;
  }

  /// Whether `id`'s current engagement was gesture-started (tests, status).
  isGestureStarted(id: number): boolean { return this.gestureStarted.get(id) === true; }

  reset(): PerceptionEvent[] {
    let ev: PerceptionEvent[] = [];
    if (this.engagedID !== null) ev = this.release(this.engagedID, 'reset');
    this.people.clear(); this.waiting = []; this.pinned = false; this.releasedAt.clear(); this.holds.clear();
    return ev;
  }

  // MARK: Per frame

  dwellNeeded(id: number, eyes: boolean): number {
    const k = this.params;
    let d = eyes ? k.dwell : k.dwellHeadOnly;
    const r = this.releasedAt.get(id);
    if (r !== undefined && this.now - r <= k.reengageWindow) d = Math.min(d, k.reengageDwell);
    if (this.isDamped(id)) d *= k.dampingFactor;
    return d;
  }

  update(inputs: readonly EngagementInput[], time: number, dt: number,
    held: readonly number[] = []): { events: PerceptionEvent[]; out: Map<number, EngagementOutput> } {
    this.now = time;
    if (this.start === null) this.start = time;
    const events: PerceptionEvent[] = [];
    const out = new Map<number, EngagementOutput>();
    const k = this.params;
    const present = new Set<number>();

    for (const inp of inputs) {
      present.add(inp.id);
      const p = this.people.get(inp.id) ?? makePerson();
      p.lastSeen = time;
      const inRange = inp.distance <= k.maxDistance;
      const quality = inp.faceHeightPx >= k.minFacePx && inp.headAngleDegrees <= k.maxHeadAngleDegrees && inp.live;
      if (inp.hasReading) {
        p.contact = p.contact ? inp.lookingAtMe >= k.exit : inp.lookingAtMe >= k.enter;
        if (inp.lookingAtMe >= k.exit) p.lastLooking = time;
        if (inp.lookingAtMe >= k.waiterMinLooking) p.lastAboveWaiter = time;
      }
      const gap = time - p.lastContact;
      if (p.contact && inp.hasReading) {
        p.lastContact = time;
        if (inRange && quality) p.acc += dt;
        if (p.lookingStart === null) { p.lookingStart = time; p.nextMilestone = 0; }
      } else if (gap > k.dropoutTolerance) {
        p.acc = Math.max(0, p.acc - k.decayRate * dt);
        p.lookingStart = null;
        p.contact = inp.hasReading ? p.contact : false;
      }
      if (!inRange) p.outOfRangeSince = p.outOfRangeSince ?? time; else p.outOfRangeSince = null;

      let lookingFor = 0;
      if (p.lookingStart !== null) {
        lookingFor = time - p.lookingStart;
        while (p.nextMilestone < k.milestones.length && lookingFor >= k.milestones[p.nextMilestone]) {
          events.push({ kind: 'lookingAtMe', id: inp.id, seconds: k.milestones[p.nextMilestone] });
          p.nextMilestone += 1;
        }
      }
      const need = this.dwellNeeded(inp.id, inp.eyes);
      const meets = p.acc >= need && inRange;
      if (meets) p.metRuleAt = p.metRuleAt ?? time; else if (!p.contact) p.metRuleAt = null;
      this.people.set(inp.id, p);
      out.set(inp.id, { lookingFor, dwell: p.acc, dwellNeeded: need });
    }

    // Forget people long gone.
    for (const [id, p] of this.people) if (!present.has(id) && time - p.lastSeen > 10) this.people.delete(id);

    // Release the turn holder.
    if (this.engagedID !== null) {
      const id = this.engagedID;
      const p = this.people.get(id);
      const gone = !present.has(id) && time - (p?.lastSeen ?? -Infinity) > k.goneRelease;
      if (gone) {
        events.push(...this.release(id, 'left'));
      } else if (!this.pinned && p !== undefined) {
        const since = Math.max(p.lastLooking, this.unpinnedAt);
        if (time - since >= k.releaseAfter) {
          events.push(...this.release(id, 'lookedAway'));
        } else if (p.outOfRangeSince !== null && time - Math.max(p.outOfRangeSince, this.unpinnedAt) >= k.outOfRangeRelease) {
          events.push(...this.release(id, 'outOfRange'));
        }
      }
    }

    // Waiters: keep only those still looking recently.
    this.waiting = this.waiting.filter((id) => {
      const p = this.people.get(id);
      if (p === undefined || !(present.has(id) || time - p.lastSeen <= k.goneRelease)) return false;
      return !(time - p.lastAboveWaiter > k.waiterGrace || id === this.engagedID);
    });

    // Candidates meeting the rule, FIFO by when they met it; ties → more eye contact, then nearer.
    const byID = new Map<number, EngagementInput>();
    for (const inp of inputs) if (!byID.has(inp.id)) byID.set(inp.id, inp);
    const candidates: [number, number][] = [];
    for (const [id, p] of this.people) {
      if (present.has(id) && p.metRuleAt !== null && id !== this.engagedID) candidates.push([id, p.metRuleAt]);
    }
    candidates.sort((a, b) => {
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      const la = byID.get(a[0])?.lookingAtMe ?? 0, lb = byID.get(b[0])?.lookingAtMe ?? 0;
      if (la !== lb) return la > lb ? -1 : 1;
      const da = byID.get(a[0])?.distance ?? 9, db = byID.get(b[0])?.distance ?? 9;
      return da < db ? -1 : da > db ? 1 : 0;
    });

    if (this.engagedID === null) {
      // A waiter from the last turn who is still looking takes it straight away (no new dwell).
      const recentRelease = time - this.lastRelease <= k.waiterGrace;
      const w = recentRelease
        ? this.waiting.find((id) => present.has(id) && time - (this.people.get(id)?.lastAboveWaiter ?? -Infinity) <= k.waiterGrace)
        : undefined;
      if (w !== undefined) {
        events.push(...this.engage(w));
      } else {
        // A directed gesture's candidate or beat holds the engagement (capped), so its beat plays first.
        for (const [id] of candidates) {
          if (this.isHeld(id, held.includes(id))) continue;
          if (this.holds.get(id)?.blockingSince != null) this.gestureHoldReleases += 1;
          events.push(...this.engage(id));
          break;
        }
      }
    }
    // Holds that have run out without holding anything back are dropped.
    for (const [id, h] of this.holds) {
      if (time > h.until && h.blockingSince === null && !held.includes(id)) this.holds.delete(id);
    }
    if (this.engagedID !== null) {
      for (const [id] of candidates) {
        if (id === this.engagedID) continue;
        if (!this.waiting.includes(id)) this.waiting.push(id);
        if (this.wantsTurnFired.get(id) !== this.turnSerial) {
          this.wantsTurnFired.set(id, this.turnSerial);
          events.push({ kind: 'wantsTurn', id });
        }
      }
    }
    return { events, out };
  }

  private engage(id: number): PerceptionEvent[] {
    const blocked = this.holds.get(id)?.blockingSince != null;
    this.gestureStarted.set(id, blocked || this.now - (this.lastGestureBeat.get(id) ?? -Infinity) <= this.params.gestureStartedWindow);
    this.holds.delete(id);
    this.engagedID = id;
    this.pinned = false;
    this.turnSerial += 1;
    this.waiting = this.waiting.filter((w) => w !== id);
    this.releasedAt.delete(id);
    return [{ kind: 'engaged', id }];
  }

  private release(id: number, reason: DisengageReason): PerceptionEvent[] {
    if (this.engagedID !== id) return [];
    this.engagedID = null;
    this.pinned = false;
    this.releasedAt.set(id, this.now);
    this.lastRelease = this.now;
    const p = this.people.get(id);
    if (p !== undefined) { p.acc = 0; p.metRuleAt = null; }
    return [{ kind: 'disengaged', id, reason }];
  }
}

/// Salience and the primary person (the one the eyes follow).
export interface SalienceParams {
  challengerLead: number;
  challengerHold: number;
  gestureBoost: number;
  gestureBoostSeconds: number;
  newnessTau: number;
}
export const makeSalienceParams = (o: Partial<SalienceParams> = {}): SalienceParams => ({
  challengerLead: 0.15, challengerHold: 1.0, gestureBoost: 0.3, gestureBoostSeconds: 2, newnessTau: 4, ...o,
});

export class PrimarySelector {
  params: SalienceParams;
  primaryID: number | null = null;
  challenger: { id: number; since: number } | null = null;
  lastGesture = new Map<number, number>();
  constructor(params: SalienceParams = makeSalienceParams()) { this.params = params; }

  noteGesture(id: number, t: number): void { this.lastGesture.set(id, t); }

  /// `0.35·facing + 0.25·proximity + 0.2·motion + 0.2·newness` (+ gesture boost; 1 while engaged), 0…1.
  salience(p: TrackedPerson, now: number, engaged: boolean): number {
    if (engaged) return 1;
    const proximity = clamp((3 - p.distance) / 2.5, 0, 1);
    const motion = clamp(vlength2(p.velocity) / 0.5, 0, 1);
    const newness = Math.exp(-Math.max(now - p.firstSeen, 0) / this.params.newnessTau);
    let s = 0.35 * p.facing + 0.25 * proximity + 0.2 * motion + 0.2 * newness;
    const g = this.lastGesture.get(p.id);
    if (g !== undefined && now - g <= this.params.gestureBoostSeconds) s += this.params.gestureBoost;
    return clamp(s, 0, 1);
  }

  /// Picks the primary: the engaged person; else the best `salience + 0.2·facing`, where a challenger must lead by
  /// `challengerLead` for `challengerHold` seconds.
  update(people: readonly TrackedPerson[], engagedID: number | null, now: number): PerceptionEvent | null {
    const old = this.primaryID;
    const score = (p: TrackedPerson): number => p.salience + 0.2 * p.facing;
    if (engagedID !== null && people.some((p) => p.id === engagedID)) {
      this.primaryID = engagedID;
      this.challenger = null;
    } else if (people.length === 0) {
      this.primaryID = null;
      this.challenger = null;
    } else {
      let best = people[0];
      for (const p of people) if (score(best) < score(p)) best = p;   // first of ties, like Swift `max(by:)`
      const cur = this.primaryID;
      const curP = cur === null ? undefined : people.find((p) => p.id === cur);
      if (curP !== undefined) {
        if (best.id !== cur && score(best) - score(curP) >= this.params.challengerLead) {
          if (this.challenger?.id !== best.id) this.challenger = { id: best.id, since: now };
          if (this.challenger !== null && now - this.challenger.since >= this.params.challengerHold) {
            this.primaryID = best.id; this.challenger = null;
          }
        } else {
          this.challenger = null;
        }
      } else {
        this.primaryID = best.id;
        this.challenger = null;
      }
    }
    for (const [id, t] of this.lastGesture) if (now - t > 10) this.lastGesture.delete(id);
    return old !== this.primaryID ? { kind: 'primaryChanged', from: old, to: this.primaryID } : null;
  }

  reset(): void { this.primaryID = null; this.challenger = null; }
}
