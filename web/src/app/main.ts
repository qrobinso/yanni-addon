// Kiosk entry point (index.html): the face full screen on WebGPU, composed as the Swift app composes it (MyApp.swift's
// AppModel.init, FaceScreen.swift): the FaceEngine is the FrameClock's source; one AudioContext carries Yanni's voice
// (AudioWorklet), the spoken replies and the microphone; the after-frame hooks run voice → life → emotion →
// conversation; perception starts 1.5 s after launch; touch goes through the TouchGestureRecognizer; the add-on socket
// syncs settings, reports live values, relays Home Assistant and delivers announcements.
import type { DisplayState, EntitySettings } from '@yanni/server/protocol';
import { GESTURES } from '@yanni/server/protocol';
import type { V2 } from '../core/vec';
import { FaceCommand } from '../engine/Commands';
import { FaceEngine } from '../engine/FaceEngine';
import { TouchGestureRecognizer } from '../engine/TouchGestures';
import { TouchReactions } from '../engine/modifiers/TouchReactions';
import { Mood } from '../engine/AgentState';
import { MoodPalette } from '../engine/MoodPalette';
import { LifeCycleController } from '../life/LifeCycleController';
import { LifeCalendar } from '../life/LifeTypes';
import type { FaceFrameSource } from '../model/FaceFrame';
import { FaceRenderer } from '../render/FaceRenderer';
import { FrameClock } from '../render/FrameClock';
import { edgeGeometryFitting } from '../render/Viewport';
import { EmotionLayer } from '../emotion/EmotionLayer';
import { LocalStorageMoodStore } from '../emotion/EmotionSettings';
import { EmotionImpulse } from '../emotion/EmotionTypes';
import { VoiceDirector } from '../voice/bridge/VoiceDirector';
import { HostClock } from '../voice/host/VoiceOutput';
import { connectPlayout, VoiceAudioHost } from '../voice/playback/VoiceAudioHost';
import { startPerception, type PerceptionHandle } from '../perception/web/startPerception';
import { CameraStatus, GestureKind, PerceptionTier } from '../perception/PerceptionTypes';
import { ConversationAudio } from '../conversation/audio/ConversationAudio';
import { AsrAudioTap } from '../conversation/audio/AsrAudioTap';
import { TurnDetectionRuntime } from '../conversation/audio/TurnDetectionRuntime';
import { conversationFace, conversationPerception } from '../conversation/core/Adapters';
import { ConversationController } from '../conversation/core/ConversationController';
import { ExpressiveDecisions, expressivePersonFrom, makeExpressiveContext } from '../conversation/core/ExpressiveDecisions';
import { TurnDetector } from '../conversation/core/TurnDetection';
import { makeVoiceServicesEndpoint, voiceServicesEndpointEqual } from '../conversation/core/VoiceServicesEndpoint';
import type { ConversationTurnDetection } from '../conversation/core/TurnDetection';
import type { VoiceTransport } from '../conversation/core/Ports';
import { DecisionQuestions } from '../conversation/agent/DecisionQuestions';
import { SystemAgentClock } from '../conversation/agent/AgentTunables';
import { HAClient } from '../conversation/agent/homeassistant/HAClient';
import { FetchHAMediaFetcher, WebAudioMediaDecoder, type HAMediaFetching } from '../conversation/agent/homeassistant/HASpeech';
import { LocalAgentTransport } from '../conversation/agent/LocalAgentTransport';
import { AnnouncementQueue, localAnnouncementStore } from '../conversation/announcements/AnnouncementQueue';
import { CaptionOverlay, captionBand } from '../conversation/captions/CaptionModel';
import { ConversationProactiveLink, CoordinatorAnnouncements } from '../conversation/home/HomeAdapters';
import { voiceServicesState } from '../conversation/home/VoiceServicesState';
import { SileroVADModel } from '../conversation/turnml/SileroVADModel';
import { SmartTurnWorkerClient } from '../conversation/turnml/SmartTurnWorkerClient';
import type { AppContext } from './AppContext';
import { ClipStore } from './conversation/ClipStore';
import { ConversationAudioEngine } from './conversation/ConversationAudioEngine';
import { EmotionLayerSink, moodReportPayload } from './conversation/EmotionLayerSink';
import { fakeHomeAssistant, RelayChannel } from './conversation/RelayChannel';
import { BabbleReplyClock, BabbleReplyVoicer, StateContextPublisher } from './conversation/VoiceAdapters';
import { DisplayClient } from './DisplayClient';
import { FaceAccessibility } from './FaceAccessibility';
import { faceReport } from './FaceSettings';
import { Hud } from './Hud';
import { keepScreenOn, lockDownGestures, motion, unlockAudio } from './Kiosk';
import { OwnerAccess } from './OwnerAccess';
import { OwnerMenu } from './OwnerMenu';
import { forgetPairing, loadPairing, showPairing } from './Pairing';
import { countingConversationPerception, PerceptionHarness } from './PerceptionHarness';
import { RenderReport } from './StatusReport';
import { TouchInput } from './TouchInput';
import { attachSettings, emotionSettings, filterReport, perceptionSettings, resetAllSettings, SettingsHub, voiceServicesEndpoint } from '../settings';
import { ownerTools } from './OwnerTools';
import { startEventCollector } from '../preview';
import { PerceptionEvent } from '../perception/PerceptionTypes';
import { KioskBoot, startKiosk, type KioskServices } from '../kiosk';
import './app.css';

const APP_VERSION = '0.1.0';
const LISTEN_CUE = new URL('sounds/listen-pop.wav', document.baseURI).href;
const params = new URLSearchParams(location.search);
/** `?fakeha`: the voice loop over the in-process fake Home Assistant (dev only). */
const FAKE_HA = params.has('fakeha');

// ---- The face (AppModel.init order) ----
const engine = new FaceEngine();
engine.setMood(Mood.playful);
engine.setAgentState('idle');
// Black → the eyes fade in (hardening design §6.2), before the first frame.
engine.fadeInFromBlack();

// Per-frame timings (ms) for the perf smoke and the HUD: engine (source), each after-frame hook, render (consumer).
const PERF_N = 8192;
const lane = () => new Float32Array(PERF_N);
const perf = { engine: lane(), voice: lane(), life: lane(), emotion: lane(), conversation: lane(), render: lane(), n: 0 };
const timedSource: FaceFrameSource = {
  frame(t) {
    const a = performance.now();
    const f = engine.frame(t);
    perf.engine[perf.n % PERF_N] = performance.now() - a;
    return f;
  },
};
const timed = (into: Float32Array, f: (t: number) => void) => (t: number) => {
  const a = performance.now();
  f(t);
  into[perf.n % PERF_N] = performance.now() - a;
};

const canvas = document.getElementById('face') as HTMLCanvasElement;
const root = document.getElementById('shell')!;
const renderer = new FaceRenderer();
const clock = new FrameClock(timedSource);

let client: DisplayClient | undefined;
const hud = new Hud(clock, () => client ? `${client.status}${client.room ? ` · ${client.room}` : ''}${client.connected ? ` · HA ${client.haConnected ? 'up' : 'down'}` : ''}` : 'not paired');
root.append(hud.el);

// ---- The event log (Status, diagnostics): never message text, transcripts or tokens ----
const events: { at: number; category: string; message: string }[] = [];
function logEvent(category: string, message: string): void {
  events.push({ at: Date.now(), category, message });
  kiosk?.diagnostics.add(category, message);
  if (events.length > 200) events.splice(0, events.length - 200);
  hud.note(`${category}: ${message}`);
}

// ---- Settings: the hub is the single writer (owner screen, Home Assistant, Tuning); the display is the source of
// truth on reconnect. The appliers attach once the subsystems exist (below). ----
const hub = new SettingsHub();
const val = <K extends keyof EntitySettings>(k: K): EntitySettings[K] => hub.settings[k] as EntitySettings[K];

// Launch-time kiosk decisions first: the device profile (with the owner's display kind) and the launch guard's verdict
// (careful start / safe mode).
const boot = new KioskBoot({ appVersion: APP_VERSION,
  overrides: hub.settings.display_kind === 'auto' ? {} : { display: hub.settings.display_kind } });

// ---- One AudioContext: Yanni's voice (AudioWorklet), the spoken replies and the microphone ----
const audio = new ConversationAudio();
const voiceHost = new VoiceAudioHost(audio.context);
const voice = new VoiceDirector(engine, voiceHost.chirp, voiceHost, undefined, voiceHost.reply);
// Keep running silently if the worklet can't start (or the launch guard holds audio back): the face cues still fire.
const startVoice = () => voiceHost.start().catch((e: unknown) => logEvent('voice', `output failed to start (${e instanceof Error ? e.name : 'error'})`));
// Yanni's chirps and babble are the echo rule's audible windows for turn detection.
connectPlayout(voice, audio);
if (boot.allows('audio')) { boot.starting('audio'); void startVoice(); }

// ---- Life cycle (the hub persists its settings; the controller only applies them) ----
const life = new LifeCycleController(engine);
// Only the life cycle decides whether it is bedtime; the voice follows (night wakes are quiet).
life.onBedtimeChange = (on) => { voice.isBedtime = on; };

// ---- Launch-time kiosk decisions (device profile, launch guard, resume snapshot), before anything starts. A reload
// within 10 min comes back in the saved phase: before the first frame, no wake, greeting or chirp, never activity.
// The kiosk services (started below) write the snapshot. ----
boot.restoreLife(life);

// ---- Emotion: the one source of feeling; personality from the settings, boredom and presence from the life cycle,
// the mood persists across launches ----
const emotion = new EmotionLayer(engine, { settings: emotionSettings(hub.settings), personality: hub.settings.personality,
  moodStore: new LocalStorageMoodStore() });
emotion.environment = () => ({ boredom: life.boredom, isPresent: life.isPresent });

// ---- Perception (started 1.5 s after launch, as the Swift PerceptionModel does) ----
let perception: PerceptionHandle | null = null;
const harness = new PerceptionHarness();
const people = () => (perception?.coordinator.latest.people ?? []).map(expressivePersonFrom);

// ---- After every engine frame, in the Swift order (each cheap, allocation-free on ordinary frames) ----
clock.addAfterFrame(timed(perf.voice, (t) => voice.afterFrame(t)));
clock.addAfterFrame(timed(perf.life, (t) => life.afterFrame(t)));
clock.addAfterFrame(timed(perf.emotion, (t) => emotion.afterFrame(t)));
// Calm frame rate (§6.6): drowsy, or perception's room-empty state on a fresh snapshot, and no one-shot playing.
clock.addAfterFrame(() => {
  const p = perception?.coordinator.latest;
  const quiet = life.phase === 'drowsy' || (p !== undefined && p.stats.vacant && performance.now() / 1000 - p.time < 1);
  clock.calmRate = quiet && engine.state.activeOneShots.length === 0;
});

// ---- Announcements: held until there's an audience, then handed to the voice loop ----
// The queue's handle on the voice loop (settings-open suppression, the high-priority push); the controller comes next.
const conversationLink = new ConversationProactiveLink(null);
const announcements = new AnnouncementQueue({
  conversation: conversationLink, now: () => performance.now() / 1000, wallNow: () => Date.now(), setAgentState: (s) => engine.setAgentState(s),
  store: localAnnouncementStore(localStorage),
  onResult: (r) => { client?.sendAnnouncement(r.outcome, r.id, r.reason); logEvent('home', `announcement ${r.outcome}`); },
  // A message arriving gets a small perk-up; its feeling comes from the has-a-message state.
  onArrival: () => { if (life.phase === 'awake' && !life.isBedtime) engine.send(FaceCommand.playOneShot('perkUp')); },
  // A nudge is a feeling for the emotion layer (its PAD tag, clamped; `look` glances).
  onNudge: (n) => emotion.apply({ kind: 'nudge', nudge: { feeling: n.feeling, strength: n.strength, look: n.look ?? null } }),
});

// ---- The voice loop over Home Assistant (direct HA design §3), through the add-on relay ----
const asrTap = new AsrAudioTap();
const audioEngine = new ConversationAudioEngine(audio, asrTap);
audioEngine.onLog = (line) => logEvent('talk', `audio: ${line}`);
const channel = new RelayChannel();
const agentClock = new SystemAgentClock();
let fakeMedia: HAMediaFetching | null = null;
let pairingToken = '';
const contextPublisher = new StateContextPublisher();
let transport: LocalAgentTransport | null = null;
let conversationUnavailable: string | null = null;
// Hosted Jev answers in ~250–580 ms, a Kev on the LAN well under 200 ms (design §17).
const babble = new BabbleReplyVoicer(voice, emotion, () => (transport?.health.jevLatencyMs ?? 0) > 200);
try {
  transport = new LocalAgentTransport({
    makeHAClient: () => new HAClient(channel, agentClock), audio: asrTap,
    voicers: { playoutSink: audioEngine.playout, yanni: babble }, context: contextPublisher,
    questions: DecisionQuestions.bundled(), clock: agentClock,
    makeMediaFetcher: () => fakeMedia ?? new FetchHAMediaFetcher(document.baseURI, pairingToken),
    mediaDecoder: new WebAudioMediaDecoder(),
  });
} catch (e) {
  conversationUnavailable = 'decision questions unavailable';
  console.error(`Voice services unavailable: ${e instanceof Error ? e.message : String(e)}`);
}
/** The transport when the orchestrator couldn't be built: it never connects, so the controller stays dormant. */
const unavailableTransport: VoiceTransport = {
  onEvent: null, status: { kind: 'disconnected' }, connect() {}, disconnect() {}, setMicEnabled() {}, send() {},
};
const babbleClock = new BabbleReplyClock(voice);
const conversation = new ConversationController({ face: conversationFace(engine), life, audio: audioEngine,
  transport: transport ?? unavailableTransport, voice, clock: HostClock.nowSeconds });
// On-device turn detection: the mic → Silero VAD + Smart Turn (onnxruntime-web). Nothing loads here: the models load
// and warm when conversation mode starts (`prepare()` at Noticing).
const turnDetector = new TurnDetector();
const smartTurn = new SmartTurnWorkerClient();
const turnRuntime: ConversationTurnDetection = new TurnDetectionRuntime({ pump: audio.pump, playout: audio.audibility,
  makeVAD: () => SileroVADModel.create(), endOfTurn: smartTurn, computeUnits: () => smartTurn.provider });
turnDetector.backend = turnRuntime;
conversation.turn = turnDetector;
const coordinatorAnnouncements = new CoordinatorAnnouncements(announcements);
conversation.announcements = coordinatorAnnouncements;
conversationLink.controller = conversation;
const emotionSink = new EmotionLayerSink(emotion);
conversation.emotion = emotionSink;
// Gates nobody handed over (a preview simulator) set the face as before, but never while a real conversation runs.
emotionSink.onOtherGate = (g) => {
  if (conversation.phase !== 'idle') return;
  engine.setAgentState(g.kind === 'notForMe' ? 'notForMe' : 'confused');
};
// The layer's mood report goes upstream verbatim; the controller decides when.
emotion.onMoodReport = (r) => conversation.noteMoodReport(moodReportPayload(r));

// Expressive decisions: the decision model picks the considered reaction to what Yanni sees (the reflex has already
// played); a starting announcement gets a delivery face (ExpressiveWiring.swift).
const expressive = new ExpressiveDecisions();
coordinatorAnnouncements.onBatchTaken = (priority) => expressive.noteAnnouncement(priority, people());
if (transport) { const o = transport.orchestrator; expressive.ask = (f) => o.expressive(f); }
expressive.context = () => makeExpressiveContext({
  agentState: engine.state.agentState, awake: life.phase === 'awake', bedtime: life.isBedtime, mood: emotion.label,
  hour: new Date().getHours(), jevAvailable: !!transport && transport.status.kind === 'ready' && transport.health.jev !== 'not configured',
});
expressive.onAnswer = (key, answers) => emotion.playExpressive(answers, key)?.summary ?? null;
expressive.onLog = (line) => logEvent('emotion', line);
setInterval(() => expressive.tick(people()), 1000);

// Greeting clips (Spoken voice): rendered through HA's TTS when the session's voice changes.
const clips = new ClipStore({ channel, fetcher: () => fakeMedia ?? new FetchHAMediaFetcher(document.baseURI, pairingToken),
  decoder: new WebAudioMediaDecoder(), endpoint: () => conversation.endpoint, conversationActive: () => conversation.phase !== 'idle',
  preload: (u) => void audioEngine.preloadClip(u), forget: (u) => audioEngine.forgetClip(u),
  onLog: (line) => logEvent('talk', `voice services: ${line}`) });
conversation.greetings = clips;
void audioEngine.preloadClip(LISTEN_CUE);

// Captions go only to the bubbles: never to the log, the Status page, Home Assistant or the add-on.
const captions = new CaptionOverlay(root, {
  mood: () => { const m = engine.state.mood; return MoodPalette.standard.displayLinear({ x: m.pleasure, y: m.arousal, z: m.dominance }); },
  reduceMotion: () => motion.reduce, style: () => renderer.style,
});
// While a caption shows, the face springs up out of the caption band (and settles back after).
captions.onShowingChange = (showing) => engine.setCaptionInset(showing ? captionBand : 0, motion.reduce);
conversation.onCaption = (c) => captions.receive(c);
/** `?debug` only: the caption kinds seen (never their words), for the smoke run. */
const captionKinds: string[] = [];
if (params.has('debug')) conversation.onCaption = (c) => { captionKinds.push(c.kind); captions.receive(c); };
conversation.onLog = (e) => logEvent('talk', `${e.kind}: ${e.detail}`);
conversation.onServicesInfo = (info) => clips.servicesChanged(info);
// Voice services unreachable is a felt condition (sheepish undertone) until the session is back.
conversation.onServicesReachabilityChange = (reachable) => emotion.setCondition('voiceServicesUnreachable', !reachable);
// Per frame, after the emotion layer.
clock.addAfterFrame(timed(perf.conversation, (t) => conversation.afterFrame(t)));

/** What the controller connects to: the add-on relay to Home Assistant's pipeline (null = dormant: not paired yet).
 *  After this the hub's conversation applier keeps it in line with the settings. */
let voiceServicesReady = false;
function applyEndpoint(): void {
  if (!transport) return;
  const ep = voiceServicesReady ? voiceServicesEndpoint(hub.settings, makeVoiceServicesEndpoint()) : null;
  if (ep === null) emotion.setCondition('voiceServicesUnreachable', false);
  if (!voiceServicesEndpointEqual(conversation.endpoint, ep)) conversation.endpoint = ep;
}

// ---- The edge geometry follows the drawable and the style ----
let faceSize = { width: 0, height: 0 };
/** The edge geometry follows the drawable (CSS px, as Swift's points) and the style. */
function pushEdgeGeometry(): void {
  if (faceSize.width > 1 && faceSize.height > 1) {
    engine.setEdgeGeometry(edgeGeometryFitting(faceSize.width, faceSize.height, renderer.style));
  }
}
new ResizeObserver(([e]) => {
  const { width, height } = e!.contentRect;
  if (width === faceSize.width && height === faceSize.height) return;
  faceSize = { width, height };
  pushEdgeGeometry();
}).observe(canvas);

// ---- Perception: the camera, people → the face, reflex impulses → feeling, gestures → Home Assistant ----
function startPerceptionNow(): void {
  perception?.stop();
  // The device's tier is the ceiling (Swift `HardwareClass.startingTier`), not full on every tablet.
  const p = startPerception(engine, life, { frameStats: clock.stats, settings: perceptionSettings(hub.settings),
    tierCeiling: PerceptionTier[boot.defaults.tierHint] });
  perception = p;
  ctx.perception = p;
  harness.attach(p, { frameStats: clock.stats, faceSize: () => faceSize, appBuild: APP_VERSION });
  // The perception tunables reach it now; the voice loop turns look-to-talk's dry run off while it is live.
  settingsAttachment.refresh();
  // Perception reflexes' impulses (gated by the layer: never asleep, at bedtime or sulking).
  p.coordinator.onImpulse = (i, reason) => emotion.apply({ kind: 'impulse', impulse: EmotionImpulse.toward(i.target, i.strength, 'perception', reason) });
  p.onEvent((e, note) => {
    harness.note(e, note, performance.now() / 1000);
    expressive.note(e, note, people());
    logEvent('People', PerceptionEvent.text(e) + (note ? ` → ${note}` : ''));
    // Home Assistant `last_gesture`: gestures aimed at Yanni only, only while presence is shared (design §6.6).
    if (e.kind !== 'gesture') return;
    const g = e.gesture;
    if (!g.directedAtYanni || g.phase === 'ended' || !val('share_presence') || (g.kind.kind === 'highFive' && g.phase === 'started')) return;
    const name = GestureKind.homeAssistantName(g.kind);
    if ((GESTURES as readonly string[]).includes(name)) client?.sendGesture(name as (typeof GESTURES)[number]);
  });
  conversation.perception = countingConversationPerception(conversationPerception(p.coordinator), harness);
}
// Give the face a moment to come alive before any permission prompt; careful start / safe mode hold it back.
setTimeout(() => { if (!kiosk || kiosk.allows('perception')) startPerceptionNow(); }, 1500);

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
  // The session disconnects whenever the app isn't in the foreground (review L8): any conversation ends.
  conversation.isAppActive = visible;
  if (!visible) { hiddenSince ??= performance.now(); emotion.saveMood(); hub.flush(); return; }
  raf = requestAnimationFrame(loop);
  // A genuine return from the background is activity; the clock may have moved while hidden.
  if (hiddenSince !== undefined) { life.noteActivity('foreground'); life.timeDidChange(); }
  hiddenSince = undefined;
}
document.addEventListener('visibilitychange', () => { if (renderer.isReady) setVisible(document.visibilityState === 'visible'); });
addEventListener('pagehide', () => { emotion.saveMood(); hub.flush(); });

const error = document.getElementById('error')!;
renderer.init(canvas).then(() => setVisible(document.visibilityState === 'visible'), (e: unknown) => {
  error.textContent = `Yanni needs WebGPU (${e instanceof Error ? e.message : String(e)}).`;
  error.hidden = false;
});

// ---- Every minute: a time-zone change (the browser has no notification for it) ----
let zone = LifeCalendar.current().timeZone;
setInterval(() => {
  const now = LifeCalendar.current();
  if (now.timeZone !== zone) { zone = now.timeZone; life.calendar = now; }
}, 60_000);

// ---- Kiosk ----
keepScreenOn();
lockDownGestures();
unlockAudio(audio.context, document.getElementById('audio-hint')!);

// ---- Owner menu ----
const access = new OwnerAccess(localStorage);
harness.access = access;
const state: Partial<DisplayState> = { started_at: new Date().toISOString() };

/** Home Assistant is up but speech recognition (down, or its model still preparing), the speech voice it needs, or Jev
 *  is down. */
function servicesDown(): boolean {
  const h = transport?.health;
  if (!h || h.homeAssistant !== 'up') return false;
  return h.asr === 'down' || h.asr === 'preparing' || h.tts === 'down' || h.jev === 'down';
}

const statusRows = (): [string, string][] => {
  const cs = conversation.status, cam = perception?.stats();
  return [
    ['Connection', client?.status ?? 'not paired'], ['Display', client?.deviceId ?? '–'], ['Room', client?.room ?? '–'],
    ['Home Assistant', FAKE_HA ? 'fake (?fakeha)' : client?.haConnected ? 'connected' : 'not connected'],
    ['Face', `${engine.state.agentState} · ${life.phase}${life.isBedtime ? ' · bedtime' : ''}`],
    ['Conversation', `${cs.phase} · session ${cs.session}${cs.dormantReason ? ` (${cs.dormantReason})` : ''}${conversationUnavailable ? ` · ${conversationUnavailable}` : ''}`],
    ['Voice services', voiceServicesState(cs, servicesDown())],
    ['Turn detection', cs.turnDetection?.availability.kind ?? '–'],
    ['Microphone', audioEngine.microphone],
    ['Last dismissal', cs.lastDismissal ?? '–'],
    ['Camera', cam ? (cam.noFramesFor !== null ? `no frames for ${cam.noFramesFor} s · camera covered or in use by another app`
      : `${CameraStatus.label(cam.camera)} · ${PerceptionTier.label(cam.tier)} · ${cam.analysisFPS.toFixed(0)} fps`) : 'starting'],
    ['People', String(perception?.coordinator.latest.people.length ?? 0)],
    ['Messages', String(announcements.items.length)],
    ['Mood', `${emotion.label}`],
    ['Frames', `${renderer.frames} drawn, ${renderer.deviceLosses} GPU losses, ${clock.backupTakeovers} backup takeovers`],
    ['Frame rate', `${clock.policy.tier} fps tier, display ${clock.displayMaximumFramesPerSecond} Hz`],
    ['Cross-origin isolated', String(globalThis.crossOriginIsolated ?? false)],
    ['Audio', audio.context.state], ['Reduce Motion', motion.reduce ? 'on' : 'off'], ['Version', APP_VERSION],
  ];
};

/** Reset all settings (typed RESET): defaults, the PIN and the greeting clips cleared; the add-on keeps the device. */
/** What a reset clears besides the settings and the PIN: the add-on hears pending announcements cancelled. */
function resetExtras(): void {
  announcements.clearAll('reset');
  void clips.clear();
  logEvent('settings', 'reset all settings');
}
function resetAll(): void { resetExtras(); resetAllSettings(hub, access); }

const menu = new OwnerMenu(root, {
  access,
  developerTools: () => hub.settings.developer_tools,
  setDeveloperTools: (on) => hub.update('app', { developer_tools: on }),
  settings: () => hub.settings,
  changeSetting: (k, v) => hub.update('app', { [k]: v }),
  toggleHud: () => hud.toggle(),
  status: statusRows,
  wrongReaction: () => harness.wrongReaction(),
  resetAll,
  onSettingsOpenChange: (open) => setSettingsOpen(open),
  external: ownerTools({ ctx: () => ctx, hub, access, kiosk: () => kiosk,
    appVersion: APP_VERSION, root, onReset: resetExtras, settingsOpenChange: (open) => setSettingsOpen(open) }),
});
document.getElementById('owner-menu-button')!.addEventListener('click', () => menu.showMenu());

// While Settings is open look-to-talk and delivery pause (the panel itself counts as activity every 30 s).
function setSettingsOpen(open: boolean): void { ctx.settingsOpen = open; }

// ---- Touch (FaceScreen.touched): a tap pokes, a hold talks, a rub tickles; the corner opens the owner menu ----
/** Hold to talk, the space bar and the "Talk to Yanni" action (AppModel.talk). Asleep, the hold is a tap first and the
 *  engagement waits for the wake. Engaged or waiting: a quick look at the finger. Already talking: nothing. Dormant or
 *  without the microphone (and awake): a small sheepish "can't". */
function talk(at: V2 | null): void {
  const sleepy = TouchReactions.startleChance(engine.state.agentState) !== null;
  if (sleepy) engine.send(FaceCommand.tap(at ?? { x: 0, y: 0 }));
  const result = audioEngine.microphone === 'denied' ? { kind: 'unavailable' as const, reason: 'microphone access is off' }
    : conversation.engageManually();
  logEvent('talk', `hold to talk: ${result.kind}`);
  switch (result.kind) {
    case 'engaged': case 'pending':
      if (at && !sleepy) engine.send(FaceCommand.glance(at, 0.6));
      break;
    case 'ignored':
      break;
    case 'unavailable':
      if (sleepy) break;
      engine.send(FaceCommand.playOneShot('sorryBlink'));
      voice.react('sheepish', false);
      break;
  }
}
/** A press began outside the owner corner: it may become hold to talk, so the voice loop warms up once the press
 *  outlasts a poke (taps release well within 0.2 s). */
let pressWarmUp: ReturnType<typeof setTimeout> | undefined;
function pressBegan(): void {
  if (audioEngine.microphone === 'denied') return;
  clearTimeout(pressWarmUp);
  pressWarmUp = setTimeout(() => conversation.warmUp(), 200);
}
function poke(at: V2): void {
  engine.send(FaceCommand.tap(at));
  expressive.noteTap(people());
}
/** One stroke of a scratch: the engine's tickle; the first stroke also nudges the feeling toward delight. */
function scratch(at: V2, intensity: number, began: boolean): void {
  engine.send(FaceCommand.scratch(at, intensity));
  if (!began || life.phase !== 'awake' || life.isBedtime || engine.state.isSulking) return;
  emotion.apply({ kind: 'impulse', impulse: EmotionImpulse.toward({ x: 0.8, y: 0.75, z: 0.3 }, 0.45, 'touch', 'tickled') });
  expressive.noteTickle(people());
}
const touch = new TouchInput(new TouchGestureRecognizer(), {
  onGesture(e, w, h) {
    const at = TouchInput.normalised(e.at, w, h);
    hud.note(`${e.kind} ${at.x.toFixed(2)}, ${at.y.toFixed(2)}`);
    if (e.kind === 'tap') clearTimeout(pressWarmUp);
    if (menu.isOpen) { menu.close(); return; }
    switch (e.kind) {
      case 'tap':
        // A tap with the mic open means "I didn't mean to": stop listening and the reply (the poke still lands).
        conversation.cancelByTap();
        poke(at);
        break;
      case 'hold': talk(at); break;
      case 'scratch': scratch(at, e.intensity, e.began); break;
    }
  },
  onPress: pressBegan,
  onCornerProgress: (p) => menu.progress(p),
  onMenu: () => menu.showMenu(),
  onReset: () => menu.showReset(),
  onAnyTouch: () => menu.noteTouch(),
});
touch.attach(canvas);
// The space bar talks too (FaceScreen's onKeyPress), unless an owner screen or a text field has it.
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || menu.isOpen || e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
  e.preventDefault();
  talk(null);
});
// The face as one accessibility element with the corner menu's destinations as actions (hardening design §10).
const a11y = new FaceAccessibility(canvas, document.getElementById('face-desc')!, {
  poke: () => poke({ x: 0, y: 0 }), talk: () => talk(null), openMenu: () => menu.showMenu(),
  settings: () => menu.open('settings'), status: () => menu.open('status'),
  wake: () => life.forceWake(), sleep: () => life.forceSleep(),
});

// ---- The shared object graph for the settings hub, the kiosk services and the owner tools ----
const ctx: AppContext = {
  engine, life, renderer, clock, audioContext: audio.context, conversationAudio: audio, voice, emotion, conversation,
  perception: null, client: null, hud, audioEngine, transport, turnDetector, announcements, captions, expressive, harness,
  style: () => renderer.style,
  setStyle: (s) => { renderer.style = s; pushEdgeGeometry(); },
  logEvent, now: () => performance.now() / 1000, talk, events, haChannel: channel,
  faceSize: () => faceSize,
  openOwner: (d) => (d === 'menu' ? menu.showMenu() : d === 'reset' ? menu.showReset() : menu.open(d)),
  settingsOpen: false,
};
// Every setting into every subsystem (the hub's appliers, in order); the kiosk caps the style (OLED budget) and takes
// its own slice.
let kiosk: KioskServices | undefined;
const settingsAttachment = attachSettings(hub, ctx, { expressive: () => expressive, replyClock: () => babbleClock,
  listenCueURL: LISTEN_CUE, styleTransform: (st) => kiosk?.model.style(st) ?? st,
  onKiosk: (k) => {
    // A new display kind re-makes the device profile: the style's caps follow.
    if (kiosk?.configure({ restartOnHang: k.hangRestartArmed, maintenanceRestart: k.maintenanceRestartArmed,
      oledBackgroundBudget: k.oledBackgroundBudget, displayOverride: k.displayOverride })) queueMicrotask(() => settingsAttachment.refresh());
  } });
// The kiosk services: resource governor, health supervisor and watchdogs, hang monitor, diagnostics, vitals, the
// resume snapshot and the screen-reader description.
kiosk = startKiosk(ctx, { appVersion: APP_VERSION, boot, renderControl: renderer, settings: () => hub.settings,
  events: () => events.map((e) => `${new Date(e.at).toISOString()} ${e.category}: ${e.message}`),
  restartPerception: () => startPerceptionNow(),
  onResume: (sub) => { if (sub === 'perception') startPerceptionNow(); else if (sub === 'audio') void startVoice(); } });
settingsAttachment.refresh();
// The event log's other sources (life phases, emotion events, the cheap diffs) for Status; the kiosk's recorder logs
// agent states, one-shots and chirps (one stream, as the Swift app's).
startEventCollector(ctx, undefined, { frameEvents: false });

// ---- Live values at 4 Hz, only what changed (the add-on rate-limits face_state to 1/s, keeping the trailing value) ----
const reported: Record<string, unknown> = {};
const same = (a: unknown, b: unknown) => a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b));
function report(all: Partial<DisplayState>): void {
  // Presence only while it is shared, the mood sentence only while the mood note is on.
  const values = filterReport(hub.settings, all);
  Object.assign(state, values);
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (!same(reported[k], v)) diff[k] = v;
  if (Object.keys(diff).length && client?.sendState(diff as Partial<DisplayState>)) Object.assign(reported, diff);
}
let announcementPending = false;
setInterval(() => {
  const now = performance.now() / 1000;
  const s = engine.state;
  const share = val('share_presence');
  report({
    ...faceReport(engine, life),
    // Presence entities exist only while presence is shared.
    ...(share ? { person_present: life.isPresent, people_count: s.people.length } : {}),
    voice_services: voiceServicesState(conversation.status, servicesDown()),
    conversation_context: contextPublisher.sensor(val('send_mood_note'), share),
    ...announcements.report(),
    ...harness.homeSignals(),
    ...kiosk.statusFields(),
  });
  harness.tick(now, () => perception?.coordinator.latest.people.map((p) => p.id) ?? []);
  clips.tick();
  // The `conversation_context` sensor's "has a message" flag (never the text).
  const pending = announcements.items.length > 0;
  if (pending !== announcementPending) { announcementPending = pending; transport?.setAnnouncementPending(pending); }
  announcements.update({ agentState: s.agentState, lifePhase: life.phase, isBedtime: life.isBedtime,
    isForceSleep: life.isForceSleepActive, personPresent: life.isPresent, eyeContact: s.engagedPersonID !== null,
    quietMode: val('quiet_mode'), settingsOpen: ctx.settingsOpen === true });
  a11y.update(kiosk.spokenState(), life.phase === 'asleep' || life.phase === 'drowsy');
}, 250);
// The render loop's numbers for the owner Status page.
const renderReport = new RenderReport(clock);
setInterval(() => report(renderReport.sample()), RenderReport.interval * 1000);

// ---- Pairing and the add-on socket ----
async function connect(): Promise<void> {
  const stored = loadPairing();
  const pairing = stored ?? await showPairing(root);
  // A fresh pairing names the room (the code's); after that the display's own setting is the truth.
  if (!stored && pairing.room) hub.update('system', { room: pairing.room });
  pairingToken = pairing.token;
  const url = new URL('ws', document.baseURI);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const c = new DisplayClient({ url: url.href, token: pairing.token, appVersion: APP_VERSION,
    deviceModel: `Browser (${navigator.platform || 'web'})`.slice(0, 80), settings: () => hub.helloValues(), state: () => state });
  client = c;
  ctx.client = c;
  hub.connect(c);
  if (!FAKE_HA) { channel.attach(c); voiceServicesReady = true; applyEndpoint(); }
  c.on('status', (s) => {
    hud.note(`socket ${s}`);
    if (s === 'unpaired') { forgetPairing(); void connect(); }
  });
  c.on('command', (cmd) => {
    logEvent('home', `command ${cmd}`);
    if (cmd === 'force_sleep') life.forceSleep();
    else if (cmd === 'force_wake') life.forceWake();
    else if (cmd === 'wrong_reaction') harness.wrongReaction();
  });
  c.on('announce', (a) => announcements.receive(a));
  c.on('error', (e) => logEvent('home', `error ${e.code}`));
  c.connect();
}
if (FAKE_HA) {
  void fakeHomeAssistant().then((fake) => {
    fakeMedia = fake;
    channel.attach(fake);
    voiceServicesReady = true;
    applyEndpoint();
    logEvent('talk', 'fake Home Assistant');
  });
}
void connect();

// Debug handle for the perf smoke (`?debug`): never on in a normal kiosk load.
if (params.has('debug')) {
  Object.assign(globalThis, { yanni: { engine, life, clock, renderer, perf, hub, ctx, conversation, audioEngine, captions, captionKinds,
    get perception() { return perception; } } });
}
