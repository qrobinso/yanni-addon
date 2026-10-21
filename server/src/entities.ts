// The Home Assistant entity table: a port of YanniHome's HomeEntities (same components, names, options and
// unique_ids, so an iPad migrated with its install ID keeps its entities). The Swift-only `signature_expires`
// sensor is left out (a browser has no signing profile).
import { ANNOUNCEMENT_OUTCOMES, FACE_STATES, GESTURES, HEALTH_OVERALL, LIFE_PHASES, RESTART_KINDS, THERMAL_STATES,
  VOICE_SERVICES } from './protocol.js';
import type { DisplayState, EntitySettings, HaCommand } from './protocol.js';
import { HA_SETTING_KEYS, settingDef, type HaEntity, type SettingKey } from './settingsSchema.js';

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

const parseBool = (p: string): Parsed => {
  const b = parseOnOff(p);
  return b === undefined ? { error: 'expected ON or OFF' } : { value: b };
};

/** A setting's entity, from its schema entry (switch, number, text HH:MM or select). */
function settingEntity(key: SettingKey, ha: HaEntity): Entity {
  const def = settingDef(key);
  const config: Json = { name: ha.name };
  switch (def.type) {
    case 'bool':
      if (ha.config) config.ent_cat = 'config';
      if (ha.icon) config.ic = ha.icon;
      return { component: key, platform: 'switch', config, setting: key, encode: onOff, parse: parseBool };
    case 'number': {
      const { min: lo, max: hi, step } = def;
      Object.assign(config, { min: lo, max: hi, step, mode: ha.mode ?? 'box' });
      if (def.unit) config.unit_of_meas = def.unit;
      if (ha.config) config.ent_cat = 'config';
      if (ha.icon) config.ic = ha.icon;
      return { component: key, platform: 'number', config, setting: key, encode: (v) => formatNumber(Number(v), step),
        parse: (p) => {
          const v = Number(p.trim());
          if (p.trim() === '' || !Number.isFinite(v)) return { error: 'expected a number' };
          if (v < lo - step / 2 || v > hi + step / 2) return { error: 'out of range' };
          return { value: Math.round(Math.min(Math.max(v, lo), hi) / step) * step };
        } };
    }
    case 'time':
      Object.assign(config, { ent_cat: 'config', min: 5, max: 5, pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', ic: ha.icon });
      return { component: key, platform: 'text', config, setting: key, encode: hhmm,
        parse: (p) => { const m = parseHHMM(p); return m === undefined ? { error: 'expected HH:MM' } : { value: m }; } };
    case 'enum': {
      const ops = def.options;
      Object.assign(config, { ent_cat: 'config', ops: [...ops], ic: ha.icon });
      return { component: key, platform: 'select', config, setting: key, encode: String,
        parse: (p) => (ops.includes(p.trim()) ? { value: p.trim() } : { error: 'unknown option' }) };
    }
    default: throw new Error(`${key}: no Home Assistant platform for ${def.type}`);
  }
}

const SETTING_ENTITIES: Entity[] = HA_SETTING_KEYS.map((k) => {
  const e = settingEntity(k, settingDef(k).ha!);
  // Consent rule: HA may only turn room understanding off (on needs an encrypted vision path, which doesn't exist yet).
  if (k === 'room_understanding') e.parse = (p) => {
    const b = parseOnOff(p);
    return b === false ? { value: false } : { error: b ? 'only the display can turn this on' : 'expected ON or OFF' };
  };
  return e;
});

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
  ...SETTING_ENTITIES,
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
