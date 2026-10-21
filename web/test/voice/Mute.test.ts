// Port of Tests/FaceVoiceTests/MuteTests.swift.
// Mute / quiet / bedtime-off: no path produces sound (rendered offline through the real renderer), face cues still
// fire, and unmuting restores sound.
import { describe, expect, test } from 'vitest';
import { FaceEngine, Mood, type OneShotKind } from '../../src/engine';
import { VoiceDirector, VoiceRenderer, VoiceSettings, VoiceSettingsStore } from '../../src/voice';
import { Fx } from './RendererFixtures';
import { FakeOutput, Rig, renderFrom, started } from './support';

const silence = 1e-4;

/// Renders the director's current renderer for `seconds` from the rig's current host time.
const render = (rig: Rig, seconds = 1.5): Float32Array => renderFrom(rig.director.renderer, rig.now, seconds);

type Gate = 'muted' | 'quiet' | 'bedtimeOff';
const gates: Gate[] = ['muted', 'quiet', 'bedtimeOff'];

function gate(rig: Rig, g: Gate, on: boolean): void {
  switch (g) {
    case 'muted': rig.director.settings.muted = on; break;
    case 'quiet': rig.director.settings.quietMode = on; break;
    case 'bedtimeOff': rig.director.isBedtime = on; break;   // bedtimeSounds defaults to .off
  }
}

/// A throwaway storage per test (port-note: a fresh UserDefaults suite in Swift).
function freshStore(): VoiceSettingsStore {
  const m = new Map<string, string>();
  return new VoiceSettingsStore({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } });
}

/// Real engine (IdleBeats, OneShotSampler, all modifiers) idling for `seconds`, rendering every frame.
function idleSoak(settings: VoiceSettings, seconds: number): { peak: number; phrases: number } {
  const engine = new FaceEngine();
  engine.setMood(Mood.playful);
  engine.setAgentState('idle');
  const d = new VoiceDirector(engine, new VoiceRenderer(48_000), new FakeOutput());
  let now = 1000.0;
  d.clock = () => now;
  d.settings = settings;
  const n = 800;
  const buf = new Float32Array(n);
  let peak = 0;
  const phrases = new Set<number>();
  let t = 0.0;
  while (t < seconds) {
    now += 1.0 / 60.0; t += 1.0 / 60.0;
    engine.tick(1.0 / 60.0, now);
    d.afterFrame(now);
    const id = d.lastPhrase?.id;
    if (id !== undefined) phrases.add(id);
    (d.renderer as VoiceRenderer).render(n, now, buf);
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
  }
  return { peak, phrases: phrases.size };
}

describe('MuteTests', () => {
  // Baseline: the same actions are audible when not muted (so silence below means the gate worked).
  test('unmutedActionsAreAudible', () => {
    const rig = new Rig();
    rig.director.react('delighted', false);
    expect(Fx.peak(render(rig))).toBeGreaterThan(0.01);
  });

  test.each(gates)('reactIsSilentButCuesFire(%s)', (g) => {
    const rig = new Rig();
    gate(rig, g, true);
    rig.director.react('delighted', true);
    const rec = rig.director.lastScheduled!;
    expect(rec).not.toBeNull();
    expect(rec.audible).toBe(false);
    expect(rig.cues.length).toBe(rec.phrase.notes.length);
    expect(rig.oneShotsAt.length).toBe(1);
    expect(Fx.peak(render(rig))).toBeLessThan(silence);
  });

  test.each(gates)('emoteAndRepeatAreSilent(%s)', (g) => {
    const rig = new Rig();
    gate(rig, g, true);
    rig.director.emote();
    expect(rig.cues.length).toBeGreaterThan(0);
    expect(Fx.peak(render(rig, 1))).toBeLessThan(silence);
    rig.director.repeatLast();
    expect(rig.cues.length).toBeGreaterThan(0);
    expect(Fx.peak(render(rig, 1))).toBeLessThan(silence);
  });

  test.each(gates)('autoVocalizedIdleBeatIsSilent(%s)', (g) => {
    const rig = new Rig();
    gate(rig, g, true);
    for (const k of ['curiousTilt', 'doubleTake', 'delightedSquint'] as OneShotKind[]) {
      rig.advance(3.5);
      rig.injector.queued = [started(k, rig.now + 1.0 / 60.0)];
      rig.frame();
      expect(Fx.peak(render(rig, 1))).toBeLessThan(silence);
    }
  });

  test.each(gates)('stateEntryIsSilent(%s)', (g) => {
    const rig = new Rig();
    gate(rig, g, true);
    rig.engine.setAgentState('engaged');
    rig.frame();
    expect(Fx.peak(render(rig))).toBeLessThan(silence);
  });

  test.each(gates)('replacedRendererStaysSilent(%s)', (g) => {
    const rig = new Rig();
    gate(rig, g, true);
    // A route change to a new rate rebuilds the renderer (comes up unmuted by default).
    rig.output.sampleRate = 44_100;
    rig.output.onConfigurationChange?.();
    expect(rig.director.renderer.sampleRate).toBe(44_100);
    rig.director.react('startled', false);
    expect(rig.cues.length).toBeGreaterThan(0);
    expect(Fx.peak(render(rig))).toBeLessThan(silence);
    // Also an explicit replacement.
    rig.director.replaceRenderer(new VoiceRenderer(48_000));
    rig.director.react('giggle', false);
    expect(Fx.peak(render(rig))).toBeLessThan(silence);
  });

  test.each(gates)('unmuteRestoresSoundSmoothly(%s)', (g) => {
    const rig = new Rig();
    gate(rig, g, true);
    rig.director.react('delighted', false);
    expect(Fx.peak(render(rig))).toBeLessThan(silence);
    gate(rig, g, false);
    rig.director.react('delighted', false);
    const x = render(rig);
    expect(Fx.peak(x)).toBeGreaterThan(0.01);
    expect(Fx.maxDelta(x)).toBeLessThan(0.2);
  });

  /// Muting while idle-beat chirps happen mid-session (auto phrase already queued) silences it.
  test('muteAfterQueuedAutoPhraseSilencesIt', () => {
    const rig = new Rig();
    rig.injector.queued = [started('curiousTilt', rig.now + 0.2)];
    rig.frame();
    expect(rig.director.lastScheduled?.isAuto).toBe(true);
    rig.director.settings.muted = true;
    expect(Fx.peak(render(rig))).toBeLessThan(silence);
  });

  // MARK: - Mute survives a relaunch

  test('settingsRoundTripThroughStore', () => {
    const store = freshStore();
    expect(store.load()).toBeNull();
    const s = new VoiceSettings();
    s.muted = true; s.quietMode = true; s.volume = 0.25; s.bedtimeSounds = 'quiet';
    s.autoVocalize = false; s.avOffset = -0.02;
    store.save(s);
    expect(store.load()?.equals(s)).toBe(true);
  });

  test('decodingToleratesMissingKeys', () => {
    const s = VoiceSettings.decode(JSON.parse('{"muted":true}'));
    const expected = new VoiceSettings(); expected.muted = true;
    expect(s.equals(expected)).toBe(true);
  });

  /// The owner's scenario: mute, relaunch, leave Yanni idle. The restored setting keeps idle beats silent.
  test('restoredMuteKeepsIdleBeatsSilentAfterRelaunch', () => {
    const baseline = idleSoak(new VoiceSettings(), 300);
    expect(baseline.phrases).toBeGreaterThan(0);
    expect(baseline.peak).toBeGreaterThan(0.01);

    const store = freshStore();
    const s = new VoiceSettings(); s.muted = true;
    store.save(s);
    // "Relaunch": a fresh director picks the settings up from the store.
    const restored = store.load();
    expect(restored).not.toBeNull();
    const muted = idleSoak(restored!, 300);
    expect(muted.peak).toBeLessThan(silence);
  }, 120_000);
});
