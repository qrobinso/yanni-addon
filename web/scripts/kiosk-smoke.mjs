// End-to-end smoke of the production kiosk: the built server (server/dist) serving web/dist, a pairing code from the
// ingress API, then headless Chrome (WebGPU) pairs, connects and draws the face. Fails on any console error.
// Then a perf run (SMOKE_SECONDS, default 60): per-frame engine / life / render JS time (p50 / p99), long tasks and
// GC pauses from a devtools trace; then a screenshot every 2 s for 20 s and a burst after a tap.
// Run: npm run build -w web && npm run build -w server && node web/scripts/kiosk-smoke.mjs
// Out: web/test/app/out/ (kiosk.png, kiosk-menu.png, seq-NN.png, tap-NNNN.png)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const out = join(here, '../test/app/out');
mkdirSync(out, { recursive: true });
const display = 18443, ingress = 18099;

const server = spawn(process.execPath, [join(repo, 'server/dist/main.js')], {
  env: { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), 'yanni-smoke-')), SSL_DIR: '/nonexistent',
    DISPLAY_PORT: String(display), INGRESS_PORT: String(ingress), INGRESS_TRUSTED: '127.0.0.1',
    WEB_ROOT: join(repo, 'web/dist'), HA_URL: '', HA_TOKEN: '', SUPERVISOR_TOKEN: '', MQTT_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const fail = (msg) => { console.error(`FAIL: ${msg}\n--- server log ---\n${serverLog}`); server.kill(); process.exit(1); };
for (let i = 0; ; i++) {
  try { await fetch(`http://127.0.0.1:${ingress}/api/status`); break; } catch { if (i > 50) fail('server did not start'); }
  await new Promise((r) => setTimeout(r, 100));
}
const { code } = await (await fetch(`http://127.0.0.1:${ingress}/api/codes`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'Smoke' }) })).json();

const browser = await chromium.launch({ headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
await page.addInitScript(() => {
  globalThis.__longTasks = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) globalThis.__longTasks.push(e.duration); })
    .observe({ type: 'longtask', buffered: true });
});

await page.goto(`http://localhost:${display}/?debug`);
await page.fill('#pair-code', code);
await page.click('.pairing button');
await page.waitForSelector('.pairing', { state: 'detached', timeout: 5000 }).catch(() => fail('pairing did not finish'));
await page.waitForTimeout(1500);
const isolated = await page.evaluate(() => crossOriginIsolated);
const errorText = await page.evaluate(() => { const e = document.getElementById('error'); return e && !e.hidden ? e.textContent : ''; });
const shot = await page.screenshot({ path: join(out, 'kiosk.png') });

// ---- Perf: the face idling for SMOKE_SECONDS, nothing else touching the page ----
const seconds = Number(process.env.SMOKE_SECONDS ?? 60);
const tracePath = join(mkdtempSync(join(tmpdir(), 'yanni-trace-')), 'trace.json');
await browser.startTracing(page, { path: tracePath, categories: ['devtools.timeline', 'v8'] });
const n0 = await page.evaluate(() => { globalThis.__longTasks.length = 0; return globalThis.yanni.perf.n; });
await page.waitForTimeout(seconds * 1000);
const perf = await page.evaluate((n0) => {
  const { perf, clock, engine, life } = globalThis.yanni;
  const N = perf.engine.length, n = perf.n, from = Math.max(n0, n - N);
  const pick = (a) => { const v = []; for (let i = from; i < n; i++) v.push(a[i % N]); return v.sort((x, y) => x - y); };
  const q = (v, p) => v.length ? +v[Math.min(v.length - 1, Math.floor(p * v.length))].toFixed(3) : NaN;
  const stat = (a) => { const v = pick(a); return { p50: q(v, 0.5), p99: q(v, 0.99), max: q(v, 1) }; };
  const s = clock.stats.snapshot();
  return { frames: n - from, engine: stat(perf.engine), life: stat(perf.life), render: stat(perf.render),
    longTasks: globalThis.__longTasks.slice(), awakeFps: +s.awake.deliveredFPS.toFixed(1),
    gapP99ms: +(s.awake.gapP99 * 1000).toFixed(2), hitchMsPerSecond: +s.awake.hitchMsPerSecond.toFixed(2),
    agentState: engine.state.agentState, phase: life.phase, tier: clock.policy.tier };
}, n0);
await browser.stopTracing();
const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
const gc = (trace.traceEvents ?? trace).filter((e) => (e.name === 'MinorGC' || e.name === 'MajorGC') && e.ph === 'X')
  .map((e) => ({ name: e.name, ms: e.dur / 1000 }));
rmSync(dirname(tracePath), { recursive: true, force: true });
const gcSummary = (name) => {
  const v = gc.filter((e) => e.name === name).map((e) => e.ms).sort((a, b) => a - b);
  return { count: v.length, maxMs: v.length ? +v.at(-1).toFixed(2) : 0, totalMs: +v.reduce((a, b) => a + b, 0).toFixed(1) };
};
perf.gc = { minor: gcSummary('MinorGC'), major: gcSummary('MajorGC') };
console.log('perf', JSON.stringify(perf, null, 1));

// ---- Screenshots: every 2 s for 20 s, then a tap and a burst after it ----
for (let i = 0; i < 10; i++) {
  await page.screenshot({ path: join(out, `seq-${String(i * 2).padStart(2, '0')}.png`) });
  await page.waitForTimeout(2000);
}
await page.mouse.click(700, 250);
let since = 0;
for (const ms of [100, 300, 600, 1200]) {
  await page.waitForTimeout(ms - since);
  since = ms;
  await page.screenshot({ path: join(out, `tap-${String(ms).padStart(4, '0')}.png`) });
}
// Tap the face (a poke), then hold the owner corner until the menu opens.
await page.mouse.click(300, 300);
await page.waitForTimeout(300);
await page.mouse.move(1010, 750);
await page.mouse.down();
await page.waitForTimeout(2700);
await page.mouse.up();
const menuOpen = await page.evaluate(() => !!document.querySelector('.owner-menu'));
await page.screenshot({ path: join(out, 'kiosk-menu.png') });
const centre = await page.evaluate(async (png) => {
  // A bright eye pixel on the screenshot's horizontal centre line proves the renderer drew.
  const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
  const o = new OffscreenCanvas(img.width, img.height).getContext('2d');
  o.drawImage(img, 0, 0);
  const row = o.getImageData(0, img.height >> 1, img.width, 1).data;
  let max = 0;
  for (let i = 0; i < row.length; i += 4) max = Math.max(max, row[i] + row[i + 1] + row[i + 2]);
  return max;
}, shot.toString('base64'));
await browser.close();
server.kill();

const connected = serverLog.includes('connected (Smoke)');
console.log({ isolated, connected, menuOpen, brightestCentrePixel: centre, errorText, problems });
if (errorText) fail(errorText);
if (!isolated) fail('not cross-origin isolated');
if (!connected) fail('display did not connect');
if (!menuOpen) fail('corner hold did not open the owner menu');
if (centre < 200) fail('the face did not render');
if (problems.length) fail(`console not clean:\n${problems.join('\n')}`);
console.log(`OK: ${join(out, 'kiosk.png')}`);
