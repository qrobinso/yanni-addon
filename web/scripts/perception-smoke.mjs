// Perception smoke: the Vite dev server (cross-origin isolated) serves perception-demo.html; headless Chrome with a
// fake camera loads it, MediaPipe starts (worker, GPU delegate unless it falls back) and frames are analysed.
// Run (after `node web/scripts/fetch-models.mjs`): node web/scripts/perception-smoke.mjs [clip.y4m] [--main] [--cpu] [--tier=full]
// A .y4m with a face makes it detect someone; without one Chrome's synthetic pattern only proves the pipeline runs.
// Screenshot: web/test/app/out/perception.png. Timings are headless (SwiftShader / ANGLE), not the tablet's.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'test/app/out');
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const clip = args.find((a) => a.endsWith('.y4m'));
const tier = args.find((a) => a.startsWith('--tier='))?.slice(7);
const query = [args.includes('--main') && 'main', args.includes('--cpu') && 'cpu', tier && `tier=${tier}`].filter(Boolean).join('&');

const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), server: { port: 18555, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true, args: [
  '--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  ...(clip ? [`--use-file-for-fake-video-capture=${clip}`] : []),
] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:18555/perception-demo.html${query ? `?${query}` : ''}`);

let stats;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  stats = await page.evaluate(() => globalThis.perceptionDemo?.stats());
  if (stats?.accepted > 20) break;
}
await page.waitForTimeout(6000);   // a full 5 s policy window
const result = await page.evaluate(async () => {
  const d = globalThis.perceptionDemo;
  // One frame's raw detections (viewer frame) for eyeballing the conventions.
  const det = await new Promise((ok) => { const off = d.onFrame((_, r) => { off(); ok(r.detections); }); });
  const s = d.stats(), snap = d.snapshot();
  return { stats: s, isolated: crossOriginIsolated, people: snap.people.map((p) => ({ id: p.id, state: p.state,
    distance: +p.distance.toFixed(2), facing: +p.facing.toFixed(2), looking: +p.lookingAtMe.toFixed(2), gaze: p.gazeSource.kind,
    static: p.isStatic })), faces: det.faces.map((f) => ({ box: f.box, headPoseDeg: f.headPose && Object.fromEntries(
    Object.entries(f.headPose).map(([k, v]) => [k, +(v * 180 / Math.PI).toFixed(1)])), eyes: f.eyes, ipd: f.interocularPx })),
    bodies: det.bodies.length, hands: det.hands.map((h) => h.chirality), statsText: document.getElementById('stats').textContent };
});
await page.screenshot({ path: join(out, 'perception.png') });

// Record a short consented session through the live pipeline, read it back from the browser's storage and replay it
// as the people source; then the governor's pressure cap. The PIN check is the kiosk's: stubbed here.
const recorded = await page.evaluate(async () => {
  const h = globalThis.perceptionDemoHarness, p = globalThis.perceptionDemo;
  await h.ready;
  h.access = { isPINRequired: true, verify: async () => 'ok' };
  h.setAllowed(true);
  const who = h.addParticipant(false, null).pseudonym;
  const check = h.start({ type: 'free', declared: [who], consentConfirmed: true, pinVerified: true });
  await new Promise((r) => setTimeout(r, 4000));
  const live = h.status;
  h.stop();
  await h.fs?.flushed();
  const id = h.sessions[0]?.id;
  if (!id) return { check, message: h.message };
  const s = await h.loadSession(id);
  let replayed = 0, people = 0;
  const off = p.onFrame((out) => { replayed++; people = Math.max(people, out.snapshot.people.length); });
  p.setSource({ kind: 'replay', recording: s.asPerceptionRecording() });
  await new Promise((r) => setTimeout(r, 3000));
  const source = p.stats().source;
  off();
  p.setSource({ kind: 'camera' });
  const tar = await h.exportTar(id);
  h.delete(id);
  return { check, backend: h.fs?.backend.kind ?? 'memory', live, frames: s.frames.length, header: s.header.framesWritten,
    paused: s.header.framesPausedUndeclared, replayed, people, source, tarBytes: tar.bytes.length, sessionsLeft: h.sessions.length };
});
console.log(`recording: ${JSON.stringify(recorded)}`);
const pressure = await page.evaluate(async () => {
  const p = globalThis.perceptionDemo;
  p.setGovernorPressure(3);
  for (let i = 0; i < 24 && !(p.stats().pressure === 3 && p.stats().tier === 0); i++) await new Promise((r) => setTimeout(r, 500));
  const s = p.stats();
  p.setGovernorPressure(0);
  return { pressure: s.pressure, tier: s.tier, camera: s.camera.kind };
});
console.log(`governor cap: ${JSON.stringify(pressure)}`);
await browser.close();
await server.close();

console.log(result.statsText);
console.log(JSON.stringify({ isolated: result.isolated, people: result.people, faces: result.faces, bodies: result.bodies,
  hands: result.hands, stageMs: result.stats.stageMs }));
if (problems.length) console.log(`console:\n${problems.join('\n')}`);
const s = result.stats;
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
if (!result.isolated) fail('not cross-origin isolated');
if (!s.delegate) fail('MediaPipe did not start');
if (s.accepted < 10) fail(`only ${s.accepted} frames analysed`);
if (recorded.check?.kind !== 'ok' || !(recorded.frames > 0) || recorded.frames !== recorded.header) fail(`recording: ${JSON.stringify(recorded)}`);
if (recorded.source !== 'replay' || !(recorded.replayed > 0) || recorded.sessionsLeft !== 0) fail(`replay: ${JSON.stringify(recorded)}`);
if (pressure.pressure !== 3 || pressure.tier !== 0) fail(`governor cap: ${JSON.stringify(pressure)}`);
console.log(`OK: ${s.worker ? 'worker' : 'main thread'}, ${s.delegate} delegate, ${s.analysisFPS.toFixed(1)} Hz · ${join(out, 'perception.png')}`);
