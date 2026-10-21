# Yanni

Yanni is a friendly face for a wall tablet. The tablet's browser runs the face, the camera and the microphone; this
add-on serves the app, pairs tablets, relays a short list of Home Assistant calls for them, and shows every tablet
in Home Assistant as a device called "Yanni ‹Room›".

Everything the tablet needs ships inside the add-on: the face, the turn-detection models (Silero VAD, Smart Turn),
the MediaPipe face, hand and pose models and both wasm runtimes. Nothing loads from the internet, at install or at
run time, so Yanni keeps working with no internet connection (speech still needs your Assist pipeline).

## Installing

1. In Home Assistant open **Settings → Add-ons → Add-on store**, then **⋮ → Repositories**, and add
   `https://github.com/qrobinso/yanni-addon`.
2. Install **Yanni** and start it. Home Assistant builds the image on the device; it is about 120 MB, mostly
   models.
3. Turn on **Show in sidebar** to reach the owner pages.

## Before you start

- **MQTT.** Install the Mosquitto broker add-on and the MQTT integration. Yanni finds the broker by itself.
- **A certificate.** Browsers allow the camera and microphone only over HTTPS. Put a certificate and its key in
  `/ssl` (the Let's Encrypt or DuckDNS add-ons do this) and name them in the options. Without them the display port
  falls back to plain HTTP and the log warns loudly: the face works, but Yanni cannot see or hear.
- **Assist.** Speech goes through your Assist pipeline (for example Whisper and Piper).

## Options

| Option | Default | Meaning |
|---|---|---|
| `certfile` | `fullchain.pem` | Certificate in `/ssl` for the display port. |
| `keyfile` | `privkey.pem` | Its private key in `/ssl`. |
| `default_room` | `Living Room` | Pre-filled room for a new pairing code. |
| `discovery_prefix` | `homeassistant` | The MQTT discovery prefix. |

The display port is 8443. Change the host port under the add-on's **Network** settings.

## Pairing a tablet

1. Open **Yanni** in the sidebar and make a pairing code for the room.
2. On the tablet, open the display URL, `https://<your Home Assistant host>:8443/` (the host name must match the
   certificate), and enter the code. Codes work once and expire after 10 minutes.
3. The tablet keeps its device token. Revoke it on the same page; that also removes it from Home Assistant.

Before it is paired (or while no Assist pipeline answers) the tablet behaves as the iPad app does without voice
services: the conversation loop stays dormant ("voice services not set up"), the microphone never opens, and the
look-to-talk dry run gives the engaged look while someone holds eye contact. Hold to talk answers with a small
sheepish "can't".

Moving from the iPad app: enter its install ID (iPad Settings → Status) when making the code, and the tablet keeps
the iPad's MQTT node, topics and entity IDs.

## Kiosk tips

- **Browser.** The face draws with WebGPU: Safari on iPadOS 26 or later, or a recent Chrome. Use a kiosk browser
  such as Fully Kiosk, or Safari with Guided Access, and allow the camera and microphone for the display URL.
- **Screen.** The page keeps the screen awake while it is visible; still turn off auto-lock or set it long, and
  leave the tablet plugged in.
- **Sound.** If the browser blocks autoplay, a hint asks for one tap; after that the voice plays.
- **Owner menu.** Hold the bottom-right corner for 2.5 seconds for Settings, Status and Tuning. Settings and Tuning
  can be locked with a 4-digit PIN.
- **Talking.** Look at Yanni to talk, or hold the face to talk. Say "that's all" or "go away" to close the mic.
- **Reduce Motion.** The tablet's Reduce Motion setting calms the face.

## What the tablet may ask Home Assistant

The tablet never holds a Home Assistant token. The add-on forwards only:

- `assist_pipeline/run` (stt, intent and tts stages; STT audio as binary frames to the run's own handler),
  `assist_pipeline/pipeline/list` and `/get`
- `conversation/process`, `conversation/agent/list`
- `call_service` for `jev.ask` and `ai_task.generate_data` only, always with `return_response`, never with a target
  or AI Task attachments
- `config_entries/get` for the `jev` domain
- `get_states`, trimmed to `ai_task`, `conversation`, `stt`, `tts` and `assist_satellite` entities (id, state,
  friendly name)
- `unsubscribe_events` for the tablet's own runs
- TTS audio (`/api/tts_proxy/…`) through the display port

Everything else is refused. Each tablet gets 30 calls in a burst, refilled at one a second, and 16 open calls.

## Entities

Each tablet appears as "Yanni ‹Room›" with the iPad app's entities: bedtime switch, schedule and times, minutes to
drowsy and asleep, bedtime awake minutes, taps to wake, wake on motion, quiet mode, sounds, chirp and voice volume,
reply voice, start listening on eye contact, mood colour and strength, mood background (and at bedtime), eyebrows,
listening glow, screen-edge antics, pupil reactions, expressive reactions, room understanding (Home Assistant can only
turn it off), Force sleep / Force wake / Wrong reaction buttons, the Announce notify entity, Announcement and Last
gesture events, face state, life phase, bedtime active, person present and people count (only while presence is
shared), and diagnostics (voice services, conversation context, pending messages, health, started at, last restart,
thermal state, resource level, battery, plugged in, kiosk lock, last seen, perception rates and recording).

A tablet is unavailable while it is not connected, and every tablet is unavailable while the add-on is stopped.
`last_seen` updates every minute while it is connected.

## Development

The add-on folder is the Docker build context and holds no sources. `scripts/stage-addon.sh` builds the web app,
bundles the server into one ESM file with its dependencies (`npm run bundle -w server`, esbuild) and copies both into
`addon/rootfs/app`. It runs `web/scripts/fetch-models.mjs` first (SHA-256 pinned; downloads only what is missing)
and fails if a model or wasm runtime did not make it into the stage. Run it before a release and commit what it
stages: Home Assistant builds the image on the device from this repository, so the models must be in it. Everything
staged is plain JavaScript, so one `node:24-alpine` Dockerfile serves aarch64 and amd64.
`SMOKE_STAGED=1 npm run smoke -w web` runs the kiosk smoke against the staged app.

Run the server against a real Home Assistant from the repo:

```sh
npm run build -w server
HA_URL=http://homeassistant.local:8123 HA_TOKEN=<long-lived token> \
MQTT_URL=mqtt://homeassistant.local:1883 MQTT_USERNAME=<user> MQTT_PASSWORD=<pass> \
DATA_DIR=./.data SSL_DIR=./.ssl INGRESS_TRUSTED=127.0.0.1,::1 \
node server/dist/main.js
```

Then the owner pages are on `http://localhost:8099/` and the display on port 8443 (`DISPLAY_PORT`, `INGRESS_PORT`,
`WEB_ROOT` and `OWNER_ROOT` override the defaults). A long-lived token from a non-admin user is enough for
everything the relay allows.

The display protocol lives in `server/src/protocol.ts`. The web app imports it with
`import type { ClientMessage, ServerMessage } from '@yanni/server/protocol'` (the workspace package's export).
