import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HA_SETTING_KEYS, isValidSetting, JSON_SETTING_MAX, SETTING_DEFAULTS, SETTING_GROUPS, SETTING_KEYS, settingDef }
  from '../src/settingsSchema.js';
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
    expect(SETTINGS_CHECKS.custom_sclera_colour('')).toBe(true); // '' = the style's own
    expect(SETTINGS_CHECKS.mood_background_colour('')).toBe(false);
    expect(SETTINGS_CHECKS.asr_language('')).toBe(false);
  });

  it('developer sections take plain JSON objects only, within the size cap', () => {
    const ok = SETTINGS_CHECKS.emotion_tunables;
    expect(ok({})).toBe(true);
    expect(ok({ dynamics: { moodGain: 0.1 }, classifier: { allowList: ['Happiness'] } })).toBe(true);
    expect(ok([])).toBe(false);
    expect(ok('{}')).toBe(false);
    expect(ok({ a: Number.NaN })).toBe(false);
    expect(ok({ big: 'x'.repeat(JSON_SETTING_MAX) })).toBe(false);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) deep = { d: deep };
    expect(ok(deep)).toBe(false);
  });

  it('every group has settings and every setting a known group', () => {
    const ids = SETTING_GROUPS.map((g) => g.id);
    for (const k of SETTING_KEYS) expect(ids, k).toContain(settingDef(k).group);
    for (const g of ids) expect(SETTING_KEYS.some((k) => settingDef(k).group === g), g).toBe(true);
  });
});

describe('docs/SETTINGS.md inventory', () => {
  const doc = readFileSync(new URL('../../docs/SETTINGS.md', import.meta.url), 'utf8');
  const ported = doc.split('## Ported')[1]!.split('\n## ')[0]!;
  // The TS key column (third) of each table row, backticked.
  const keys = ported.split('\n').filter((l) => l.startsWith('| `')).map((l) => /^\|[^|]*\|[^|]*\| `([a-z0-9_]+)` \|/.exec(l)?.[1]);

  it('names a schema key on every row, once', () => {
    expect(keys.length).toBeGreaterThan(100);
    for (const k of keys) expect(SETTING_KEYS, String(k)).toContain(k);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists every schema key', () => {
    for (const k of SETTING_KEYS) expect(keys, k).toContain(k);
  });

  it('marks exactly the Home Assistant settings as entities', () => {
    const rows = ported.split('\n').filter((l) => l.startsWith('| `'));
    const ha = rows.filter((l) => !l.trimEnd().endsWith('| — |')).map((l) => /^\|[^|]*\|[^|]*\| `([a-z0-9_]+)` \|/.exec(l)?.[1]);
    expect(new Set(ha)).toEqual(new Set(HA_SETTING_KEYS));
  });
});
