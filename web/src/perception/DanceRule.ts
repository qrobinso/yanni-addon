// Port of FacePerception/DanceRule.swift.
import type { V2 } from '../core/vec';
import type { BodyRuleParams } from './BodyGestures';
import type { Chirality, GesturePhase } from './PerceptionTypes';
import { vlength2 } from './PerceptionTypes';
import { PersonFeatureStream, StreamJoint, type FeatureSample } from './PersonFeatureStream';

// port-note: Swift `extension Chirality { static let both }` (Chirality is a plain string union here).
export const chiralityBoth: readonly Chirality[] = ['left', 'right'];

/// Dancing (sustained, design §6.2): over a 4 s window, the normalised autocorrelation peaks (lags 0.33–1.25 s) of the
/// shoulder centre's height, the hip centre (x, y) and both wrists (x, y, relative to the shoulders). The score is the
/// mean of the three strongest signals that move at all (std ≥ 2 cm), with at least one wrist rhythmic (peak ≥ 0.4),
/// ≥ 75 % of the window with a body reading, and the body's net speed under 0.3 m/s. Starts at ≥ 0.5, ends below 0.3
/// for 2 s.
export class DanceRule {
  active = false;
  private lowSince: number | null = null;
  private buf: number[] = new Array<number>(PersonFeatureStream.capacity).fill(0);
  lastScore = 0;

  /// Fills `buf` with one signal over the newest `n` samples (masked samples carry the last value); returns how many
  /// samples had a value.
  private fill(s: PersonFeatureStream, n: number, value: (x: FeatureSample) => number | null | undefined): number {
    let last: number | null = null;
    let valid = 0;
    for (let i = 0; i < n; i++) {
      const v = value(s.back(n - 1 - i));
      if (v !== null && v !== undefined) { last = v; valid += 1; }
      this.buf[i] = last ?? 0;
    }
    let firstValid = -1;
    for (let i = 0; i < n; i++) { const v = value(s.back(n - 1 - i)); if (v !== null && v !== undefined) { firstValid = i; break; } }
    if (firstValid >= 0) for (let i = 0; i < firstValid; i++) this.buf[i] = this.buf[firstValid];
    return valid;
  }

  /// Peak normalised autocorrelation of `buf[0..<n]` over `lags`, counted only after it first dipped below zero (a
  /// rhythm, not a step or a drift); 0 for a still signal.
  private peak(n: number, lagLo: number, lagHi: number, minStd: number): number {
    const buf = this.buf;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += buf[i];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = buf[i] - mean; v += d * d; }
    if (!(v > 0) || !(Math.sqrt(v / n) >= minStd)) return 0;
    let best = 0;
    let dipped = false;
    for (let lag = 1; lag <= lagHi; lag++) {
      if (!(lag < n - 4)) continue;
      let c = 0;
      for (let i = 0; i < n - lag; i++) c += (buf[i] - mean) * (buf[i + lag] - mean);
      const r = c / v * n / (n - lag);
      if (r < 0) dipped = true;
      if (dipped && lag >= lagLo) best = Math.max(best, r);
    }
    return Math.min(best, 1);
  }

  /// The transition on this sample (`started` / `ended`), or null.
  step(s: PersonFeatureStream, k: BodyRuleParams): GesturePhase | null {
    const rate = PersonFeatureStream.rate;
    const want = Math.trunc(k.danceWindow * rate);
    const n = Math.min(s.count, want);
    const x = s.newest;
    if (x === null || !(n >= want - 2)) return null;
    const lagLo = Math.trunc(0.33 * rate), lagHi = Math.trunc(1.25 * rate);
    let p0 = 0, p1 = 0, p2 = 0;
    let wristStrong = false;
    const add = (p: number, wrist: boolean): void => {
      if (wrist && p >= 0.4) wristStrong = true;
      if (p > p0) { p2 = p1; p1 = p0; p0 = p; } else if (p > p1) { p2 = p1; p1 = p; } else if (p > p2) { p2 = p; }
    };
    const bodyValid = this.fill(s, n, (y) => y.body ? y.centre?.y : null);
    add(this.peak(n, lagLo, lagHi, k.danceMinStd), false);
    this.fill(s, n, (y) => y.body ? y.hipCentre?.x : null);
    add(this.peak(n, lagLo, lagHi, k.danceMinStd), false);
    this.fill(s, n, (y) => y.body ? y.hipCentre?.y : null);
    add(this.peak(n, lagLo, lagHi, k.danceMinStd), false);
    for (const side of chiralityBoth) {
      const j = StreamJoint.wrist(side);
      this.fill(s, n, (y) => y.body ? y.rel(j)?.x : null);
      add(this.peak(n, lagLo, lagHi, k.danceMinStd), true);
      this.fill(s, n, (y) => y.body ? y.rel(j)?.y : null);
      add(this.peak(n, lagLo, lagHi, k.danceMinStd), true);
    }
    const speed = DanceRule.netSpeed(s, n);
    const enoughBody = bodyValid >= 0.75 * n;
    const score = enoughBody && wristStrong && speed < k.danceMaxSpeed ? (p0 + p1 + p2) / 3 : 0;
    this.lastScore = score;
    if (!this.active) {
      if (score >= k.danceStart) { this.active = true; this.lowSince = null; return 'started'; }
    } else if (score < k.danceEnd) {
      const l = this.lowSince ?? x.t;
      this.lowSince = l;
      if (x.t - l >= k.danceEndHold) { this.active = false; this.lowSince = null; return 'ended'; }
    } else {
      this.lowSince = null;
    }
    return null;
  }

  /// Net speed (m/s) of the shoulder centre between the first and last body readings of the newest `n` samples.
  static netSpeed(s: PersonFeatureStream, n: number): number {
    let first: [number, V2] | null = null, last: [number, V2] | null = null;
    const m = Math.min(n, s.count);
    for (let i = 0; i < m; i++) {
      const y = s.back(m - 1 - i);
      const c = y.body ? y.centre : null;
      if (c !== null) {
        if (first === null) first = [y.t, c];
        last = [y.t, c];
      }
    }
    if (first === null || last === null || !(last[0] - first[0] > 0.5)) return 0;
    return vlength2({ x: last[1].x - first[1].x, y: last[1].y - first[1].y }) / (last[0] - first[0]);
  }

  reset(): void { this.active = false; this.lowSince = null; this.lastScore = 0; }
}
