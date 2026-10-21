// Screenshots of the kiosk Settings screen (dev server harness) and the add-on's owner Settings page.
// Run from the repo root after `npm run build -w server`: node web/test/settings/screenshot.mjs
// Out: web/test/app/out/settings-*.png, server/test/out/owner-settings.png (both gitignored).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const webOut = join(repo, 'web/test/app/out');
const ownerOut = join(repo, 'server/test/out');
mkdirSync(webOut, { recursive: true });
mkdirSync(ownerOut, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(url) {
  for (let i = 0; i < 100; i++) { try { await fetch(url); return; } catch { await wait(150); } }
  throw new Error(`no server at ${url}`);
}

const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '5187', '--strictPort'], { cwd: join(repo, 'web'), stdio: 'ignore' });
const server = spawn(process.execPath, [join(repo, 'server/dist/main.js')], {
  env: { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), 'yanni-shot-')), SSL_DIR: '/nonexistent', DISPLAY_PORT: '18543',
    INGRESS_PORT: '18199', INGRESS_TRUSTED: '127.0.0.1', HA_URL: '', HA_TOKEN: '', SUPERVISOR_TOKEN: '', MQTT_URL: '',
    WEB_ROOT: join(repo, 'web') },
  stdio: 'ignore',
});
const browser = await chromium.launch();
try {
  await until('http://127.0.0.1:5187/');
  const page = await browser.newPage({ viewport: { width: 1024, height: 1366 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const base = 'http://127.0.0.1:5187/test/settings/harness/panel.html';
  await page.goto(`${base}`);
  await page.waitForSelector('.ys-prompt');
  await wait(400); // the fade-in
  await page.screenshot({ path: join(webOut, 'settings-first-open.png') });
  await page.goto(`${base}?prompted`);
  await page.waitForSelector('.ys-section');
  await wait(400);
  for (const d of await page.$$('details')) await d.evaluate((e) => { e.open = true; });
  await page.screenshot({ path: join(webOut, 'settings-full.png'), fullPage: false });
  // The whole scrolling sheet, as one tall image.
  const h = await page.$eval('.ys-sheet', (e) => e.scrollHeight);
  await page.setViewportSize({ width: 1024, height: Math.min(h + 40, 30000) });
  await page.screenshot({ path: join(webOut, 'settings-all.png') });
  const counts = await page.evaluate(() => ({ rows: document.querySelectorAll('[id^="ys-"][id$="-msg"]').length,
    keys: Object.keys(globalThis.hub.settings).length }));
  console.log('kiosk panel controls', counts);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}?prompted&changed`);
  await page.waitForSelector('.ys-section');
  await wait(400);
  await page.screenshot({ path: join(webOut, 'settings-phone.png') });

  await until('http://127.0.0.1:18199/api/status');
  const { code } = await (await fetch('http://127.0.0.1:18199/api/codes', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room: 'Office' }) })).json();
  await fetch('http://127.0.0.1:18543/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const owner = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  await owner.goto('http://127.0.0.1:18199/#/settings');
  await owner.waitForSelector('fieldset');
  for (const d of await owner.$$('details')) await d.evaluate((e) => { e.open = true; });
  const oh = await owner.evaluate(() => document.documentElement.scrollHeight);
  await owner.setViewportSize({ width: 900, height: Math.min(oh, 30000) });
  await owner.screenshot({ path: join(ownerOut, 'owner-settings.png') });
  const ownerRows = await owner.evaluate(() => document.querySelectorAll('[id^="set-"][id$="-msg"]').length);
  console.log('owner page controls', ownerRows);
  if (errors.length) { console.error('page errors:', errors); process.exitCode = 1; }
} finally {
  await browser.close();
  vite.kill();
  server.kill();
}
