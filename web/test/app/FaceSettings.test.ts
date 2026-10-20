import { describe, expect, test } from 'vitest';
import { applyEngineSettings, changed, composeStyle, faceReport, lifeSettings } from '../../src/app/FaceSettings';
import { FaceEngine } from '../../src/engine/FaceEngine';
import { LifeCycleController } from '../../src/life/LifeCycleController';
import { LifeSettings } from '../../src/life/LifeSettings';
import { makeRenderStyle } from '../../src/render/RenderStyle';

describe('FaceSettings', () => {
  test('nothing synced yet: the Swift defaults (eyebrows on, mood colour full, black background)', () => {
    expect(lifeSettings({}, new LifeSettings()).equals(new LifeSettings())).toBe(true);
    const st = composeStyle({}, makeRenderStyle());
    expect(st.browsEnabled).toBe(true);
    expect(st.moodColorAmount).toBe(1);
    expect(st.backgroundVignette).toBe(makeRenderStyle().backgroundVignette);
  });

  test('Home Assistant values land on life, engine and style', () => {
    const base = new LifeSettings({ idleMoodDrift: false });
    const l = lifeSettings({ bedtime: true, bedtime_schedule: true, bedtime_start: 1380, minutes_to_drowsy: 0.5,
      taps_to_wake: 2 }, base);
    expect([l.manualBedtime, l.bedtimeEnabled, l.bedtimeStart, l.minutesToDrowsy, l.tapsToWake, l.idleMoodDrift])
      .toEqual([true, true, 1380, 0.5, 2, false]);

    const engine = new FaceEngine();
    applyEngineSettings(engine, { screen_antics: false, pupil_reactions: false, mood_background: 'Fixed colour',
      mood_background_at_bedtime: true, listening_glow: false }, true);
    expect(engine.edgeAnticSettings.enabled).toBe(false);
    expect(engine.pupilReactionSettings).toMatchObject({ enabled: false, reduceMotion: true });
    expect(engine.moodBackground).toMatchObject({ mode: 'fixed', colourAtBedtime: true, reduceMotion: true });
    expect(engine.listeningGlow).toMatchObject({ enabled: false, reduceMotion: true });

    const st = composeStyle({ eyebrows: false, mood_colour_strength: 40, mood_background: 'Mood' }, makeRenderStyle());
    expect([st.browsEnabled, st.moodColorAmount, st.backgroundVignette, st.backgroundVignetteInner]).toEqual([false, 0.4, 0.15, 0.45]);
    expect(composeStyle({ mood_colour: false }, makeRenderStyle()).moodColorAmount).toBe(0);
  });

  test('reports snake-case states and only what changed', () => {
    const engine = new FaceEngine();
    const life = new LifeCycleController(engine);
    engine.setAgentState('halfAwake');
    engine.tick(1 / 60);
    const r = faceReport(engine, life);
    expect(r).toEqual({ face_state: 'half_awake', life_phase: 'half_awake', bedtime_active: false });
    expect(changed({ face_state: 'half_awake', life_phase: 'awake' }, r)).toEqual({ life_phase: 'half_awake', bedtime_active: false });
  });
});
