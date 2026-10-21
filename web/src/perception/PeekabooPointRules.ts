// Port of FacePerception/PeekabooPointRules.swift.
import type { V2 } from '../core/vec';
import { makeRuleResult, rangeContains, type BodyRuleParams, type ClosedRange, type RuleResult } from './BodyGestures';
import type { Chirality } from './PerceptionTypes';
import { clamp, radToDeg, vdot2, vlength2, vnormalize2 } from './PerceptionTypes';
import { PersonFeatureStream, StreamJoint } from './PersonFeatureStream';

/// Peekaboo (design §6.2): aimed at Yanni while both wrists come up to the face (≥ 2 samples), then the face is lost
/// (or both eyes shut) for 0.5–4 s while the body track holds, then the face is back. The reveal is the gesture.
export class PeekabooRule {
  phase: 'idle' | 'covering' | 'hidden' = 'idle';
  private since = 0;
  private nearCount = 0;
  private lastBody = 0;

  /// `aimed`: the aimed-at gate holds now (only read when the cover starts).
  step(s: PersonFeatureStream, aimed: boolean, k: BodyRuleParams): RuleResult {
    const x = s.newest;
    if (x === null) return makeRuleResult();
    if (x.body) this.lastBody = x.t;
    const faceSeen = x.face && x.openness >= 0.1;
    switch (this.phase) {
      case 'idle': {
        const nose = x.joints.get(StreamJoint.nose), l = x.joints.get(StreamJoint.leftWrist), r = x.joints.get(StreamJoint.rightWrist);
        if (!x.body || nose === null || l === null || r === null) { this.nearCount = 0; return makeRuleResult(); }
        const near = vlength2({ x: l.x - nose.x, y: l.y - nose.y }) <= k.peekNearFace &&
          vlength2({ x: r.x - nose.x, y: r.y - nose.y }) <= k.peekNearFace;
        this.nearCount = near ? this.nearCount + 1 : 0;
        if (this.nearCount >= 2 && aimed) { this.phase = 'covering'; this.since = x.t; }
        return makeRuleResult(near && aimed);
      }
      case 'covering':
        if (!faceSeen) { this.phase = 'hidden'; this.since = x.t; }
        else if (x.t - this.since > k.peekCoverTimeout) { this.phase = 'idle'; this.nearCount = 0; }
        return makeRuleResult(this.phase !== 'idle');
      case 'hidden': {
        if (x.t - this.lastBody > 0.5 || x.t - this.since > k.peekHidden.upperBound) {
          this.phase = 'idle'; this.nearCount = 0; return makeRuleResult();
        }
        if (!faceSeen) return makeRuleResult(true);
        const hidden = x.t - this.since;
        this.phase = 'idle';
        this.nearCount = 0;
        return rangeContains(k.peekHidden, hidden) ? makeRuleResult(false, 0.85) : makeRuleResult();
      }
    }
  }

  reset(): void { this.phase = 'idle'; this.nearCount = 0; }
}

/// Far point (body pose, beyond hand-shape range; design §6.2): the elbow → wrist ray with the arm ≥ 60 % extended,
/// the wrist away from the torso and not hanging down, the direction steady (≤ 20°) for ≥ 0.4 s.
export class FarPointRule {
  private start: number | null = null;
  private startDir: V2 = { x: 0, y: 0 };
  direction: V2 = { x: 0, y: 0 };

  step(s: PersonFeatureStream, side: Chirality, since: number, k: BodyRuleParams): RuleResult {
    const x = s.newest;
    const c = x?.body ? x.centre : null;
    const w = x?.joints.get(StreamJoint.wrist(side)) ?? null, e = x?.joints.get(StreamJoint.elbow(side)) ?? null;
    const sh = x?.joints.get(StreamJoint.shoulder(side)) ?? null;
    if (x === null || c === null || w === null || e === null || sh === null) { this.start = null; return makeRuleResult(); }
    const arm = vlength2({ x: e.x - sh.x, y: e.y - sh.y }) + vlength2({ x: w.x - e.x, y: w.y - e.y });
    const extended = arm > 0.1 && vlength2({ x: w.x - sh.x, y: w.y - sh.y }) >= k.pointExtended * arm;
    const dir = vnormalize2({ x: w.x - e.x, y: w.y - e.y });
    const away = Math.abs(w.x - c.x) >= k.pointAway + (x.shoulderWidth ?? 0.4) / 2 || w.y < sh.y;
    const notDown = dir.y < 0.7; // within ≈ 45° of straight down is a hanging arm
    if (!(extended && away && notDown)) { this.start = null; return makeRuleResult(); }
    const t0 = this.start;
    if (t0 !== null && Math.acos(clamp(vdot2(dir, this.startDir), -1, 1)) * radToDeg <= k.pointStableDegrees) {
      this.direction = vnormalize2({ x: this.direction.x * 0.7 + dir.x * 0.3, y: this.direction.y * 0.7 + dir.y * 0.3 });
      const out = makeRuleResult(true);
      if (x.t - t0 >= k.pointHold - 1e-6 && t0 > since) out.fired = 0.8;
      return out;
    }
    this.start = x.t;
    this.startDir = dir;
    this.direction = dir;
    return makeRuleResult(true);
  }
}

/// Nod (design §6.2): head pitch relative to the head → camera ray, high-passed over a 1.5 s window: ≥ 2 reversals,
/// peak-to-peak ≥ 7° near (10° beyond 1.5 m), 1.2–4 Hz, yaw peak-to-peak < half the pitch's, body speed < 0.3 m/s.
export class NodRule {
  window = 1.5;
  minPeakNear = 7;
  minPeakFar = 10;
  halfPeriod: ClosedRange = { lowerBound: 0.125, upperBound: 0.42 };
  maxSpeed = 0.3;

  step(s: PersonFeatureStream, distance: number, speed: number, since: number): RuleResult {
    const n = Math.min(s.count, Math.trunc(this.window * PersonFeatureStream.rate));
    const newest = s.newest;
    if (!(n >= 8) || newest === null || !newest.face || !(speed < this.maxSpeed)) return makeRuleResult();
    let mean = 0, valid = 0;
    let yLo = Infinity, yHi = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = s.back(i);
      if (!x.face || !(x.t > since)) continue;
      mean += x.pitch; valid += 1;
      yLo = Math.min(yLo, x.yaw); yHi = Math.max(yHi, x.yaw);
    }
    // f32: Swift `Int(Float(n) * 0.8)`.
    if (!(valid >= Math.trunc(Math.fround(n * Math.fround(0.8))))) return makeRuleResult();
    mean /= valid;
    // Turning points of the high-passed pitch, oldest first, with 2° hysteresis.
    let dir = 0, ext = 0, extT = 0;
    let reversals = 0, lastRev: number | null = null;
    let lo = Infinity, hi = -Infinity;
    let regular = true;
    for (let i = n - 1; i >= 0; i--) {
      const x = s.back(i);
      if (!x.face || !(x.t > since)) continue;
      const p = x.pitch - mean;
      lo = Math.min(lo, p); hi = Math.max(hi, p);
      if (dir === 0) {
        if (hi - lo > 2) { dir = p >= hi ? 1 : -1; ext = p; extT = x.t; }
      } else if ((dir > 0 && p > ext) || (dir < 0 && p < ext)) {
        ext = p; extT = x.t;
      } else if (Math.abs(p - ext) > 2) {
        reversals += 1;
        if (lastRev !== null && !rangeContains(this.halfPeriod, extT - lastRev)) regular = false;
        lastRev = extT;
        dir = -dir; ext = p; extT = x.t;
      }
    }
    const pp = hi - lo;
    const need = distance <= 1.5 ? this.minPeakNear : this.minPeakFar;
    const candidate = reversals >= 1 && pp >= need * 0.6;
    if (!(reversals >= 2) || !regular || !(pp >= need) || !((yHi - yLo) < 0.5 * pp)) return makeRuleResult(candidate);
    return makeRuleResult(true, clamp(0.7 + 0.02 * (pp - need), 0.7, 0.95));
  }
}
