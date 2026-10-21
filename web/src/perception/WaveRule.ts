// Port of FacePerception/WaveRule.swift.
import { makeRuleResult, type RuleResult } from './BodyGestures';
import { DistanceEstimator } from './Distance';
import type { GestureParams } from './Gestures';
import { clamp } from './PerceptionTypes';

interface WaveSample { t: number; x: number; raised: boolean }

/// Wave (hello and bye share it; design §6.2): the raised wrist's horizontal turning points in a 1.5 s window, from the
/// body-pose stream (or hand-pose wrists when the person has no body pose): ≥ 2 reversals with a median swing ≥ 0.6 ×
/// shoulder width (1.2 × palm width from hand pose alone), the hand open in ≥ 60 % of its hand results. Confidence
/// from amplitude and rhythm. One per (person, side); a fixed ring.
export class WaveRule {
  static readonly capacity = 48;
  private ring: WaveSample[] = Array.from({ length: WaveRule.capacity }, () => ({ t: -Infinity, x: 0, raised: false }));
  private head = 0;
  private count = 0;
  private swings: number[] = new Array<number>(WaveRule.capacity).fill(0);
  /// Shoulder width (metres) last seen, else the palm-derived estimate.
  shoulderM: number | null = null;

  reset(): void { this.head = 0; this.count = 0; this.shoulderM = null; }

  /// Appends a sample (`x` metres, viewer frame). Out-of-order samples are dropped.
  add(t: number, x: number, raised: boolean): void {
    const C = WaveRule.capacity;
    if (this.count > 0 && t <= this.ring[(this.head - 1 + C) % C].t) return;
    this.ring[this.head] = { t, x, raised };
    this.head = (this.head + 1) % C;
    this.count = Math.min(this.count + 1, C);
  }

  get newestTime(): number { return this.count > 0 ? this.ring[(this.head - 1 + WaveRule.capacity) % WaveRule.capacity].t : -Infinity; }

  /// Evaluates the window ending at the newest sample. `openFraction`: share of open-hand results (null: none).
  evaluate(since: number, k: GestureParams, openFraction: number | null): RuleResult {
    if (this.count <= 0) return makeRuleResult();
    const C = WaveRule.capacity;
    const swings = this.swings;
    const now = this.newestTime;
    const required = k.waveAmplitudeShoulders * (this.shoulderM ?? DistanceEstimator.shoulderWidthMetres);
    if (openFraction !== null && openFraction < k.waveOpenFraction) return makeRuleResult();
    const hyst = required * 0.5;
    let n = 0;
    let dir = 0;
    let lo = { t: 0, x: 0 }, hi = lo, start = lo, ext = lo;
    let reversals = 0;
    let nSwings = 0;
    let lastExtT = 0;
    let intervalSum = 0, intervalSq = 0, intervals = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const s = this.ring[(this.head - 1 - i + C * 2) % C];
      if (!s.raised || !(s.t > since) || !(now - s.t <= k.waveWindow)) continue;
      const cur = { t: s.t, x: s.x };
      n += 1;
      if (n === 1) { lo = cur; hi = cur; start = cur; ext = cur; continue; }
      if (dir === 0) {
        if (cur.x > hi.x) hi = cur;
        if (cur.x < lo.x) lo = cur;
        if (hi.x - lo.x > hyst) {
          if (hi.t >= lo.t) { dir = 1; start = lo; ext = hi; } else { dir = -1; start = hi; ext = lo; }
        }
      } else if ((dir > 0 && cur.x > ext.x) || (dir < 0 && cur.x < ext.x)) {
        ext = cur;
      } else if (Math.abs(cur.x - ext.x) > hyst) {
        swings[nSwings] = Math.abs(ext.x - start.x); nSwings += 1;
        if (reversals > 0) {
          const d = ext.t - lastExtT;
          intervalSum += d; intervalSq += d * d; intervals += 1;
        }
        lastExtT = ext.t;
        reversals += 1;
        start = ext; ext = cur; dir = -dir;
      }
    }
    if (dir !== 0 && nSwings < C) { swings[nSwings] = Math.abs(ext.x - start.x); nSwings += 1; }
    const candidate = reversals >= 1;
    if (!(n >= 4) || !(reversals >= k.waveReversals) || !(nSwings > 0)) return makeRuleResult(candidate);
    // Median swing (insertion sort of a handful of values in the scratch buffer).
    for (let i = 1; i < Math.max(nSwings, 1); i++) {
      const v = swings[i];
      let j = i - 1;
      while (j >= 0 && swings[j] > v) { swings[j + 1] = swings[j]; j -= 1; }
      swings[j + 1] = v;
    }
    const amp = swings[Math.trunc(nSwings / 2)];
    if (!(amp >= required)) return makeRuleResult(candidate);
    let regularity = 0.5;
    if (intervals >= 1) {
      const mean = intervalSum / intervals;
      const sd = Math.sqrt(Math.max(intervalSq / intervals - mean * mean, 0));
      if (mean > 0) regularity = Math.max(0, 1 - sd / mean);
    }
    const ampScore = clamp(amp / required - 1, 0, 1);
    const extra = Math.min(reversals - k.waveReversals, 2) * 0.05;
    return makeRuleResult(true, clamp(0.6 + 0.15 * ampScore + 0.15 * regularity + extra, 0, 1));
  }
}
