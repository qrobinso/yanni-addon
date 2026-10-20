// Shared render-test helpers (Swift RendererTests.swift top-level functions, plus the property-test RNG).
import { SplitMix64 } from '../../src/core/random';
import { v2, type V2 } from '../../src/core/vec';
import { makeFaceFrame, type FaceFrame } from '../../src/model/FaceFrame';
import type { FacePose } from '../../src/model/FacePose';
import { ParamLayout } from '../../src/model/ParamLayout';

/// The closure scale the engine reports for blink closure `c` (matches `blinked`).
export function blinkClosureScale(c: number): V2 {
  const e = c * c * (3 - 2 * c);
  return v2(1 + (1.08 - 1) * e, 1 + (0.3 - 1) * e);
}

/// A frame at blink closure `c`, with the closure scale set (so the pupil rides the blink as a rigid body).
export function blinkFrame(pose: FacePose, c: number, brightness = 1): FaceFrame {
  return makeFaceFrame(blinked(pose, c), { brightness, closureScale: blinkClosureScale(c) });
}

/// Applies the engine's blink closure (Part D C4) so tests can render mid-blink frames without FaceEngine.
export function blinked(pose: FacePose, c: number): FacePose {
  const p = pose.copy();
  const e = c * c * (3 - 2 * c);
  for (const side of ParamLayout.Side.allCases) {
    const u = p.eye(side, 'upperLidY'), l = p.eye(side, 'lowerLidY');
    const a = 1 - u - l;
    const m = u + 0.6 * a;
    p.setEye(side, 'upperLidY', u + (m - u) * c);
    p.setEye(side, 'lowerLidY', l + ((1 - m) - l) * c);
    p.setEye(side, 'scaleY', p.eye(side, 'scaleY') * (1 + (0.3 - 1) * e));
    p.setEye(side, 'scaleX', p.eye(side, 'scaleX') * (1 + (1.08 - 1) * e));
  }
  return p;
}

/// Sets both pupils (a copy).
export function withPupils(pose: FacePose, o: { x?: number; y?: number; size?: number; squash?: number }): FacePose {
  const p = pose.copy();
  for (const side of ParamLayout.Side.allCases) {
    if (o.x !== undefined) p.setEye(side, 'x', o.x);
    if (o.y !== undefined) p.setEye(side, 'y', o.y);
    if (o.size !== undefined) p.setEye(side, 'size', o.size);
    if (o.squash !== undefined) p.setEye(side, 'squash', o.squash);
  }
  return p;
}

/// Seeded RNG for property tests (Swift `SplitMix` + `Float.random(in:using:)` / `randomElement(using:)`).
// shortcut: same seeds as the Swift, but not Swift's Lemire sampling, so the sampled cases differ (same properties).
export class TestRandom {
  private readonly r: SplitMix64;
  constructor(seed: number) { this.r = new SplitMix64(seed); }
  float(lo: number, hi: number): number { return this.r.uniform(lo, hi); }
  pick<T>(a: readonly T[]): T { return a[Math.floor(this.r.unit() * a.length)]; }
}

export const dist2 = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.y - b.y);
