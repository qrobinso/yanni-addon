// Kiosk entry point (index.html): the face full screen on WebGPU, wired as the Swift app wires it (MyApp.swift's
// AppModel, FaceScreen.swift): the FaceEngine is the FrameClock's source, the after-frame hooks run voice → life →
// emotion → conversation, touch goes through the TouchGestureRecognizer, the edge geometry follows the drawable and
// the style, Reduce Motion is a runtime input of the settings, and the add-on socket syncs settings and live values.
import type { DisplayState, EntitySettings } from '@yanni/server/protocol';
import type { V2 } from '../core/vec';
import { FaceCommand } from '../engine/Commands';
import { FaceEngine } from '../engine/FaceEngine';
import { TouchGestureRecognizer } from '../engine/TouchGestures';
import { TouchReactions } from '../engine/modifiers/TouchReactions';
import { Mood } from '../engine/AgentState';
import { LifeCycleController } from '../life/LifeCycleController';
import { LifeCalendar } from '../life/LifeTypes';
import type { LifeResumeState } from '../life/LifeResume';
import type { FaceFrameSource } from '../model/FaceFrame';
import { FaceRenderer } from '../render/FaceRenderer';
import { FrameClock } from '../render/FrameClock';
import { makeRenderStyle } from '../render/RenderStyle';
import { edgeGeometryFitting } from '../render/Viewport';
import { ConversationAudio } from '../conversation/audio/ConversationAudio';
import { DisplayClient } from './DisplayClient';
import { applyEngineSettings, changed, composeStyle, faceReport, lifeSettings } from './FaceSettings';
import { Hud } from './Hud';
import { describeFace, fullscreenOnTap, keepScreenOn, lockDownGestures, motion, unlockAudio } from './Kiosk';
import { OwnerAccess } from './OwnerAccess';
import { OwnerMenu } from './OwnerMenu';
import { forgetPairing, loadPairing, showPairing, storage } from './Pairing';
import { TouchInput } from './TouchInput';
import './app.css';

const APP_VERSION = '0.1.0';
const SETTINGS_KEY = 'yanni.settings';
const RESUME_KEY = 'yanni.resume';
/** ResumeSnapshot.maxAge: a reload within 10 min comes back in the saved phase. */
const RESUME_MAX_AGE = 600;

// ---- The face (AppModel.init order) ----
const engine = new FaceEngine();
engine.setMood(Mood.playful);
engine.setAgentState('idle');
// Black → the eyes fade in (hardening design §6.2), before the first frame.
engine.fadeInFromBlack();
// The hub persists the settings (here: the synced EntitySettings in local storage); the controller only applies them.
const life = new LifeCycleController(engine);
// hook (voice, WP12): `life.onBedtimeChange = (on) => { voice.isBedtime = on; }` — night wakes are quiet.

// Per-frame timings (ms) for the perf smoke and the HUD: engine (source), life (hook), render (consumer).
const PERF_N = 8192;
const perf = { engine: new Float32Array(PERF_N), life: new Float32Array(PERF_N), render: new Float32Array(PERF_N), n: 0 };
const timedSource: FaceFrameSource = {
  frame(t) {
    const a = performance.now();
    const f = engine.frame(t);
    perf.engine[perf.n % PERF_N] = performance.now() - a;
    return f;
  },
};

const canvas = document.getElementById('face') as HTMLCanvasElement;
const root = document.getElementById('shell')!;
const renderer = new FaceRenderer();
const clock = new FrameClock(timedSource);
const audio = new ConversationAudio();

// ---- Resume (KioskBoot.restoreLife): before the first frame, no wake, greeting or chirp, never activity ----
interface ResumeSnapshot { savedAt: number; life: LifeResumeState }
const saved = storage.get<ResumeSnapshot>(RESUME_KEY);
const savedElapsed = saved ? (Date.now() - saved.savedAt) / 1000 : NaN;
if (saved && savedElapsed >= -5 && savedElapsed <= RESUME_MAX_AGE) life.restore(saved.life, savedElapsed);
function saveSnapshot(): void { storage.set(RESUME_KEY, { savedAt: Date.now(), life: life.resumeState() }); }
let lastSavedPhase = life.phase;
life.onPhaseChange = (c) => { if (c.to !== lastSavedPhase) { lastSavedPhase = c.to; saveSnapshot(); } };

// ---- After every engine frame, in the Swift order (each cheap, allocation-free on ordinary frames) ----
// hook (voice, WP12): clock.addAfterFrame((t) => voice.afterFrame(t));
clock.addAfterFrame((t) => {
  const a = performance.now();
  life.afterFrame(t);
  perf.life[perf.n % PERF_N] = performance.now() - a;
});
// hook (emotion, WP11): clock.addAfterFrame((t) => emotionModel.tick(t)); clock.addAfterFrame((t) => emotion.afterFrame(t));
// Calm frame rate (§6.6): drowsy, and no one-shot playing. hook (perception, WP14): `|| room vacant on a fresh snapshot`.
clock.addAfterFrame(() => { clock.calmRate = life.phase === 'drowsy' && engine.state.activeOneShots.length === 0; });
// hook (conversation, WP16): clock.addAfterFrame((t) => conversation.afterFrame(t));

// ---- Settings (the display is the source of truth on reconnect) ----
const settings: Partial<EntitySettings> = storage.get(SETTINGS_KEY) ?? {};
const state: Partial<DisplayState> = { started_at: new Date().toISOString() };
let developerTools = storage.get<boolean>('yanni.developerTools') ?? false;
let client: DisplayClient | undefined;
let faceSize = { width: 0, height: 0 };

/** The edge geometry follows the drawable (CSS px, as Swift's points) and the style. */
function pushEdgeGeometry(): void {
  if (faceSize.width > 1 && faceSize.height > 1) {
    engine.setEdgeGeometry(edgeGeometryFitting(faceSize.width, faceSize.height, renderer.style));
  }
}

/** The hub's appliers in order (life → voice → engine → emotion → style), all re-run on any change. */
function applySettings(): void {
  life.settings = lifeSettings(settings, life.settings);
  // hook (voice, WP12): voice.settings from sounds / chirp_volume / quiet_mode.
  applyEngineSettings(engine, settings, motion.reduce);
  // hook (emotion, WP11): personality and EmotionSettings.
  // hook (conversation, WP16): voice_volume, quiet_mode, reply_voice, listen_on_eye_contact (applyConversationSettings).
  renderer.style = composeStyle(settings, makeRenderStyle());
  pushEdgeGeometry();
}
function changeSettings(values: Partial<EntitySettings>, echo: boolean): void {
  Object.assign(settings, values);
  storage.set(SETTINGS_KEY, settings);
  applySettings();
  if (echo) client?.sendSettings(values);
}
applySettings();
// Reduce Motion is a runtime input of the engine applier, never a stored setting.
motion.onChange(() => applySettings());
// Force wake clears the manual bedtime switch: fold only that field back in (never echoed to the controller).
life.onSettingsChange = (s) => { if (settings.bedtime !== s.manualBedtime) changeSettings({ bedtime: s.manualBedtime }, true); };

new ResizeObserver(([e]) => {
  const { width, height } = e!.contentRect;
  if (width === faceSize.width && height === faceSize.height) return;
  faceSize = { width, height };
  pushEdgeGeometry();
}).observe(canvas);

// ---- The frame loop: one FrameClock frame per display refresh, skipping refreshes above the policy's tier ----
let drawn = false;
clock.addConsumer(renderer, (f) => {
  const a = performance.now();
  drawn = renderer.render(f);
  perf.render[perf.n % PERF_N] = performance.now() - a;
  perf.n += 1;
});
let raf = 0, lastDrawn = -Infinity, lastRaf: number | undefined, refresh = 1 / 60;
function loop(ms: number): void {
  raf = requestAnimationFrame(loop);
  const t = ms / 1000;
  if (lastRaf !== undefined) refresh += 0.05 * (Math.min(Math.max(t - lastRaf, 0), 0.1) - refresh);
  lastRaf = t;
  clock.displayMaximumFramesPerSecond = refresh < 1 / 90 ? 120 : 60;
  // The policy's tier (asleep 30, awake 60, fast motion 120): asleep on a 60 Hz panel draws every other refresh; a
  // quarter refresh of slack absorbs rAF jitter.
  if (t - lastDrawn < 1 / clock.policy.tier - 0.25 * refresh) return;
  lastDrawn = t;
  drawn = false;
  clock.beginFrame(t);
  clock.endFrame(drawn);
}
let hiddenSince: number | undefined;
function setVisible(visible: boolean): void {
  clock.isActive = visible;
  cancelAnimationFrame(raf);
  lastRaf = undefined;
  if (!visible) { hiddenSince ??= performance.now(); saveSnapshot(); return; }
  raf = requestAnimationFrame(loop);
  // A genuine return from the background is activity; the clock may have moved while hidden.
  if (hiddenSince !== undefined) { life.noteActivity('foreground'); life.timeDidChange(); }
  hiddenSince = undefined;
}
document.addEventListener('visibilitychange', () => { if (renderer.isReady) setVisible(document.visibilityState === 'visible'); });
addEventListener('pagehide', saveSnapshot);

const error = document.getElementById('error')!;
renderer.init(canvas).then(() => setVisible(document.visibilityState === 'visible'), (e: unknown) => {
  error.textContent = `Yanni needs WebGPU (${e instanceof Error ? e.message : String(e)}).`;
  error.hidden = false;
});

// ---- Every minute: the snapshot, and a time-zone change (the browser has no notification for it) ----
let zone = LifeCalendar.current().timeZone;
setInterval(() => {
  saveSnapshot();
  const now = LifeCalendar.current();
  if (now.timeZone !== zone) { zone = now.timeZone; life.calendar = now; }
}, 60_000);

// ---- Kiosk ----
keepScreenOn();
fullscreenOnTap();
lockDownGestures();
unlockAudio(audio.context, document.getElementById('audio-hint')!);

// ---- Live values at 4 Hz, only what changed (the add-on rate-limits face_state to 1/s, keeping the trailing value) ----
const reported: Partial<DisplayState> = {};
const phaseWords = { awake: 'awake', drowsy: 'drowsy', asleep: 'asleep', halfAwake: 'half awake', waking: 'waking up' };
setInterval(() => {
  // hook (perception, WP14): person_present, people_count; (conversation, WP16): voice_services, pending messages.
  const now = faceReport(engine, life);
  Object.assign(state, now);
  const diff = changed(reported, now);
  if (Object.keys(diff).length && client?.sendState(diff)) Object.assign(reported, diff);
  describeFace(`Two eyes, ${phaseWords[life.phase]}.`);
}, 250);

// ---- Owner menu, HUD ----
const hud = new Hud(clock, () => client ? `${client.status}${client.room ? ` · ${client.room}` : ''}${client.connected ? ` · HA ${client.haConnected ? 'up' : 'down'}` : ''}` : 'not paired');
root.append(hud.el);
const menu = new OwnerMenu(root, {
  access: new OwnerAccess(localStorage),
  developerTools: () => developerTools,
  setDeveloperTools: (on) => { developerTools = on; storage.set('yanni.developerTools', on); },
  settings: () => settings,
  changeSetting: (k, v) => changeSettings({ [k]: v }, true),
  toggleHud: () => hud.toggle(),
  status: () => [
    ['Connection', client?.status ?? 'not paired'], ['Display', client?.deviceId ?? '–'], ['Room', client?.room ?? '–'],
    ['Home Assistant', client?.haConnected ? 'connected' : 'not connected'],
    ['Face', `${engine.state.agentState} · ${life.phase}${life.isBedtime ? ' · bedtime' : ''}`],
    ['Frames', `${renderer.frames} drawn, ${renderer.deviceLosses} GPU losses, ${clock.backupTakeovers} backup takeovers`],
    ['Frame rate', `${clock.policy.tier} fps tier, display ${clock.displayMaximumFramesPerSecond} Hz`],
    ['Cross-origin isolated', String(globalThis.crossOriginIsolated ?? false)],
    ['Audio', audio.context.state], ['Reduce Motion', motion.reduce ? 'on' : 'off'], ['Version', APP_VERSION],
  ],
});
document.getElementById('owner-menu-button')!.addEventListener('click', () => menu.showMenu());

// ---- Touch (FaceScreen.touched): a tap pokes, a hold talks, a rub tickles; the corner opens the owner menu ----
/** AppModel.talk with the conversation dormant (Swift `.unavailable`): asleep the hold is a tap first; awake, a small
 *  sheepish "can't". */
function talk(at: V2 | null): void {
  const sleepy = TouchReactions.startleChance(engine.state.agentState) !== null;
  if (sleepy) engine.send(FaceCommand.tap(at ?? { x: 0, y: 0 }));
  // hook (conversation, WP16): `conversation.engageManually()`: engaged / pending → `glance(at, 0.6)` unless sleepy;
  // ignored → nothing; unavailable → the "can't" below.
  if (!sleepy) engine.send(FaceCommand.playOneShot('sorryBlink')); // hook (voice): voice.react('sheepish', withFace: false)
}
const touch = new TouchInput(new TouchGestureRecognizer(), {
  onGesture(e, w, h) {
    if (menu.isOpen) { menu.close(); return; }
    const at = TouchInput.normalised(e.at, w, h);
    hud.note(`${e.kind} ${at.x.toFixed(2)}, ${at.y.toFixed(2)}`);
    switch (e.kind) {
      case 'tap':
        // hook (conversation, WP16): pressWasTap() cancels the warm-up; conversation.cancelByTap() before the poke.
        engine.send(FaceCommand.tap(at));
        // hook (expressive decisions): expressive.noteTap()
        break;
      case 'hold':
        talk(at);
        break;
      case 'scratch':
        engine.send(FaceCommand.scratch(at, e.intensity));
        // hook (emotion, WP11): first stroke, awake, not bedtime, not sulking → impulse toward delight ("tickled").
        break;
    }
  },
  // hook (conversation, WP16): pressBegan() warms the voice loop up after 200 ms (a press may become hold to talk).
  onPress: () => {},
  onCornerProgress: (p) => menu.progress(p),
  onMenu: () => menu.showMenu(),
});
touch.attach(canvas);
// The space bar talks too (FaceScreen's onKeyPress), unless the owner menu is open.
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || menu.isOpen || e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  talk(null);
});
// hook (perception, WP14): perception.coordinator → engine.setPeople, engine.noteFriendlyTouch (the high-five window),
// life presence; gestures → client.sendGesture.

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
  c.on('settings', ({ values }) => changeSettings(values, false));
  c.on('command', (cmd) => {
    hud.note(`command ${cmd}`);
    if (cmd === 'force_sleep') life.forceSleep();
    else if (cmd === 'force_wake') life.forceWake();
    // hook (perception, WP14): wrong_reaction → harness.wrongReaction()
  });
  c.on('announce', () => hud.note('announcement')); // hook (WP13): the announcement coordinator
  c.on('error', (e) => hud.note(`error ${e.code}: ${e.message}`));
  c.connect();
}
void connect();

// Debug handle for the perf smoke (`?debug`): never on in a normal kiosk load.
if (new URLSearchParams(location.search).has('debug')) {
  Object.assign(globalThis, { yanni: { engine, life, clock, renderer, perf, settings } });
}
