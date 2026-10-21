// Port of Tests/FaceVoiceTests/SettingsTests.swift.
import { describe, expect, test } from 'vitest';
import { VoiceDirector, VoiceSettings } from '../../src/voice';
import { Rig } from './support';

describe('SettingsTests', () => {
  test('quietModeMutesRendererButCuesStillSent', () => {
    const rig = new Rig();
    rig.director.settings.quietMode = true;
    expect(rig.director.rendererMuted).toBe(true);
    rig.director.react('delighted', false);
    const rec = rig.director.lastScheduled!;
    expect(rec).not.toBeNull();
    expect(rec.audible).toBe(false);
    expect(rig.cues.length).toBe(rec.phrase.notes.length);
    expect(rig.director.audibleUntilHostTime).toBe(0);
    rig.director.settings.quietMode = false;
    expect(rig.director.rendererMuted).toBe(false);
  });

  test('mutedAndBedtimeOffMute', () => {
    const rig = new Rig();
    rig.director.settings.muted = true;
    expect(rig.director.rendererMuted).toBe(true);
    rig.director.settings.muted = false;
    rig.director.isBedtime = true;   // default bedtimeSounds .off
    expect(rig.director.rendererMuted).toBe(true);
    rig.director.react('sleepy', false);
    expect(rig.cues.length).toBeGreaterThan(0);
  });

  test('bedtimeQuietAllowsOnlySleepyAndSheepishAtReducedVolume', () => {
    const rig = new Rig();
    rig.director.settings.volume = 1;
    rig.director.isBedtime = true;
    rig.director.settings.bedtimeSounds = 'quiet';
    expect(rig.director.rendererMuted).toBe(false);
    expect(Math.abs(rig.director.rendererVolume - 0.4)).toBeLessThan(1e-6);
    rig.director.react('sleepy', false);
    expect(rig.director.lastScheduled!.audible).toBe(true);
    rig.director.react('delighted', false);
    expect(rig.director.lastScheduled!.audible).toBe(false);
    expect(rig.cues.length).toBeGreaterThan(0);
  });

  test('volumeIsForwarded', () => {
    const rig = new Rig();
    rig.director.settings.volume = 0.3;
    expect(Math.abs(rig.director.rendererVolume - 0.3)).toBeLessThan(1e-6);
  });

  /// Bedtime is runtime-only (owned by the life cycle): an old saved `bedtime: true` is ignored, so a daytime
  /// relaunch never starts silent.
  test('legacyBedtimeKeyIsIgnoredSoADaytimeRelaunchIsNotSilent', () => {
    const s = VoiceSettings.decode(JSON.parse('{"bedtime":true,"volume":0.5}'));
    expect(s.volume).toBe(0.5);
    const rig = new Rig();
    rig.director.settings = s;
    expect(rig.director.isBedtime).toBe(false);
    expect(rig.director.rendererMuted).toBe(false);
    const json = JSON.stringify(s);
    expect(json.includes('"bedtime"')).toBe(false);
  });

  /// The sound panel pushes whole settings; that can never clear the life cycle's bedtime.
  test('replacingSettingsKeepsBedtime', () => {
    const rig = new Rig();
    rig.director.isBedtime = true;
    const s = rig.director.settings.copy();
    s.volume = 0.2;
    rig.director.settings = s;
    rig.director.settings = new VoiceSettings();
    expect(rig.director.isBedtime).toBe(true);
    expect(rig.director.rendererMuted).toBe(true);
    rig.director.isBedtime = false;
    expect(rig.director.rendererMuted).toBe(false);
  });

  test('catchSelfIsSilent', () => {
    expect(VoiceDirector.reactionForOneShot('catchSelf')).toBeNull();
  });

  test('defaultsMatchSpec', () => {
    const s = new VoiceSettings();
    expect(s.bedtimeSounds).toBe('off');
    expect(s.autoVocalize).toBe(true);
    expect(s.volume).toBe(0.7);
    expect(s.avOffset).toBe(0);
  });
});
