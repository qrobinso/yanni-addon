// The synced settings → the face, and the face's live values → the add-on. The face's slices of the Swift hub
// appliers (YanniSettings/SettingsAppliers.swift: `.life`, `.engine`, `.style` through StyleComposer) over the
// HomeEntities field mapping (YanniHome/HomeEntities.swift). A key that was never synced takes the schema default
// (`@yanni/server/settings`, the Swift defaults). Voice, conversation, emotion and perception keys (sounds, volumes,
// quiet mode, reply voice, listen on eye contact, captions, personality, expressive reactions, room understanding,
// share presence, the pipeline and agent ids) are left to those subsystems.
import type { DisplayState, EntitySettings } from '@yanni/server/protocol';
import { IDLE_GAMES, PUPIL_SHAPES, SETTING_DEFAULTS } from '@yanni/server/settings';
import type { FaceEngine } from '../engine/FaceEngine';
import type { MoodBackgroundMode } from '../engine/MoodBackground';
import type { LifeCycleController } from '../life/LifeCycleController';
import { LifeSettings } from '../life/LifeSettings';
import { makeRenderStyle, RenderStyle } from '../render/RenderStyle';

type S = Partial<EntitySettings>;
/** The synced value, else the default. */
const val = <K extends keyof EntitySettings>(s: S, k: K): EntitySettings[K] => (s[k] ?? SETTING_DEFAULTS[k]) as EntitySettings[K];
const camel = (k: string) => k.replace(/_(.)/g, (_, c: string) => c.toUpperCase());

/** StyleComposer's `colourVignetteInner`. */
const colourVignetteInner = 0.45;
const backgroundModes: Record<EntitySettings['mood_background'], MoodBackgroundMode> = {
  'Black': 'black', 'Mood': 'mood', 'Fixed colour': 'fixed',
};

/** `life` slice: `base` keeps the fields Home Assistant doesn't carry (mood drift, takeover). */
export function lifeSettings(s: S, base: LifeSettings): LifeSettings {
  return base.with({
    manualBedtime: val(s, 'bedtime'),
    bedtimeEnabled: val(s, 'bedtime_schedule'),
    bedtimeStart: val(s, 'bedtime_start'),
    bedtimeEnd: val(s, 'bedtime_end'),
    minutesToDrowsy: val(s, 'minutes_to_drowsy'),
    minutesToAsleep: val(s, 'minutes_to_asleep'),
    bedtimeAwakeMinutes: val(s, 'bedtime_awake_minutes'),
    tapsToWake: val(s, 'taps_to_wake'),
    wakeOnMotionAtBedtime: val(s, 'wake_on_motion_at_bedtime'),
    // Not a Home Assistant entity: only an owner-page value overrides the display's own.
    ...(s.idle_mood_drift !== undefined ? { idleMoodDrift: s.idle_mood_drift } : {}),
  });
}

/** `SettingsApplier.engine`: edge antics, idle games, pupil reactions, brow intensity, mood background, listening
 *  glow; Reduce Motion from the system. Fields the settings don't carry keep the engine's current value. */
export function applyEngineSettings(engine: FaceEngine, s: S, reduceMotion: boolean): void {
  const edge = engine.edgeAnticSettings;
  edge.enabled = val(s, 'screen_antics');
  edge.frequency = val(s, 'antics_frequency');
  engine.edgeAnticSettings = edge;
  const games = engine.idleGameSettings;
  games.enabled = val(s, 'idle_games');
  games.frequency = val(s, 'idle_games_frequency');
  games.intensity = val(s, 'idle_games_intensity');
  games.timingScale = val(s, 'idle_games_timing');
  for (const g of IDLE_GAMES) {
    (games as unknown as Record<string, unknown>)[camel(g)] = { enabled: val(s, `game_${g}`), weight: val(s, `game_${g}_weight`),
      cooldown: val(s, `game_${g}_cooldown`) };
  }
  engine.idleGameSettings = games;
  const pupils = engine.pupilReactionSettings;
  pupils.enabled = val(s, 'pupil_reactions');
  pupils.intensity = val(s, 'pupil_intensity') / 100;
  pupils.minConfidence = val(s, 'pupil_min_confidence') / 100;
  pupils.globalCooldown = val(s, 'pupil_pause');
  pupils.repeatWindow = val(s, 'pupil_repeat_window');
  pupils.moodAccent = val(s, 'pupil_mood_accent');
  for (const k of PUPIL_SHAPES) {
    pupils[k] = { enabled: val(s, `pupil_${k}`), hold: val(s, `pupil_${k}_hold`), cooldown: val(s, `pupil_${k}_cooldown`) };
  }
  pupils.reduceMotion = reduceMotion;
  engine.pupilReactionSettings = pupils;
  engine.browIntensity = val(s, 'brow_intensity');
  const bg = engine.moodBackground;
  bg.mode = backgroundModes[val(s, 'mood_background')];
  bg.strength = val(s, 'mood_background_strength') / 100;
  bg.speed = val(s, 'mood_background_speed');
  bg.colourBursts = val(s, 'colour_bursts');
  bg.burstStrength = val(s, 'burst_strength') / 100;
  // Only a chosen colour overrides (the default hex is the engine's linear default, rounded).
  if (s.mood_background_colour) bg.fixedColor = RenderStyle.linear(parseInt(s.mood_background_colour.slice(1), 16));
  bg.colourAtBedtime = val(s, 'mood_background_at_bedtime');
  bg.reduceMotion = reduceMotion;
  engine.moodBackground = bg;
  const glow = engine.listeningGlow;
  glow.enabled = val(s, 'listening_glow');
  glow.reduceMotion = reduceMotion;
  engine.listeningGlow = glow;
}

const rimOf = (st: RenderStyle) => [st.rimColor.x, st.rimColor.y, st.rimColor.z, st.rimWidth, st.inkWidth].join();

/** `StyleComposer.compose` for the owner fields, over the developer style `base` (its rim yields to the preset
 *  unless the developer changed it). */
export function composeStyle(s: S, base: RenderStyle): RenderStyle {
  const st = RenderStyle.clone(base);
  if (val(s, 'theme_preset') === 'sticker' && rimOf(st) === rimOf(makeRenderStyle())) {
    const p = RenderStyle.ivoryRim;
    st.rimColor = { ...p.rimColor };
    st.rimWidth = p.rimWidth;
    st.inkWidth = p.inkWidth;
  }
  st.moodColorAmount = val(s, 'mood_colour') ? val(s, 'mood_colour_strength') / 100 : 0;
  st.shapeMoodAccent = val(s, 'pupil_mood_accent');
  st.browsEnabled = val(s, 'eyebrows');
  st.browInk = val(s, 'ink_brows');
  if (val(s, 'mood_background') !== 'Black') {
    st.backgroundVignette = val(s, 'mood_background_vignette') / 100;
    st.backgroundVignetteInner = colourVignetteInner;
  }
  return st;
}

const snake = (v: string): string => v.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The face's sensors (`HomeSignals`: face state, life phase, bedtime). */
export function faceReport(engine: FaceEngine, life: LifeCycleController):
  Pick<DisplayState, 'face_state' | 'life_phase' | 'bedtime_active'> {
  return {
    face_state: snake(engine.state.agentState) as DisplayState['face_state'],
    life_phase: snake(life.phase) as DisplayState['life_phase'],
    bedtime_active: life.isBedtime,
  };
}

/** The keys of `next` whose values differ from `prev` (what a state report sends). */
export function changed<T extends object>(prev: Partial<T>, next: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as (keyof T)[]) if (prev[k] !== next[k]) out[k] = next[k];
  return out;
}
