// The synced settings → the face, and the face's live values → the add-on. The face's slices of the Swift hub
// appliers (YanniSettings/SettingsAppliers.swift: `.life`, `.engine`, `.style` through StyleComposer) over the
// HomeEntities field mapping (YanniHome/HomeEntities.swift). A key that was never synced takes the Swift default.
// Voice, conversation, emotion and perception keys (sounds, volumes, quiet mode, reply voice, listen on eye contact,
// expressive reactions, room understanding, share presence) are left to those subsystems.
import type { DisplayState, EntitySettings } from '@yanni/server/protocol';
import type { FaceEngine } from '../engine/FaceEngine';
import type { MoodBackgroundMode } from '../engine/MoodBackground';
import type { LifeCycleController } from '../life/LifeCycleController';
import { LifeSettings } from '../life/LifeSettings';
import { RenderStyle } from '../render/RenderStyle';

type S = Partial<EntitySettings>;

/** StyleComposer's colour-background vignette (`MoodBackgroundSettings.vignette` default, `colourVignetteInner`). */
const colourVignette = 0.15, colourVignetteInner = 0.45;
const backgroundModes: Record<EntitySettings['mood_background'], MoodBackgroundMode> = {
  'Black': 'black', 'Mood': 'mood', 'Fixed colour': 'fixed',
};

/** `life` slice: `base` keeps the fields Home Assistant doesn't carry (mood drift, takeover). */
export function lifeSettings(s: S, base: LifeSettings): LifeSettings {
  const d = new LifeSettings();
  return base.with({
    manualBedtime: s.bedtime ?? d.manualBedtime,
    bedtimeEnabled: s.bedtime_schedule ?? d.bedtimeEnabled,
    bedtimeStart: s.bedtime_start ?? d.bedtimeStart,
    bedtimeEnd: s.bedtime_end ?? d.bedtimeEnd,
    minutesToDrowsy: s.minutes_to_drowsy ?? d.minutesToDrowsy,
    minutesToAsleep: s.minutes_to_asleep ?? d.minutesToAsleep,
    bedtimeAwakeMinutes: s.bedtime_awake_minutes ?? d.bedtimeAwakeMinutes,
    tapsToWake: s.taps_to_wake ?? d.tapsToWake,
    wakeOnMotionAtBedtime: s.wake_on_motion_at_bedtime ?? d.wakeOnMotionAtBedtime,
  });
}

/** `SettingsApplier.engine`: edge antics, pupil reactions, mood background, listening glow; Reduce Motion from the
 *  system. Fields Home Assistant doesn't carry keep the engine's current value. */
export function applyEngineSettings(engine: FaceEngine, s: S, reduceMotion: boolean): void {
  const edge = engine.edgeAnticSettings;
  edge.enabled = s.screen_antics ?? true;
  engine.edgeAnticSettings = edge;
  const pupils = engine.pupilReactionSettings;
  pupils.enabled = s.pupil_reactions ?? true;
  pupils.reduceMotion = reduceMotion;
  engine.pupilReactionSettings = pupils;
  const bg = engine.moodBackground;
  bg.mode = backgroundModes[s.mood_background ?? 'Black'];
  bg.colourAtBedtime = s.mood_background_at_bedtime ?? false;
  bg.reduceMotion = reduceMotion;
  engine.moodBackground = bg;
  const glow = engine.listeningGlow;
  glow.enabled = s.listening_glow ?? true;
  glow.reduceMotion = reduceMotion;
  engine.listeningGlow = glow;
}

/** `StyleComposer.compose` for the owner fields Home Assistant carries, over the developer style `base`. */
export function composeStyle(s: S, base: RenderStyle): RenderStyle {
  const st = RenderStyle.clone(base);
  st.moodColorAmount = (s.mood_colour ?? true) ? (s.mood_colour_strength ?? 100) / 100 : 0;
  st.browsEnabled = s.eyebrows ?? true;
  if ((s.mood_background ?? 'Black') !== 'Black') {
    st.backgroundVignette = colourVignette;
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
