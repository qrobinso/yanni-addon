// Kiosk entry point (index.html): the face full screen on WebGPU, driven by the FrameClock from requestAnimationFrame;
// touch → the face; the hidden owner corner; pairing and the add-on socket.
import type { DisplayState, EntitySettings } from '@yanni/server/protocol';
import type { V2 } from '../core/vec';
import type { FaceFrameSource } from '../model/FaceFrame';
import { FaceRenderer } from '../render/FaceRenderer';
import { FrameClock } from '../render/FrameClock';
import { ConversationAudio } from '../conversation/audio/ConversationAudio';
import { DisplayClient } from './DisplayClient';
import { Hud } from './Hud';
import { describeFace, fullscreenOnTap, keepScreenOn, lockDownGestures, motion, unlockAudio } from './Kiosk';
import { OwnerAccess } from './OwnerAccess';
import { OwnerMenu } from './OwnerMenu';
import { forgetPairing, loadPairing, showPairing, storage } from './Pairing';
import { StubFaceSource } from './StubFaceSource';
import { TapHoldRecognizer, TouchInput } from './TouchInput';
import './app.css';

const APP_VERSION = '0.1.0';

/** What the shell needs from the face (FaceEngine has all of it). */
type ShellFace = FaceFrameSource & {
  send(command: { kind: 'tap'; at: V2 } | { kind: 'scratch'; at: V2; intensity: number }): void;
  pupilReactionSettings?: { reduceMotion: boolean; copy?(): unknown };
};

// The one line that swaps in the engine: `const face: ShellFace = new FaceEngine();`
const face: ShellFace = new StubFaceSource();

const canvas = document.getElementById('face') as HTMLCanvasElement;
const root = document.getElementById('shell')!;
const renderer = new FaceRenderer();
const clock = new FrameClock(face);
const audio = new ConversationAudio();

// ---- Reduce Motion (the engine carries it in its pupil reaction settings) ----
function applyReduceMotion(reduce: boolean): void {
  const s = face.pupilReactionSettings;
  if (!s) return;
  s.reduceMotion = reduce;
  face.pupilReactionSettings = s; // FaceEngine's setter validates and stores a copy
}
applyReduceMotion(motion.reduce);
motion.onChange(applyReduceMotion);

// ---- The frame loop: one FrameClock frame per display refresh, skipping refreshes above the policy's tier ----
let drawn = false;
clock.addConsumer(renderer, (f) => { drawn = renderer.render(f); });
let raf = 0, lastDrawn = -Infinity, lastRaf: number | undefined, refresh = 1 / 60;
function loop(ms: number): void {
  raf = requestAnimationFrame(loop);
  const t = ms / 1000;
  if (lastRaf !== undefined) refresh += 0.05 * (Math.min(Math.max(t - lastRaf, 0), 0.1) - refresh);
  lastRaf = t;
  clock.displayMaximumFramesPerSecond = refresh < 1 / 90 ? 120 : 60;
  // Asleep (30) on a 60 Hz panel draws every other refresh; a quarter refresh of slack absorbs rAF jitter.
  if (t - lastDrawn < 1 / clock.policy.tier - 0.25 * refresh) return;
  lastDrawn = t;
  drawn = false;
  clock.beginFrame(t);
  clock.endFrame(drawn);
}
function setVisible(visible: boolean): void {
  clock.isActive = visible;
  cancelAnimationFrame(raf);
  lastRaf = undefined;
  if (visible) raf = requestAnimationFrame(loop);
}
document.addEventListener('visibilitychange', () => setVisible(document.visibilityState === 'visible'));

const error = document.getElementById('error')!;
renderer.init(canvas).then(() => setVisible(document.visibilityState === 'visible'), (e: unknown) => {
  error.textContent = `Yanni needs WebGPU (${e instanceof Error ? e.message : String(e)}).`;
  error.hidden = false;
});

// ---- Kiosk ----
keepScreenOn();
fullscreenOnTap();
lockDownGestures();
unlockAudio(audio.context, document.getElementById('audio-hint')!);
describeFace('Two eyes, idle.');

// ---- Settings (the display is the source of truth on reconnect) ----
const SETTINGS_KEY = 'yanni.settings';
const settings: Partial<EntitySettings> = storage.get(SETTINGS_KEY) ?? {};
const state: Partial<DisplayState> = { started_at: new Date().toISOString() };
let developerTools = storage.get<boolean>('yanni.developerTools') ?? false;
let client: DisplayClient | undefined;

// ---- Owner menu, HUD ----
const hud = new Hud(clock, () => client ? `${client.status}${client.room ? ` · ${client.room}` : ''}${client.connected ? ` · HA ${client.haConnected ? 'up' : 'down'}` : ''}` : 'not paired');
root.append(hud.el);
const menu = new OwnerMenu(root, {
  access: new OwnerAccess(localStorage),
  developerTools: () => developerTools,
  setDeveloperTools: (on) => { developerTools = on; storage.set('yanni.developerTools', on); },
  settings: () => settings,
  changeSetting: (k, v) => { settings[k] = v; storage.set(SETTINGS_KEY, settings); client?.sendSettings({ [k]: v }); },
  toggleHud: () => hud.toggle(),
  status: () => [
    ['Connection', client?.status ?? 'not paired'], ['Display', client?.deviceId ?? '–'], ['Room', client?.room ?? '–'],
    ['Home Assistant', client?.haConnected ? 'connected' : 'not connected'],
    ['Frames', `${renderer.frames} drawn, ${renderer.deviceLosses} GPU losses, ${clock.backupTakeovers} backup takeovers`],
    ['Frame rate', `${clock.policy.tier} fps tier, display ${clock.displayMaximumFramesPerSecond} Hz`],
    ['Cross-origin isolated', String(globalThis.crossOriginIsolated ?? false)],
    ['Audio', audio.context.state], ['Reduce Motion', motion.reduce ? 'on' : 'off'], ['Version', APP_VERSION],
  ],
});
document.getElementById('owner-menu-button')!.addEventListener('click', () => menu.showMenu());

// ---- Touch: a tap pokes, a hold talks, a rub tickles; the corner opens the owner menu ----
// The swap: `new TouchGestureRecognizer()` from the engine instead of the tap/hold stand-in.
const touch = new TouchInput(new TapHoldRecognizer(), {
  onGesture(e, w, h) {
    if (menu.isOpen) { menu.close(); return; }
    const at = TouchInput.normalised(e.at, w, h);
    hud.note(`${e.kind} ${at.x.toFixed(2)}, ${at.y.toFixed(2)}`);
    if (e.kind === 'tap') face.send({ kind: 'tap', at });
    else if (e.kind === 'scratch') face.send({ kind: 'scratch', at, intensity: e.intensity });
    // hold → talk: the conversation (WP16) takes it from here.
  },
  onCornerProgress: (p) => menu.progress(p),
  onMenu: () => menu.showMenu(),
});
touch.attach(canvas);

// ---- Pairing and the add-on socket ----
async function connect(): Promise<void> {
  const pairing = loadPairing() ?? await showPairing(root);
  const url = new URL('ws', document.baseURI);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const c = new DisplayClient({ url: url.href, token: pairing.token, appVersion: APP_VERSION,
    deviceModel: `Browser (${navigator.platform || 'web'})`.slice(0, 80), settings: () => settings, state: () => state });
  client = c;
  c.on('status', (s) => {
    hud.note(`socket ${s}`);
    if (s === 'unpaired') { forgetPairing(); void connect(); }
  });
  c.on('settings', ({ values }) => { Object.assign(settings, values); storage.set(SETTINGS_KEY, settings); });
  c.on('command', (cmd) => hud.note(`command ${cmd}`)); // force_sleep / force_wake → the life cycle (WP10)
  c.on('announce', () => hud.note('announcement')); // → the announcement coordinator (WP13)
  c.on('error', (e) => hud.note(`error ${e.code}: ${e.message}`));
  c.connect();
}
void connect();
