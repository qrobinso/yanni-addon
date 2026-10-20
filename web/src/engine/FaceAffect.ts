// Port of FaceEngine/FaceAffect.swift.
import type { V3 } from '../core/vec';
import type { ExpressionLibrary, ExpressionMix } from '../model';
import type { Mood } from './AgentState';
import type { FaceState } from './FaceState';

const ZERO3 = (): V3 => ({ x: 0, y: 0, z: 0 });
const c1 = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0);

/// The face's effective affect (PAD), shared by MoodColor and the voice (review M1) so colour and sound always come
/// from the same point.
///
/// Effective PAD = mood + `expressionInfluence` · (PAD of the shown mix − Neutral's PAD), where the shown mix is
/// `expressionOverride ?? targetMix`. Every component is clamped to −1…1; non-finite inputs read as 0. A reaction overlay
/// blends in like the pose does: delta = (1 − w)·influence·shownDelta + w·`reactionOverlayInfluence`·overlayDelta.
export const FaceAffect = {
  /// How strongly a fully weighted reaction overlay moves the PAD point (absolute, not × expressionInfluence).
  reactionOverlayInfluence: 1.6,

  /// Effective PAD for this state (x = pleasure, y = arousal, z = dominance).
  effectivePAD(s: FaceState, expressionInfluence = 0.5): V3 {
    const main = FaceAffect.padDelta(s.expressionOverride ?? s.targetMix, s.library);
    let ov = ZERO3();
    if (s.expressionOverride === null && s.reactionOverlayWeight > 0 && s.reactionOverlay !== null) {
      ov = FaceAffect.padDelta(s.reactionOverlay, s.library);
    }
    return FaceAffect.combineOverlay(s.mood, main, ov, FaceAffect.overlayWeight(s), expressionInfluence);
  },

  /// The overlay weight FaceAffect applies for this state (0 under an override or without an overlay).
  overlayWeight(s: FaceState): number {
    if (!(s.expressionOverride === null && s.reactionOverlay !== null)) return 0;
    const w = s.reactionOverlayWeight;
    return Number.isFinite(w) ? Math.min(Math.max(w, 0), 1) : 0;
  },

  /// `combine` with a reaction overlay blended in. w = 0 is exactly `combine`.
  combineOverlay(mood: Mood, mixDelta: V3, overlayDelta: V3, w: number, expressionInfluence: number): V3 {
    if (!(w > 0 && Number.isFinite(w))) return FaceAffect.combine(mood, mixDelta, expressionInfluence);
    const ww = Math.min(w, 1);
    const k = Number.isFinite(expressionInfluence) ? Math.max(expressionInfluence, 0) : 0;
    const a = k * (1 - ww), b = FaceAffect.reactionOverlayInfluence * ww;
    const d = { x: mixDelta.x * a + overlayDelta.x * b, y: mixDelta.y * a + overlayDelta.y * b, z: mixDelta.z * a + overlayDelta.z * b };
    return FaceAffect.combine(mood, d, 1);
  },

  /// PAD offset of `mix` relative to Neutral, scaled by the mix intensity. Unknown names / missing PADs skip.
  padDelta(mix: ExpressionMix, library: ExpressionLibrary): V3 {
    const n = library.get('Neutral')?.pad ?? { p: 0, a: 0, d: 0 };
    let sx = 0, sy = 0, sz = 0, total = 0;
    for (const e of mix.entries) {
      if (!(e.weight > 0)) continue;
      const pad = library.get(e.name)?.pad;
      if (!pad) continue;
      sx += (pad.p - n.p) * e.weight;
      sy += (pad.a - n.a) * e.weight;
      sz += (pad.d - n.d) * e.weight;
      total += e.weight;
    }
    if (!(total > 0 && Number.isFinite(mix.intensity))) return ZERO3();
    const k = mix.intensity / total;
    const d = { x: sx * k, y: sy * k, z: sz * k };
    return Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.z) ? d : ZERO3();
  },

  /// mood + influence · mixDelta, clamped to the PAD cube (the one formula; MoodColor caches `mixDelta`).
  combine(mood: Mood, mixDelta: V3, expressionInfluence: number): V3 {
    const k = Number.isFinite(expressionInfluence) ? Math.max(expressionInfluence, 0) : 0;
    const cl = (v: number): number => Math.min(Math.max(v, -1), 1);
    return {
      x: cl(c1(mood.pleasure) + mixDelta.x * k),
      y: cl(c1(mood.arousal) + mixDelta.y * k),
      z: cl(c1(mood.dominance) + mixDelta.z * k),
    };
  },
} as const;
