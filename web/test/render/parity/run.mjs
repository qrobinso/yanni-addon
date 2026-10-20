// npm run -w web render:parity [-- name-filter]
// Renders every fixtures/render/frames.json entry with the TS FaceRenderer in headless Chromium (WebGPU on the
// Metal backend) and compares it with the Swift Metal reference PNG. Writes the TS render and a diff image per entry
// to test/render/parity/out (gitignored). Exits 1 when an entry misses the thresholds.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Thresholds (code values, 0…255): mean absolute error over all pixels and channels < 1; outside anti-aliased edges
// (see EDGE_RANGE in page.ts) no channel off by more than 8.
const MEAN_LIMIT = 1;
const MAX_NON_EDGE_LIMIT = 8;

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '../../..');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
const filter = process.argv[2];

const server = await createServer({ root: webRoot, logLevel: 'error', server: { port: 0 } });
await server.listen();
const url = server.resolvedUrls.local[0] + 'test/render/parity/index.html';

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
let failed = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(url);
  const count = await page.evaluate(() => window.parity.ready);
  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter();
    return a ? `${a.info.vendor} ${a.info.architecture} ${a.info.description}`.trim() : 'none';
  });
  console.log(`WebGPU adapter: ${adapter}; ${count} entries`);
  console.log('name                            mean    max  maxNonEdge  >8 nonEdge  edge px');
  for (let i = 0; i < count; i++) {
    const r = await page.evaluate((i) => window.parity.run(i, true), i);
    if (filter && !r.name.includes(filter)) continue;
    writeFileSync(join(out, `${r.name}.ts.png`), Buffer.from(r.outPng, 'base64'));
    writeFileSync(join(out, `${r.name}.diff.png`), Buffer.from(r.diffPng, 'base64'));
    const ok = r.mean < MEAN_LIMIT && r.maxNonEdge <= MAX_NON_EDGE_LIMIT;
    if (!ok) failed++;
    console.log(`${r.name.padEnd(28)} ${r.mean.toFixed(5).padStart(8)} ${String(r.max).padStart(6)} ` +
      `${String(r.maxNonEdge).padStart(11)} ${String(r.over8NonEdge).padStart(11)} ${String(r.edgePixels).padStart(8)}` +
      (ok ? '' : '  FAIL'));
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `${failed} entries over the thresholds` : 'all entries within the thresholds');
process.exit(failed ? 1 : 0);
