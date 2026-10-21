import { describe, expect, it } from 'vitest';
import { HA_SETTING_KEYS, isValidSetting, SETTING_DEFAULTS, SETTING_KEYS, settingDef } from '../src/settingsSchema.js';
import { SETTINGS_CHECKS } from '../src/protocol.js';
import { entities } from '../src/entities.js';

describe('settings schema', () => {
  it('every default is valid, and every key has a check', () => {
    for (const k of SETTING_KEYS) {
      expect(isValidSetting(settingDef(k), SETTING_DEFAULTS[k]), k).toBe(true);
      expect(SETTINGS_CHECKS[k](SETTING_DEFAULTS[k]), k).toBe(true);
    }
  });

  it('the Home Assistant settings are exactly the iPad entity list, in its order', () => {
    expect(HA_SETTING_KEYS).toEqual(['bedtime', 'bedtime_schedule', 'bedtime_start', 'bedtime_end', 'minutes_to_drowsy',
      'minutes_to_asleep', 'bedtime_awake_minutes', 'taps_to_wake', 'wake_on_motion_at_bedtime', 'quiet_mode', 'sounds',
      'chirp_volume', 'voice_volume', 'reply_voice', 'listen_on_eye_contact', 'mood_colour', 'mood_colour_strength',
      'mood_background', 'mood_background_at_bedtime', 'eyebrows', 'listening_glow', 'screen_antics', 'pupil_reactions',
      'expressive_reactions', 'room_understanding']);
    expect(entities(true).filter((e) => e.setting).map((e) => e.setting)).toEqual(HA_SETTING_KEYS);
  });

  it('HA parse results pass the display-side check', () => {
    for (const e of entities(true)) {
      if (!e.setting || !e.parse || !e.encode) continue;
      const r = e.parse(e.encode(SETTING_DEFAULTS[e.setting]));
      if (e.setting === 'room_understanding') continue; // off is the default; HA may send only off
      expect('value' in r && SETTINGS_CHECKS[e.setting]((r as { value: unknown }).value), e.setting).toBe(true);
    }
  });

  it('validates ranges, integers, options, colours and unsafe text', () => {
    expect(SETTINGS_CHECKS.taps_to_wake(2.5)).toBe(false);
    expect(SETTINGS_CHECKS.game_yo_yo_cooldown(10)).toBe(false);
    expect(SETTINGS_CHECKS.personality('grumpy')).toBe(false);
    expect(SETTINGS_CHECKS.mood_background_colour('#ABCDEF')).toBe(false);
    expect(SETTINGS_CHECKS.mood_background_colour('#abcdef')).toBe(true);
    expect(SETTINGS_CHECKS.pipeline_id('')).toBe(true);
    expect(SETTINGS_CHECKS.pipeline_id('a‮b')).toBe(false);
    expect(SETTINGS_CHECKS.room('   ')).toBe(false);
    expect(SETTINGS_CHECKS.pupil_pause(Number.NaN)).toBe(false);
  });
});
