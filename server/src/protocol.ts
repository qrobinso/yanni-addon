// The display <-> add-on WebSocket protocol (`/ws` on the display port). JSON text frames, plus binary frames for
// Assist pipeline audio. The web app imports these types with `import type { … } from '@yanni/server/protocol'`
// (npm workspace link; this file has no imports and no Node APIs, so Vite bundles it as is).
//
// Session: the display opens `/ws`, sends `hello` (with its device token) within 5 s, and gets `welcome`.
// Anything before a valid hello closes the socket (code 4401).

export const PROTOCOL_VERSION = 1;

// ---- Vocabulary (mirrors YanniHome's HomeEntities) ----

export const FACE_STATES = ['idle', 'noticing', 'engaged', 'listening', 'thinking', 'speaking', 'follow_up',
  'interrupted', 'not_for_me', 'confused', 'sheepish', 'has_message', 'drowsy', 'asleep', 'half_awake', 'waking'] as const;
export const LIFE_PHASES = ['awake', 'drowsy', 'asleep', 'half_awake', 'waking'] as const;
export const VOICE_SERVICES = ['connected', 'degraded', 'unreachable', 'not_configured'] as const;
export const GESTURES = ['wave', 'bye_wave', 'clap', 'arms_up', 'point', 'nod', 'thumbs_up', 'thumbs_down',
  'open_palm', 'peace', 'heart_hands', 'peekaboo', 'dance', 'high_five'] as const;
export const ANNOUNCEMENT_OUTCOMES = ['delivered', 'expired', 'cancelled', 'failed'] as const;
export const REPLY_VOICES = ['Spoken', 'Yanni'] as const;
export const MOOD_BACKGROUNDS = ['Black', 'Mood', 'Fixed colour'] as const;
export const HEALTH_OVERALL = ['ok', 'degraded', 'safe_mode'] as const;
export const RESTART_KINDS = ['clean', 'reboot', 'crash', 'hang', 'self_restart'] as const;
export const THERMAL_STATES = ['nominal', 'fair', 'serious', 'critical'] as const;

export type FaceState = (typeof FACE_STATES)[number];
export type LifePhase = (typeof LIFE_PHASES)[number];
export type VoiceServicesState = (typeof VOICE_SERVICES)[number];
export type Gesture = (typeof GESTURES)[number];
export type AnnouncementOutcome = (typeof ANNOUNCEMENT_OUTCOMES)[number];

/** The settings Home Assistant can see and change, in Home Assistant's units (keys = entity components). */
export interface EntitySettings {
  /** Device name is "Yanni ‹room›" (not an entity; a change republishes discovery). */
  room: string;
  /** Presence entities exist only while this is on (not an entity). */
  share_presence: boolean;
  bedtime: boolean;
  bedtime_schedule: boolean;
  /** Minutes after midnight (HA sees HH:MM). */
  bedtime_start: number;
  bedtime_end: number;
  minutes_to_drowsy: number;
  minutes_to_asleep: number;
  bedtime_awake_minutes: number;
  taps_to_wake: number;
  wake_on_motion_at_bedtime: boolean;
  quiet_mode: boolean;
  /** Sounds on (= not muted). */
  sounds: boolean;
  /** Percent 0–100. */
  chirp_volume: number;
  voice_volume: number;
  reply_voice: (typeof REPLY_VOICES)[number];
  listen_on_eye_contact: boolean;
  mood_colour: boolean;
  mood_colour_strength: number;
  mood_background: (typeof MOOD_BACKGROUNDS)[number];
  mood_background_at_bedtime: boolean;
  eyebrows: boolean;
  listening_glow: boolean;
  screen_antics: boolean;
  pupil_reactions: boolean;
  expressive_reactions: boolean;
  /** Camera snapshots. HA may only turn it off (no encrypted vision path exists yet). */
  room_understanding: boolean;
}

/** Live values the display reports (send only what changed). Null = unknown (nothing is published). */
export interface DisplayState {
  face_state: FaceState;
  life_phase: LifePhase;
  bedtime_active: boolean;
  person_present: boolean;
  people_count: number;
  voice_services: VoiceServicesState;
  /** The agent's context sentence (fixed vocabulary, never anyone's words, ≤ 255 chars, "none" when empty). */
  conversation_context: string;
  pending_messages: number;
  pending_ids: string[];
  /** ISO 8601, parallel to pending_ids. */
  pending_expires: string[];
  health: (typeof HEALTH_OVERALL)[number];
  health_degraded: string[];
  started_at: string | null;
  last_restart: (typeof RESTART_KINDS)[number] | null;
  last_restart_at: string | null;
  thermal_state: (typeof THERMAL_STATES)[number];
  resource_level: number;
  resource_reason: string;
  battery: number | null;
  power_plugged: boolean | null;
  kiosk_lock: boolean;
  false_engagements_per_hour: number;
  gesture_reactions_per_hour: number;
  gesture_false_reports_per_hour: number;
  perception_recording: boolean;
}

export type HaCommand = 'force_sleep' | 'force_wake' | 'wrong_reaction';

/** A Home Assistant WebSocket command without its `id` (the relay assigns upstream ids). */
export interface HaRequest {
  type: string;
  [key: string]: unknown;
}

// ---- Display -> add-on ----

export type ClientMessage =
  | { type: 'hello'; protocol: number; token: string; appVersion: string; deviceModel?: string;
      /** The display is the source of truth on (re)connect: its values are stored and republished. */
      settings: Partial<EntitySettings>; state?: Partial<DisplayState> }
  | { type: 'settings'; values: Partial<EntitySettings> }
  | { type: 'state'; values: Partial<DisplayState> }
  | { type: 'event'; entity: 'last_gesture'; eventType: Gesture }
  | { type: 'event'; entity: 'announcement'; eventType: AnnouncementOutcome; id: string; reason?: string }
  /** `id` is the display's own (positive integer, unique per socket); results and events come back under it. */
  | { type: 'ha.call'; id: number; request: HaRequest };

// Binary frames (display -> add-on): Assist pipeline STT audio, exactly HA's format: byte 0 = the
// `stt_binary_handler_id` from the run's `run-start` event, then 16-bit LE PCM; a frame of only the handler byte ends
// the audio. Only a handler id of one of this display's own runs is accepted.

// ---- Add-on -> display ----

export type ServerMessage =
  | { type: 'welcome'; protocol: number; deviceId: string; room: string; settings: Partial<EntitySettings>;
      ha: { connected: boolean } }
  /** Settings changed elsewhere (Home Assistant or the owner pages). Apply without echoing back. */
  | { type: 'settings'; values: Partial<EntitySettings>; origin: 'homeassistant' | 'owner' }
  | { type: 'command'; command: HaCommand }
  /** The raw notify payload (plain text or the JSON announce / nudge / cancel object; ≤ 8 KB). The display parses it. */
  | { type: 'command'; command: 'announce'; payload: string }
  | { type: 'ha.result'; id: number; success: true; result: unknown }
  | { type: 'ha.result'; id: number; success: false; error: { code: string; message: string } }
  | { type: 'ha.event'; id: number; event: unknown }
  /** The upstream HA connection went up or down. Down ends every subscription. */
  | { type: 'ha.status'; connected: boolean }
  | { type: 'error'; code: string; message: string };

// ---- Validation (the server checks every inbound frame; the web app may use it in tests) ----

type Check = (v: unknown) => boolean;
const isBool: Check = (v) => typeof v === 'boolean';
const isStr = (max: number): Check => (v) => typeof v === 'string' && v.length <= max;
const isNum = (lo: number, hi: number): Check => (v) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const oneOf = (list: readonly string[]): Check => (v) => typeof v === 'string' && list.includes(v);
const orNull = (c: Check): Check => (v) => v === null || c(v);
const strList: Check = (v) => Array.isArray(v) && v.length <= 50 && v.every(isStr(64));

export const SETTINGS_CHECKS: { [K in keyof EntitySettings]: Check } = {
  room: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 40,
  share_presence: isBool,
  bedtime: isBool,
  bedtime_schedule: isBool,
  bedtime_start: (v) => Number.isInteger(v) && isNum(0, 1439)(v),
  bedtime_end: (v) => Number.isInteger(v) && isNum(0, 1439)(v),
  minutes_to_drowsy: isNum(0.25, 120),
  minutes_to_asleep: isNum(0.25, 120),
  bedtime_awake_minutes: isNum(0.25, 30),
  taps_to_wake: (v) => Number.isInteger(v) && isNum(1, 6)(v),
  wake_on_motion_at_bedtime: isBool,
  quiet_mode: isBool,
  sounds: isBool,
  chirp_volume: isNum(0, 100),
  voice_volume: isNum(0, 100),
  reply_voice: oneOf(REPLY_VOICES),
  listen_on_eye_contact: isBool,
  mood_colour: isBool,
  mood_colour_strength: isNum(0, 100),
  mood_background: oneOf(MOOD_BACKGROUNDS),
  mood_background_at_bedtime: isBool,
  eyebrows: isBool,
  listening_glow: isBool,
  screen_antics: isBool,
  pupil_reactions: isBool,
  expressive_reactions: isBool,
  room_understanding: isBool,
};

export const STATE_CHECKS: { [K in keyof DisplayState]: Check } = {
  face_state: oneOf(FACE_STATES),
  life_phase: oneOf(LIFE_PHASES),
  bedtime_active: isBool,
  person_present: isBool,
  people_count: (v) => Number.isInteger(v) && isNum(0, 100)(v),
  voice_services: oneOf(VOICE_SERVICES),
  conversation_context: isStr(255),
  pending_messages: (v) => Number.isInteger(v) && isNum(0, 1000)(v),
  pending_ids: strList,
  pending_expires: strList,
  health: oneOf(HEALTH_OVERALL),
  health_degraded: strList,
  started_at: orNull(isStr(40)),
  last_restart: orNull(oneOf(RESTART_KINDS)),
  last_restart_at: orNull(isStr(40)),
  thermal_state: oneOf(THERMAL_STATES),
  resource_level: (v) => Number.isInteger(v) && isNum(0, 10)(v),
  resource_reason: isStr(64),
  battery: orNull(isNum(0, 100)),
  power_plugged: orNull(isBool),
  kiosk_lock: isBool,
  false_engagements_per_hour: isNum(0, 1e6),
  gesture_reactions_per_hour: isNum(0, 1e6),
  gesture_false_reports_per_hour: isNum(0, 1e6),
  perception_recording: isBool,
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every key known and every value valid (a partial record). */
function validRecord(v: unknown, checks: Record<string, Check>): boolean {
  return isObj(v) && Object.entries(v).every(([k, x]) => Object.hasOwn(checks, k) && checks[k]!(x));
}

/** Parses and validates one inbound text frame. Returns the message, or an error string. */
export function parseClientMessage(text: string): ClientMessage | { error: string } {
  let m: unknown;
  try { m = JSON.parse(text); } catch { return { error: 'not JSON' }; }
  if (!isObj(m) || typeof m.type !== 'string') return { error: 'expected an object with a type' };
  const settingsOk = (v: unknown) => validRecord(v, SETTINGS_CHECKS);
  const stateOk = (v: unknown) => validRecord(v, STATE_CHECKS);
  switch (m.type) {
    case 'hello':
      if (typeof m.protocol !== 'number' || !isStr(200)(m.token) || !isStr(40)(m.appVersion)
        || (m.deviceModel !== undefined && !isStr(80)(m.deviceModel))) return { error: 'bad hello' };
      if (!settingsOk(m.settings)) return { error: 'bad settings' };
      if (m.state !== undefined && !stateOk(m.state)) return { error: 'bad state' };
      break;
    case 'settings':
      if (!settingsOk(m.values)) return { error: 'bad settings' };
      break;
    case 'state':
      if (!stateOk(m.values)) return { error: 'bad state' };
      break;
    case 'event':
      if (m.entity === 'last_gesture') {
        if (!oneOf(GESTURES)(m.eventType)) return { error: 'unknown gesture' };
      } else if (m.entity === 'announcement') {
        if (!oneOf(ANNOUNCEMENT_OUTCOMES)(m.eventType) || !isStr(64)(m.id)
          || (m.reason !== undefined && !isStr(64)(m.reason))) return { error: 'bad announcement event' };
      } else return { error: 'unknown event entity' };
      break;
    case 'ha.call':
      if (!Number.isSafeInteger(m.id) || (m.id as number) <= 0) return { error: 'ha.call needs a positive integer id' };
      if (!isObj(m.request) || typeof m.request.type !== 'string' || 'id' in m.request) {
        return { error: 'ha.call needs a request with a type and no id' };
      }
      break;
    default:
      return { error: `unknown message type ${String(m.type).slice(0, 40)}` };
  }
  return m as unknown as ClientMessage;
}
