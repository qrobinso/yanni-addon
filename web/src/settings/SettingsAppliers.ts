// Port of YanniSettings/SettingsAppliers.swift plus the app's own settings wiring (MyApp.swift `wireSettings`,
// `applyConversationSettings`, ExpressiveWiring, PerceptionSupport, KioskModel): each applier writes only its own
// slice and only when that slice changed, so a volume drag never re-assigns the life settings. Order: life → voice →
// engine → emotion → style → conversation → perception → expressive → kiosk.
//
// The pure mappings (settings → each subsystem's settings type) are exported for tests and for the Tuning tool.
import type { DisplayState } from '@yanni/server/protocol';
import { EDGE_ANTICS, IDLE_GAMES, PUPIL_SHAPES, SETTING_DEFAULTS, type Settings } from '@yanni/server/settings';
import type { AppContext } from '../app/AppContext';
import { motion } from '../app/Kiosk';
import { conversationSettingsEqual, type ConversationSettings } from '../conversation/core/ConversationSettings';
import type { ExpressiveBudget } from '../conversation/core/ExpressiveDecisions';
import type { ReplyClock } from '../conversation/core/Ports';
import { voiceServicesEndpointEqual, type VoiceServicesEndpoint } from '../conversation/core/VoiceServicesEndpoint';
import { makeTurnTunables, type TurnTunables } from '../conversation/turn/TurnTunables';
import { EmotionSettings } from '../emotion/EmotionSettings';
import type { EdgeAnticSettings } from '../engine/EdgeAnticSettings';
import type { FaceEngine } from '../engine/FaceEngine';
import type { IdleGameSettings } from '../engine/IdleGameSettings';
import type { ListeningGlowConfig } from '../engine/ListeningGlow';
import type { MoodBackgroundConfig, MoodBackgroundMode } from '../engine/MoodBackground';
import type { PupilReactionSettings } from '../engine/PupilReactionTypes';
import { LifeSettings } from '../life/LifeSettings';
import { PerceptionSettings } from '../perception/PerceptionSettings';
import type { RenderStyle } from '../render/RenderStyle';
import { VoiceSettings } from '../voice/bridge/VoiceDirector';
import type { SettingsApplier, SettingsHub } from './SettingsHub';
import { hexToLinear, sameStyle, StyleComposer } from './StyleComposer';

const camel = (k: string) => k.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- Pure mappings ----

/** `life` slice. */
export function lifeSettings(s: Settings): LifeSettings {
  return new LifeSettings({
    manualBedtime: s.bedtime, bedtimeEnabled: s.bedtime_schedule, bedtimeStart: s.bedtime_start,
    bedtimeEnd: s.bedtime_end, minutesToDrowsy: s.minutes_to_drowsy, minutesToAsleep: s.minutes_to_asleep,
    bedtimeAwakeMinutes: s.bedtime_awake_minutes, tapsToWake: s.taps_to_wake,
    wakeOnMotionAtBedtime: s.wake_on_motion_at_bedtime, idleMoodDrift: s.idle_mood_drift,
    aloneTakeoverMinutes: s.alone_takeover_minutes,
  }).validated();
}

/** `voice` slice (Swift `VoiceSettings`; `validatedVoice`: volume 0…1, offset ±0.06). */
export function voiceSettings(s: Settings): VoiceSettings {
  return new VoiceSettings({ volume: s.chirp_volume / 100, muted: !s.sounds, quietMode: s.quiet_mode,
    bedtimeSounds: s.bedtime_sounds, autoVocalize: s.auto_vocalize, avOffset: s.av_offset });
}

/** `playfulness.edgeAntics` over the engine's current value. */
export function edgeAnticSettings(s: Settings, base: EdgeAnticSettings): EdgeAnticSettings {
  const e = base.copy();
  e.enabled = s.screen_antics;
  e.frequency = s.antics_frequency;
  e.travel = s.antics_travel;
  e.intensity = s.antics_intensity;
  e.timingScale = s.antics_timing;
  e.maxHiddenSeconds = s.antics_max_hidden;
  for (const a of EDGE_ANTICS) {
    e.setAntic(camel(a) as never, { enabled: s[`antic_${a}`], weight: s[`antic_${a}_weight`], cooldown: s[`antic_${a}_cooldown`] });
  }
  e.greetingChance = s.antics_greeting_chance / 100;
  e.postConversationChance = s.antics_post_conversation_chance / 100;
  e.sleepySinkChance = s.antics_sleepy_sink_chance / 100;
  e.quietAtBedtime = s.antics_quiet_at_bedtime;
  return e.validated();
}

/** `playfulness.idleGames`. */
export function idleGameSettings(s: Settings, base: IdleGameSettings): IdleGameSettings {
  const g = base.copy();
  g.enabled = s.idle_games;
  g.frequency = s.idle_games_frequency;
  g.intensity = s.idle_games_intensity;
  g.timingScale = s.idle_games_timing;
  for (const k of IDLE_GAMES) {
    g.setGame(camel(k) as never, { enabled: s[`game_${k}`], weight: s[`game_${k}_weight`], cooldown: s[`game_${k}_cooldown`] });
  }
  return g.validated();
}

/** `playfulness.pupilReactions`; `reduceMotion` comes from the system. */
export function pupilReactionSettings(s: Settings, base: PupilReactionSettings, reduceMotion: boolean): PupilReactionSettings {
  const p = base.copy();
  p.enabled = s.pupil_reactions;
  p.intensity = s.pupil_intensity / 100;
  p.minConfidence = s.pupil_min_confidence / 100;
  p.globalCooldown = s.pupil_pause;
  p.repeatWindow = s.pupil_repeat_window;
  p.moodAccent = s.pupil_mood_accent;
  for (const k of PUPIL_SHAPES) p[k] = { enabled: s[`pupil_${k}`], hold: s[`pupil_${k}_hold`], cooldown: s[`pupil_${k}_cooldown`] };
  p.reduceMotion = reduceMotion;
  return p.validated();
}

const backgroundModes: Record<Settings['mood_background'], MoodBackgroundMode> = { 'Black': 'black', 'Mood': 'mood', 'Fixed colour': 'fixed' };

/** Swift `SettingsApplier.moodBackground`: `readabilityGap` and `scleraLightness` stay what the device side set. */
export function moodBackground(s: Settings, reduceMotion: boolean, base: MoodBackgroundConfig): MoodBackgroundConfig {
  const c = base.copy();
  c.mode = backgroundModes[s.mood_background];
  c.strength = s.mood_background_strength / 100;
  // The default hex is the engine's linear default rounded to 8 bits: keep the exact default for it.
  c.fixedColor = s.mood_background_colour === SETTING_DEFAULTS.mood_background_colour
    ? { x: 0.02, y: 0.05, z: 0.12 } : hexToLinear(s.mood_background_colour);
  c.speed = s.mood_background_speed;
  c.colourAtBedtime = s.mood_background_at_bedtime;
  c.colourBursts = s.colour_bursts;
  c.burstStrength = s.burst_strength / 100;
  c.reduceMotion = reduceMotion;
  return c.validated();
}

/** Swift `SettingsApplier.listeningGlow`: `motion` stays the governor's. */
export function listeningGlow(s: Settings, reduceMotion: boolean, base: ListeningGlowConfig): ListeningGlowConfig {
  const c = base.copy();
  c.enabled = s.listening_glow;
  c.reduceMotion = reduceMotion;
  return c.validated();
}

/** `SettingsApplier.engine`: edge antics, idle games, pupil reactions, brow intensity, mood background, listening
 *  glow. Writes only what changed. */
export function applyEngine(engine: FaceEngine, s: Settings, reduceMotion: boolean): void {
  const edge = edgeAnticSettings(s, engine.edgeAnticSettings);
  if (!edge.equals(engine.edgeAnticSettings)) engine.edgeAnticSettings = edge;
  const games = idleGameSettings(s, engine.idleGameSettings);
  if (!games.equals(engine.idleGameSettings)) engine.idleGameSettings = games;
  const pupils = pupilReactionSettings(s, engine.pupilReactionSettings, reduceMotion);
  if (!pupils.equals(engine.pupilReactionSettings)) engine.pupilReactionSettings = pupils;
  if (engine.browIntensity !== s.brow_intensity) engine.browIntensity = s.brow_intensity;
  const bg = moodBackground(s, reduceMotion, engine.moodBackground);
  if (!bg.equals(engine.moodBackground)) engine.moodBackground = bg;
  const glow = listeningGlow(s, reduceMotion, engine.listeningGlow);
  if (!glow.equals(engine.listeningGlow)) engine.listeningGlow = glow;
}

/** The emotion layer's tunables (tolerant: unreadable keys keep their defaults). */
export const emotionSettings = (s: Settings): EmotionSettings => EmotionSettings.fromJSON(s.emotion_tunables).validated();

/** The perception tunables (tolerant). */
export const perceptionSettings = (s: Settings): PerceptionSettings => PerceptionSettings.decode(s.perception_tunables).validated();

/** The listening tunables (numbers only; the detector clamps them). */
export function turnTunables(s: Settings): TurnTunables {
  const d = makeTurnTunables() as unknown as Record<string, number>;
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.turn_tunables)) if (k in d && typeof v === 'number' && Number.isFinite(v)) o[k] = v;
  return makeTurnTunables(o as Partial<TurnTunables>);
}

/** MyApp `applyConversationSettings`: what the conversation needs from the settings, over its current value. */
export function conversationSettings(s: Settings, base: ConversationSettings): ConversationSettings {
  return { ...base, voiceVolume: s.voice_volume / 100, quietMode: s.quiet_mode, soundsOff: !s.sounds,
    thinkingTimeout: s.thinking_timeout_seconds, showCaptions: s.show_captions, listenOnEyeContact: s.listen_on_eye_contact };
}

const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

/** VoiceServicesModel `endpoint`: the agent, pipeline, decision model, AI Task, language and reply voice over the
 *  transport's endpoint (its Home Assistant part is the add-on relay and stays as it is). */
export function voiceServicesEndpoint(s: Settings, base: VoiceServicesEndpoint): VoiceServicesEndpoint {
  const pipelineID = orNull(s.pipeline_id);
  const language = orNull(s.asr_language);
  return { ...base,
    asr: { kind: 'homeAssistant', pipelineID, language },
    tts: base.tts === null ? null : { kind: 'homeAssistant', pipelineID },
    agent: { ...base.agent, agentID: orNull(s.conversation_agent_id), pipelineID, jevConfigEntry: orNull(s.jev_config_entry_id),
      aiTaskEntityID: orNull(s.ai_task_entity_id), language },
    replyVoice: s.reply_voice === 'Yanni' ? 'yanni' : 'spoken' };
}

/** ExpressiveWiring: the owner's switch and reaction budget. */
export const expressiveBudget = (s: Settings, base: ExpressiveBudget): ExpressiveBudget =>
  ({ ...base, enabled: s.expressive_reactions, perHour: s.reaction_budget_per_hour });

/** The kiosk's settings (KioskSettings: self-restart armed only with a verified reload, the OLED budget). */
export interface KioskSlice {
  restartVerified: boolean;
  selfRestartOnHang: boolean;
  maintenanceRestart: boolean;
  hangRestartArmed: boolean;
  maintenanceRestartArmed: boolean;
  /** 0.05…0.30 of full brightness. */
  oledBackgroundBudget: number;
  /** null = the device table. */
  displayOverride: 'oled' | 'lcd' | 'miniLED' | null;
}

export function kioskSlice(s: Settings): KioskSlice {
  return { restartVerified: s.restart_verified, selfRestartOnHang: s.self_restart_on_hang,
    maintenanceRestart: s.maintenance_restart, hangRestartArmed: s.restart_verified && s.self_restart_on_hang,
    maintenanceRestartArmed: s.restart_verified && s.maintenance_restart, oledBackgroundBudget: s.oled_background_budget / 100,
    displayOverride: s.display_kind === 'auto' ? null : s.display_kind };
}

/** What a state report may carry (HomeAssistantBridge): the mood sentence only while `send_mood_note` is on, presence
 *  only while `share_presence` is on. A copy. */
export function filterReport(s: Settings, state: Partial<DisplayState>): Partial<DisplayState> {
  const out = { ...state };
  if (!s.send_mood_note && out.conversation_context !== undefined) out.conversation_context = 'none';
  if (!s.share_presence) { delete out.person_present; delete out.people_count; }
  return out;
}

// ---- Wiring ----

export interface AttachOptions {
  /** Reduce Motion (default: the system's `prefers-reduced-motion`). */
  reduceMotion?: () => boolean;
  /** Subscribe to Reduce Motion changes (default: the media query); every applier re-runs. */
  onReduceMotionChange?: (fn: () => void) => void;
  /** The expressive bridge (default: `ctx.expressive`). */
  expressive?: () => { budget: ExpressiveBudget } | null;
  /** The babble clock the controller uses in Yanni's own voice (`replyClock`); null keeps the audio's. */
  replyClock?: () => ReplyClock | null;
  /** The listening pop (`conversation.listenCue`) while `listening_sound` is on. */
  listenCueURL?: string | null;
  /** The style the renderer gets, from the composed one (the kiosk's OLED budget, `KioskApply.style`). */
  styleTransform?: (style: RenderStyle, s: Settings) => RenderStyle;
  /** The kiosk's slice changed (or attach / refresh). */
  onKiosk?: (k: KioskSlice) => void;
}

export interface SettingsAttachment {
  /** Re-applies everything, forced: call after a context field (voice, emotion, conversation, perception) is set. */
  refresh(): void;
  /** Removes the appliers and hooks. */
  detach(): void;
}

/** Registers the appliers on `hub` and applies everything once. `ctx` fields are read at apply time, so subsystems
 *  that are still null are skipped and get their slice on `refresh()` (or, unforced, on the next change that
 *  touches it once they exist: each applier also re-pushes when it sees a new subsystem object). Force wake clearing
 *  the bedtime switch folds back into the hub (origin `system`, never echoed to the controller). */
export function attachSettings(hub: SettingsHub, ctx: AppContext, opts: AttachOptions = {}): SettingsAttachment {
  const reduce = opts.reduceMotion ?? (() => motion.reduce);
  /** Per applier: the subsystem object it last pushed to (a new object gets everything). */
  const seen = new Map<string, unknown>();
  const fresh = (name: string, obj: unknown): boolean => {
    const was = seen.get(name) !== obj;
    seen.set(name, obj);
    return was;
  };
  const changed = (old: Settings, next: Settings, keys: readonly (keyof Settings)[]) => keys.some((k) => !same(old[k], next[k]));
  let lastStyle: RenderStyle | null = null;
  let lastKiosk = '';
  // The cue the app installed (unless given): remembered so Listening sound can turn it back on.
  let cueURL = opts.listenCueURL ?? null;

  const appliers: SettingsApplier[] = [
    { name: 'life', apply(_o, s) {
      const l = lifeSettings(s);
      if (!ctx.life.settings.equals(l)) ctx.life.settings = l;
    } },
    { name: 'voice', apply(_o, s) {
      const v = ctx.voice;
      if (!v) return;
      const vs = voiceSettings(s);
      if (!v.settings.equals(vs)) v.settings = vs;
    } },
    { name: 'engine', apply(_o, s) { applyEngine(ctx.engine, s, reduce()); } },
    { name: 'emotion', apply(o, s, _origin, force) {
      const e = ctx.emotion;
      if (!e) return;
      const isNew = fresh('emotion', e);
      if (e.personality !== s.personality) e.personality = s.personality;
      if (force || isNew || !same(o.emotion_tunables, s.emotion_tunables)) {
        const es = emotionSettings(s);
        if (!e.settings.equals(es)) e.settings = es;
      }
      const yanni = s.reply_voice === 'Yanni';
      if (e.stanceNeedsClaim !== yanni) e.stanceNeedsClaim = yanni;
    } },
    { name: 'style', apply(_o, s) {
      const composed = StyleComposer.compose(s);
      const st = opts.styleTransform ? opts.styleTransform(composed, s) : composed;
      if (lastStyle && sameStyle(lastStyle, st)) return;
      lastStyle = st;
      ctx.setStyle(st);
    } },
    { name: 'conversation', apply(o, s, _origin, force) {
      const c = ctx.conversation;
      if (!c) return;
      const isNew = fresh('conversation', c);
      if (cueURL === null && opts.listenCueURL === undefined) cueURL = c.listenCue;
      const cs = conversationSettings(s, c.settings);
      if (!conversationSettingsEqual(c.settings, cs)) c.settings = cs;
      if (cueURL !== null) {
        const cue = s.listening_sound ? cueURL : null;
        if (c.listenCue !== cue) c.listenCue = cue;
      }
      if (opts.replyClock) {
        const clock = s.reply_voice === 'Yanni' ? opts.replyClock() : null;
        if (c.replyClock !== clock) c.replyClock = clock;
      }
      if (c.endpoint !== null) {
        const ep = voiceServicesEndpoint(s, c.endpoint);
        if (!voiceServicesEndpointEqual(c.endpoint, ep)) c.endpoint = ep;
      }
      if (c.turn && (force || isNew || fresh('turn', c.turn) || changed(o, s, ['turn_tunables']))) c.turn.setTunables(turnTunables(s));
    } },
    { name: 'perception', apply(o, s, _origin, force) {
      const p = ctx.perception;
      if (!p) return;
      if (fresh('perception', p) || force || changed(o, s, ['perception_tunables'])) p.setSettings(perceptionSettings(s));
    } },
    { name: 'expressive', apply(_o, s) {
      const x = opts.expressive ? opts.expressive() : (ctx.expressive ?? null);
      if (!x) return;
      const b = expressiveBudget(s, x.budget);
      if (!same(b, x.budget)) x.budget = b;
    } },
    { name: 'kiosk', apply(_o, s) {
      if (!opts.onKiosk) return;
      const k = kioskSlice(s);
      const key = JSON.stringify(k);
      if (key === lastKiosk) return;
      lastKiosk = key;
      opts.onKiosk(k);
    } },
  ];
  hub.appliers.push(...appliers);
  hub.applyAll();

  const previousLifeHook = ctx.life.onSettingsChange;
  ctx.life.onSettingsChange = (l) => {
    previousLifeHook?.(l);
    if (hub.settings.bedtime !== l.manualBedtime) hub.update('system', { bedtime: l.manualBedtime });
  };
  let attached = true;
  (opts.onReduceMotionChange ?? ((fn) => motion.onChange(fn)))(() => { if (attached) hub.applyAll(); });

  return {
    refresh: () => { if (attached) hub.applyAll(); },
    detach: () => {
      attached = false;
      hub.appliers = hub.appliers.filter((a) => !appliers.includes(a));
      ctx.life.onSettingsChange = previousLifeHook;
    },
  };
}
