# Yanni

Yanni is a playful, eyes-only companion face for the home. It runs on a wall tablet in the browser and ships as a Home Assistant add-on. The tablet shows two expressive cartoon eyes and does everything that has to react instantly:
- the face, rendered with WebGPU
- perception through the camera
- voice activity and end-of-turn detection
- a procedural voice
- the emotion layer
- look-to-talk conversation

The add-on serves the app and connects it to Home Assistant.

**Priority #1: the motion.** The eyes must feel smooth, lifelike and playful. Any change that touches animation has to keep timing and feel exactly as they are. The reference traces (see Testing) are how we know.

The product spec, which describes every behaviour, is `../yanni/docs/spec.md`. Read the section relevant to your task before changing behaviour.

## Layout
```
repository.yaml        HA add-on repository manifest
addon/                 the add-on: config.yaml, Dockerfile, rootfs/run.sh, DOCS.md, CHANGELOG.md
scripts/stage-addon.sh builds web + server and copies them into addon/rootfs/app (run before a release)
server/                Node 24 add-on server (npm workspace @yanni/server)
  src/protocol.ts        display ⇄ add-on WebSocket protocol (imported by web as @yanni/server/protocol)
  src/settingsSchema.ts  every setting: type, default, range, HA exposure (@yanni/server/settings)
  src/relay.ts           whitelisted Home Assistant WebSocket relay (SUPERVISOR_TOKEN never leaves the server)
  src/mqtt.ts, entities.ts  MQTT discovery: each paired display appears as "Yanni ‹Room›"
  src/announce.ts        notify payload parsing → typed announce commands
  src/server.ts          display port (HTTPS, COOP/COEP) + ingress port (owner pages, gateway-only)
  owner/app.ts           owner pages (pairing, settings, status, announcements, help), built to public/app.js
web/                   the browser app (npm workspace @yanni/web)
  src/core/              vec helpers, seedable SplitMix64, log
  src/model/             face model: FacePose (51 params, ParamLayout), expressions.json, FaceFrame, EdgeGeometry, Oklab
  src/engine/            face engine: FaceEngine facade, FaceState, Director + 27 modifiers (modifiers/), one-shots, idle games, edge antics
  src/life/              life cycle: idle → drowsy → asleep → waking, bedtime, resume
  src/emotion/           emotion layer: felt/mood PAD, rules, classifier, decision mapping
  src/voice/             procedural voice: generator, VoiceDirector, AudioWorklet playback (playback/)
  src/render/            WebGPU renderer: EyeShader.wgsl (one full-screen SDF pass), CPU geometry, uniform packing
  src/perception/        tracker, engagement, eye contact, gestures, reflexes, coordinator; web/ = MediaPipe front end in a worker
  src/conversation/      turn detection (turn/, turnml/ Silero VAD + Smart Turn on onnxruntime-web), audio/, core/ controller,
                         agent/ (HA Assist pipeline, jev.ask gate, reply voicing), captions/, announcements/, home/
  src/app/               kiosk shell: main.ts frame loop, pairing, DisplayClient, touch, owner menu, HUD, settings application
  *.html                 index (kiosk) + demo pages: render-demo, voice-demo, turn-demo, perception-demo
  scripts/               fetch-models.mjs (ONNX + MediaPipe models into public/, sha256-pinned), kiosk/perception smoke tests
fixtures/golden/       reference traces (gzipped JSON) for engine, life, emotion and voice; FORMAT.md documents them
fixtures/render/       reference PNGs + frames.json for render parity
tools/golden/          Swift recorders that produce the fixtures from the reference engine (needs ../yanni)
docs/PLAN.md           architecture decisions and roadmap; docs/PORTING.md: numeric and code conventions
```

## Commands
Run from the repo root unless noted.
```sh
npm install
node web/scripts/fetch-models.mjs   # once: models + wasm into web/public (gitignored)
npm test                            # all workspaces (Vitest)
npm run build                       # web (tsc + vite) and server (tsc + owner bundle)
npm run dev                         # Vite dev server for web; demo pages at /render-demo.html etc.
npm run smoke -w web                # headless Chrome: pairing, socket, face renders, frame timings
npm run render:parity -w web        # headless Chrome WebGPU vs fixtures/render PNGs
cd web && npx tsc --noEmit          # typecheck web
```
To run locally end to end:
1. `npm run build`
2. `DATA_DIR=/tmp/yanni-data SSL_DIR=/nonexistent DISPLAY_PORT=8443 INGRESS_PORT=8099 INGRESS_TRUSTED=127.0.0.1 node server/dist/main.js`
3. Get a pairing code: `curl -XPOST localhost:8099/api/codes -H 'content-type: application/json' -d '{"room":"Office"}'`
4. Open http://localhost:8443 and enter the code.

To use a real HA in dev, add `HA_URL=… HA_TOKEN=…` (and `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`) to step 2. Append `?fakeha` to the display URL for a conversation loop that needs no HA. Append `?debug` for timings.

## Architecture in one breath
Each frame, `main.ts` does the following:
1. `FaceEngine.frame(t)`: the Director runs the modifiers in phases (behaviour → affect → expression → attention → motion → lids → output), then the Composer clamps everything into a `FaceFrame`.
2. The after-frame hooks run in a fixed order: voice → life → emotion → conversation.
3. `FaceRenderer.render(frame)` packs the uniforms and draws one fragment pass.

Perception runs in a worker and posts people, engagement and gestures to the coordinator, which drives the engine and life cycle. The tablet talks to the add-on over one WebSocket (`DisplayClient`), which carries:
- settings sync
- state reports
- commands
- `ha.call` relay requests
- binary STT audio

## Testing: the reference traces are the contract
- `fixtures/golden/*.json.gz` hold per-frame `FaceFrame` output for scripted scenarios: every one-shot, idle game and antic, the agent-state tours, mood sweeps, touch, 10-minute idle runs, life-cycle runs, plus emotion and voice traces in subfolders.
- `web/test/golden/harness.ts` replays each scenario's input script against the TS engine and compares every field with tolerance. A failure names the first diverging frame, field and lane.
- **Never loosen a tolerance or skip a golden scenario to make a change pass.** If behaviour must change on purpose, regenerate the fixture: `cd tools/golden && swift run -c release golden-record <scenario>`, then `--check`. Explain why in the commit.
- Debug a divergence with `compareUntilDivergence`.
- Render parity (`npm run render:parity -w web`) holds WebGPU output to within 1 code value of the reference PNGs.
- Unit tests sit in `web/test/<area>/` and `server/test/`. `npm test` must stay green.

## Conventions that matter (details in docs/PORTING.md)
- **Determinism:**
  - All engine randomness comes from the single `SplitMix64` in `FaceState`, seeded at construction.
  - Consuming the RNG in a different order changes every trace after it, so keep the call order.
  - Never use `Math.random` in engine, life, emotion, voice or perception logic.
- **Float32 where it matters:** the engine's reference behaviour is float32. Values that sit exactly on a frame boundary or threshold use `Math.fround`, marked with a `// f32:` comment: dt, one-shot playheads and durations, beat clocks, blink tails, K-of-N gesture checks. Keep them, and add new ones only when a trace proves the need.
- **Value semantics:** many types are `struct`-like (FacePose, BrowPose, settings, ExpressionMix). Copy before mutating anything you didn't create.
  - Some accessors return live objects for zero allocation: `ExpressionLibrary.get`, `life.settings` is a copy, `layer.dynamics` is live. Their doc comments say which.
  - Settings objects are immutable in practice. Reassign them with `x.settings = x.settings.with({...})`, because mutating a field in place doesn't notify anything.
- **Modifiers:** each is self-contained, with one file in `src/engine/modifiers/`, registered in `modifiers/index.ts` (`defaultModifierOrder` + `modifierFactories`). Facade lookups go through `director.modifier(name)` and tolerate a modifier being absent.
- **Hot paths:** no per-frame allocation in the engine. Reuse scratch objects and clear arrays with `arr.length = 0`. The renderer reuses its uniform buffer. Engine p99 is about 0.5 ms; keep it under 2 ms.
- **Cross-origin isolation:** the display page is COOP/COEP isolated, which onnxruntime-web threads need. Every asset (models, wasm, fonts) must be self-hosted under `web/public`. CDNs are blocked.
- **Security:**
  - The browser never holds an HA token.
  - New HA calls must be added to the relay whitelist in `server/src/relay.ts`, with tests.
  - Display routes need the device token, and ingress routes accept only the gateway address.
  - Never log tokens, codes, transcripts or message text.
- **Settings:** add a setting in `server/src/settingsSchema.ts` (type, default, range, HA exposure). The server entities, the owner pages and `web/src/app/FaceSettings.ts` all derive from it. Keep existing MQTT topic names and unique_ids stable.
- **Style:**
  - TypeScript strict, ES modules.
  - Name things after the domain: `Blink`, `IdleGames`, `EdgeAntics`.
  - Keep doc comments short and about the why.
  - Write a `port-note:` comment where a behaviour looks odd but is intentional and covered by a trace.
- **Accessibility:** the face canvas is one labelled element. Owner UI uses real labelled controls. Respect `prefers-reduced-motion`; the engine has Reduce Motion paths.

## Things that need real hardware or a real HA
These all depend on the tablet or on Home Assistant itself, so they can't be checked in CI:
- frame pacing and GC on the tablet
- WebGPU on Safari
- MediaPipe head-pose and handedness signs (raise your right hand)
- camera field of view and offset
- echo cancellation and barge-in
- MQTT discovery on a real broker
- the Assist pipeline through the relay
- the ingress iframe

Say so in your report when a change touches one of these.
