// Perception demo (web/perception-demo.html): the camera with a landmarks overlay, the tracked people, the event log
// and the pipeline's timings, plus a small face driven by the same engine perception feeds. `?cpu` forces the CPU
// delegate, `?main` the main-thread fallback, `?tier=full|standard|reduced` pins the tier.
import { FaceEngine } from '../../engine/FaceEngine';
import { Mood } from '../../engine/AgentState';
import { LifeCycleController } from '../../life/LifeCycleController';
import { FaceRenderer } from '../../render/FaceRenderer';
import { NRect, PerceptionEvent, PerceptionTier, fmt, type FrameDetections, type PerceptionSnapshot } from '../PerceptionTypes';
import { PerceptionSettings, type TierOverride } from '../PerceptionSettings';
import { startPerception } from './startPerception';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = new URLSearchParams(location.search);

const engine = new FaceEngine();
engine.setMood(Mood.playful);
engine.setAgentState('idle');
const life = new LifeCycleController(engine);
const renderer = new FaceRenderer();
const perception = startPerception(engine, life, { video: $<HTMLVideoElement>('video'), delegate: q.has('cpu') ? 'CPU' : 'GPU',
  worker: !q.has('main'), settings: new PerceptionSettings({ tierOverride: (q.get('tier') ?? 'auto') as TierOverride }) });

// The face preview (render-demo's pattern: one engine frame per refresh).
renderer.init($<HTMLCanvasElement>('face')).then(() => {
  const loop = (ms: number) => {
    const t = ms / 1000;
    renderer.render(engine.frame(t));
    life.afterFrame(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}, (e: unknown) => { $('stats').textContent = `WebGPU: ${e}`; });

// Event log.
const log = $<HTMLPreElement>('log');
const lines: string[] = [];
perception.onEvent((e, note) => {
  lines.push(`${(performance.now() / 1000).toFixed(1)}  ${PerceptionEvent.text(e)}${note ? ` → ${note}` : ''}`);
  if (lines.length > 200) lines.shift();
  log.textContent = lines.join('\n');
  log.scrollTop = log.scrollHeight;
});

// Overlay, in the viewer frame (the video is shown mirrored, so viewer coordinates map straight onto it).
const overlay = $<HTMLCanvasElement>('overlay');
const g = overlay.getContext('2d')!;
const per: Record<string, { ms: number; n: number }> = {};
perception.onFrame((out, r) => {
  draw(r.detections, out.snapshot);
  for (const [k, v] of Object.entries(r.stages)) { const s = (per[k] ??= { ms: 0, n: 0 }); s.ms += v; s.n++; }
});

function draw(det: FrameDetections, snap: PerceptionSnapshot): void {
  const w = overlay.width = overlay.clientWidth * devicePixelRatio, h = overlay.height = overlay.clientHeight * devicePixelRatio;
  g.lineWidth = 2 * devicePixelRatio;
  const rect = (b: NRect, c: string) => { g.strokeStyle = c; g.strokeRect(b.x * w, b.y * h, b.w * w, b.h * h); };
  const dot = (p: { x: number; y: number }, c: string, r = 3) => { g.fillStyle = c; g.beginPath(); g.arc(p.x * w, p.y * h, r * devicePixelRatio, 0, 7); g.fill(); };
  for (const b of det.bodies) {
    rect(b.box, '#4a8');
    for (const j of Object.values(b.joints)) if (j && j.c >= 0.3) dot(j.p, '#6c9');
  }
  for (const f of det.faces) {
    rect(f.box, f.eyes ? '#fc4' : '#a84');
    const c = NRect.center(f.box);
    if (f.headPose) {
      // Head direction (yaw + right, pitch + down) as a line from the face centre.
      g.strokeStyle = '#f84';
      g.beginPath(); g.moveTo(c.x * w, c.y * h);
      g.lineTo((c.x + Math.sin(f.headPose.yaw) * f.box.w) * w, (c.y + Math.sin(f.headPose.pitch) * f.box.h) * h);
      g.stroke();
    }
    if (f.eyes) dot({ x: c.x + f.eyes.pupilOffset.x * f.box.w * 0.15, y: f.box.y + f.box.h * 0.4 + f.eyes.pupilOffset.y * f.box.h * 0.05 }, '#4cf', 4);
  }
  for (const hd of det.hands) {
    for (const j of Object.values(hd.joints)) if (j) dot(j.p, hd.chirality === 'left' ? '#f6c' : '#c6f', 2);
  }
  g.font = `${12 * devicePixelRatio}px ui-monospace, monospace`;
  for (const p of snap.people) {
    const b = p.bodyBox ?? p.faceBox;
    if (!b) continue;
    rect(b, p.engaged ? '#f44' : p.id === snap.primaryID ? '#fff' : '#888');
    g.fillStyle = '#fff';
    g.fillText(`#${p.id} ${p.distance.toFixed(1)} m`, b.x * w + 4, b.y * h + 14 * devicePixelRatio);
  }
}

// Read-outs at 4 Hz.
setInterval(() => {
  const s = perception.stats();
  const snap = perception.snapshot();
  const people = $<HTMLTableElement>('people');
  people.innerHTML = '<tr><th>id</th><th>state</th><th>dist</th><th>facing</th><th>looking</th><th>gaze</th><th>dwell</th><th></th></tr>' +
    snap.people.map((p) => `<tr><td>${p.id}</td><td>${p.state}</td><td>${fmt(p.distance, 2)} ${p.distanceSource}</td>` +
      `<td>${fmt(p.facing, 2)}</td><td>${fmt(p.lookingAtMe, 2)}${p.gazeErrorDegrees !== null ? ` θ ${fmt(p.gazeErrorDegrees, 1)}°/${fmt(p.toleranceDegrees ?? 0, 1)}°` : ''}</td>` +
      `<td>${p.gazeSource.kind === 'eyes' ? `eyes (${p.gazeSource.source})` : p.gazeSource.kind}</td><td>${fmt(p.dwell, 1)}/${fmt(p.dwellNeeded, 1)}</td>` +
      `<td>${p.id === snap.primaryID ? 'primary ' : ''}${p.engaged ? 'ENGAGED' : ''}${p.isStatic ? ' static' : ''}</td></tr>`).join('');
  const models = Object.entries(per).map(([k, v]) => `${k} ${(v.ms / v.n).toFixed(1)}`).join(' · ');
  for (const k of Object.keys(per)) delete per[k];
  $('stats').textContent = [
    `camera   ${s.camera.kind}${'reason' in s.camera ? ` (${s.camera.reason})` : ''}${s.noFramesFor !== null ? ` · no frames for ${s.noFramesFor} s` : ''}`,
    `video    ${s.video.width}×${s.video.height}`,
    `runs     ${s.worker ? 'worker' : 'main thread'} · ${s.delegate ?? 'loading…'} delegate · tier ${PerceptionTier.label(s.tier)}`,
    `rate     ${s.hz} Hz now · ${s.analysisFPS.toFixed(1)} Hz (5 s) · p90 ${s.p90Ms.toFixed(1)} ms`,
    `stage ms ${models || '—'}   (rects = pose, landmarks = face)`,
    `frames   ${s.arrived} arrived · ${s.accepted} analysed · ${s.droppedBusy} dropped busy`,
    `offset   (${fmt(s.cameraOffset.x, 3, true)}, ${fmt(s.cameraOffset.y, 3, true)}) m · primary ${snap.primaryID ?? '—'} · engaged ${snap.engagedID ?? '—'}`,
  ].join('\n');
}, 250);

Object.assign(globalThis, { perceptionDemo: perception });
