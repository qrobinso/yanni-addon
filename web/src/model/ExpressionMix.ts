// Port of FaceModel/ExpressionMix.swift.
import { BrowLayout, BrowPose } from './BrowPose';
import type { ExpressionLibrary } from './Expression';
import { FacePose } from './FacePose';
import { ParamLayout } from './ParamLayout';

export interface ExpressionMixEntry { name: string; weight: number }
export const mixEntry = (name: string, weight: number): ExpressionMixEntry => ({ name, weight });

const sumPose = new Float64Array(ParamLayout.count);
const sumBrows = new Float64Array(32);

/// A weighted blend of named expressions with an overall intensity.
///
/// Target = neutral + intensity * Σ (wᵢ/Σw) * (exprᵢ − neutral).
/// Scale parameters blend in log space instead: s = s_n · exp(I · Σ ŵᵢ ln(sᵢ/s_n)), which keeps them
/// positive under exaggeration. Intensity 0 is Neutral, 1 is the authored blend, >1 exaggerates.
export class ExpressionMix {
  constructor(public entries: ExpressionMixEntry[], public intensity = 1) {}

  static single(name: string, intensity = 1): ExpressionMix {
    return new ExpressionMix([mixEntry(name, 1)], intensity);
  }

  /// Fresh each access.
  static get neutral(): ExpressionMix { return ExpressionMix.single('Neutral'); }

  copy(): ExpressionMix { return new ExpressionMix(this.entries.map((e) => ({ ...e })), this.intensity); }

  equals(o: ExpressionMix): boolean {
    return this.intensity === o.intensity && this.entries.length === o.entries.length &&
      this.entries.every((e, i) => e.name === o.entries[i].name && e.weight === o.entries[i].weight);
  }

  /// Resolves the mix against a library. Unknown names are skipped and weights renormalised. Returns a new pose.
  pose(library: ExpressionLibrary): FacePose {
    const neutral = library.neutral.raw;
    sumPose.fill(0);
    let total = 0;
    for (const e of this.entries) {
      if (!(e.weight > 0)) continue;
      const expr = library.get(e.name);
      if (!expr) continue;
      const p = expr.pose.raw;
      for (let i = 0; i < sumPose.length; i++) sumPose[i] += (p[i] - neutral[i]) * e.weight;
      total += e.weight;
    }
    if (!(total > 0)) return library.neutral.copy();
    const out = new FacePose();
    const k = this.intensity / total;
    for (let i = 0; i < sumPose.length; i++) out.raw[i] = neutral[i] + sumPose[i] * k;
    for (const i of ParamLayout.scaleIndices) {
      let logSum = 0;
      for (const e of this.entries) {
        if (!(e.weight > 0)) continue;
        const expr = library.get(e.name);
        if (!expr) continue;
        logSum += e.weight * Math.log(Math.max(expr.pose.raw[i], 1e-3) / Math.max(neutral[i], 1e-3));
      }
      out.raw[i] = neutral[i] * Math.exp((this.intensity * logSum) / total);
    }
    return out;
  }

  /// The mix's eyebrows, blended the same way relative to the library Neutral's brows: linear lanes add weighted
  /// deltas, width and thickness blend in log space. An expression without brows contributes Neutral's.
  brows(library: ExpressionLibrary): BrowPose {
    const neutral = library.neutralBrows.raw;
    sumBrows.fill(0);
    let total = 0;
    for (const e of this.entries) {
      if (!(e.weight > 0) || library.get(e.name) === undefined) continue;
      const b = library.brows(e.name).raw;
      for (let i = 0; i < sumBrows.length; i++) sumBrows[i] += (b[i] - neutral[i]) * e.weight;
      total += e.weight;
    }
    if (!(total > 0)) return library.neutralBrows.copy();
    const out = new BrowPose();
    const k = this.intensity / total;
    for (let i = 0; i < sumBrows.length; i++) out.raw[i] = neutral[i] + sumBrows[i] * k;
    for (const i of BrowLayout.scaleIndices) {
      let logSum = 0;
      for (const e of this.entries) {
        if (!(e.weight > 0) || library.get(e.name) === undefined) continue;
        logSum += e.weight * Math.log(Math.max(library.brows(e.name).raw[i], 1e-3) / Math.max(neutral[i], 1e-3));
      }
      out.raw[i] = neutral[i] * Math.exp((this.intensity * logSum) / total);
    }
    return out;
  }
}
