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

  test('owner-page values land on the engine and the style (games, pupil shapes, background, preset)', () => {
    const engine = new FaceEngine();
    applyEngineSettings(engine, { antics_frequency: 2, game_yo_yo: false, game_hula_hoop_weight: 2.5, pupil_heart: false,
      pupil_intensity: 50, mood_background_strength: 40, mood_background_colour: '#ff0000', brow_intensity: 0.5 }, false);
    expect(engine.edgeAnticSettings.frequency).toBe(2);
    expect(engine.idleGameSettings.yoYo.enabled).toBe(false);
    expect(engine.idleGameSettings.hulaHoop.weight).toBe(2.5);
    expect(engine.pupilReactionSettings.heart.enabled).toBe(false);
    expect(engine.pupilReactionSettings.intensity).toBe(0.5);
    expect(engine.moodBackground.strength).toBe(0.4);
    expect(engine.moodBackground.fixedColor).toEqual({ x: 1, y: 0, z: 0 });
    expect(engine.browIntensity).toBe(0.5);
    const st = composeStyle({ theme_preset: 'sticker', ink_brows: true, mood_background: 'Mood', mood_background_vignette: 30 }, makeRenderStyle());
    expect([st.rimWidth, st.inkWidth, st.browInk, st.backgroundVignette]).toEqual([0.35, 1.3, true, 0.3]);
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

describe('RenderReport', () => {
  test('fps over the sample interval, the tier p99 rounded, the tier name', async () => {
    const { RenderReport } = await import('../../src/app/StatusReport');
    let t = 0;
    const clock = { ticks: 0, policy: { tier: 60 }, stats: { peek: () => ({ tier: () => ({ gapP99: 0.01834 }) }) } };
    const r = new RenderReport(clock as never, () => t);
    clock.ticks = 299; t = 5;
    expect(r.sample()).toEqual({ fps: 60, frame_gap_p99_ms: 18.3, render_tier: 'awake' });
  });
});
