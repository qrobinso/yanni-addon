# Changelog

## 0.1.0

First release.

- **The face in the browser.** Yanni's eyes render with WebGPU on the wall tablet, with the iPad app's motion:
  blinks, saccades, one-shots, idle games, screen-edge antics, the life cycle (idle, drowsy, asleep, waking,
  bedtime), the emotion layer, mood colours and the procedural voice.
- **Seeing and hearing on the tablet.** MediaPipe face, hand and pose tracking in a worker (eye contact, gestures,
  presence); Silero VAD and Smart Turn on onnxruntime-web for when someone starts and stops talking.
- **Conversation through Home Assistant.** Look to talk or hold to talk, the Assist pipeline (speech to text, the
  agent, text to speech), the optional `jev.ask` decision model, captions, announcements through each tablet's
  notify entity, and ending by voice ("that's all").
- **Fully offline.** All models and wasm runtimes are served by the add-on; nothing loads from a CDN.
- **The add-on.** Kiosk display port 8443 (HTTPS with the certificate in `/ssl`), owner pages on Ingress (pairing
  codes, displays, settings, status, announcements, help), per-device tokens, a whitelisted Home Assistant relay
  (the tablet never holds a token) and MQTT discovery: every paired tablet appears as "Yanni ‹Room›".
- One image for aarch64 and amd64 (`node:24-alpine`).
