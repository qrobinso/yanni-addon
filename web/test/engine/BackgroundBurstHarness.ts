// Shared helpers of the colour burst suites (Swift BackgroundBurstTests' statics, used by the Gate / Safety suites).
import { v3, type V3 } from '../../src/core/vec';
import { Oklab, type FaceFrame } from '../../src/model';
import { FaceEngine, MoodBackgroundConfig, OneShotSampler, type Modifier, type MoodBackground } from '../../src/engine';
import { Brightness } from '../../src/engine/modifiers/Brightness';
import { MoodColor } from '../../src/engine/modifiers/MoodColor';

export const dt = 1 / 60;
export const fdt = Math.fround(dt);

export function engine(sampler = false, configure: (c: MoodBackgroundConfig) => void = () => {}): FaceEngine {
  const mods: Modifier[] = sampler ? [new OneShotSampler(), new MoodColor(), new Brightness()] : [new MoodColor(), new Brightness()];
  const e = new FaceEngine({ seed: 3, modifiers: mods });
  e.setAgentState('idle');
  const c = e.moodBackground;
  c.mode = 'mood';
  configure(c);
  e.moodBackground = c;
  return e;
}

export const bg = (e: FaceEngine): MoodBackground => (e.director.modifier('MoodColor') as MoodColor).background;
export const lab = (f: FaceFrame): V3 => Oklab.fromLinear(f.backgroundColor);
export const dist = (a: V3, b: V3): number => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
export const chroma = (l: V3): number => Math.sqrt(l.y * l.y + l.z * l.z);

/// Distance of the shown colour from the mood background's own colour, per frame, for `seconds`.
export function run(e: FaceEngine, seconds: number, each: (f: FaceFrame, b: MoodBackground) => void = () => {}, step = dt)
  : number[] {
  const out: number[] = [];
  const n = Math.round(seconds / step);
  for (let i = 0; i < n; i++) {
    const f = e.tick(step);
    const b = bg(e);
    out.push(dist(Oklab.fromLinear(Oklab.toLinearClamped(b.currentLab, v3(0))), lab(f)));
    each(f, b);
  }
  return out;
}

export function settled(configure: (c: MoodBackgroundConfig) => void = () => {}): FaceEngine {
  const e = engine(false, configure);
  run(e, 2);
  return e;
}

export const maxOf = (xs: readonly number[]): number => xs.reduce((m, x) => Math.max(m, x), -Infinity);
export const minOf = (xs: readonly number[]): number => xs.reduce((m, x) => Math.min(m, x), Infinity);
/// Swift `indices.max { a[$0] < a[$1] }`: the first index of the largest value.
export const argMax = (xs: readonly number[]): number => xs.reduce((bi, x, i) => (x > xs[bi] ? i : bi), 0);
