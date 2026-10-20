// Render fixtures (fixtures/render/frames.json, written by tools/golden `golden-render`): the FaceFrame inputs,
// style, size and the Swift-packed uniforms of every reference PNG.
import { v2, v3, v4 } from '../../src/core/vec';
import { BrowLayout, BrowPose } from '../../src/model/BrowPose';
import { makeFaceFrame, type FaceFrame } from '../../src/model/FaceFrame';
import { FacePose } from '../../src/model/FacePose';
import { RenderStyle } from '../../src/render/RenderStyle';

export interface RenderEntry {
  name: string;
  png: string;
  width: number;
  height: number;
  source: { scenario: string; f: number };
  styleName: string;
  style: Record<string, unknown>;
  frame: Record<string, number | boolean | number[]>;
  uniforms: number[];
}

export interface RenderFixtures { version: number; uniformFloats: number; entries: RenderEntry[] }

/// A trace-format frame record → FaceFrame (`brows` are the 18 used lanes in `BrowLayout.usedIndices` order).
export function frameFromRecord(r: RenderEntry['frame']): FaceFrame {
  const a = (k: string) => r[k] as number[];
  const n = (k: string) => r[k] as number;
  const brows = new BrowPose();
  BrowLayout.usedIndices.forEach((idx, i) => brows.set(idx, a('brows')[i]));
  const [c, cs, so, es, ps, pm, pss, bo, bg, g1, g2, gp] =
    ['color', 'closureScale', 'stageOffset', 'eyeStageOffset', 'pupilShape', 'pupilMorph', 'pupilShapeScale',
      'browOffset', 'backgroundColor', 'glowColor', 'glowColor2', 'glowPhase'].map(a);
  return makeFaceFrame(FacePose.fromArray(a('pose')), {
    brightness: n('brightness'), wantsHighFrameRate: r.wantsHighFrameRate as boolean, isAsleep: r.isAsleep as boolean,
    color: v3(c[0], c[1], c[2]), closureScale: v2(cs[0], cs[1]), stageOffset: v2(so[0], so[1]),
    eyeStageOffset: v4(es[0], es[1], es[2], es[3]), pupilShape: v2(ps[0], ps[1]), pupilMorph: v2(pm[0], pm[1]),
    pupilShapeScale: v4(pss[0], pss[1], pss[2], pss[3]), brows, browPresence: n('browPresence'),
    browOffset: v4(bo[0], bo[1], bo[2], bo[3]), backgroundColor: v3(bg[0], bg[1], bg[2]),
    backgroundStrength: n('backgroundStrength'), backgroundPresence: n('backgroundPresence'),
    backgroundBrightness: n('backgroundBrightness'), glowLevel: n('glowLevel'), glowHeight: n('glowHeight'),
    glowMotion: n('glowMotion'), glowRipple: n('glowRipple'), glowColor: v3(g1[0], g1[1], g1[2]),
    glowColor2: v3(g2[0], g2[1], g2[2]), glowPhase: v4(gp[0], gp[1], gp[2], gp[3]), captionInset: n('captionInset'),
  });
}

export const styleFromEntry = (e: RenderEntry): RenderStyle => RenderStyle.decode(e.style);
