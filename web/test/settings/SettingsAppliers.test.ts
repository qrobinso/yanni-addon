// The appliers (SettingsAppliers.swift and the app's wiring): each subsystem gets its slice, only when it changed,
// subsystems that arrive late get theirs on refresh, and force wake folds the bedtime switch back into the hub.
import { describe, expect, test } from 'vitest';
import type { Settings } from '@yanni/server/settings';
import type { AppContext } from '../../src/app/AppContext';
import { makeConversationSettings, type ConversationSettings } from '../../src/conversation/core/ConversationSettings';
import { makeExpressiveBudget } from '../../src/conversation/core/ExpressiveDecisions';
import { makeVoiceServicesEndpoint, type VoiceServicesEndpoint } from '../../src/conversation/core/VoiceServicesEndpoint';
import type { TurnTunables } from '../../src/conversation/turn/TurnTunables';
import { EmotionLayer } from '../../src/emotion/EmotionLayer';
import { FaceEngine } from '../../src/engine/FaceEngine';
import { LifeCycleController } from '../../src/life/LifeCycleController';
import type { PerceptionSettings } from '../../src/perception/PerceptionSettings';
import { makeRenderStyle, type RenderStyle } from '../../src/render/RenderStyle';
import { VoiceDirector } from '../../src/voice/bridge/VoiceDirector';
import { VoiceRenderer } from '../../src/voice/dsp/VoiceRenderer';
import { attachSettings, filterReport, kioskSlice, memoryHub, settingsFrom, type KioskSlice } from '../../src/settings';

function fakeConversation() {
  const turns: TurnTunables[] = [];
  return {
    settings: makeConversationSettings() as ConversationSettings,
    listenCue: 'listen-pop.wav' as string | null,
    replyClock: null as unknown,
    endpoint: null as VoiceServicesEndpoint | null,
    isSuppressed: false,
    turn: { setTunables: (t: TurnTunables) => turns.push(t) },
    turns,
  };
}

function rig(initial: Partial<Settings> = {}) {
  const engine = new FaceEngine();
  const life = new LifeCycleController(engine);
  const styles: RenderStyle[] = [];
  const ctx = {
    engine, life, voice: null, emotion: null, conversation: null, perception: null, client: null,
    style: () => styles.at(-1) ?? makeRenderStyle(),
    setStyle: (s: RenderStyle) => styles.push(s),
    logEvent: () => {}, now: () => 0,
  } as unknown as AppContext & { voice: VoiceDirector | null; emotion: EmotionLayer | null };
  const hub = memoryHub(initial);
  let reduce = false;
  let reduceChanged: () => void = () => {};
  const kiosk: KioskSlice[] = [];
  const expressive = { budget: makeExpressiveBudget() };
  const a = attachSettings(hub, ctx, { reduceMotion: () => reduce, onReduceMotionChange: (fn) => { reduceChanged = fn; },
    onKiosk: (k) => kiosk.push(k), expressive: () => expressive });
  return { engine, life, ctx, hub, styles, kiosk, expressive, a,
    setReduce(v: boolean) { reduce = v; reduceChanged(); } };
}

describe('attachSettings', () => {
  test('a fresh install applies the Swift defaults everywhere', () => {
    const r = rig();
    expect(r.life.settings.equals(settingsFromLife())).toBe(true);
    expect(r.engine.edgeAnticSettings.equals(new FaceEngine().edgeAnticSettings)).toBe(true);
    expect(r.engine.idleGameSettings.equals(new FaceEngine().idleGameSettings)).toBe(true);
    expect(r.engine.pupilReactionSettings.equals(new FaceEngine().pupilReactionSettings)).toBe(true);
    expect(r.engine.moodBackground.equals(new FaceEngine().moodBackground)).toBe(true);
    expect(r.styles).toHaveLength(1);
    expect(r.styles[0]).toMatchObject({ browsEnabled: true, moodColorAmount: 1, backgroundVignette: makeRenderStyle().backgroundVignette });
    expect(r.kiosk).toEqual([{ restartVerified: false, selfRestartOnHang: false, maintenanceRestart: false, hangRestartArmed: false,
      maintenanceRestartArmed: false, oledBackgroundBudget: 0.15, displayOverride: null }]);
    expect(r.expressive.budget).toEqual(makeExpressiveBudget());
  });

  test('life: every field, and force wake folds the bedtime switch back in (origin system)', () => {
    const r = rig();
    r.hub.update('homeassistant', { bedtime: true, bedtime_start: 1380, taps_to_wake: 2, idle_mood_drift: false, alone_takeover_minutes: 5 });
    const l = r.life.settings;
    expect([l.manualBedtime, l.bedtimeStart, l.tapsToWake, l.idleMoodDrift, l.aloneTakeoverMinutes]).toEqual([true, 1380, 2, false, 5]);
    r.life.forceWake();
    expect(r.hub.settings.bedtime).toBe(false);
    expect(r.hub.lastOrigin).toBe('system');
  });

  test('engine: antics per antic, games per game, pupils per shape, background, glow, brows; Reduce Motion re-applies', () => {
    const r = rig();
    r.hub.update('app', { antics_travel: 1.4, antic_pop_up: false, antic_curious_lean_weight: 2, antics_greeting_chance: 80,
      antics_quiet_at_bedtime: false, game_hula_hoop_weight: 2.5, pupil_heart_hold: 0.8, pupil_intensity: 50,
      mood_background: 'Fixed colour', mood_background_colour: '#ff0000', brow_intensity: 0.5, listening_glow: false });
    const e = r.engine.edgeAnticSettings;
    expect([e.travel, e.popUp.enabled, e.curiousLean.weight, e.greetingChance, e.quietAtBedtime]).toEqual([1.4, false, 2, 0.8, false]);
    expect(r.engine.idleGameSettings.hulaHoop.weight).toBe(2.5);
    expect(r.engine.pupilReactionSettings).toMatchObject({ intensity: 0.5, heart: { hold: 0.8 }, reduceMotion: false });
    expect(r.engine.moodBackground).toMatchObject({ mode: 'fixed', fixedColor: { x: 1, y: 0, z: 0 } });
    expect(r.engine.browIntensity).toBe(0.5);
    expect(r.engine.listeningGlow.enabled).toBe(false);
    r.setReduce(true);
    expect(r.engine.pupilReactionSettings.reduceMotion).toBe(true);
    expect(r.engine.moodBackground.reduceMotion).toBe(true);
    expect(r.engine.listeningGlow.reduceMotion).toBe(true);
  });

  test('style: pushed only when the composed style changes', () => {
    const r = rig();
    r.hub.update('app', { chirp_volume: 10 });
    expect(r.styles).toHaveLength(1);
    r.hub.update('app', { eyebrows: false, custom_crescent_colour: '#ff0000', theme_preset: 'sticker' });
    expect(r.styles).toHaveLength(2);
    expect(r.styles[1]).toMatchObject({ browsEnabled: false, crescentColor: { x: 1, y: 0, z: 0 }, rimWidth: 0.35, inkWidth: 1.3 });
  });

  test('voice, emotion, conversation, perception attached late: skipped, then applied on refresh and on change', () => {
    const r = rig({ sounds: false, chirp_volume: 40, personality: 'shy', reply_voice: 'Yanni', quiet_mode: true });
    const voice = new VoiceDirector(r.engine, new VoiceRenderer(48_000), null);
    const emotion = new EmotionLayer(r.engine);
    const conversation = fakeConversation();
    const perceptionSeen: PerceptionSettings[] = [];
    Object.assign(r.ctx, { voice, emotion, conversation, perception: { setSettings: (s: PerceptionSettings) => perceptionSeen.push(s) } });
    expect(voice.settings.muted).toBe(false);
    r.a.refresh();
    expect(voice.settings).toMatchObject({ muted: true, volume: 0.4, quietMode: true });
    expect(emotion.personality).toBe('shy');
    expect(emotion.stanceNeedsClaim).toBe(true);
    expect(conversation.settings).toMatchObject({ soundsOff: true, quietMode: true, voiceVolume: 0.8, thinkingTimeout: 8 });
    expect(conversation.turns).toHaveLength(1);
    expect(perceptionSeen).toHaveLength(1);

    r.hub.update('app', { listening_sound: false, thinking_timeout_seconds: 12, show_captions: false,
      emotion_tunables: { dynamics: { moodGain: 0.1 } }, perception_tunables: { maxPeople: 3, cameraOffWhenAsleepAtBedtime: true },
      turn_tunables: { vadThreshold: 0.7, bogus: 'x' } });
    expect(conversation.listenCue).toBeNull();
    expect(conversation.settings).toMatchObject({ thinkingTimeout: 12, showCaptions: false });
    expect(emotion.settings.dynamics.moodGain).toBe(0.1);
    expect(perceptionSeen.at(-1)).toMatchObject({ maxPeople: 3, cameraOffWhenAsleepAtBedtime: true });
    expect(conversation.turns.at(-1)!.vadThreshold).toBe(0.7);
    r.hub.update('app', { listening_sound: true });
    expect(conversation.listenCue).toBe('listen-pop.wav');
  });

  test('conversation endpoint: agent, pipeline, decision model, AI Task, language and reply voice once there is one', () => {
    const r = rig();
    const conversation = fakeConversation();
    Object.assign(r.ctx, { conversation });
    r.a.refresh();
    expect(conversation.endpoint).toBeNull(); // dormant stays dormant
    conversation.endpoint = makeVoiceServicesEndpoint();
    r.hub.update('owner', { pipeline_id: ' 01pipe ', conversation_agent_id: 'conversation.jev', jev_config_entry_id: '',
      ai_task_entity_id: 'ai_task.openai', asr_language: 'de', reply_voice: 'Yanni' });
    expect(conversation.endpoint).toMatchObject({
      asr: { kind: 'homeAssistant', pipelineID: '01pipe', language: 'de' },
      tts: { kind: 'homeAssistant', pipelineID: '01pipe' },
      agent: { agentID: 'conversation.jev', pipelineID: '01pipe', jevConfigEntry: null, aiTaskEntityID: 'ai_task.openai', language: 'de' },
      replyVoice: 'yanni',
    });
  });

  test('expressive budget, kiosk slice, report filter', () => {
    const r = rig();
    r.hub.update('app', { expressive_reactions: false, reaction_budget_per_hour: 120, restart_verified: true,
      self_restart_on_hang: true, oled_background_budget: 25, display_kind: 'lcd' });
    expect(r.expressive.budget).toMatchObject({ enabled: false, perHour: 120, dailyCap: 600 });
    expect(r.kiosk.at(-1)).toMatchObject({ hangRestartArmed: true, maintenanceRestartArmed: false, oledBackgroundBudget: 0.25, displayOverride: 'lcd' });
    expect(kioskSlice(settingsFrom({ self_restart_on_hang: true })).hangRestartArmed).toBe(false);
    const s = settingsFrom({ send_mood_note: false, share_presence: false });
    expect(filterReport(s, { conversation_context: 'feeling happy', person_present: true, people_count: 2, face_state: 'idle' }))
      .toEqual({ conversation_context: 'none', face_state: 'idle' });
  });

  test('detach removes the appliers and the life hook', () => {
    const r = rig();
    r.a.detach();
    r.hub.update('app', { taps_to_wake: 5 });
    expect(r.life.settings.tapsToWake).toBe(3);
    expect(r.hub.appliers).toHaveLength(0);
  });
});

function settingsFromLife() {
  return new LifeCycleController(new FaceEngine()).settings;
}
