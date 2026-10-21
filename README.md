# Yanni

Yanni is a playful, eyes-only companion face for a wall tablet. The tablet's browser draws two expressive cartoon
eyes (WebGPU), watches the room through the camera, listens for when someone talks to it, and answers through your
Home Assistant Assist pipeline. This repository is the Home Assistant add-on that serves the app, pairs tablets,
relays a short whitelist of Home Assistant calls (the tablet never holds a token) and shows every tablet in Home
Assistant as a device called "Yanni ‹Room›". All models and runtimes ship inside the add-on, so it works offline.

## Install

1. In Home Assistant open **Settings → Add-ons → Add-on store → ⋮ → Repositories** and add
   `https://github.com/qrobinso/yanni-addon`.
2. Install **Yanni**, start it and turn on **Show in sidebar**.
3. Put a certificate in `/ssl` (Let's Encrypt or DuckDNS add-on): browsers only allow the camera and microphone over
   HTTPS. Install the Mosquitto broker and the MQTT integration for the entities.

## Open the display and pair

1. Open **Yanni** in the sidebar and make a pairing code for the room.
2. On the tablet, open `https://<your Home Assistant host>:8443/` (the host name must match the certificate) and
   enter the code. The tablet keeps its device token; revoke it on the same page.

Until a tablet is paired the face still lives: it notices people and looks engaged when you look at it (the
look-to-talk dry run), but the microphone never opens.

## Kiosk tips

- Use Safari on iPadOS 26+ (or a recent Chrome) in a kiosk browser such as Fully Kiosk, or Safari with Guided
  Access, and allow the camera and microphone for the display URL.
- Leave the tablet plugged in with auto-lock off or long; the page keeps the screen awake while visible.
- If the browser blocks autoplay, tap once when the hint asks.
- Hold the bottom-right corner 2.5 s for the owner menu (Settings, Status, Tuning with developer tools on). A
  four-finger press opens it too; keep it 10 s for Reset if you forgot the PIN.
- Look at Yanni to talk, or hold the face. Say "that's all" or "go away" to close the mic.

More in [addon/DOCS.md](addon/DOCS.md). Developers: see [CLAUDE.md](CLAUDE.md) for the layout, commands and tests.
