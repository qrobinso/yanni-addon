// tuning.html: the Tune / Status inspector over a full face with its own AppContext (engine, renderer, life, voice,
// emotion, captions; no add-on server), like the macOS preview build. `?status` opens on the Status page.
import type { AppContext } from '../app/AppContext';
import { Hud } from '../app/Hud';
import { CaptionOverlay } from '../conversation/captions/CaptionModel';
import { ConversationAudio } from '../conversation/audio/ConversationAudio';
import { EmotionLayer } from '../emotion/EmotionLayer';
import { Mood } from '../engine/AgentState';
import { FaceEngine } from '../engine/FaceEngine';
import { LifeCycleController } from '../life/LifeCycleController';
import { FaceRenderer } from '../render/FaceRenderer';
import { FrameClock } from '../render/FrameClock';
import { resolvedEyeColor } from '../render/MoodColorMix';
import { makeRenderStyle, type RenderStyle } from '../render/RenderStyle';
import { edgeGeometryFitting } from '../render/Viewport';
import { VoiceDirector } from '../voice/bridge/VoiceDirector';
import { PhraseGenerator } from '../voice/generate/PhraseGenerator';
import { installAudioUnlock, VoiceAudioHost } from '../voice/playback/VoiceAudioHost';
import { appEventLog, openStatus, openTuning, savedTuningStyle, startEventCollector } from './index';

const canvas = document.getElementById('face') as HTMLCanvasElement;
const engine = new FaceEngine();
engine.setMood(Mood.playful);
engine.setAgentState('idle');
const life = new LifeCycleController(engine);
const renderer = new FaceRenderer();
const clock = new FrameClock(engine);
const audio = new ConversationAudio();
const host = new VoiceAudioHost(audio.context);
installAudioUnlock(audio.context);
const voice = new VoiceDirector(engine, host.chirp, host, new PhraseGenerator(), host.reply);
life.onBedtimeChange = (on) => { voice.isBedtime = on; };
const emotion = new EmotionLayer(engine);
let style: RenderStyle = savedTuningStyle() ?? makeRenderStyle();
renderer.style = style;
const captions = new CaptionOverlay(document.body, { mood: () => resolvedEyeColor(style, engine.state.output), reduceMotion: () => false,
  style: () => style });
captions.onShowingChange = (on) => engine.setCaptionInset(on ? 0.3 : 0);
const hud = new Hud(clock, () => 'standalone (no add-on)');
document.body.append(hud.el);

let size = { width: 0, height: 0 };
const pushEdges = (): void => { if (size.width > 1 && size.height > 1) engine.setEdgeGeometry(edgeGeometryFitting(size.width, size.height, style)); };
new ResizeObserver(([e]) => { size = { width: e!.contentRect.width, height: e!.contentRect.height }; pushEdges(); }).observe(canvas);

const ctx: AppContext = {
  engine, life, renderer, clock, audioContext: audio.context, conversationAudio: audio, voice, emotion,
  conversation: null, perception: null, client: null, hud, captions,
  get events() { return appEventLog.contextEvents; },
  style: () => style,
  setStyle: (s) => { style = s; renderer.style = s; pushEdges(); },
  logEvent: (c, m) => appEventLog.log(c, m),
  now: () => performance.now() / 1000,
};

// After every frame, in the app's order: voice → life → emotion.
clock.addAfterFrame((t) => voice.afterFrame(t));
clock.addAfterFrame((t) => life.afterFrame(t));
clock.addAfterFrame((t) => emotion.afterFrame(t));
startEventCollector(ctx, appEventLog);
let drawn = false;
clock.addConsumer(renderer, (f) => { drawn = renderer.render(f); });

renderer.init(canvas).then(() => {
  void host.start();
  const loop = (ms: number): void => {
    requestAnimationFrame(loop);
    drawn = false;
    clock.beginFrame(ms / 1000);
    clock.endFrame(drawn);
  };
  requestAnimationFrame(loop);
}, (e: unknown) => { document.getElementById('error')!.textContent = `WebGPU: ${e instanceof Error ? e.message : String(e)}`; });

const show = (): void => { (new URLSearchParams(location.search).has('status') ? openStatus : openTuning)(ctx); };
show();
document.getElementById('reopen')!.addEventListener('click', () => openTuning(ctx));
Object.assign(globalThis, { yanni: { ctx, openTuning: () => openTuning(ctx), openStatus: () => openStatus(ctx) } });
