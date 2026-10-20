# Yanni web: port plan

A TypeScript port of Yanni (the iPad app in `../yanni`), packaged as a Home Assistant add-on. A modern tablet browser (Chrome or Safari 26, WebGPU) shows the face. Everything that has to react instantly (face, perception, voice activity, voice) runs in that browser. The add-on serves the app and connects it to Home Assistant.

The canonical behaviour is `../yanni/docs/spec.md`. This port matches it unless this plan says otherwise. **The Swift code is read-only.** Nothing in `../yanni` is edited. The golden recorder only depends on its packages by path.

## Decisions
| Topic | Decision |
|---|---|
| Language | TypeScript (strict), Vite build, Vitest tests. No framework for the face, plain DOM for the owner pages. |
| GPU | WebGPU only (WGSL port of the one-pass SDF shader). No WebGL fallback. |
| Parity | Golden traces. A Swift recorder runs the real engine with fixed seeds and scripted inputs and writes per-frame `FaceFrame` vectors. The TS port must match them within tolerance. See `PORTING.md`. |
| v1 scope | Everything, including the look-to-talk conversation. |
| Swift app | Untouched. Whether it is frozen or kept in sync gets decided once this port proves itself. |
| Display URL | The kiosk display opens the add-on's **direct HTTPS port** (a secure context for the camera and mic, no iframe). **Ingress** hosts the owner pages (pairing, settings, status) behind HA's login. |
| HA access | The browser never holds an HA token. The add-on server uses `SUPERVISOR_TOKEN` to relay a **whitelisted** set of HA WebSocket calls (Assist pipeline, `jev.ask`, AI Task, conversation agent and similar), never a raw admin proxy. |
| Display auth | A pairing code is shown on the Ingress page. The display redeems it for a device token that it keeps in local storage, and every display WebSocket must present that token. |
| MQTT | The add-on server owns MQTT discovery (`services: mqtt:want`). It publishes each paired display as "Yanni ‹Room›" with the spec's entities and forwards settings and commands to the display over its socket. |
| STT | HA Assist pipeline STT (for example the Whisper add-on) by default. There is no on-device recogniser (Apple's doesn't exist on the web, and Web Speech sends audio to a cloud). |
| Turn models | The Silero VAD and Smart Turn ONNX models run in onnxruntime-web (WebGPU, falling back to WASM). |
| Perception | MediaPipe Tasks Vision (face landmarker, hand landmarker, pose landmarker) on the GPU, feeding a port of FacePerception's tracker, engagement and gesture logic. |

## Layout
```
yanni-addon/
  repository.yaml          HA add-on repository manifest
  addon/                   the add-on: config.yaml, Dockerfile, run script, icon
  server/                  Node 24: static files, display socket, HA relay, MQTT discovery, pairing, settings store
  web/                     the browser app
    src/model/             ← FaceModel           (expressions.json copied verbatim)
    src/engine/            ← FaceEngine          (modifiers, one-shots, idle games, edge antics…)
    src/life/              ← FaceLife
    src/emotion/           ← FaceEmotion
    src/voice/             ← FaceVoice           (AudioWorklet playback)
    src/render/            ← FaceRendering       (WGSL)
    src/perception/        ← FacePerception      (MediaPipe front end)
    src/conversation/      ← ConversationCore/Turn/Agent/Audio (HA pipeline over the relay)
    src/app/               kiosk shell, owner overlay, tuning/status pages
    test/                  Vitest: unit + golden parity
  tools/golden/            Swift package: the golden recorder (path dependency on ../../../yanni/Packages/YanniFace)
  fixtures/golden/         recorded traces (JSON, gzip if large)
  docs/                    PLAN.md, PORTING.md, decisions
```

## Phases and milestones
Each phase lists its work packages (WP). WPs in the same wave run as parallel sub-agents on disjoint folders.

### P0 Foundations (wave 1)
- **WP0 Scaffold** (done inline): repo, npm workspaces, TS, Vite, Vitest, the core math (`vec`, `SplitMix64`), porting rules.
- **WP1 Golden recorder**: a Swift CLI in `tools/golden` that drives `FaceEngine` (and later `LifeCycleController`, `EmotionLayer` and the voice generator) through named scenarios and writes `fixtures/golden/<scenario>.json`: per-frame `FaceFrame` fields plus the active one-shot kinds. Scenarios cover idle for 10 minutes, every one-shot, every idle beat, antic and game, engage and interrupt, agent-state tours, drowsy → asleep → waking, mood sweeps, touch, and pupil reactions.
- **WP2 FaceModel port**: all of `FaceModel` (ParamLayout, FacePose, Expression, ExpressionMix, BrowPose, EdgeGeometry, Oklab, PupilShape, VocalContour, FaceFrame), with unit tests ported from `FaceModelTests`.
- **WP3 Add-on + server skeleton**: `config.yaml` (ingress, a direct port, `homeassistant_api`, `mqtt:want`, ssl map), Dockerfile, Node server with static hosting, pairing, the display WebSocket, the whitelisted HA relay and a settings store in `/data`. Tested against a mock HA WebSocket.

### P1 Face engine (waves 2–3)
- **WP4 Engine core**: FaceState, Commands, AgentState and profiles, Modifier and Director, Composer, Spring, Easing, Noise, LidMath, ExpressionSprings, BrowSprings, the OneShot library, OneShotSampler, OneShotApply, the FaceEngine facade. The gate: the golden "rest" scenario (all modifiers off except the core) matches.
- **WP5–WP7 Modifiers** (three parallel agents, split by file): (5) attention, gaze, pupils, noticing, thinking, micro-motion; (6) one-shot curves, answer curves, pupil shapes, edge antics, idle beats, idle games, touch; (7) mood: modulation, colour, background, bursts, brightness, burn-in, lids and blink, breathing, squash, vocal sync, brows, listening glow, caption inset, expressive overlay. Each one ends when its golden scenarios match.

### P2 Renderer + shell (wave 3, alongside WP5–7) → **M1: it idles in a browser**
- **WP8 WGSL renderer**: port `EyeShader`, EyeGeometry, BrowGeometry, PupilGeometry, PupilGlyphs, MoodColorMix, FrameClock and FrameRatePolicy. Uniform packing mirrors `FaceRenderer`. Visual parity comes from a Swift tool that renders reference PNGs offscreen with Metal (added to `tools/golden`) and a headless Chrome WebGPU comparison.
- **WP9 Kiosk shell**: full screen, wake lock, a `requestAnimationFrame` loop on real `dt`, the visibility/pause policy, the tap and poke input, and an fps HUD.

### P3 Life, emotion, voice (wave 4) → **M2: the full silent and chirping face**
- **WP10 FaceLife**: the life-cycle controller, bedtime and resume. Golden scenarios from the recorder.
- **WP11 FaceEmotion**: the emotion layer, dynamics, rules, classifier, settings and the conversation simulator.
- **WP12 FaceVoice**: the procedural voice generator ported exactly (golden PCM hashes or sample traces), with playback in an AudioWorklet, an audio-unlock gesture, mute and volume.

### P4 Home Assistant (wave 4) → **M3: installable add-on showing the face**
- **WP13 HA integration**: MQTT discovery entities and topics (ported from YanniHome and YanniSettings), the retained-settings sync rule, announcements, the notify entity, the heartbeat and availability, the owner pages on Ingress (pairing, settings, status).

### P5 Perception (wave 5) → **M4: it sees you**
- **WP14 Perception port**: a MediaPipe front end that maps landmarks onto the features FacePerception expects. Port the tracker, association, engagement, eye contact, distance fusion, gestures, reflexes and coordinator. The synthetic scenes and replay become Vitest tests.

### P6 Conversation (wave 5–6) → **M5: you can talk to it**
- **WP15 Audio and turn**: `getUserMedia` with echo cancellation, resampling, Silero VAD and Smart Turn in onnxruntime-web, the turn pump, and barge-in.
- **WP16 Conversation agent**: session and phase machine, address policy, the HA Assist pipeline (STT and TTS) over the relay, `jev.ask` decisions, reply cleaning and sentence voicing (Spoken and Yanni babble), captions, proactive messages.

### P7 Hardening (wave 6) → **v1**
Tuning and Status pages (the useful subset of the Preview tool), a 24-hour soak (memory, frame-gap p99), burn-in protections, kiosk guide (Fully Kiosk / Safari guided access), multi-arch image build, README.

## Verification gates
- `npm test` is green: unit tests plus golden parity for every engine, life, emotion and voice scenario.
- Render parity: the WebGPU frames match the Metal reference PNGs within a per-pixel tolerance.
- Owner check by eye, on the tablet: idle, games and antics side by side with the iPad. Animation quality is the top priority.
- The add-on installs on a real HA and the display pairs. Settings round-trip through MQTT.

## Risks
| Risk | Mitigation |
|---|---|
| Float32 (Swift) vs float64 (JS) drift | The RNG matches exactly. Compare with a tolerance, and add `Math.fround` only where a branch is threshold-sensitive (see PORTING.md). |
| Browser frame pacing | Step on real `dt` with the engine's `maxDt` clamp, use a kiosk browser, add a frame-gap p99 HUD. |
| Echo cancellation weaker than iOS | Keep the existing echo margins and self-voice rejection, and tune by ear. Barge-in quality is a known gap. |
| The relay is a privilege escalation | A strict whitelist, device tokens and rate limits, with tests. |
| Perception quality vs Apple Vision | MediaPipe output is mapped onto the same feature contract, then re-tuned with the replay tools. |
