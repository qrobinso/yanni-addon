// Entry point. In the add-on everything comes from the Supervisor (SUPERVISOR_TOKEN, /data/options.json, the MQTT
// service); outside HA set HA_URL + HA_TOKEN and MQTT_URL (see DOCS.md, "Development").
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HaRelay } from './relay.js';
import { connectBroker, HomeBridge, mqttCredentials } from './mqtt.js';
import { createDisplayServer, createIngressServer, INGRESS_GATEWAY } from './server.js';
import { Devices, SettingsStore } from './store.js';
import { log } from './log.js';

const env = process.env;
const dataDir = env.DATA_DIR ?? '/data';
const options = (() => {
  try { return JSON.parse(readFileSync(env.OPTIONS_FILE ?? join(dataDir, 'options.json'), 'utf8')); } catch { return {}; }
})() as { certfile?: string; keyfile?: string; default_room?: string; discovery_prefix?: string };

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const webRoot = env.WEB_ROOT ?? here('../../web/dist');
const ownerRoot = env.OWNER_ROOT ?? here('../public');
const displayPort = Number(env.DISPLAY_PORT ?? 8443);
const ingressPort = Number(env.INGRESS_PORT ?? 8099);

// HA: dev URL + token, else the Supervisor proxy.
const haWs = env.HA_URL ? `${env.HA_URL.replace(/^http/, 'ws').replace(/\/$/, '')}/api/websocket`
  : env.SUPERVISOR_TOKEN ? 'ws://supervisor/core/websocket' : undefined;
const haHttp = env.HA_URL ? env.HA_URL.replace(/\/$/, '') : env.SUPERVISOR_TOKEN ? 'http://supervisor/core' : undefined;
const haToken = env.HA_TOKEN ?? env.SUPERVISOR_TOKEN;

const devices = new Devices(dataDir);
const settings = new SettingsStore(dataDir);
const relay = haWs && haToken ? new HaRelay({ url: haWs, token: haToken }) : undefined;
if (relay) relay.start(); else log.warn('ha: no SUPERVISOR_TOKEN or HA_URL/HA_TOKEN; the relay is off');

let bridge: HomeBridge | undefined;
const deps = { devices, settings, relay, bridge: () => bridge, haHttp, haToken, defaultRoom: options.default_room };

const sslDir = env.SSL_DIR ?? '/ssl';
const certPath = join(sslDir, options.certfile ?? 'fullchain.pem');
const keyPath = join(sslDir, options.keyfile ?? 'privkey.pem');
const tls = existsSync(certPath) && existsSync(keyPath)
  ? { cert: readFileSync(certPath), key: readFileSync(keyPath) } : undefined;
if (!tls) {
  log.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  log.warn(`!! No certificate at ${certPath} / ${keyPath}: the display port is plain HTTP.`);
  log.warn('!! Browsers allow the camera and microphone only on HTTPS: Yanni cannot see or hear you.');
  log.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
}

// MQTT first, so displays that connect at once are published.
const creds = await mqttCredentials(env);
if (creds) {
  bridge = connectBroker(creds, (pub) => new HomeBridge(pub, settings, {
    send: (id, m) => displays.send(id, m), // displays is assigned below, before any socket opens
    device: (id) => { const d = devices.get(id); return d && { id: d.id, installId: d.installId, room: d.room }; },
  }, options.discovery_prefix ?? 'homeassistant')).bridge;
} else {
  log.warn('mqtt: no broker; displays will not appear in Home Assistant');
}

const { server: display, displays } = createDisplayServer(deps, webRoot, tls);
display.listen(displayPort, () => log.info(`display: ${tls ? 'https' : 'http'} on port ${displayPort}, serving ${webRoot}`));

const trusted = (env.INGRESS_TRUSTED ?? INGRESS_GATEWAY).split(',').map((s) => s.trim()).filter(Boolean);
const ingress = createIngressServer(deps, ownerRoot, trusted, (d) => {
  displays.disconnect(d.id);
  bridge?.remove({ id: d.id, installId: d.installId, room: d.room });
}, displays);
ingress.listen(ingressPort, () => log.info(`ingress: http on port ${ingressPort} (trusting ${trusted.join(', ')})`));

const stop = () => { relay?.stop(); display.close(); ingress.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
