// The settings model: every owner setting the web display has, with its type, default, range or options, group and
// label, and the Home Assistant entity for the ones Home Assistant sees. A port of YanniSettings (the iPad's
// `YanniSettings.swift`) flattened into snake_case keys, in the units Home Assistant uses (percent 0–100, minutes,
// minutes after midnight). Left out on purpose: the Keychain items (tokens, PIN), the iPad's own Home Assistant and
// broker connection and its Wyoming hosts (the add-on owns those connections), kiosk self-restart (iPad only), custom
// colours and the developer sections (tuning, emotion, perception), which stay on the display.
//
// Shared by the server (validation, MQTT entities, the owner pages) and the web app (defaults): no imports, no Node
// APIs. The web app imports it as `@yanni/server/settings`.

export type SettingGroup = 'yanni' | 'sleep' | 'sound' | 'look' | 'playfulness' | 'pupils' | 'games' | 'conversation'
  | 'home' | 'privacy';

export const SETTING_GROUPS: readonly { id: SettingGroup; title: string; note?: string }[] = [
  { id: 'yanni', title: 'Yanni', note: 'Home Assistant shows this display as “Yanni ‹room›”.' },
  { id: 'sleep', title: 'Sleep & bedtime', note: 'The schedule on the display is the reliable bedtime: it works even when Home Assistant is away.' },
  { id: 'sound', title: 'Sound', note: 'Quiet mode keeps Yanni from speaking up on its own; messages wait until it ends. Sounds off silences the chirps, the greeting and the listening sound; Yanni still answers when you talk to it.' },
  { id: 'look', title: 'Look' },
  { id: 'playfulness', title: 'Playfulness', note: 'Personality is where Yanni’s feelings rest and how strongly it reacts. Antics are Yanni peeking in from the screen edges. With expressive reactions the decision model (HA-Jev) picks how Yanni answers a wave, a stare or a poke; only a few words about the moment go out, never images, names or speech.' },
  { id: 'pupils', title: 'Pupil reactions', note: 'Yanni reacts only when it is confident enough, and rests between reactions so they stay special.' },
  { id: 'games', title: 'Idle games' },
  { id: 'conversation', title: 'Conversation', note: 'Empty = Home Assistant’s preferred pipeline and agent. In Yanni’s own voice replies are expressive babble: Yanni won’t say information out loud.' },
  { id: 'home', title: 'Home Assistant' },
  { id: 'privacy', title: 'Privacy', note: 'Room understanding (camera snapshots) stays unavailable until an encrypted vision path exists.' },
];

/** The Home Assistant entity of a setting (MQTT discovery; the component is the setting's key). */
export interface HaEntity {
  name: string;
  icon?: string;
  /** `entity_category: config`. */
  config?: boolean;
  /** Number entities: box or slider. */
  mode?: 'box' | 'slider';
}

interface Base { group: SettingGroup; label: string; help?: string; ha?: HaEntity }
export interface BoolDef extends Base { type: 'bool'; default: boolean }
export interface NumberDef extends Base { type: 'number'; default: number; min: number; max: number; step: number;
  unit?: string; integer?: boolean }
export interface EnumDef<O extends string = string> extends Base { type: 'enum'; default: O; options: readonly O[];
  labels?: readonly string[] }
export interface TextDef extends Base { type: 'text'; default: string; maxLength: number; required?: boolean }
/** Minutes after midnight (Home Assistant sees HH:MM). */
export interface TimeDef extends Base { type: 'time'; default: number }
/** `#rrggbb` (sRGB). */
export interface ColorDef extends Base { type: 'color'; default: string }
export type SettingDef = BoolDef | NumberDef | EnumDef | TextDef | TimeDef | ColorDef;

export const REPLY_VOICES = ['Spoken', 'Yanni'] as const;
export const MOOD_BACKGROUNDS = ['Black', 'Mood', 'Fixed colour'] as const;
export const PERSONALITIES = ['playful', 'calm', 'bubbly', 'shy'] as const;
export const THEME_PRESETS = ['inky', 'sticker'] as const;
export const BEDTIME_SOUNDS = ['off', 'quiet'] as const;

const bool = (group: SettingGroup, label: string, d: boolean, ha?: HaEntity, help?: string) =>
  ({ type: 'bool', group, label, default: d, ...(ha ? { ha } : {}), ...(help ? { help } : {}) }) as const satisfies BoolDef;
const num = (group: SettingGroup, label: string, d: number, min: number, max: number, step: number, unit?: string,
  ha?: HaEntity, extra: Partial<NumberDef> = {}) =>
  ({ type: 'number', group, label, default: d, min, max, step, ...(unit ? { unit } : {}), ...(ha ? { ha } : {}), ...extra }) as const satisfies NumberDef;
const pick = <const O extends string>(group: SettingGroup, label: string, d: O, options: readonly O[], ha?: HaEntity,
  labels?: readonly string[]) =>
  ({ type: 'enum', group, label, default: d, options, ...(labels ? { labels } : {}), ...(ha ? { ha } : {}) }) as EnumDef<O>;
const text = (group: SettingGroup, label: string, maxLength: number, help?: string) =>
  ({ type: 'text', group, label, default: '', maxLength, ...(help ? { help } : {}) }) as const satisfies TextDef;
const pct = (group: SettingGroup, label: string, d: number, ha?: HaEntity) => num(group, label, d, 0, 100, 1, '%', ha);

/** Per-game and per-shape keys (camelCase engine names → snake_case setting keys). */
export const IDLE_GAMES = ['ping_pong', 'basketball', 'juggling', 'yo_yo', 'leapfrog', 'staring_contest',
  'hide_and_seek', 'catch_the_fly', 'dance_break', 'hula_hoop'] as const;
export const PUPIL_SHAPES = ['star', 'heart', 'note', 'question', 'exclaim'] as const;
/** Swift `PupilReactionSettings` shape defaults: hold seconds, cooldown seconds. */
const SHAPE_DEFAULTS: Record<(typeof PUPIL_SHAPES)[number], [number, number]> = {
  star: [1.0, 90], heart: [1.3, 120], note: [1.5, 90], question: [1.0, 75], exclaim: [0.6, 75],
};
const title = (k: string) => k.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

type GameKeys<G extends string> = { [K in G as `game_${K}`]: BoolDef } & { [K in G as `game_${K}_weight` | `game_${K}_cooldown`]: NumberDef };
type ShapeKeys<S extends string> = { [K in S as `pupil_${K}`]: BoolDef } & { [K in S as `pupil_${K}_hold` | `pupil_${K}_cooldown`]: NumberDef };

function games(): GameKeys<(typeof IDLE_GAMES)[number]> {
  const o: Record<string, SettingDef> = {};
  for (const g of IDLE_GAMES) {
    o[`game_${g}`] = bool('games', title(g), true);
    o[`game_${g}_weight`] = num('games', `${title(g)}: weight`, 1, 0, 3, 0.1);
    o[`game_${g}_cooldown`] = num('games', `${title(g)}: rest between games`, 180, 30, 1800, 10, 's');
  }
  return o as GameKeys<(typeof IDLE_GAMES)[number]>;
}

function shapes(): ShapeKeys<(typeof PUPIL_SHAPES)[number]> {
  const o: Record<string, SettingDef> = {};
  for (const s of PUPIL_SHAPES) {
    const [hold, cooldown] = SHAPE_DEFAULTS[s];
    o[`pupil_${s}`] = bool('pupils', `${title(s)} eyes`, true);
    o[`pupil_${s}_hold`] = num('pupils', `${title(s)}: hold`, hold, 0.5, 1.5, 0.1, 's');
    o[`pupil_${s}_cooldown`] = num('pupils', `${title(s)}: rest before the next one`, cooldown, 0, 600, 5, 's');
  }
  return o as ShapeKeys<(typeof PUPIL_SHAPES)[number]>;
}

/** Every setting, in settings-screen order. The Home Assistant entities are published in this order too. */
export const SETTINGS_SCHEMA = {
  room: { type: 'text', group: 'yanni', label: 'Room', default: 'Living Room', maxLength: 40, required: true } satisfies TextDef,

  // ---- Sleep & bedtime (FaceLife LifeSettings) ----
  bedtime: bool('sleep', 'Bedtime now', false, { name: 'Bedtime', icon: 'mdi:weather-night' }),
  bedtime_schedule: bool('sleep', 'Bedtime schedule', false, { name: 'Bedtime schedule', config: true, icon: 'mdi:calendar-clock' }),
  bedtime_start: { type: 'time', group: 'sleep', label: 'Bedtime starts', default: 22 * 60, ha: { name: 'Bedtime start', config: true, icon: 'mdi:clock-outline' } } satisfies TimeDef,
  bedtime_end: { type: 'time', group: 'sleep', label: 'Bedtime ends', default: 7 * 60, ha: { name: 'Bedtime end', config: true, icon: 'mdi:clock-outline' } } satisfies TimeDef,
  minutes_to_drowsy: num('sleep', 'Drowsy after', 3, 0.25, 120, 0.25, 'min', { name: 'Minutes to drowsy', config: true, mode: 'box' }),
  minutes_to_asleep: num('sleep', 'Then asleep after', 3, 0.25, 120, 0.25, 'min', { name: 'Minutes to asleep', config: true, mode: 'box' }),
  bedtime_awake_minutes: num('sleep', 'Awake after a night wake', 1, 0.25, 30, 0.25, 'min', { name: 'Bedtime awake minutes', config: true, mode: 'box' }),
  taps_to_wake: num('sleep', 'Taps to wake at bedtime', 3, 1, 6, 1, undefined, { name: 'Taps to wake at bedtime', config: true, mode: 'slider' }, { integer: true }),
  wake_on_motion_at_bedtime: bool('sleep', 'Wake on motion at bedtime', false, { name: 'Wake on motion at bedtime', config: true }),
  idle_mood_drift: bool('sleep', 'Idle mood drift', true, undefined, 'Left alone, Yanni gets a little bored.'),

  // ---- Sound (FaceVoice VoiceSettings, SpeechSettings) ----
  quiet_mode: bool('sound', 'Quiet mode', false, { name: 'Quiet mode', icon: 'mdi:volume-off' }),
  sounds: bool('sound', 'Sounds', true, { name: 'Sounds', icon: 'mdi:music-note' }),
  chirp_volume: pct('sound', 'Chirp volume', 70, { name: 'Chirp volume', mode: 'slider' }),
  voice_volume: pct('sound', 'Voice volume', 80, { name: 'Voice volume', mode: 'slider' }),
  listening_sound: bool('sound', 'Listening sound', true),
  bedtime_sounds: pick('sound', 'Sounds at bedtime', 'off', BEDTIME_SOUNDS, undefined, ['Off', 'Quiet']),

  // ---- Conversation (SpeechSettings, VoiceServicesSettings) ----
  reply_voice: pick('conversation', 'Reply voice', 'Spoken', REPLY_VOICES, { name: 'Reply voice', config: true, icon: 'mdi:account-voice' }),
  listen_on_eye_contact: bool('conversation', 'Start listening when I make eye contact', true, { name: 'Start listening on eye contact', config: true, icon: 'mdi:eye-outline' }),

  // ---- Look (LookSettings, MoodBackgroundSettings) ----
  mood_colour: bool('look', 'Mood colour', true, { name: 'Mood colour', config: true, icon: 'mdi:palette' }),
  mood_colour_strength: pct('look', 'Mood colour strength', 100, { name: 'Mood colour strength', config: true, mode: 'slider' }),
  mood_background: pick('look', 'Background', 'Black', MOOD_BACKGROUNDS, { name: 'Mood background', config: true, icon: 'mdi:format-color-fill' }),
  mood_background_at_bedtime: bool('look', 'Keep the colour at bedtime', false, { name: 'Mood background at bedtime', config: true, icon: 'mdi:weather-night' }),
  eyebrows: bool('look', 'Eyebrows', true, { name: 'Eyebrows', config: true }),
  listening_glow: bool('look', 'Listening glow', true, { name: 'Listening glow', config: true, icon: 'mdi:microphone-outline' }),

  // ---- Playfulness ----
  screen_antics: bool('playfulness', 'Screen-edge antics', true, { name: 'Screen-edge antics', config: true }),
  pupil_reactions: bool('pupils', 'Pupil reactions', true, { name: 'Pupil reactions', config: true }),
  expressive_reactions: bool('playfulness', 'Expressive reactions', true, { name: 'Expressive reactions', config: true, icon: 'mdi:emoticon-wink-outline' }),

  // ---- Privacy ----
  /** Camera snapshots. HA may only turn it off (no encrypted vision path exists yet). */
  room_understanding: bool('privacy', 'Room understanding', false, { name: 'Room understanding', config: true, icon: 'mdi:camera-outline' }),
  /** Presence entities exist only while this is on. */
  share_presence: bool('privacy', 'Share presence with Home Assistant', true),

  // ---- App-only (not Home Assistant entities) ----
  theme_preset: pick('look', 'Style', 'inky', THEME_PRESETS, undefined, ['Inky', 'Sticker']),
  ink_brows: bool('look', 'Ink brows', false),
  brow_intensity: num('look', 'Brow animation', 1, 0, 1.5, 0.05, '×'),
  mood_background_strength: pct('look', 'Background strength', 100),
  mood_background_vignette: pct('look', 'Edge darkening', 15),
  mood_background_speed: num('look', 'Colour change speed', 1, 0.25, 2, 0.05, '×'),
  mood_background_colour: { type: 'color', group: 'look', label: 'Background colour', default: '#273f61' } satisfies ColorDef,
  colour_bursts: bool('look', 'Colour bursts', true),
  burst_strength: pct('look', 'Burst strength', 100),

  personality: pick('playfulness', 'Personality', 'playful', PERSONALITIES, undefined, ['Playful', 'Calm', 'Bubbly', 'Shy']),
  antics_frequency: num('playfulness', 'Antics: how often', 1, 0.25, 4, 0.05, '×'),
  reaction_budget_per_hour: num('playfulness', 'Reaction budget', 60, 0, 600, 10, '/h', undefined, { integer: true, help: '0 = none.' }),

  pupil_intensity: pct('pupils', 'Intensity', 100),
  pupil_min_confidence: num('pupils', 'Minimum confidence', 70, 30, 100, 1, '%'),
  pupil_pause: num('pupils', 'Pause between reactions', 50, 10, 180, 1, 's'),
  pupil_repeat_window: num('pupils', 'Don’t repeat a topic within', 60, 0, 600, 5, 's'),
  pupil_mood_accent: bool('pupils', 'Mood accent on stars and hearts', true),
  ...shapes(),

  idle_games: bool('games', 'Idle games', true),
  idle_games_frequency: num('games', 'How often', 1, 0.25, 4, 0.05, '×'),
  idle_games_intensity: num('games', 'Intensity', 1, 0, 2, 0.05, '×'),
  idle_games_timing: num('games', 'Timing (slower > 1)', 1, 0.8, 1.4, 0.05, '×'),
  ...games(),

  show_captions: bool('conversation', 'Captions', true, undefined, 'What Yanni heard and its reply, on the face while relevant; never stored or sent.'),
  pipeline_id: text('conversation', 'Assist pipeline ID', 120),
  conversation_agent_id: text('conversation', 'Conversation agent ID', 120, 'HA-Jev’s agent with an LLM fallback is recommended.'),
  jev_config_entry_id: text('conversation', 'HA-Jev entry ID (only with several)', 64),
  ai_task_entity_id: text('conversation', 'AI Task entity for announcements', 120, 'Empty: a short template (“Hey! The laundry is done.”).'),
  thinking_timeout_seconds: num('conversation', 'Thinking timeout', 8, 4, 20, 0.5, 's'),
  send_mood_note: bool('conversation', 'Send Yanni’s mood to the agent', true),

  announcement_expiry_minutes: num('home', 'Announcements expire after (when they don’t say)', 30, 1, 720, 1, 'min'),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
type ValueOf<D> = D extends { type: 'bool' } ? boolean : D extends EnumDef<infer O> ? O : D extends { type: 'number' | 'time' } ? number : string;
/** Every setting's value (the display and the add-on exchange `Partial<Settings>`). */
export type Settings = { -readonly [K in SettingKey]: ValueOf<(typeof SETTINGS_SCHEMA)[K]> };

export const SETTING_KEYS = Object.keys(SETTINGS_SCHEMA) as SettingKey[];

/** The defaults (the Swift defaults). */
export const SETTING_DEFAULTS: Readonly<Settings> = Object.fromEntries(
  SETTING_KEYS.map((k) => [k, SETTINGS_SCHEMA[k].default])) as unknown as Settings;

/** The settings Home Assistant sees, in discovery order. */
export const HA_SETTING_KEYS = SETTING_KEYS.filter((k) => (SETTINGS_SCHEMA[k] as SettingDef).ha !== undefined);

// Control characters (C0, DEL, C1), zero-width and bidi formatting characters: never in a stored text setting.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/;

/** Whether `v` is a valid value for the setting (finite, in range, a known option, a safe string). */
export function isValidSetting(def: SettingDef, v: unknown): boolean {
  switch (def.type) {
    case 'bool': return typeof v === 'boolean';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && v >= def.min && v <= def.max && (!def.integer || Number.isInteger(v));
    case 'time': return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1439;
    case 'enum': return typeof v === 'string' && def.options.includes(v);
    case 'color': return typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v);
    case 'text':
      return typeof v === 'string' && v.length <= def.maxLength && !UNSAFE_TEXT.test(v) && (!def.required || v.trim().length > 0);
  }
}

export const settingDef = (k: SettingKey): SettingDef => SETTINGS_SCHEMA[k] as SettingDef;
