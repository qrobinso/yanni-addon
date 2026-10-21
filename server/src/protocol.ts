// The display <-> add-on WebSocket protocol (`/ws` on the display port). JSON text frames, plus binary frames for
// Assist pipeline audio. The web app imports these types with `import type { … } from '@yanni/server/protocol'`
// (npm workspace link; this file and its imports have no Node APIs, so Vite bundles them as is).
//
// Session: the display opens `/ws`, sends `hello` (with its device token) within 5 s, and gets `welcome`.
// Anything before a valid hello closes the socket (code 4401).

import { SETTING_KEYS, isValidSetting, settingDef, type Settings } from './settingsSchema.js';
import type { AnnounceCommand } from './announce.js';

export { MOOD_BACKGROUNDS, REPLY_VOICES } from './settingsSchema.js';

export const PROTOCOL_VERSION = 1;

// ---- Vocabulary (mirrors YanniHome's HomeEntities) ----

export const FACE_STATES = ['idle', 'noticing', 'engaged', 'listening', 'thinking', 'speaking', 'follow_up',
  'interrupted', 'not_for_me', 'confused', 'sheepish', 'has_message', 'drowsy', 'asleep', 'half_awake', 'waking'] as const;
export const LIFE_PHASES = ['awake', 'drowsy', 'asleep', 'half_awake', 'waking'] as const;
export const VOICE_SERVICES = ['connected', 'degraded', 'unreachable', 'not_configured'] as const;
export const GESTURES = ['wave', 'bye_wave', 'clap', 'arms_up', 'point', 'nod', 'thumbs_up', 'thumbs_down',
  'open_palm', 'peace', 'heart_hands', 'peekaboo', 'dance', 'high_five'] as const;
export const ANNOUNCEMENT_OUTCOMES = ['delivered', 'expired', 'cancelled', 'failed'] as const;
export const HEALTH_OVERALL = ['ok', 'degraded', 'safe_mode'] as const;
export const RESTART_KINDS = ['clean', 'reboot', 'crash', 'hang', 'self_restart'] as const;
export const THERMAL_STATES = ['nominal', 'fair', 'serious', 'critical'] as const;

export type FaceState = (typeof FACE_STATES)[number];
export type LifePhase = (typeof LIFE_PHASES)[number];
export type VoiceServicesState = (typeof VOICE_SERVICES)[number];
export type Gesture = (typeof GESTURES)[number];
export type AnnouncementOutcome = (typeof ANNOUNCEMENT_OUTCOMES)[number];

/** Every synced setting (the schema in settingsSchema.ts; `ha` marks the ones Home Assistant sees as entities).
 *  `room` is the device name "Yanni ‹room›" (a change republishes discovery); `share_presence` gates the presence
 *  entities. */
export type EntitySettings = Settings;

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
  /** Owner Status page only (not entities): the render loop (StatusReport.ts). */
  fps: number;
  frame_gap_p99_ms: number;
  render_tier: string;
}

/** What the add-on keeps per display for the owner Status page (memory only). */
export interface DisplayStatus {
  online: boolean;
  appVersion: string;
  deviceModel: string;
  connectedAt: string;
  lastSeenAt: string;
  state: Partial<DisplayState>;
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
  /** A notify payload, parsed and validated by the add-on (announce.ts). The display queues or applies it. */
  | { type: 'command'; command: 'announce'; announce: AnnounceCommand }
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

export const SETTINGS_CHECKS = Object.fromEntries(SETTING_KEYS.map((k) => {
  const def = settingDef(k);
  return [k, (v: unknown) => isValidSetting(def, v)];
})) as { [K in keyof EntitySettings]: Check };

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
  fps: isNum(0, 1000),
  frame_gap_p99_ms: isNum(0, 1e6),
  render_tier: isStr(32),
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
