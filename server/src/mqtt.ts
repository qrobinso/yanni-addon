// MQTT discovery and sync for every paired display (a port of YanniHome's HomeAssistantBridge, minus the parts the
// iPad needed for its own connection). The add-on is the MQTT client; each display is one HA device.
//
// Sync rule: settings are retained state topics, last writer wins. A display (re)connecting is the source of truth:
// its hello settings are stored and everything is republished. HA commands are non-retained `…/set` messages; a
// retained command is ignored and cleared, an empty payload ignored, a rejected or no-op command republishes the
// canonical state so HA's UI snaps back.
import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import { ADDON_AVAILABILITY, attributesTopic, availabilityTopic, discovery, entities, PRESENCE_ENTITIES, stateTopic,
  type Entity, type Identity } from './entities.js';
import type { DisplayState, EntitySettings, ServerMessage } from './protocol.js';
import type { SettingsStore } from './store.js';
import { log } from './log.js';

export interface Publisher {
  publish(topic: string, payload: string, retain: boolean): void;
  subscribe(filters: string[]): void;
}

export interface BridgeHooks {
  /** Send to the display's socket (false when it isn't connected). */
  send(id: string, msg: ServerMessage): boolean;
  /** A paired display by id (commands for unknown ids are dropped). */
  device(id: string): Identity | undefined;
}

interface Live {
  identity: Identity;
  state: Partial<DisplayState>;
  appVersion: string;
  deviceModel: string;
  heartbeat?: NodeJS.Timeout;
  faceTimer?: NodeJS.Timeout;
  lastFace: number;
}

export const HEARTBEAT_MS = 60_000;
export const FACE_STATE_MIN_MS = 1000;
export const MAX_ANNOUNCE_BYTES = 8192;

export class HomeBridge {
  private live = new Map<string, Live>();
  private last = new Map<string, string>();
  private birthTimer?: NodeJS.Timeout;
  private connectedAt = 0;

  constructor(private readonly pub: Publisher, private readonly settings: SettingsStore, private readonly hooks: BridgeHooks,
    private readonly prefix = 'homeassistant') {}

  // ---- Connection ----

  /** Every (re)connect: subscribe, online, then everything again for every connected display. */
  connected(): void {
    this.connectedAt = Date.now();
    this.last.clear();
    this.pub.subscribe(['yanni/+/+/set', `${this.prefix}/status`]);
    this.pub.publish(ADDON_AVAILABILITY, 'online', true);
    for (const l of this.live.values()) this.publishAll(l);
  }

  // ---- Display lifecycle ----

  displayOnline(identity: Identity, appVersion: string, deviceModel: string, state: Partial<DisplayState> = {}): void {
    this.displayOffline(identity.id, false);
    const l: Live = { identity, state: { ...state }, appVersion, deviceModel, lastFace: 0 };
    this.live.set(identity.id, l);
    this.publishAll(l);
    const beat = () => this.publish(stateTopic(identity, 'last_seen'), new Date().toISOString(), true, true);
    beat();
    l.heartbeat = setInterval(beat, HEARTBEAT_MS).unref();
  }

  displayOffline(id: string, announce = true): void {
    const l = this.live.get(id);
    if (!l) return;
    clearInterval(l.heartbeat);
    clearTimeout(l.faceTimer);
    this.live.delete(id);
    if (announce) this.publish(availabilityTopic(l.identity), 'offline', true, true);
  }

  isOnline(id: string): boolean { return this.live.has(id); }

  /** The display's settings changed (from the display or the owner pages). */
  settingsChanged(id: string, changed: (keyof EntitySettings)[], identity?: Identity): void {
    const l = this.live.get(id);
    if (!l) return;
    if (identity) l.identity = identity;
    if (changed.includes('room') || changed.includes('share_presence')) return this.publishAll(l);
    for (const e of this.table(id)) if (e.setting && changed.includes(e.setting)) this.publishEntity(l, e, false);
  }

  /** A state report: publish what changed (face_state at most once a second, keeping the trailing value). */
  report(id: string, values: Partial<DisplayState>): void {
    const l = this.live.get(id);
    if (!l) return;
    Object.assign(l.state, values);
    for (const e of this.table(id)) {
      if (!e.report || e.report === 'face_state') continue;
      this.publishEntity(l, e, false);
    }
    if ('face_state' in values) this.publishFaceState(l);
  }

  event(id: string, component: 'last_gesture' | 'announcement', payload: Record<string, unknown>): void {
    const l = this.live.get(id);
    if (!l) return;
    if (component === 'last_gesture' && !this.settings.get(id).share_presence) return; // only while presence is shared
    this.pub.publish(stateTopic(l.identity, component), JSON.stringify(payload), false);
  }

  /** A revoked display: remove the device from HA (empty retained discovery and states). */
  remove(identity: Identity): void {
    this.displayOffline(identity.id, false);
    this.publish(`${this.prefix}/device/yanni_${identity.id}/config`, '', true, true);
    for (const e of entities(true)) {
      if (['event', 'button', 'notify'].includes(e.platform)) continue;
      this.publish(stateTopic(identity, e.component), '', true, true);
      if (e.attrs) this.publish(attributesTopic(identity, e.component), '', true, true);
    }
    this.publish(availabilityTopic(identity), '', true, true);
  }

  // ---- Inbound ----

  message(topic: string, payload: Buffer, retain: boolean): void {
    if (topic === `${this.prefix}/status`) {
      // HA restarted: republish after 1–5 s, but not for the retained birth that arrives with our subscription.
      if (payload.toString() !== 'online' || Date.now() - this.connectedAt < 5000) return;
      clearTimeout(this.birthTimer);
      this.birthTimer = setTimeout(() => { for (const l of this.live.values()) this.publishAll(l); },
        1000 + Math.random() * 4000).unref();
      return;
    }
    const m = /^yanni\/([0-9a-f]{8})\/([a-z_]+)\/set$/.exec(topic);
    if (!m || payload.length === 0) return; // an empty payload is a retained clear, never a command
    const [, id, component] = m as unknown as [string, string, string];
    const identity = this.hooks.device(id);
    if (!identity) return;
    if (retain) {
      log.warn(`mqtt: retained command on ${component} ignored and cleared`);
      this.pub.publish(topic, '', true);
      return;
    }
    if (component === 'announce') return this.announce(identity, payload);
    const e = this.table(id).find((x) => x.component === component);
    if (!e) return;
    if (e.button) {
      if (!this.hooks.send(id, { type: 'command', command: e.button })) log.info(`mqtt: ${component} for offline ${id}`);
      return;
    }
    if (!e.parse || !e.setting) return;
    const r = e.parse(payload.toString('utf8').slice(0, 256));
    if ('error' in r) {
      log.info(`mqtt: ${component} rejected: ${r.error}`);
    } else {
      const values = { [e.setting]: r.value } as Partial<EntitySettings>;
      const changed = this.settings.merge(id, values);
      if (changed.length) this.hooks.send(id, { type: 'settings', values, origin: 'homeassistant' });
    }
    // Canonical state either way (a no-op or a rejection snaps HA's UI back).
    const l = this.live.get(id);
    if (l) this.publishEntity(l, e, true);
    else this.publishSetting(identity, e, true);
  }

  private announce(identity: Identity, payload: Buffer): void {
    const text = payload.length <= MAX_ANNOUNCE_BYTES ? payload.toString('utf8') : undefined;
    if (text !== undefined && this.hooks.send(identity.id, { type: 'command', command: 'announce', payload: text })) {
      log.info(`mqtt: announce for ${identity.id} (${payload.length} bytes)`); // never the text
      return;
    }
    let msgId = '';
    try { const o = JSON.parse(text ?? ''); if (typeof o?.id === 'string') msgId = o.id.slice(0, 64); } catch { /* plain text */ }
    this.pub.publish(stateTopic(identity, 'announcement'), JSON.stringify({ event_type: 'failed', id: msgId, kind: 'announce',
      reason: text === undefined ? 'too_large' : 'unavailable' }), false);
  }

  // ---- Outbound ----

  private table(id: string): Entity[] { return entities(this.settings.get(id).share_presence === true); }

  private publishAll(l: Live): void {
    const d = l.identity;
    const s = this.settings.get(d.id);
    const share = s.share_presence === true;
    this.publish(`${this.prefix}/device/yanni_${d.id}/config`,
      JSON.stringify(discovery(d, share, l.appVersion, l.deviceModel)), true, true);
    if (!share) for (const e of PRESENCE_ENTITIES) this.publish(stateTopic(d, e.component), '', true, false);
    for (const e of this.table(d.id)) this.publishEntity(l, e, true);
    this.publish(availabilityTopic(d), 'online', true, true);
  }

  private publishFaceState(l: Live): void {
    const wait = l.lastFace + FACE_STATE_MIN_MS - Date.now();
    const e = this.table(l.identity.id).find((x) => x.component === 'face_state')!;
    if (wait <= 0) { l.lastFace = Date.now(); this.publishEntity(l, e, false); return; }
    l.faceTimer ??= setTimeout(() => { l.faceTimer = undefined; l.lastFace = Date.now(); this.publishEntity(l, e, false); }, wait).unref();
  }

  private publishSetting(d: Identity, e: Entity, force: boolean): void {
    const v = e.setting ? this.settings.get(d.id)[e.setting] : undefined;
    if (v !== undefined && e.encode) this.publish(stateTopic(d, e.component), e.encode(v), true, force);
  }

  private publishEntity(l: Live, e: Entity, force: boolean): void {
    if (e.setting) return this.publishSetting(l.identity, e, force);
    if (!e.report) return;
    const v = l.state[e.report];
    if (v === undefined || v === null || !e.encode) return;
    this.publish(stateTopic(l.identity, e.component), e.encode(v), true, force);
    if (e.attrs) this.publish(attributesTopic(l.identity, e.component), JSON.stringify(e.attrs(l.state)), true, force);
  }

  /** Retained publishes are deduplicated by their last payload (no echo loops); `force` sends anyway. */
  private publish(topic: string, payload: string, retain: boolean, force: boolean): void {
    if (!force && this.last.get(topic) === payload) return;
    this.last.set(topic, payload);
    this.pub.publish(topic, payload, retain);
  }
}

export interface MqttCredentials { url: string; username?: string; password?: string }

/** Supervisor-provided broker (`services: mqtt:want`), else MQTT_URL / MQTT_USERNAME / MQTT_PASSWORD. */
export async function mqttCredentials(env: NodeJS.ProcessEnv): Promise<MqttCredentials | undefined> {
  if (env.MQTT_URL) return { url: env.MQTT_URL, username: env.MQTT_USERNAME, password: env.MQTT_PASSWORD };
  if (!env.SUPERVISOR_TOKEN) return undefined;
  try {
    const r = await fetch('http://supervisor/services/mqtt', { headers: { Authorization: `Bearer ${env.SUPERVISOR_TOKEN}` } });
    if (!r.ok) { log.warn(`mqtt: no broker from the Supervisor (HTTP ${r.status}); is the Mosquitto add-on installed?`); return undefined; }
    const { data } = (await r.json()) as { data: { host: string; port: number; ssl?: boolean; username?: string; password?: string } };
    return { url: `${data.ssl ? 'mqtts' : 'mqtt'}://${data.host}:${data.port}`, username: data.username, password: data.password };
  } catch (e) {
    log.warn(`mqtt: Supervisor services API failed: ${(e as Error).message}`);
    return undefined;
  }
}

/** The real broker connection (mqtt.js reconnects every 5 s; `bridge.connected()` runs on every CONNACK). */
export function connectBroker(creds: MqttCredentials, make: (pub: Publisher) => HomeBridge): { client: MqttClient; bridge: HomeBridge } {
  const opts: IClientOptions = {
    clientId: 'yanni-addon', username: creds.username, password: creds.password, keepalive: 30, reconnectPeriod: 5000,
    will: { topic: ADDON_AVAILABILITY, payload: Buffer.from('offline'), qos: 1, retain: true },
  };
  const client = connect(creds.url, opts);
  const bridge = make({
    publish: (t, p, retain) => { client.publish(t, p, { qos: 1, retain }); },
    subscribe: (f) => { client.subscribe(f, { qos: 1 }); },
  });
  client.on('connect', () => { log.info(`mqtt: connected to ${creds.url}`); bridge.connected(); });
  client.on('message', (topic, payload, packet) => bridge.message(topic, payload, packet.retain));
  client.on('error', (e) => log.warn(`mqtt: ${e.message}`));
  return { client, bridge };
}
