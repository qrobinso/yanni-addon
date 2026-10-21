// Port of FacePerception/GestureRecognizer.swift, with its extensions folded in (one section each):
// GestureRecognizer+Update.swift, +Rules.swift, +Hands.swift, +Shapes.swift, +Fire.swift.
import type { V2, V3 } from '../core/vec';
import { ArmsUpRule, BodyRuleParams, ClapRule, type RuleResult } from './BodyGestures';
import type { CameraGeometry } from './CameraGeometry';
import { DanceRule, chiralityBoth } from './DanceRule';
import { GestureEventLayer, DecisionRing, type GestureEventLayerState } from './GestureEventLayer';
import {
  GestureParams, HandTrack, ShapeBit, makeHandResult, makeShapeState, type GesturePerson, type ShapeState,
} from './Gestures';
import { HandShape } from './HandShapes';
import { FarPointRule, NodRule, PeekabooRule } from './PeekabooPointRules';
import {
  GestureKind, NRect, bodyJoint, clamp, makeGestureObservation, radToDeg, vlength2, vlength3, vnormalize2,
  type Chirality, type FrameDetections, type GestureDecision, type GestureObservation, type GesturePhase,
} from './PerceptionTypes';
import { JointSet, PersonFeatureStream, StreamJoint, type BodyKey, type FaceKey } from './PersonFeatureStream';
import { WaveRule } from './WaveRule';

const IDX = {
  wave: GestureKind.index(GestureKind.wave), clap: GestureKind.index(GestureKind.clap),
  armsUp: GestureKind.index(GestureKind.armsUp), point: GestureKind.index(GestureKind.point({ x: 0, y: 0 })),
  nod: GestureKind.index(GestureKind.nod),
};
const sub2 = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/// Everything the recogniser keeps about one person, in a fixed slot (design §4.3).
export class GestureSlot {
  id = -1;
  lastSeen = -Infinity;
  stream = new PersonFeatureStream();
  /// 0 left, 1 right (the person's own).
  hands: HandTrack[] = [new HandTrack(), new HandTrack()];
  waves: WaveRule[] = [new WaveRule(), new WaveRule()];
  farPoints: FarPointRule[] = [new FarPointRule(), new FarPointRule()];
  clap = new ClapRule();
  armsUp = new ArmsUpRule();
  dance = new DanceRule();
  peekaboo = new PeekabooRule();
  nod = new NodRule();
  layer: GestureEventLayerState[] = Array.from({ length: GestureKind.count }, () => GestureEventLayer.State());
  heart: ShapeState = makeShapeState();
  heartTotal = 0;
  heartPositive = 0;
  lastFire = -Infinity;
  lastRank = 0;
  /// facing ≥ danceFacing continuously since.
  facingSince: number | null = null;
  /// Dancing detected, the start not reported yet (waiting for the facing run).
  danceStartPending: number | null = null;
  prevMetres: V3 | null = null;
  prevTime = 0;
  /// m/s, smoothed.
  speed = 0;
  distanceRate = 0;
  aimedCandidate = false;
  /// Last body-pose wrist / elbow (normalised viewer frame) per side, for the wrist ROIs.
  wristN: (V2 | null)[] = [null, null];
  elbowN: (V2 | null)[] = [null, null];
  wristSpeed: number[] = [0, 0];
  wristAt = -Infinity;

  // port-note: like the Swift, reset keeps heartTotal / heartPositive, prevTime, wristSpeed and wristAt.
  reset(id: number): void {
    this.id = id;
    this.stream.reset();
    for (let i = 0; i < 2; i++) {
      this.hands[i].reset(); this.waves[i].reset(); this.farPoints[i] = new FarPointRule(); this.wristN[i] = null; this.elbowN[i] = null;
    }
    this.clap = new ClapRule(); this.armsUp = new ArmsUpRule(); this.dance.reset(); this.peekaboo.reset();
    for (let i = 0; i < this.layer.length; i++) this.layer[i] = GestureEventLayer.State();
    this.heart = makeShapeState(); this.lastFire = -Infinity; this.lastRank = 0; this.facingSince = null; this.prevMetres = null;
    this.danceStartPending = null;
    this.speed = 0; this.distanceRate = 0; this.aimedCandidate = false;
  }

  static side(c: Chirality): number { return c === 'left' ? 0 : 1; }
}

/// `fire`'s labelled arguments.
export interface FireArgs {
  conf: number;
  hand: Chirality | null;
  at: V2;
  now: number;
  phase?: GesturePhase;
  others: boolean;
  aimedOverride?: boolean | null;
}

/// Temporal gesture recognition (design §6): per person a 15 Hz feature stream, the body / face rules, the hand
/// shapes with time-based K-of-N, the two-hand heart and the high-five approach, all through the shared firing rules
/// (`GestureEventLayer`). Synchronous and deterministic; per-person state lives in fixed slots.
export class GestureRecognizer {
  params: GestureParams;
  body = new BodyRuleParams();
  static readonly slotCount = 8;
  slots: GestureSlot[] = Array.from({ length: GestureRecognizer.slotCount }, () => new GestureSlot());
  // port-note: the per-frame outputs are fresh arrays each update (Swift copies them out by value; callers keep them).
  observations: GestureObservation[] = [];
  decisions: GestureDecision[] = [];
  /// People whose aimed gesture candidate holds their engagement (design §7), this frame.
  heldIDs: number[] = [];
  /// Wrist regions worth a zoomed hand pass (design §6.3), most relevant first.
  wristROIs: NRect[] = [];
  log = new DecisionRing();

  constructor(params: GestureParams = new GestureParams()) { this.params = params; }

  reset(): void {
    for (const s of this.slots) { s.reset(-1); s.lastSeen = -Infinity; }
  }

  /// The slot for `id` (an existing one, else a free or the least recently seen one, reset).
  slotIndex(id: number, now: number): number {
    void now;
    const found = this.slots.findIndex((s) => s.id === id);
    if (found >= 0) return found;
    let pick = 0;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].id < 0) { pick = i; break; }
      if (this.slots[i].lastSeen < this.slots[pick].lastSeen) pick = i;
    }
    this.slots[pick].reset(id);
    return pick;
  }

  /// Hand → person (design §9): the person whose body-pose wrist of the same chirality is nearest in metres
  /// (≤ 0.15 m), else the containment rule, nearest head first. Swift `owner(of: HandShape, …)`.
  static owner(hand: HandShape, chirality: Chirality | null, people: GesturePerson[], geometry: CameraGeometry,
    minConfidence = 0.3): number | null {
    let best: [number, number] | null = null;
    people.forEach((p, i) => {
      const b = p.body;
      if (b === null) return;
      const mx = geometry.metresPerUnitX(p.distance), my = geometry.metresPerUnitY(p.distance);
      for (const side of chiralityBoth) {
        if (chirality !== null && chirality !== side) continue;
        const w = bodyJoint(b, side === 'left' ? 'leftWrist' : 'rightWrist', minConfidence);
        if (w === null) continue;
        const d = sub2(hand.wrist, w);
        const m = vlength2({ x: d.x * mx, y: d.y * my });
        if (m <= 0.15 && (best === null || m < best[1])) best = [i, m];
      }
    });
    if (best !== null) return (best as [number, number])[0];
    return GestureRecognizer.ownerOfWrist(hand.wrist, people);
  }

  /// Containment fallback: the person whose body (or face, widened) contains the wrist, nearest head first.
  /// Swift `owner(of: SIMD2<Float>, people:)`.
  static ownerOfWrist(wrist: V2, people: GesturePerson[]): number | null {
    let best: [number, number] | null = null;
    people.forEach((p, i) => {
      let inside = false;
      if (p.bodyBox !== null) inside = NRect.contains(NRect.insetBy(p.bodyBox, 0.5), wrist);
      const f = p.faceBox;
      if (!inside && f !== null) {
        const c = NRect.center(f);
        inside = NRect.contains(NRect.fromCenter({ x: c.x, y: c.y + f.h }, { x: f.w * 6, y: f.h * 5 }), wrist);
      }
      if (!inside) return;
      const dd = vlength2(sub2(wrist, p.headCentre));
      if (best === null || dd < best[1]) best = [i, dd];
    });
    return best === null ? null : (best as [number, number])[0];
  }

  // MARK: - GestureRecognizer+Update.swift

  /// One analysed frame. Fills `observations`, `decisions`, `heldIDs` and `wristROIs`.
  update(det: FrameDetections, people: GesturePerson[], geometry: CameraGeometry): void {
    const now = det.time;
    this.observations = [];
    this.decisions = [];
    this.heldIDs = [];
    this.wristROIs = [];

    for (const p of people) {
      const si = this.slotIndex(p.id, now);
      this.slots[si].aimedCandidate = false;
      this.track(si, p, now, det.bodyPoseRan, geometry);
      this.slots[si].lastSeen = now;
      const n = this.slots[si].stream.advance(now, this.bodyKey(p, det.bodyPoseRan, geometry, now), this.faceKey(p, now));
      if (n > 0) this.streamRules(si, p, people, n, now);
    }
    if (det.handsRan) this.handResults(det, people, geometry, now);

    // Engagement hold: an aimed candidate within engagement range (design §7).
    for (const p of people) {
      if (!(p.distance <= this.params.engageMaxDistance && GestureEventLayer.aimed(p, now, this.params))) continue;
      const si = this.slots.findIndex((s) => s.id === p.id);
      if (si < 0) continue;
      if (this.candidateActive(si, now)) this.heldIDs.push(p.id);
    }
    this.wristRegions(people, now, geometry);
  }

  /// Speed, distance rate, the facing run (dancing's directed exception) and the wrists for the ROIs.
  private track(si: number, p: GesturePerson, now: number, bodyRan: boolean, geometry: CameraGeometry): void {
    const s = this.slots[si];
    const prev = s.prevMetres;
    if (prev !== null && now > s.prevTime) {
      const dt = now - s.prevTime;
      const v = vlength2({ x: p.positionMetres.x - prev.x, y: p.positionMetres.z - prev.z }) / dt;
      const a = Math.min(dt / 0.5, 1);
      s.speed += (Math.min(v, 5) - s.speed) * a;
      s.distanceRate += ((p.positionMetres.z - prev.z) / dt - s.distanceRate) * a;
    }
    s.prevMetres = { ...p.positionMetres };
    s.prevTime = now;
    if (p.facing >= this.params.danceFacing) s.facingSince = s.facingSince ?? now; else s.facingSince = null;
    const b = p.body;
    if (bodyRan && b !== null) {
      for (const side of chiralityBoth) {
        const i = GestureSlot.side(side);
        const w = bodyJoint(b, side === 'left' ? 'leftWrist' : 'rightWrist', this.params.minJointConfidence);
        const old = s.wristN[i];
        if (w !== null && old !== null) {
          const d = { x: (w.x - old.x) * geometry.metresPerUnitX(p.distance), y: (w.y - old.y) * geometry.metresPerUnitY(p.distance) };
          s.wristSpeed[i] = vlength2(d) / Math.max(now - s.wristAt, 1 / 60);
        }
        s.wristN[i] = w;
        s.elbowN[i] = bodyJoint(b, side === 'left' ? 'leftElbow' : 'rightElbow', this.params.minJointConfidence);
      }
      s.wristAt = now;
    }
  }

  private bodyKey(p: GesturePerson, ran: boolean, geometry: CameraGeometry, now: number): BodyKey | null {
    const b = p.body;
    if (!ran || b === null || Object.keys(b.joints).length === 0) return null;
    const mx = geometry.metresPerUnitX(p.distance), my = geometry.metresPerUnitY(p.distance);
    const j = new JointSet();
    for (const sj of StreamJoint.allCases) {
      const v = bodyJoint(b, StreamJoint.body(sj), this.params.minJointConfidence);
      if (v !== null) j.set(sj, { x: v.x * mx, y: v.y * my });
    }
    return j.mask === 0 ? null : { t: now, joints: j };
  }

  private faceKey(p: GesturePerson, now: number): FaceKey | null {
    const f = p.face;
    const hp = f?.headPose ?? null;
    if (f === null || hp === null) return null;
    // Pitch relative to the head → camera ray: walking past (the ray's elevation changing) is not a nod.
    const elevation = Math.atan2(p.positionMetres.y, Math.max(p.positionMetres.z, 0.1));
    return { t: now, pitch: (hp.pitch + elevation) * radToDeg, yaw: hp.yaw * radToDeg, openness: f.eyes?.openness ?? 0.3 };
  }

  /// Whether the person has any gesture in progress (static shape, heart, or a body rule's candidate).
  candidateActive(si: number, now: number): boolean {
    const s = this.slots[si];
    if (s.aimedCandidate) return true;
    // A static candidate holds only while its shape is still showing (one hand-result interval of grace).
    const fresh = 0.3;
    if (s.heart.start !== null && now - s.heart.lastPositive <= fresh) return true;
    for (const h of s.hands) {
      for (const st of h.shapes) if (st.armed && st.start !== null && now - st.lastPositive <= fresh) return true;
    }
    return false;
  }

  /// Someone else within 1.2 m of this person (they may be talking to each other).
  static othersNear(p: GesturePerson, people: GesturePerson[]): boolean {
    return people.some((q) => q.id !== p.id && vlength3(sub3(q.positionMetres, p.positionMetres)) <= 1.2);
  }

  // MARK: - GestureRecognizer+Rules.swift

  /// Runs the body / face rules on the samples the stream just emitted.
  streamRules(si: number, p: GesturePerson, people: GesturePerson[], n: number, now: number): void {
    const k = this.params;
    const slot = this.slots[si];
    const others = GestureRecognizer.othersNear(p, people);
    const aimedNow = GestureEventLayer.aimed(p, now, k);

    // Waves: every new body sample feeds both sides' turning-point rings.
    let hasBody = false;
    for (let back = n - 1; back >= 0; back--) {
      const x = slot.stream.back(back);
      const c = x.body ? x.centre : null;
      if (c === null) continue;
      hasBody = true;
      const headY = x.joints.get(StreamJoint.nose)?.y ?? c.y - 0.25;
      for (const side of chiralityBoth) {
        const w = x.joints.get(StreamJoint.wrist(side));
        if (w === null) continue;
        let raised = w.y - headY <= k.waveHeadBand;
        const e = x.joints.get(StreamJoint.elbow(side));
        if (e !== null) raised = raised && w.y < e.y;
        const i = GestureSlot.side(side);
        slot.waves[i].add(x.t, w.x, raised);
        const sw = x.shoulderWidth;
        if (sw !== null && sw > 0.1) slot.waves[i].shoulderM = sw;
      }
    }
    if (hasBody) this.evaluateWaves(si, p, others, now);

    const x = slot.stream.newest;
    if (x === null) return;
    let candidate = false;

    // Clap.
    const clap = slot.clap.step(slot.stream, slot.layer[IDX.clap].lastFire, this.body);
    if (this.ruleGate(si, GestureKind.clap, clap, now) && clap.fired !== null) {
      this.fire(GestureKind.clap, si, p, { conf: clap.fired, hand: null, at: p.position, now, others });
    }
    candidate = candidate || clap.candidate;

    // Arms up.
    const arms = slot.armsUp.step(slot.stream, slot.layer[IDX.armsUp].lastFire, this.body);
    if (this.ruleGate(si, GestureKind.armsUp, arms, now) && arms.fired !== null) {
      this.fire(GestureKind.armsUp, si, p, { conf: arms.fired, hand: null, at: p.position, now, others });
    }
    candidate = candidate || arms.candidate;

    // Peekaboo: aimed before the cover, facing at the reveal.
    const peek = slot.peekaboo.step(slot.stream, aimedNow, this.body);
    if (this.ruleGate(si, GestureKind.peekaboo, peek, now) && peek.fired !== null) {
      this.fire(GestureKind.peekaboo, si, p, { conf: peek.fired, hand: null, at: p.position, now, others,
        aimedOverride: p.facing >= k.farFacing });
    }

    // Far point (body pose) beyond the hand-pose range.
    if (p.distance > k.waveHandPoseMaxDistance) {
      for (const side of chiralityBoth) {
        const i = GestureSlot.side(side);
        const r = slot.farPoints[i].step(slot.stream, side, slot.layer[IDX.point].lastFire, this.body);
        if (this.ruleGate(si, GestureKind.point({ x: 0, y: 0 }), r, now) && r.fired !== null) {
          this.fire(GestureKind.point({ ...slot.farPoints[i].direction }), si, p,
            { conf: r.fired, hand: side, at: p.position, now, others });
        }
        candidate = candidate || r.candidate;
      }
    }

    // Nod (the face rule; the reflex table plays the mirror only in follow-up with the engaged person).
    const nodSpeed = Math.max(slot.speed, DanceRule.netSpeed(slot.stream, Math.trunc(slot.nod.window * PersonFeatureStream.rate)));
    const nod = slot.nod.step(slot.stream, p.distance, nodSpeed, slot.layer[IDX.nod].lastFire);
    if (this.ruleGate(si, GestureKind.nod, nod, now) && nod.fired !== null) {
      this.fire(GestureKind.nod, si, p, { conf: nod.fired, hand: null, at: p.position, now, others, aimedOverride: p.engaged });
    }

    // Dancing (sustained): directed when facing ≥ 0.3 for the last 4 s. The start waits (up to 4 s) for that; an
    // episode that never faces Yanni is an undirected event.
    const facingLong = slot.facingSince !== null ? now - slot.facingSince >= k.danceFacingHold : false;
    if (x.body || slot.dance.active) {
      const phase = slot.dance.step(slot.stream, this.body);
      if (phase !== null) {
        if (phase === 'started') {
          slot.danceStartPending = now;
        } else if (slot.danceStartPending !== null) {
          slot.danceStartPending = null; // ended before it was ever reported
        } else {
          this.fire(GestureKind.dancing, si, p, { conf: 0.6, hand: null, at: p.position, now, phase: 'ended', others,
            aimedOverride: facingLong });
        }
      }
    }
    const pending = slot.danceStartPending;
    if (pending !== null && (facingLong || now - pending >= k.danceFacingHold)) {
      slot.danceStartPending = null;
      this.fire(GestureKind.dancing, si, p, { conf: clamp(slot.dance.lastScore + 0.3, 0.6, 1), hand: null, at: p.position,
        now, phase: 'started', others, aimedOverride: facingLong });
    }
    if (candidate && aimedNow) slot.aimedCandidate = true;
  }

  /// Hysteresis for a rule-driven gesture: false while it hasn't re-armed since its last firing.
  ruleGate(si: number, kind: GestureKind, r: RuleResult, now: number): boolean {
    return GestureEventLayer.rearm(this.slots[si].layer[GestureKind.index(kind)], r.candidate || r.fired !== null, now,
      this.params.rearm) && this.params.isEnabled(kind);
  }

  /// Both sides' waves; a completed wave is a bye when the person is leaving (design §6.2).
  evaluateWaves(si: number, p: GesturePerson, others: boolean, now: number): void {
    const k = this.params;
    if (!(p.distance <= k.waveMaxDistance)) return;
    let best: [number, Chirality] | null = null;
    let candidate = false;
    const slot = this.slots[si];
    const since = slot.layer[IDX.wave].lastFire;
    for (const side of chiralityBoth) {
      const i = GestureSlot.side(side);
      const open = this.openFraction(si, i, Math.max(since, now - k.waveWindow));
      const r = slot.waves[i].evaluate(since, k, open);
      candidate = candidate || r.candidate;
      if (r.fired !== null && (best === null || r.fired > best[0])) best = [r.fired, side];
    }
    const armed = GestureEventLayer.rearm(slot.layer[IDX.wave], candidate, now, k.rearm);
    if (candidate && GestureEventLayer.aimed(p, now, k)) slot.aimedCandidate = true;
    if (!armed || best === null) return;
    const [c, side] = best;
    const bye = this.byeSide(si, p);
    const kind = bye !== null ? GestureKind.byeWave(bye) : GestureKind.wave;
    if (!k.isEnabled(kind)) return;
    this.fire(kind, si, p, { conf: c, hand: side, at: p.position, now, others });
    slot.layer[IDX.wave].armed = false;
    slot.layer[IDX.wave].lastFire = now;
  }

  /// The exit side if the person is leaving: heading for a frame edge, stepping out of range, or just released.
  byeSide(si: number, p: GesturePerson): number | null {
    const s = this.slots[si];
    const sideOf = (v: number): number => v >= 0 ? 1 : -1;
    const ahead = p.position.x + p.velocity.x * 1.0;
    if (Math.abs(p.velocity.x) >= 0.12 && Math.abs(ahead) >= 0.85 && p.velocity.x * ahead > 0) return sideOf(p.velocity.x);
    if (p.distance > this.params.engageMaxDistance && s.distanceRate > 0.15) return sideOf(p.position.x);
    if (p.releasedRecently) return sideOf(Math.abs(p.velocity.x) > 0.05 ? p.velocity.x : p.position.x);
    return null;
  }

  /// Share of open-hand results of one hand since `since` (null when there were none).
  openFraction(si: number, side: number, since: number): number | null {
    const h = this.slots[si].hands[side];
    let total = 0, open = 0;
    for (let i = 0; i < h.count; i++) {
      const r = h.back(i);
      if (!(r.t > since)) break;
      total += 1;
      if (r.open) open += 1;
    }
    return total > 0 ? open / total : null;
  }

  // MARK: - GestureRecognizer+Hands.swift

  /// Hand results of this frame: classify, assign to a person and side, feed the shape tracks, hand-pose waves (for
  /// someone without body pose), the two-hand heart and the high-five approach.
  handResults(det: FrameDetections, people: GesturePerson[], geometry: CameraGeometry, now: number): void {
    const k = this.params;
    let updated = 0; // bit (slot * 2 + side)
    for (const h of det.hands) {
      const shape = HandShape.classify(h, k, det.intrinsics.imageSize);
      if (shape === null) continue;
      const pi = GestureRecognizer.owner(shape, h.chirality, people, geometry, k.minJointConfidence);
      if (pi === null) continue;
      const si = this.slots.findIndex((s) => s.id === people[pi].id);
      if (si < 0) continue;
      const p = people[pi];
      const slot = this.slots[si];
      const side: Chirality = h.chirality ?? (shape.wrist.x < p.headCentre.x ? 'left' : 'right');
      const i = GestureSlot.side(side);
      if ((updated & (1 << (si * 2 + i))) !== 0) continue; // one result per hand per frame
      updated |= 1 << (si * 2 + i);
      const mx = geometry.metresPerUnitX(p.distance), my = geometry.metresPerUnitY(p.distance);
      let flags = 0;
      for (const bit of ShapeBit.allCases) if (ShapeBit.holds(bit, shape)) flags |= 1 << bit;
      const four = HandShape.extended(shape, 1) && HandShape.extended(shape, 2) && HandShape.extended(shape, 3) &&
        HandShape.extended(shape, 4);
      const r = makeHandResult({
        t: now, flags, open: shape.openPalm || four, wristM: { x: shape.wrist.x * mx, y: shape.wrist.y * my },
        size: vlength2({ x: shape.box.w * mx, y: shape.box.h * my }), pointDir: shape.pointDirection ?? { x: 0, y: 0 },
        at: geometry.gazePosition(shape.wrist),
      });
      slot.hands[i].add(r, k.newHandGap);
      slot.hands[i].shape = shape;

      // Hand-pose wrists drive the wave only for someone without a recent body-pose reading.
      const nw = slot.stream.newest;
      const bodyRecent = nw !== null ? nw.body && now - nw.t <= 0.5 : false;
      if (!bodyRecent && p.distance <= k.waveHandPoseMaxDistance) {
        let headY = p.headCentre.y;
        const nose = p.body !== null ? bodyJoint(p.body, 'nose', k.minJointConfidence) : null;
        if (nose !== null) headY = nose.y;
        const raised = (shape.wrist.y - headY) * my <= k.waveHeadBand;
        slot.waves[i].add(now, r.wristM.x, raised);
        if (slot.waves[i].shoulderM === null) {
          slot.waves[i].shoulderM = shape.palmWidth * mx * k.waveAmplitudePalms / k.waveAmplitudeShoulders;
        }
        this.evaluateWaves(si, p, GestureRecognizer.othersNear(p, people), now);
      }
      if (p.distance <= k.handGestureMaxDistance) this.evaluateShapes(si, i, p, people, now);
      this.highFiveApproach(si, i, p, people, now);
    }
    // Two-hand heart, for every person with a hand result this frame.
    for (let si = 0; si < this.slots.length; si++) {
      if (!(this.slots[si].id >= 0 && (updated & (3 << (si * 2))) !== 0)) continue;
      const p = people.find((q) => q.id === this.slots[si].id);
      if (p === undefined) continue;
      this.heartHands(si, p, people, (updated & (3 << (si * 2))) === 3 << (si * 2), geometry, now);
    }
  }

  /// Onset (design §6.5): the body-pose wrist rose ≥ 0.1 m within the last 2 s (the stream, else the hand-pose
  /// wrist), or the hand became active within it.
  onset(si: number, side: number, now: number): boolean {
    const k = this.params;
    const h = this.slots[si].hands[side];
    if (now - h.activeSince <= k.onsetWindow) return true;
    const s = this.slots[si].stream;
    const joint = side === 0 ? StreamJoint.leftWrist : StreamJoint.rightWrist;
    let current: number | null = null, lowest = -Infinity;
    for (let i = 0; i < s.count; i++) {
      const x = s.back(i);
      if (now - x.t > k.onsetWindow) break;
      const w = x.body ? x.joints.get(joint) : null;
      if (w !== null) { if (current === null) current = w.y; lowest = Math.max(lowest, w.y); }
    }
    if (current !== null && lowest - current >= k.onsetRise) return true;
    current = null; lowest = -Infinity;
    for (let i = 0; i < h.count; i++) {
      const r = h.back(i);
      if (now - r.t > k.onsetWindow) break;
      if (current === null) current = r.wristM.y;
      lowest = Math.max(lowest, r.wristM.y);
    }
    if (current !== null && lowest - current >= k.onsetRise) return true;
    return false;
  }

  /// True while a two-hand heart is forming for this person (it holds the one-hand shapes it contains).
  heartForming(si: number, now: number): boolean {
    return this.slots[si].heart.start !== null && now - this.slots[si].heart.lastPositive <= this.params.rearm;
  }

  /// Hand results of one hand inside [`start`, `now`]: (total, with `bit`). Swift `results(_:_:bit:from:)`.
  results(si: number, side: number, bit: ShapeBit, start: number): { total: number; positive: number } {
    const h = this.slots[si].hands[side];
    let total = 0, pos = 0;
    for (let i = 0; i < h.count; i++) {
      const r = h.back(i);
      if (!(r.t >= start - 1e-9)) break;
      total += 1;
      if ((r.flags & (1 << bit)) !== 0) pos += 1;
    }
    return { total, positive: pos };
  }

  // MARK: - GestureRecognizer+Shapes.swift

  /// Static hand shapes on one hand's newest result: onset at the candidate's start, time-based K-of-N over the
  /// hold, hysteresis (design §6.5). Open palm must also be held still; point takes its direction from the results.
  evaluateShapes(si: number, side: number, p: GesturePerson, people: GesturePerson[], now: number): void {
    const k = this.params;
    const track = this.slots[si].hands[side];
    const newest = track.count > 0 ? track.back(0) : null;
    if (newest === null || newest.t !== now) return;
    const others = GestureRecognizer.othersNear(p, people);
    for (const bit of ShapeBit.allCases) {
      const st = track.shapes[bit];
      const pos = (newest.flags & (1 << bit)) !== 0;
      // Hysteresis: re-armed once the shape has been gone for `rearm` (checked before this result counts).
      if (!st.armed && now - st.lastPositive >= k.rearm) st.armed = true;
      if (pos) {
        st.lastPositive = now;
        if (st.armed && st.start === null) {
          if (this.onset(si, side, now)) {
            st.start = now;
          } else {
            st.armed = false;
            this.note(ShapeBit.kind(bit), p.id, 'no onset (held pose)', now);
          }
        }
      } else if (st.start !== null && now - st.lastPositive > k.rearm) {
        st.start = null;
      }
      if (!st.armed && now - st.lastPositive >= k.rearm) st.armed = true;
      const hold = bit === ShapeBit.openPalm ? k.palmHold : k.shapeHold;
      const s0 = st.start;
      if (st.armed && pos && s0 !== null && now - s0 >= hold - 1e-6 && k.isEnabled(ShapeBit.kind(bit)) && !this.heartForming(si, now)) {
        const { total, positive } = this.results(si, side, bit, s0);
        // f32: Swift `Float(positive) >= k.kOfNFraction * Float(total)` (0.6 × 5 is 3.0000001 in Float).
        if (total >= k.minResults && positive >= Math.fround(Math.fround(k.kOfNFraction) * total)) {
          const kind = this.shapeKind(bit, si, side, p, s0, now);
          if (kind !== null) {
            const conf = clamp(0.7 + 0.25 * positive / total, 0, 0.95);
            this.fire(kind, si, p, { conf, hand: side === 0 ? 'left' : 'right', at: newest.at, now, others });
            st.armed = false;
            st.start = null;
          }
        }
      }
    }
  }

  /// The gesture a held shape is, after its extra checks (open palm still; point direction), or null.
  shapeKind(bit: ShapeBit, si: number, side: number, p: GesturePerson, s0: number, now: number): GestureKind | null {
    const h = this.slots[si].hands[side];
    switch (bit) {
      case ShapeBit.openPalm: {
        // Path speed, not net displacement: a waving palm returns to where it started.
        let path = 0;
        let prev: V2 | null = null;
        for (let i = h.count - 1; i >= 0; i--) {
          const r = h.back(i);
          if (!(r.t >= s0 - 1e-9)) continue;
          if (prev !== null) path += vlength2(sub2(r.wristM, prev));
          prev = r.wristM;
        }
        return path / Math.max(now - s0, 1e-3) < this.params.palmMaxSpeed ? GestureKind.openPalm : null;
      }
      case ShapeBit.point: {
        let dir: V2 = { x: 0, y: 0 };
        for (let i = 0; i < h.count; i++) {
          const r = h.back(i);
          if (!(r.t >= s0 - 1e-9)) break;
          dir = { x: dir.x + r.pointDir.x, y: dir.y + r.pointDir.y };
        }
        if (p.body !== null) {
          const ej = bodyJoint(p.body, side === 0 ? 'leftElbow' : 'rightElbow', this.params.minJointConfidence);
          const wj = bodyJoint(p.body, side === 0 ? 'leftWrist' : 'rightWrist', this.params.minJointConfidence);
          if (ej !== null && wj !== null) {
            const a = vnormalize2(dir), b = vnormalize2(sub2(wj, ej));
            dir = { x: a.x * 0.6 + b.x * 0.4, y: a.y * 0.6 + b.y * 0.4 };
          }
        }
        return vlength2(dir) > 0 ? GestureKind.point(vnormalize2(dir)) : null;
      }
      default:
        return ShapeBit.kind(bit);
    }
  }

  /// Two-hand heart (design §6.2): both tips together and mirror-posed, below the chin and in front of the torso,
  /// held ≥ 0.4 s with K-of-N over the frames that had a hand result.
  heartHands(si: number, p: GesturePerson, people: GesturePerson[], both: boolean, geometry: CameraGeometry, now: number): void {
    const k = this.params;
    if (!k.isEnabled(GestureKind.heartHands) || !(p.distance <= k.heartMaxDistance)) return;
    const slot = this.slots[si];
    let pos = false;
    const a = slot.hands[0].shape, b = slot.hands[1].shape;
    if (both && a !== null && b !== null) {
      const mx = geometry.metresPerUnitX(p.distance), my = geometry.metresPerUnitY(p.distance);
      pos = HandShape.heart(a, b, mx, my, k.heartTipMetres);
      const tips = { x: (a.indexTip.x + b.indexTip.x) / 2, y: (a.indexTip.y + b.indexTip.y) / 2 };
      const chin = p.faceBox !== null ? NRect.maxY(p.faceBox) : p.headCentre.y;
      if (tips.y < chin) pos = false; // below the chin
      if (p.bodyBox !== null && !NRect.contains(NRect.insetBy(p.bodyBox, 0.15), tips)) pos = false; // in front of the torso
    }
    const st = slot.heart;
    if (!st.armed && now - st.lastPositive >= k.rearm) st.armed = true;
    if (pos) {
      st.lastPositive = now;
      if (st.armed && st.start === null) {
        if (this.onset(si, 0, now) || this.onset(si, 1, now)) { st.start = now; st.armed = true; }
        else { st.armed = false; this.note(GestureKind.heartHands, p.id, 'no onset (held pose)', now); }
      }
    } else if (st.start !== null && now - st.lastPositive > k.rearm) {
      st.start = null;
    }
    if (!st.armed && now - st.lastPositive >= k.rearm) st.armed = true;
    if (st.start !== null) {
      slot.heartTotal += 1;
      if (pos) slot.heartPositive += 1;
    } else {
      slot.heartTotal = 0; slot.heartPositive = 0;
    }
    const total = slot.heartTotal, positive = slot.heartPositive;
    const s0 = st.start;
    // f32: as in evaluateShapes.
    if (st.armed && pos && s0 !== null && now - s0 >= k.shapeHold - 1e-6 && total >= k.minResults &&
      positive >= Math.fround(Math.fround(k.kOfNFraction) * total)) {
      const at = slot.hands[0].count > 0 ? slot.hands[0].back(0).at : p.position;
      this.fire(GestureKind.heartHands, si, p, { conf: 0.85, hand: null, at, now, others: GestureRecognizer.othersNear(p, people) });
      st.armed = false;
      st.start = null;
      slot.heartTotal = 0; slot.heartPositive = 0;
    }
  }

  /// High-five approach (design §6.6): an aimed open palm within ~1 m whose hand box grew ≥ 25 % within 0.5 s arms
  /// the touch window (`phase == started`); the tap that confirms it is the engine's.
  highFiveApproach(si: number, side: number, p: GesturePerson, people: GesturePerson[], now: number): void {
    const k = this.params;
    const h = this.slots[si].hands[side];
    const shape = h.shape;
    if (!k.isEnabled(GestureKind.highFive) || !(p.distance <= k.highFiveMaxDistance) || !(h.count >= 2) ||
      !(now - h.highFiveArmedAt > 2) || shape === null || !shape.openPalm) return;
    const cur = h.back(0);
    let grew = false;
    for (let i = 1; i < h.count; i++) {
      const r = h.back(i);
      if (!(now - r.t <= k.highFiveWindow)) break;
      if (r.open && r.size > 0 && cur.size >= k.highFiveGrowth * r.size) { grew = true; break; }
    }
    if (!grew || !GestureEventLayer.aimed(p, now, k)) return;
    h.highFiveArmedAt = now;
    this.fire(GestureKind.highFive, si, p, { conf: 0.8, hand: side === 0 ? 'left' : 'right', at: cur.at, now, phase: 'started',
      others: GestureRecognizer.othersNear(p, people) });
  }

  // MARK: - GestureRecognizer+Fire.swift

  /// Emits a completed gesture through precedence, the aimed-at gate and the directed score (design §6.5). Returns
  /// whether an observation was emitted. `aimedOverride` replaces the gate for the gestures with their own.
  fire(kind: GestureKind, si: number, p: GesturePerson, a: FireArgs): boolean {
    const k = this.params;
    const { conf, hand, at, now, others } = a;
    const phase = a.phase ?? 'instant';
    const aimedOverride = a.aimedOverride ?? null;
    const rank = GestureEventLayer.rank(kind);
    const s = this.slots[si];
    if (rank > 0 && now - s.lastFire < k.precedenceWindow && rank <= s.lastRank) {
      this.note(kind, p.id, 'precedence', now);
      return false;
    }
    if (rank === 2 && s.dance.active && kind.kind !== 'peekaboo') {
      this.note(kind, p.id, 'dancing', now);
      return false;
    }
    const aimed = aimedOverride ?? GestureEventLayer.aimed(p, now, k);
    let raised = true;
    const w = hand !== null ? s.wristN[GestureSlot.side(hand)] : null;
    if (w !== null && p.bodyBox !== null) {
      const box = p.bodyBox;
      // Between hip and head, within the shoulder span widened 30 %.
      const span = NRect.insetBy(box, 0.15);
      raised = NRect.contains(span, w) || w.y < box.y + box.h * 0.2;
    }
    const d = GestureEventLayer.directedScore(p, raised, true, others);
    const directed = aimed && (aimedOverride !== null || d >= k.directedScoreMin);
    this.observations.push(makeGestureObservation({
      kind, personID: p.id, hand, confidence: conf, directedAtYanni: directed, at, distance: p.distance, time: now,
      source: { kind: 'rules' }, directedScore: d, phase,
    }));
    const idx = GestureKind.index(kind);
    s.layer[idx].armed = false;
    s.layer[idx].lastFire = now;
    if (rank > 0) { s.lastFire = now; s.lastRank = rank; }
    this.note(kind, p.id, directed ? 'fired' : (aimed ? `fired · directed score ${Math.trunc(d * 100)}%` : 'fired · not aimed at Yanni'), now);
    return true;
  }

  note(kind: GestureKind, id: number, reason: string, now: number): void {
    const d: GestureDecision = { kind: GestureKind.name(kind), personID: id, reason, time: now };
    this.decisions.push(d);
    this.log.add(d);
  }

  /// Wrist regions for zoomed hand passes (design §6.3 / §4.2): a wrist raised above the hip line, moving faster than
  /// 0.15 m/s or near the face, of someone who looked at Yanni recently or faces it — or anyone engaged or primary.
  /// Square at wrist + 0.4 × (wrist − elbow), side max(2 × forearm, 0.28 m), engaged / primary first, at most 4.
  wristRegions(people: GesturePerson[], now: number, geometry: CameraGeometry): void {
    for (let pass = 0; pass < 2; pass++) {
      for (const p of people) {
        const important = p.engaged || p.primary;
        if ((pass === 0) !== important) continue;
        if (!(important || now - p.lastLook <= this.params.lookWindow || p.facing >= this.params.farFacing)) continue;
        const si = this.slots.findIndex((s) => s.id === p.id);
        if (si < 0) continue;
        const s = this.slots[si];
        const mx = geometry.metresPerUnitX(p.distance), my = geometry.metresPerUnitY(p.distance);
        for (let i = 0; i < 2; i++) {
          const w = s.wristN[i];
          if (w === null || !(this.wristROIs.length < 4)) continue;
          const hipY = p.bodyBox !== null ? NRect.maxY(p.bodyBox) : p.headCentre.y + 0.6 / my;
          const head = p.faceBox !== null ? NRect.center(p.faceBox) : p.headCentre;
          const nearFace = vlength2({ x: (w.x - head.x) * mx, y: (w.y - head.y) * my }) <= 0.25;
          if (!(w.y < hipY || s.wristSpeed[i] > 0.15 || nearFace)) continue;
          let centre = w;
          let side = 0.28;
          const e = s.elbowN[i];
          if (e !== null) {
            centre = { x: w.x + (w.x - e.x) * 0.4, y: w.y + (w.y - e.y) * 0.4 };
            side = Math.max(side, 2 * vlength2({ x: (w.x - e.x) * mx, y: (w.y - e.y) * my }));
          }
          const r = NRect.fromCenter(centre, { x: side / mx, y: side / my });
          r.x = clamp(r.x, 0, Math.max(1 - r.w, 0)); r.y = clamp(r.y, 0, Math.max(1 - r.h, 0));
          r.w = Math.min(r.w, 1); r.h = Math.min(r.h, 1);
          this.wristROIs.push(r);
        }
      }
    }
  }
}
