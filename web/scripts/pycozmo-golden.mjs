// Converts the Swift PyCozmoGolden.swift test data into web/test/render/pycozmo-golden.json (mechanical, no edits).
// Usage: node scripts/pycozmo-golden.mjs [path/to/PyCozmoGolden.swift]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = process.argv[2] ??
  fileURLToPath(new URL('../../../yanni/Packages/YanniFace/Tests/FaceRenderingTests/PyCozmoGolden.swift', import.meta.url));
const text = readFileSync(src, 'utf8');
const entries = [...text.matchAll(/Entry\(\s*name:\s*"([^"]+)",\s*params:\s*\[([^\]]*)\],\s*rows:\s*\[([^\]]*)\]\)/g)]
  .map(([, name, params, rows]) => ({
    name,
    params: params.split(',').map((s) => s.trim()).filter(Boolean).map(Number),
    rows: [...rows.matchAll(/"([0-9a-f]+)"/g)].map((m) => m[1]),
  }));
if (entries.length === 0 || entries.some((e) => e.params.some(Number.isNaN))) throw new Error('parse failed');
const header = text.split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join(' ');
writeFileSync(fileURLToPath(new URL('../test/render/pycozmo-golden.json', import.meta.url)),
  `{"source": ${JSON.stringify(header)},\n"entries": [\n${entries.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`);
console.log(`${entries.length} entries`);
