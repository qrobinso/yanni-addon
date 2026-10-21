// Port of FacePerception/BodyGestures.swift.
//
// Body-pose rules on the 15 Hz `PersonFeatureStream` (design §6.2). All read joints in metres in the image plane at
// the person's distance, ignore masked samples, and look only at samples newer than `since` (the gesture's last
// firing). Each returns `candidate` (in progress) and a confidence when it completes.
import type { V2 } from '../core/vec';
import { chiralityBoth } from './DanceRule';
import { clamp, radToDeg, vdot2, vlength2, vnormalize2 } from './PerceptionTypes';
import { PersonFeatureStream, StreamJoint } from './PersonFeatureStream';

/// What a rule says on a stream sample.
export interface RuleResult { candidate: boolean; fired: number | null }
export const makeRuleResult = (candidate = false, fired: number | null = null): RuleResult => ({ candidate, fired });

/// Swift `ClosedRange<Double>`.
export interface ClosedRange { lowerBound: number; upperBound: number }
export const rangeContains = (r: ClosedRange, v: number): boolean => v >= r.lowerBound && v <= r.upperBound;

/// Rule tunables.
export class BodyRuleParams {
  // Clap.
  clapClosed = 0.25;
  clapOpen = 0.6;
  clapGap: ClosedRange = { lowerBound: 0.25, upperBound: 0.8 };
  clapWindow = 2;
  // Arms up.
  armsAboveNose = 0.15;
  armsElbowDegrees = 140;
  armsHold = 0.4;
  armsOnset = 1;
  // Dancing.
  danceWindow = 4;
  danceStart = 0.5;
  danceEnd = 0.3;
  danceEndHold = 2;
  danceMinStd = 0.02;
  danceMaxSpeed = 0.3;
  // Peekaboo.
  peekNearFace = 0.18;
  peekHidden: ClosedRange = { lowerBound: 0.5, upperBound: 4 };
  peekCoverTimeout = 2;
  // Far point.
  pointExtended = 0.6;
  pointHold = 0.4;
  pointAway = 0.25;
  pointStableDegrees = 20;
}

/// Clap: wrist separation over shoulder width; ≥ 2 closings (< 0.25) each after an opening (> 0.6), the closings
/// 0.25–0.8 s apart, both wrists in front of the torso between hip and head.
export class ClapRule {
  step(s: PersonFeatureStream, since: number, k: BodyRuleParams): RuleResult {
    const newest = s.newest;
    if (newest === null) return makeRuleResult();
    let opened = false;
    let lastMin: number | null = null;
    let minima = 0;
    let inClosed = false;
    let n = Math.min(s.count, Math.trunc(k.clapWindow * PersonFeatureStream.rate));
    while (n > 0) {
      n -= 1;
      const x = s.back(n);
      if (!(x.t > since) || !x.body) continue;
      const sw = x.shoulderWidth, c = x.centre;
      const l = x.joints.get(StreamJoint.leftWrist), r = x.joints.get(StreamJoint.rightWrist);
      if (sw === null || !(sw > 0.05) || c === null || l === null || r === null) continue;
      const top = (x.joints.get(StreamJoint.nose)?.y ?? c.y - 0.25) - 0.1;
      const bottom = x.hipCentre?.y ?? c.y + 0.55;
      const span = sw * 0.65 * 1.3;
      const inFront = l.y > top && r.y > top && l.y < bottom && r.y < bottom && Math.abs(l.x - c.x) <= span + sw * 0.3 &&
        Math.abs(r.x - c.x) <= span + sw * 0.3;
      const sep = vlength2({ x: l.x - r.x, y: l.y - r.y }) / sw;
      if (sep > k.clapOpen) { opened = true; inClosed = false; continue; }
      if (!inFront || !(sep < k.clapClosed) || !opened || inClosed) continue;
      inClosed = true;
      opened = false;
      if (lastMin !== null && !rangeContains(k.clapGap, x.t - lastMin)) {
        minima = x.t - lastMin > k.clapGap.upperBound ? 1 : minima;
      } else {
        minima += 1;
      }
      lastMin = x.t;
    }
    const recent = lastMin !== null ? newest.t - lastMin <= k.clapGap.upperBound : false;
    const out = makeRuleResult(minima >= 1 && recent);
    if (minima >= 2 && recent) out.fired = clamp(0.75 + 0.05 * (minima - 2), 0, 0.95);
    return out;
  }
}

/// Arms up ("yay!"): both wrists above the nose by ≥ 0.15 m with the elbows ≥ 140° open, held ≥ 0.4 s, the arms
/// having come up from below the shoulders within 1 s before the pose began.
export class ArmsUpRule {
  poseStart: number | null = null;
  lastBelowShoulders = -Infinity;

  static elbowDegrees(sh: V2, el: V2, wr: V2): number {
    const a = vnormalize2({ x: sh.x - el.x, y: sh.y - el.y }), b = vnormalize2({ x: wr.x - el.x, y: wr.y - el.y });
    return Math.acos(clamp(vdot2(a, b), -1, 1)) * radToDeg;
  }

  step(s: PersonFeatureStream, since: number, k: BodyRuleParams): RuleResult {
    const x = s.newest;
    if (x === null || !x.body) return makeRuleResult();
    const nose = x.joints.get(StreamJoint.nose), c = x.centre;
    if (nose === null || c === null) return makeRuleResult();
    let up = true, below = true;
    for (const side of chiralityBoth) {
      const w = x.joints.get(StreamJoint.wrist(side));
      if (w === null) { up = false; below = false; continue; }
      if (w.y < c.y) below = false;
      const e = x.joints.get(StreamJoint.elbow(side)), sh = x.joints.get(StreamJoint.shoulder(side));
      if (e === null || sh === null) { up = false; continue; }
      if (!(w.y < nose.y - k.armsAboveNose && ArmsUpRule.elbowDegrees(sh, e, w) >= k.armsElbowDegrees)) up = false;
    }
    if (below) this.lastBelowShoulders = x.t;
    if (up) this.poseStart = this.poseStart ?? x.t; else this.poseStart = null;
    const start = this.poseStart;
    if (start === null) return makeRuleResult();
    const out = makeRuleResult(true);
    if (x.t - start >= k.armsHold - 1e-6 && start > since && start - this.lastBelowShoulders <= k.armsOnset) out.fired = 0.85;
    return out;
  }
}
