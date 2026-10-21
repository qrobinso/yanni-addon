# Kiosk services: iOS → browser mapping

`web/src/kiosk/` ports the Swift kiosk hardening layer: `YanniKiosk`, `FaceRuntime` (recorder, leak alarm, vitals,
soak), `YanniDevice` and the app's `Kiosk/` folder. The logic is ported 1:1 wherever it is platform-neutral:
- resource governor levels and budgets
- watchdog backoff and circuit breaker
- hang thresholds
- crash-loop rules and probation
- leak alarm
- soak verdict
- spoken-state throttle
- device defaults
- Health card wording

Only the platform signals change. Each mapping is listed below.

| iOS / Swift | Browser | Notes |
|---|---|---|
| `ProcessInfo.thermalState` | The worse of the **Compute Pressure API** (`PressureObserver`, `cpu`: nominal / fair / serious / critical) and **frame-time pressure**: the face's own drop rate, smoothed over about 10 s; above 10 % counts as fair, above 25 % as serious | Compute Pressure is Chromium only. Frame-time pressure never reaches critical. |
| Low Power Mode | none, always `false` | No browser exposes it. |
| `UIDevice.batteryLevel` / `batteryState` | **Battery Status API** (`navigator.getBattery()`: `level`, `charging`) | Chromium only. Safari reports `null`, so HA shows unknown. Unplugged still debounces 2 min. |
| Memory warning (`didReceiveMemoryWarning`, memory-pressure source) | The JS heap above 90 % of `jsHeapSizeLimit` (`performance.memory`), edge-triggered (clears below 80 %) | Chromium only. Safari has no warning at all. |
| `phys_footprint` | `performance.measureUserAgentSpecificMemory()` (the page is cross-origin isolated), else `performance.memory.usedJSHeapSize`, else 0 | The precise measure waits for a GC (up to about 20 s, timed out at 30 s). |
| `os_proc_available_memory()` | `jsHeapSizeLimit − usedJSHeapSize`, else `null` (the alarm's stand-in: 512 MB) | |
| Thread count, open files, `MTLDevice.currentAllocatedSize` | no web API, always 0 | The leak alarm's growth checks and the soak's thread and file deltas never trip. |
| Screen backlight (`UIScreen.brightness`, `BacklightFollower`) | No browser control. The face canvas gets a CSS `filter: brightness()` and keeps the same 12-step, 3 s ramp to 20 % | Dims the pixels, not the backlight: the room gets as dark, but the LCD saves no power. Never on OLED. |
| `MTKView` drawable scale (`FaceRenderControl.renderScale`) | `KioskOptions.renderControl` = the `FaceRenderer` (`renderScale`, clamped 0.5…1, scales the canvas backing store) | Level ≥ 3 draws at 0.8×; the browser scales the canvas up. |
| Perception `governorPressure` | `PerceptionHandle.setGovernorPressure(budget.perceptionPressure)`, pushed every 1 s tick | The tier policy takes it as its pressure (the browser has no thermal state of its own for perception). Camera pressure *into* the governor comes from `stats().camera.kind === 'pressure'`. |
| `HangMonitor` (a GCD timer pinging the main queue) | A **Worker** (`HangWatchdog.worker.ts`) runs the same `HangMonitor` and pings the main thread with `postMessage`; the main thread answers at once (`MainThreadHeartbeat`). Without a Worker, a **long-task observer** (`PerformanceObserver('longtask')`, Chromium) feeds hitches and hangs | The worker measures a stall while it happens. Logging and the restart run on the main thread once it is free again. A main thread that never recovers can't be restarted from inside the page; the browser kills it, and the next load reads a crash. |
| `LaunchGuard` `launches.json` | localStorage `yanni.kiosk.launches` | Writes are synchronous, so `flushNow` is free. |
| Clean-exit marker (background / terminate) | `pagehide` and `visibilitychange` → hidden; cleared when visible again | A deliberate reload sets `restarting`, so its own `pagehide` never marks the run clean. |
| Kernel boot time (`KERN_BOOTTIME`, reboot detection) | A per-tab **session stamp** in sessionStorage | A record from another browser session counts as `reboot`: tab closed, browser restarted, device rebooted. A reload or crash-reload in the same tab doesn't. |
| Debugger attached (`P_TRACED`) | always `false` | |
| `exit()` after a hang, maintenance restart, Crash now (test) | `location.reload()` with a breadcrumb (`hang`, `selfRestart`, `crashTest`) and a **backoff** by the unclean streak: 0, 5, 30, 120, then 600 s | The render watchdog's third step reloads too (Swift falls back to SafeFace there), never in safe mode. A renderer that never came up (no WebGPU) counts as `off`, not failed, so it can't cause a reload loop. |
| Guided Access (`isGuidedAccessEnabled`) | Kiosk lock = `document.fullscreenElement`, or `(display-mode: fullscreen)` / `(display-mode: standalone)` | An installed web app, or a kiosk browser such as Fully Kiosk. |
| `isIdleTimerDisabled` | Screen Wake Lock sentinel, re-requested on show and every 60 s | `screenKeptOn` is false without the API. |
| `hw.machine` + `DeviceTable` | A screen key `iPad <long>x<short>@<dpr>` (CSS px, landscape) from `screen` and `devicePixelRatio`. iPadOS Safari says "Macintosh", so an iPad is a Mac UA with touch points. When two models share a screen (12.9" Pro and 13" Air), the measured refresh rate decides | Rows keep the Swift display kinds, camera edges, chips and sizes. A screen shared by models with different camera edges (11" Air / iPad 10th gen) is `calibrated: false`. Other touch devices are `tablet <model>` (from the Android UA) and get the OLED-safe defaults. Desktop browsers are `desktop`, Swift's `.mac` preview. |
| `UIScreen.maximumFramesPerSecond` | `clock.displayMaximumFramesPerSecond` (measured by main.ts from rAF), re-checked every tick | |
| `ProcessInfo.physicalMemory` | `navigator.deviceMemory` (GB, capped at 8, Chromium) | |
| Metal GPU family (chip floor) | `GPUDevice.adapterInfo` (vendor, architecture), for the summary only | It doesn't identify the chip. |
| `ProvisioningProfile`, signature expiry, `OpenDecisions` (bundle ID, distribution path) | **dropped** | A web page has no signing profile or bundle ID. The HA `signature_expires` sensor is already absent (server/src/entities.ts). |
| `MetricsCollector` (MetricKit) | **dropped** | No browser API for crash, hang or power reports. LaunchGuard and the ring log never depended on it. |
| `DiagnosticsLog` (2 MB × 5 JSONL files) | localStorage keys `yanni.diag.log-0…15`, 64 K characters each, flushed every 30 s | localStorage holds about 5 MB per origin, shared with settings. A quota error drops the oldest file and never throws. |
| Diagnostics export (a folder zipped for the share sheet) | One JSON bundle (`yanni-diagnostics-<time>.json`) offered as a download | No zip without a dependency. Every part is scanned for forbidden keys and dropped if one is found, then the whole bundle is scanned again and refused if it still trips. |
| `ResumeSnapshot` file | localStorage `yanni.kiosk.resume` | main.ts keeps its own `RESUME_KEY` today: KioskBoot can replace it. |
| `SoakLogger` (`-YanniSoak`, a JSONL file) | `?soak`, localStorage `yanni.kiosk.soak` (400 lines max, header kept), included in the export | |
| VoiceOver value (`FaceAccessibility`) | `spokenState()`: the throttled text for `#face-desc` (`describeFace`) | English only, since there's no string catalog. |
| Burn-in check (SwiftUI `TimelineView`) | A fixed full-screen `div` (`role=button`, `aria-modal`): 6 fields × 20 s. Tap, click, Escape, Enter or Space exits | |
| Owner kiosk settings (`restartVerified`, `selfRestartOnHang`, `maintenanceRestart`, `oledBackgroundBudget`, `displayOverride`) | The `kiosk` settings section (`restart_verified`, `self_restart_on_hang`, `maintenance_restart`, `oled_background_budget` in %, `display_kind`), handed in through `KioskOptions` / `KioskBootOptions` and `configure()`: `restartOnHang = restart_verified && self_restart_on_hang`, `maintenanceRestart = restart_verified && maintenance_restart`, `oledBackgroundBudget = oled_background_budget / 100`, `overrides.display = display_kind` (except `auto`) | Both restarts are off by default, as the spec asks. A reload always comes back in a browser; "verified" means it comes back under the kiosk lock. `display_kind` applies at launch (the stored settings, as Swift's `KioskBoot`) and again through `configure({ displayOverride })` when a different value arrives from the add-on; the shell then re-applies the style. The LCD backlight follower keeps its launch-time choice. |
