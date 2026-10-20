// End-to-end smoke of the production kiosk: the built server (server/dist) serving web/dist, a pairing code from the
// ingress API, then headless Chrome (WebGPU) pairs, connects and draws the face. Fails on any console error.
// Run: npm run build -w web && npm run build -w server && node web/scripts/kiosk-smoke.mjs
// Screenshot: web/test/app/out/kiosk.png
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
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

await page.goto(`http://localhost:${display}/`);
await page.fill('#pair-code', code);
await page.click('.pairing button');
await page.waitForSelector('.pairing', { state: 'detached', timeout: 5000 }).catch(() => fail('pairing did not finish'));
await page.waitForTimeout(1500);
const isolated = await page.evaluate(() => crossOriginIsolated);
const errorText = await page.evaluate(() => { const e = document.getElementById('error'); return e && !e.hidden ? e.textContent : ''; });
const shot = await page.screenshot({ path: join(out, 'kiosk.png') });
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
