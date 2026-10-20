// Port of Tests/FaceLifeTests/LifeMiscTests.swift: conversation states, takeover, mood drift, settings, voice wiring and a
// whole-engine soak.
import { describe, expect, test } from 'vitest';
import type { AgentState } from '../../src/engine';
import { LifeCycleController, LifeSettings, LifeSettingsStore } from '../../src/life';
import { LifeRig, fullStackTest, req } from './LifeRig';

const last = <T>(a: T[]): T | undefined => a[a.length - 1];

/// UserDefaults suite stand-in.
function freshStore(): LifeSettingsStore {
  const m = new Map<string, string>();
  return new LifeSettingsStore({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } });
}

describe('LifeMiscTests', () => {
  // MARK: Conversation states

  fullStackTest.each(['engaged', 'listening', 'thinking', 'speaking', 'followUp'] as AgentState[])('conversationStatesAreNeverOverridden %s', (st) => {
    const rig = new LifeRig();
    rig.life.timeWarp = 600;
    rig.engine.setAgentState(st);
    rig.run(20);                                     // 200 warped minutes, nobody around
    expect(rig.state).toBe(st);
  });

  fullStackTest('interruptedHandsOffToListeningAndStaysThere', () => {
    const rig = new LifeRig();
    rig.life.timeWarp = 600;
    rig.engine.setAgentState('interrupted');
    rig.run(20);
    expect(rig.state).toBe('listening');
  });

  // MARK: Takeover

  fullStackTest.each(['sheepish', 'confused', 'hasMessage'] as AgentState[])('aloneTooLongTheLifeCycleTakesOver %s', (st) => {
    const rig = new LifeRig({ settings: new LifeSettings({ minutesToDrowsy: 0.25, minutesToAsleep: 0.25 }) });
    rig.engine.setAgentState(st);
    rig.run(60);
    expect(rig.state, 'held for aloneTakeoverMinutes (2)').toBe(st);
    const t = req(rig.runUntil(80, () => rig.state === 'idle'));
    expect(t).toBeLessThan(61);
    expect(last(rig.changes)?.reason).toBe('takeover');
    req(rig.runUntil(40, () => rig.state === 'asleep'));
  });

  fullStackTest('takeoverWaitsWhileSomeoneIsThere', () => {
    const rig = new LifeRig();
    rig.life.timeWarp = 60;
    rig.person(true);
    rig.engine.setAgentState('hasMessage');
    rig.run(10);                                     // 10 warped minutes
    expect(rig.state).toBe('hasMessage');
  });

  // MARK: Mood drift

  test('idleMoodDriftsBoredAndPerksUpOnActivity', () => {
    const rig = new LifeRig();
    const base = { ...rig.engine.state.baseMood };
    rig.life.timeWarp = 60;
    rig.life.settings = rig.life.settings.with({ minutesToDrowsy: 30 });
    rig.run(5.5);                                    // 5.5 warped minutes idle and alone
    expect(rig.life.boredom).toBeGreaterThan(0.99);
    expect(Math.abs(rig.engine.state.mood.arousal - (base.arousal - 0.3))).toBeLessThan(0.02);
    expect(Math.abs(rig.engine.state.mood.pleasure - (base.pleasure - 0.1))).toBeLessThan(0.02);
    expect(rig.engine.state.baseMood, "the panel's baseline is untouched").toEqual(base);
    rig.life.timeWarp = 1;
    rig.life.noteActivity('motion');
    let peak = -1;
    rig.run(1.5, 1 / 30, () => { peak = Math.max(peak, rig.engine.state.mood.arousal); });
    expect(peak, 'curious bump above baseline').toBeGreaterThan(base.arousal);
    rig.run(12);
    expect(Math.abs(rig.engine.state.mood.arousal - base.arousal)).toBeLessThan(0.01);
    expect(rig.life.boredom).toBeLessThan(0.01);
  });

  test('moodDriftCanBeTurnedOff', () => {
    const rig = new LifeRig({ settings: new LifeSettings({ idleMoodDrift: false, minutesToDrowsy: 30 }) });
    rig.life.timeWarp = 60;
    rig.run(6);
    expect(rig.life.boredom).toBe(0);
    expect(rig.engine.state.moodOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  // MARK: Settings

  test('settingsPersistAndLoad', () => {
    const store = freshStore();
    expect(store.load()).toBeNull();
    const rig = new LifeRig({ store });
    rig.life.settings = rig.life.settings.with({ minutesToDrowsy: 7 });
    rig.life.settings = rig.life.settings.with({ bedtimeEnabled: true });
    rig.life.settings = rig.life.settings.with({ tapsToWake: 4 });
    const loaded = store.load();
    expect(loaded?.minutesToDrowsy).toBe(7);
    expect(loaded?.bedtimeEnabled).toBe(true);
    expect(loaded?.tapsToWake).toBe(4);
  });

  test('decodingIsTolerantAndValidated', () => {
    const s = LifeSettings.decode(JSON.parse('{"minutesToDrowsy":-5,"tapsToWake":99,"bedtimeStart":1500,"idleMoodDrift":"nope","future":1}'));
    expect(s.minutesToDrowsy).toBe(LifeSettings.minutesRange[0]);
    expect(s.tapsToWake).toBe(6);
    expect(s.bedtimeStart).toBe(60);
    expect(s.idleMoodDrift).toBe(true);
    expect(s.minutesToAsleep).toBe(3);
    const rig = new LifeRig();
    rig.life.settings = rig.life.settings.with({ bedtimeAwakeMinutes: NaN });
    expect(rig.life.settings.bedtimeAwakeMinutes).toBe(1);
  });

  test('timeWarpIsRuntimeOnlyAndClamped', () => {
    const rig = new LifeRig();
    rig.life.timeWarp = 0;
    expect(rig.life.timeWarp).toBe(1);
    rig.life.timeWarp = 1e9;
    expect(rig.life.timeWarp).toBe(LifeCycleController.maxTimeWarp);
    expect(JSON.stringify(rig.life.settings).includes('arp')).toBe(false);
  });

  // MARK: Voice wiring

  // needs WP12 (FaceVoice: VoiceDirector, VoiceRenderer, PhraseGenerator)
  test.skip('nightWakeIsSilentAndDaytimeWakeIsNot', () => {});
  // needs WP12 (FaceVoice: VoiceDirector settings and bedtime)
  test.skip('voiceSettingsCannotClearBedtime', () => {});

  // MARK: Whole engine

  /// ×60: one real second is one minute of the minute-scale timers; second-scale delays stay real.
  fullStackTest('tenSimulatedMinutesWithTheRealEngine', () => {
    const rig = new LifeRig({ settings: new LifeSettings({ minutesToDrowsy: 1.5, minutesToAsleep: 2 }), seed: 21 });
    rig.life.timeWarp = 60;
    const dt = 1 / 60;
    rig.run(3.7, dt);                                // minutes 0–3.7: idle → drowsy (1.5) → asleep (3.5)
    expect(rig.state).toBe('asleep');
    rig.person(true, { engaged: true });             // someone arrives and looks
    rig.run(3.3, dt);                                // half-awake (0.7 s) → waking → noticing
    expect(rig.state).toBe('noticing');
    rig.person(false);                               // they leave
    rig.run(3.3, dt);                                // idle again 3 s later: ≈ minute 10
    expect(rig.states).toEqual(['idle', 'drowsy', 'asleep', 'halfAwake', 'waking', 'noticing', 'idle']);
    expect(rig.sawNonFinite).toBe(false);
    expect(Number.isNaN(rig.engine.state.mood.pleasure)).toBe(false);
  });
});
