// The TS packing (RenderUniforms.packFrameUniforms) matches the WGSL `FrameU` layout: offsets are computed here from
// the shader's struct declarations with the WGSL alignment rules (WGSL spec §13.4, memory layout), not hard-coded.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { FrameUniforms, frameUniformBytes, frameUniformFloats, packFrameUniforms, uniformOffsets } from '../../src/render/RenderUniforms';

const wgsl = readFileSync(fileURLToPath(new URL('../../src/render/EyeShader.wgsl', import.meta.url)), 'utf8');

interface Layout { align: number; size: number; members: Map<string, number> }
const structs = new Map<string, { fields: [string, string][] }>();
for (const m of wgsl.matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
  const body = m[2].replace(/\/\/[^\n]*/g, '');
  // One member per line (`name: type,`); the PupilF helper struct is on one line and never in a uniform.
  const fields = body.split('\n').map((l) => /^\s*(\w+)\s*:\s*(.+?),?\s*$/.exec(l)).filter((f) => f !== null)
    .map((f) => [f[1], f[2].trim()] as [string, string]);
  structs.set(m[1], { fields });
}

const roundUp = (k: number, n: number) => Math.ceil(n / k) * k;
const scalars: Record<string, [number, number]> = { f32: [4, 4], i32: [4, 4], u32: [4, 4], vec2f: [8, 8],
  vec3f: [16, 12], vec4f: [16, 16] };

/// (align, size, flattened member offsets) of a type in the uniform address space.
function layout(type: string): Layout {
  if (scalars[type]) return { align: scalars[type][0], size: scalars[type][1], members: new Map() };
  const arr = /^array<(\w+),\s*(\d+)>$/.exec(type);
  if (arr) {
    const el = layout(arr[1]);
    const stride = roundUp(16, roundUp(el.align, el.size)); // uniform arrays: stride a multiple of 16
    return { align: roundUp(16, el.align), size: stride * Number(arr[2]), members: new Map() };
  }
  const s = structs.get(type);
  if (!s) throw new Error(`unknown WGSL type ${type}`);
  let offset = 0, align = 0;
  const members = new Map<string, number>();
  for (const [name, t] of s.fields) {
    const l = layout(t);
    const a = structs.has(t) ? roundUp(16, l.align) : l.align; // uniform: struct members 16-aligned
    offset = roundUp(a, offset);
    members.set(name, offset);
    for (const [sub, o] of l.members) members.set(`${name}.${sub}`, offset + o);
    offset += l.size;
    align = Math.max(align, a);
  }
  return { align, size: roundUp(align, offset), members };
}

test('FrameU in the shader has the TS packing offsets', () => {
  const frame = layout('FrameU');
  expect(frame.size).toBe(frameUniformBytes);
  const ts = uniformOffsets();
  for (const [name, floatOffset] of Object.entries(ts)) {
    expect(frame.members.get(name), name).toBe(floatOffset * 4);
  }
  // And nothing in the shader that the TS side doesn't pack (leaf members only).
  const leaves = [...frame.members.keys()].filter((k) => ![...frame.members.keys()].some((o) => o.startsWith(k + '.')));
  expect(leaves.sort()).toEqual(Object.keys(ts).sort());
});

test('packFrameUniforms writes each field at its offset', () => {
  const u = new FrameUniforms();
  u.glowColorB.z = 7;
  u.right.lidBlend.w = 9;
  u.browRight.points[12].y = 11;
  const out = packFrameUniforms(u, new Float32Array(frameUniformFloats));
  const o = uniformOffsets();
  expect(out[o.glowColorB + 2]).toBe(7);
  expect(out[o['right.lidBlend'] + 3]).toBe(9);
  expect(out[o['browRight.points'] + 12 * 4 + 1]).toBe(11);
  expect(out.length).toBe(316);
});
