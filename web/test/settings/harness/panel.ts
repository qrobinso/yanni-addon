// Dev harness for the kiosk Settings screen (screenshots: web/test/settings/screenshot.mjs). Served by the Vite dev
// server at /test/settings/harness/panel.html; a real FaceEngine and life cycle, no renderer, a fake add-on client.
import type { AppContext } from '../../../src/app/AppContext';
import { OwnerAccess } from '../../../src/app/OwnerAccess';
import { FaceEngine } from '../../../src/engine/FaceEngine';
import { LifeCycleController } from '../../../src/life/LifeCycleController';
import { attachSettings, memoryHub, openSettingsPanel } from '../../../src/settings';

const engine = new FaceEngine();
const life = new LifeCycleController(engine);
const ctx = {
  engine, life, voice: null, emotion: null, conversation: null, perception: null, hud: null,
  client: { status: 'connected', room: 'Living Room', deviceId: 'a1b2c3d4', haConnected: true },
  style: () => engine as never, setStyle: () => {}, logEvent: () => {}, now: () => performance.now() / 1000,
} as unknown as AppContext;
const hub = memoryHub(new URLSearchParams(location.search).has('changed') ? { mood_background: 'Mood', sounds: false } : {});
attachSettings(hub, ctx);
const store = new Map<string, string>();
const access = new OwnerAccess({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) });
if (new URLSearchParams(location.search).has('prompted')) hub.update('app', { pin_prompt_shown: true });
openSettingsPanel(ctx, hub, access, { appVersion: '0.1.0', idleTimeout: 3600 });
Object.assign(globalThis, { hub });
