// The Home Assistant entity table: a port of YanniHome's HomeEntities (same components, names, options and
// unique_ids, so an iPad migrated with its install ID keeps its entities). The Swift-only `signature_expires`
// sensor is left out (a browser has no signing profile).
import { ANNOUNCEMENT_OUTCOMES, FACE_STATES, GESTURES, HEALTH_OVERALL, LIFE_PHASES, MOOD_BACKGROUNDS, REPLY_VOICES,
  RESTART_KINDS, SETTINGS_CHECKS, THERMAL_STATES, VOICE_SERVICES } from './protocol.js';
import type { DisplayState, EntitySettings, HaCommand } from './protocol.js';

type Json = Record<string, unknown>;
type Parsed = { value: unknown } | { error: string };

export interface Entity {
  component: string;
  platform: string;
  /** Platform fields (abbreviated keys) without p, uniq_id, stat_t, cmd_t. */
  config: Json;
  /** A setting (state from the settings store, commands change it). */
  setting?: keyof EntitySettings;
  /** A display report (state from the display's last `state`). */
  report?: keyof DisplayState;
  encode?: (v: unknown) => string;
  parse?: (payload: string) => Parsed;
  /** Extra JSON attributes from the display's report. */
  attrs?: (s: Partial<DisplayState>) => Json;
  button?: HaCommand;
  presence?: boolean;
}

export const onOff = (b: unknown) => (b ? 'ON' : 'OFF');

export function parseOnOff(s: string): boolean | undefined {
  const u = s.trim().toUpperCase();
  return ['ON', 'TRUE', '1'].includes(u) ? true : ['OFF', 'FALSE', '0'].includes(u) ? false : undefined;
}

/** Rounded to `step`, without trailing zeros ("70", "0.25"). */
export function formatNumber(v: number, step: number): string {
  const r = Math.round(v / step) * step;
  return Number.isInteger(r) ? String(r) : String(Number(r.toFixed(4)));
}

export const hhmm = (m: unknown) => {
  const n = Number(m);
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};

export function parseHHMM(s: string): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

function toggle(c: keyof EntitySettings & string, name: string, opts: { config?: boolean; icon?: string } = {}): Entity {
  const config: Json = { name };
  if (opts.config) config.ent_cat = 'config';
  if (opts.icon) config.ic = opts.icon;
  return { component: c, platform: 'switch', config, setting: c, encode: onOff,
    parse: (p) => { const b = parseOnOff(p); return b === undefined ? { error: 'expected ON or OFF' } : { value: b }; } };
}

function num(c: keyof EntitySettings & string, name: string, lo: number, hi: number, step: number, unit: string | null,
  mode: 'box' | 'slider', opts: { config?: boolean; icon?: string } = {}): Entity {
  const config: Json = { name, min: lo, max: hi, step, mode };
  if (unit) config.unit_of_meas = unit;
  if (opts.config ?? true) config.ent_cat = 'config';
  if (opts.icon) config.ic = opts.icon;
  return { component: c, platform: 'number', config, setting: c, encode: (v) => formatNumber(Number(v), step),
    parse: (p) => {
      const v = Number(p.trim());
      if (p.trim() === '' || !Number.isFinite(v)) return { error: 'expected a number' };
      if (v < lo - step / 2 || v > hi + step / 2) return { error: 'out of range' };
      return { value: Math.round(Math.min(Math.max(v, lo), hi) / step) * step };
    } };
}

function timeText(c: 'bedtime_start' | 'bedtime_end', name: string): Entity {
  return { component: c, platform: 'text', setting: c, encode: hhmm,
    config: { name, ent_cat: 'config', min: 5, max: 5, pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', ic: 'mdi:clock-outline' },
    parse: (p) => { const m = parseHHMM(p); return m === undefined ? { error: 'expected HH:MM' } : { value: m }; } };
}

function select(c: 'reply_voice' | 'mood_background', name: string, ops: readonly string[], icon: string): Entity {
  return { component: c, platform: 'select', setting: c, encode: String,
    config: { name, ent_cat: 'config', ops: [...ops], ic: icon },
    parse: (p) => (ops.includes(p.trim()) ? { value: p.trim() } : { error: 'unknown option' }) };
}

function button(c: HaCommand, name: string, icon: string): Entity {
  return { component: c, platform: 'button', config: { name, ic: icon }, button: c };
}

function sensor(c: keyof DisplayState & string, config: Json, encode: (v: unknown) => string = String, extra: Partial<Entity> = {}): Entity {
  return { component: c, platform: 'sensor', config, report: c, encode, ...extra };
}

function binary(c: keyof DisplayState & string, config: Json, extra: Partial<Entity> = {}): Entity {
  return { component: c, platform: 'binary_sensor', config, report: c, encode: onOff, ...extra };
}

const rate = (c: keyof DisplayState & string, name: string, ic: string) =>
  sensor(c, { name, ent_cat: 'diagnostic', stat_cla: 'measurement', unit_of_meas: '/h', ic }, (v) => Number(v).toFixed(2));

const PRESENCE: Entity[] = [
  binary('person_present', { name: 'Person present', dev_cla: 'occupancy' }, { presence: true }),
  sensor('people_count', { name: 'People count', stat_cla: 'measurement', ic: 'mdi:account-group' }, String, { presence: true }),
];

const TABLE: Entity[] = [
  toggle('bedtime', 'Bedtime', { icon: 'mdi:weather-night' }),
  toggle('bedtime_schedule', 'Bedtime schedule', { config: true, icon: 'mdi:calendar-clock' }),
  timeText('bedtime_start', 'Bedtime start'),
  timeText('bedtime_end', 'Bedtime end'),
  num('minutes_to_drowsy', 'Minutes to drowsy', 0.25, 120, 0.25, 'min', 'box'),
  num('minutes_to_asleep', 'Minutes to asleep', 0.25, 120, 0.25, 'min', 'box'),
  num('bedtime_awake_minutes', 'Bedtime awake minutes', 0.25, 30, 0.25, 'min', 'box'),
  num('taps_to_wake', 'Taps to wake at bedtime', 1, 6, 1, null, 'slider'),
  toggle('wake_on_motion_at_bedtime', 'Wake on motion at bedtime', { config: true }),
  toggle('quiet_mode', 'Quiet mode', { icon: 'mdi:volume-off' }),
  toggle('sounds', 'Sounds', { icon: 'mdi:music-note' }),
  num('chirp_volume', 'Chirp volume', 0, 100, 1, '%', 'slider', { config: false }),
  num('voice_volume', 'Voice volume', 0, 100, 1, '%', 'slider', { config: false }),
  select('reply_voice', 'Reply voice', REPLY_VOICES, 'mdi:account-voice'),
  toggle('listen_on_eye_contact', 'Start listening on eye contact', { config: true, icon: 'mdi:eye-outline' }),
  toggle('mood_colour', 'Mood colour', { config: true, icon: 'mdi:palette' }),
  num('mood_colour_strength', 'Mood colour strength', 0, 100, 1, '%', 'slider'),
  select('mood_background', 'Mood background', MOOD_BACKGROUNDS, 'mdi:format-color-fill'),
  toggle('mood_background_at_bedtime', 'Mood background at bedtime', { config: true, icon: 'mdi:weather-night' }),
  toggle('eyebrows', 'Eyebrows', { config: true }),
  toggle('listening_glow', 'Listening glow', { config: true, icon: 'mdi:microphone-outline' }),
  toggle('screen_antics', 'Screen-edge antics', { config: true }),
  toggle('pupil_reactions', 'Pupil reactions', { config: true }),
  toggle('expressive_reactions', 'Expressive reactions', { config: true, icon: 'mdi:emoticon-wink-outline' }),
  { ...toggle('room_understanding', 'Room understanding', { config: true, icon: 'mdi:camera-outline' }),
    // Consent rule: HA may only turn it off (on needs an encrypted vision path, which doesn't exist yet).
    parse: (p) => { const b = parseOnOff(p); return b === false ? { value: false } : { error: b ? 'only the display can turn this on' : 'expected ON or OFF' }; } },
  button('force_sleep', 'Force sleep', 'mdi:sleep'),
  button('force_wake', 'Force wake', 'mdi:alarm'),
  button('wrong_reaction', 'Wrong reaction', 'mdi:hand-back-left-off'),
  { component: 'announce', platform: 'notify', config: { name: 'Announce', ic: 'mdi:message-text' } },
  { component: 'announcement', platform: 'event', config: { name: 'Announcement', evt_typ: [...ANNOUNCEMENT_OUTCOMES] } },
  sensor('face_state', { name: 'Face state', dev_cla: 'enum', ops: [...FACE_STATES], ic: 'mdi:eye' }),
  sensor('life_phase', { name: 'Life phase', dev_cla: 'enum', ops: [...LIFE_PHASES], ic: 'mdi:sleep' }),
  binary('bedtime_active', { name: 'Bedtime active', ic: 'mdi:weather-night' }),
];

const TAIL: Entity[] = [
  { component: 'last_gesture', platform: 'event', config: { name: 'Last gesture', evt_typ: [...GESTURES], ic: 'mdi:hand-wave' } },
  sensor('voice_services', { name: 'Voice services', ent_cat: 'diagnostic', dev_cla: 'enum', ops: [...VOICE_SERVICES], ic: 'mdi:account-voice' }),
  sensor('conversation_context', { name: 'Conversation context', ent_cat: 'diagnostic', ic: 'mdi:message-processing-outline' }),
  sensor('pending_messages', { name: 'Pending messages', ent_cat: 'diagnostic', stat_cla: 'measurement', ic: 'mdi:message-badge' },
    String, { attrs: (s) => ({ ids: s.pending_ids ?? [], expires: s.pending_expires ?? [] }) }),
  sensor('health', { name: 'Health', ent_cat: 'diagnostic', dev_cla: 'enum', ops: [...HEALTH_OVERALL], ic: 'mdi:heart-pulse' },
    String, { attrs: (s) => ({ degraded: s.health_degraded ?? [] }) }),
  sensor('started_at', { name: 'Started at', ent_cat: 'diagnostic', dev_cla: 'timestamp' }),
  sensor('last_restart', { name: 'Last restart', ent_cat: 'diagnostic', dev_cla: 'enum', ops: [...RESTART_KINDS], ic: 'mdi:restart' },
    String, { attrs: (s) => ({ time: s.last_restart_at ?? '' }) }),
  sensor('thermal_state', { name: 'Thermal state', ent_cat: 'diagnostic', dev_cla: 'enum', ops: [...THERMAL_STATES], ic: 'mdi:thermometer' }),
  sensor('resource_level', { name: 'Resource level', ent_cat: 'diagnostic', stat_cla: 'measurement', ic: 'mdi:speedometer' },
    String, { attrs: (s) => ({ reason: s.resource_reason ?? 'nominal' }) }),
  sensor('battery', { name: 'Battery', ent_cat: 'diagnostic', dev_cla: 'battery', unit_of_meas: '%', stat_cla: 'measurement' }),
  binary('power_plugged', { name: 'Plugged in', ent_cat: 'diagnostic', dev_cla: 'plug' }),
  binary('kiosk_lock', { name: 'Kiosk lock', ent_cat: 'diagnostic', ic: 'mdi:lock' }),
  // Published by the server every 60 s while the display is connected (with availability: "Yanni is not running").
  { component: 'last_seen', platform: 'sensor', config: { name: 'Last seen', ent_cat: 'diagnostic', dev_cla: 'timestamp', ic: 'mdi:heart' } },
  rate('false_engagements_per_hour', 'False engagements per hour', 'mdi:eye-off-outline'),
  rate('gesture_reactions_per_hour', 'Gesture reactions per hour', 'mdi:hand-wave'),
  rate('gesture_false_reports_per_hour', 'Gesture false reports per hour', 'mdi:hand-back-left-off'),
  binary('perception_recording', { name: 'Perception recording', ent_cat: 'diagnostic', ic: 'mdi:record-rec' }),
];

/** Every entity in discovery order; presence entities only while presence is shared. */
export function entities(sharePresence: boolean): Entity[] {
  return [...TABLE, ...(sharePresence ? PRESENCE : []), ...TAIL];
}

export const PRESENCE_ENTITIES = PRESENCE;

// Every setting that HA exposes must also pass the display-side check after parsing.
for (const e of TABLE) if (e.setting && !SETTINGS_CHECKS[e.setting]) throw new Error(`no check for ${e.setting}`);

export interface Identity { id: string; installId: string; room: string }

export const node = (d: Identity) => `yanni_${d.id}`;
export const baseTopic = (d: Identity) => `yanni/${d.id}`;
export const stateTopic = (d: Identity, c: string) => `${baseTopic(d)}/${c}/state`;
export const commandTopic = (d: Identity, c: string) => `${baseTopic(d)}/${c}/set`;
export const attributesTopic = (d: Identity, c: string) => `${baseTopic(d)}/${c}/attributes`;
export const availabilityTopic = (d: Identity) => `${baseTopic(d)}/availability`;
/** The add-on's own availability (its MQTT will): every display goes unavailable when the add-on stops. */
export const ADDON_AVAILABILITY = 'yanni/addon/availability';

/** The device-based discovery payload for `<prefix>/device/yanni_<id>/config`. */
export function discovery(d: Identity, sharePresence: boolean, appVersion: string, deviceModel: string): Json {
  const cmps: Json = {};
  for (const e of entities(sharePresence)) {
    const c: Json = { ...e.config, p: e.platform, uniq_id: `${node(d)}_${e.component}` };
    if (e.platform === 'button' || e.platform === 'notify') c.cmd_t = commandTopic(d, e.component);
    else {
      c.stat_t = stateTopic(d, e.component);
      if (e.parse) c.cmd_t = commandTopic(d, e.component);
    }
    if (e.attrs) c.json_attr_t = attributesTopic(d, e.component);
    cmps[e.component] = c;
  }
  // shortcut: removal stubs go out on every discovery while presence is off (HA ignores a stub for nothing);
  // track what was published if HA ever complains.
  if (!sharePresence) for (const e of PRESENCE) cmps[e.component] = { p: e.platform };
  return {
    dev: { ids: [`yanni-${d.installId}`], name: `Yanni ${d.room}`, mf: 'Quiet Luxury', mdl: deviceModel, sw: appVersion },
    o: { name: 'yanni', sw: appVersion },
    avty: [{ t: availabilityTopic(d) }, { t: ADDON_AVAILABILITY }],
    avty_mode: 'all',
    cmps,
  };
}
