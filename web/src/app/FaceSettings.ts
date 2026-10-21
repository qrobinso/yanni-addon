// The face's live values → the add-on (`HomeSignals`), and the older partial-settings entry points, now folded into
// web/src/settings (the hub and its appliers own applying settings; see docs/SETTINGS.md).
import type { DisplayState, EntitySettings } from '@yanni/server/protocol';
import type { FaceEngine } from '../engine/FaceEngine';
import type { LifeCycleController } from '../life/LifeCycleController';
import type { LifeSettings } from '../life/LifeSettings';
import type { RenderStyle } from '../render/RenderStyle';
import { applyEngine, lifeSettings as lifeSlice, settingsFrom, StyleComposer } from '../settings';

type S = Partial<EntitySettings>;

/** @deprecated Use `attachSettings`. The life slice of `s` (missing keys take the defaults). */
export function lifeSettings(s: S, _base?: LifeSettings): LifeSettings { return lifeSlice(settingsFrom(s)); }

/** @deprecated Use `attachSettings`. The engine slice of `s` (missing keys take the defaults). */
export function applyEngineSettings(engine: FaceEngine, s: S, reduceMotion: boolean): void {
  applyEngine(engine, settingsFrom(s), reduceMotion);
}

/** @deprecated Use `StyleComposer.compose`. The developer style comes from `tuning_style`. */
export function composeStyle(s: S, _base?: RenderStyle): RenderStyle { return StyleComposer.compose(settingsFrom(s)); }

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
