// The TS geometry packs the same uniforms as the Swift renderer for every render fixture (CPU parity; the pixels are
// compared by `npm run render:parity`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { EyeGeometry } from '../../src/render/EyeGeometry';
import { resolvedStyle } from '../../src/render/MoodColorMix';
import { FrameUniforms, frameUniformFloats, packFrameUniforms, uniformOffsets } from '../../src/render/RenderUniforms';
import { Viewport } from '../../src/render/Viewport';
import { frameFromRecord, styleFromEntry, type RenderFixtures } from './frames';

const fixtures: RenderFixtures = JSON.parse(readFileSync(fileURLToPath(new URL('../../../fixtures/render/frames.json',
  import.meta.url)), 'utf8'));

const names = Object.entries(uniformOffsets()).sort((a, b) => a[1] - b[1]);
const fieldAt = (i: number): string => {
  let name = '?';
  for (const [k, o] of names) if (o <= i) name = `${k}[${i - o}]`;
  return name;
};

describe('uniform parity with Swift', () => {
  test('fixture float count matches the layout', () => {
    expect(fixtures.uniformFloats).toBe(frameUniformFloats);
  });

  test.each(fixtures.entries.map((e) => [e.name, e] as const))('%s', (_n, e) => {
    const frame = frameFromRecord(e.frame);
    const style = styleFromEntry(e);
    const vp = Viewport.fitting(e.width, e.height, style, frame.captionInset);
    const u = EyeGeometry.uniforms(frame, vp, resolvedStyle(style, frame), new FrameUniforms());
    const ts = packFrameUniforms(u, new Float32Array(frameUniformFloats));
    const bad: string[] = [];
    for (let i = 0; i < ts.length; i++) {
      const a = ts[i], b = e.uniforms[i];
      // Swift computes in Float32 (iterative solvers included); 1e-3 absolute or 1e-4 relative (PORTING.md).
      if (!(Math.abs(a - b) <= 1e-3 + 1e-4 * Math.abs(b))) bad.push(`${fieldAt(i)}: ts ${a} swift ${b}`);
    }
    expect(bad).toEqual([]);
  });
});
