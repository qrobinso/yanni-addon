import { describe, expect, test } from 'vitest';
import { applyEngineSettings, changed, composeStyle, faceReport, lifeSettings } from '../../src/app/FaceSettings';
import { FaceEngine } from '../../src/engine/FaceEngine';
import { LifeCycleController } from '../../src/life/LifeCycleController';
import { LifeSettings } from '../../src/life/LifeSettings';
import { makeRenderStyle } from '../../src/render/RenderStyle';

describe('FaceSettings (partial values: missing keys take the schema defaults)', () => {
  test('nothing synced yet: the Swift defaults (eyebrows on, mood colour full, black background)', () => {
    expect(lifeSettings({}).equals(new LifeSettings())).toBe(true);
    const st = composeStyle({});
    expect(st.browsEnabled).toBe(true);
    expect(st.moodColorAmount).toBe(1);
    expect(st.backgroundVignette).toBe(makeRenderStyle().backgroundVignette);
  });

  test('Home Assistant values land on life, engine and style', () => {
    const l = lifeSettings({ bedtime: true, bedtime_schedule: true, bedtime_start: 1380, minutes_to_drowsy: 0.5, taps_to_wake: 2,
      idle_mood_drift: false });
    expect([l.manualBedtime, l.bedtimeEnabled, l.bedtimeStart, l.minutesToDrowsy, l.tapsToWake, l.idleMoodDrift])
      .toEqual([true, true, 1380, 0.5, 2, false]);
    const engine = new FaceEngine();
    applyEngineSettings(engine, { screen_antics: false, pupil_reactions: false, mood_background: 'Fixed colour',
      mood_background_at_bedtime: true, listening_glow: false }, true);
    expect(engine.edgeAnticSettings.enabled).toBe(false);
    expect(engine.pupilReactionSettings).toMatchObject({ enabled: false, reduceMotion: true });
    expect(engine.moodBackground).toMatchObject({ mode: 'fixed', colourAtBedtime: true, reduceMotion: true, fixedColor: { x: 0.02, y: 0.05, z: 0.12 } });
    expect(engine.listeningGlow).toMatchObject({ enabled: false, reduceMotion: true });
    const st = composeStyle({ eyebrows: false, mood_colour_strength: 40, mood_background: 'Mood' });
    expect([st.browsEnabled, st.moodColorAmount, st.backgroundVignette, st.backgroundVignetteInner]).toEqual([false, 0.4, 0.15, 0.45]);
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
