// Port of the app's Kiosk/SystemInputs.swift for the browser. The platform's kiosk-relevant state (hardening design
// §5.5, §6.4, §6.5): thermal state, battery and power source, memory warnings, the kiosk lock and the screen staying
// on. Read by the kiosk's 1 s tick; events only flag changes. Every browser API is injectable (MAPPING.md has the
// iOS → web table):
// - thermal: the Compute Pressure API ('cpu' records: nominal / fair / serious / critical, Chromium) combined with
//   frame-time pressure (the face's own drop rate, smoothed: > 10 % fair, > 25 % serious); the worse wins;
// - Low Power Mode: no web signal (always false);
// - battery: the Battery Status API (Chromium); null where it doesn't exist (Safari);
// - memory warnings: none in the web; the JS heap above 90 % of its limit (Chromium) counts as one, edge-triggered;
// - kiosk lock: fullscreen, or the display mode is fullscreen / standalone (an installed web app or a kiosk browser);
// - keep the screen on: a Screen Wake Lock sentinel, re-requested when released.
import { Thermal } from './ResourceGovernor';

export interface BatteryLike extends EventTarget { level: number; charging: boolean }
interface PressureRecordLike { state: string }
interface PressureObserverLike { observe(source: string): Promise<void>; disconnect(): void }
type PressureObserverCtor = new (cb: (records: PressureRecordLike[]) => void) => PressureObserverLike;
interface WakeLockSentinelLike extends EventTarget { released: boolean }

export interface SystemEnv {
  getBattery?: () => Promise<BatteryLike>;
  PressureObserver?: PressureObserverCtor;
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
  /// Fullscreen element present, or `(display-mode: fullscreen | standalone)` matches.
  kioskLock: () => boolean;
  /// Chromium heap use, or null.
  heap: () => { used: number; limit: number } | null;
  visible: () => boolean;
}

export function browserSystemEnv(): SystemEnv {
  const n = navigator as Navigator & { getBattery?: () => Promise<BatteryLike>; wakeLock?: SystemEnv['wakeLock'] };
  const g = globalThis as typeof globalThis & { PressureObserver?: PressureObserverCtor };
  const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
  return {
    getBattery: typeof n.getBattery === 'function' ? () => n.getBattery!() : undefined,
    PressureObserver: g.PressureObserver,
    wakeLock: n.wakeLock,
    kioskLock: () => document.fullscreenElement != null || mq('(display-mode: fullscreen)') || mq('(display-mode: standalone)'),
    heap: () => {
      const m = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      return m && m.jsHeapSizeLimit > 0 ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
    },
    visible: () => document.visibilityState === 'visible',
  };
}

export class SystemInputs {
  /// Unplugged this long counts as on battery (governor level ≥ 1, HA `power_plugged` off).
  static readonly unpluggedDebounce = 120;
  /// The heap above this fraction of its limit is a memory warning.
  static readonly heapWarning = 0.9;
  static readonly heapClear = 0.8;
  /// Frame-time pressure: the smoothed drop rate above these is fair / serious.
  static readonly dropFair = 0.10;
  static readonly dropSerious = 0.25;

  onMemoryWarning: (() => void) | null = null;
  onKioskLockChange: ((on: boolean) => void) | null = null;
  onPowerChange: (() => void) | null = null;

  /// The Compute Pressure state ('cpu'), nominal where the API doesn't exist.
  computePressure: Thermal = Thermal.nominal;
  /// The smoothed frame drop rate fed by the tick.
  frameDrop = 0;
  private battery: BatteryLike | null = null;
  private observer: PressureObserverLike | null = null;
  private sentinel: WakeLockSentinelLike | null = null;
  private requesting = false;
  private unpluggedSince: number | null = null;
  private heapHigh = false;
  private lastLock: boolean | null = null;

  constructor(private readonly env: SystemEnv) {}

  start(): void {
    this.env.getBattery?.().then((b) => {
      this.battery = b;
      for (const t of ['chargingchange', 'levelchange']) b.addEventListener(t, () => this.onPowerChange?.());
      this.onPowerChange?.();
    }, () => {});
    const P = this.env.PressureObserver;
    if (P) {
      try {
        const o = new P((records) => {
          const last = records[records.length - 1];
          if (!last) return;
          const t = SystemInputs.pressureThermal(last.state);
          if (t !== this.computePressure) { this.computePressure = t; this.onPowerChange?.(); }
        });
        o.observe('cpu').catch(() => {});
        this.observer = o;
      } catch { /* not allowed here */ }
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  static pressureThermal(state: string): Thermal {
    switch (state) {
      case 'fair': return Thermal.fair;
      case 'serious': return Thermal.serious;
      case 'critical': return Thermal.critical;
      default: return Thermal.nominal;
    }
  }

  /// Feeds the face's drop rate over the last second (an EWMA over ~10 s).
  noteFrameDrop(rate: number): void { this.frameDrop += 0.1 * (Math.min(Math.max(rate, 0), 1) - this.frameDrop); }

  get frameTimePressure(): Thermal {
    return this.frameDrop > SystemInputs.dropSerious ? Thermal.serious : this.frameDrop > SystemInputs.dropFair ? Thermal.fair : Thermal.nominal;
  }

  get thermal(): Thermal { return Math.max(this.computePressure, this.frameTimePressure) as Thermal; }

  /// port-note: no Low Power Mode signal in any browser.
  get lowPowerMode(): boolean { return false; }

  /// Battery percent (null where unknown).
  get batteryPercent(): number | null {
    const b = this.battery;
    return b && Number.isFinite(b.level) ? Math.round(b.level * 100) : null;
  }

  /// Raw plugged-in state (null when unknown).
  get pluggedRaw(): boolean | null { return this.battery ? this.battery.charging : null; }

  /// Debounced: false only after `unpluggedDebounce` seconds unplugged.
  plugged(now: number): boolean | null {
    const raw = this.pluggedRaw;
    if (raw === null) return null;
    if (raw) { this.unpluggedSince = null; return true; }
    const since = this.unpluggedSince ?? now;
    this.unpluggedSince = since;
    return now - since < SystemInputs.unpluggedDebounce;
  }

  get kioskLock(): boolean { return this.env.kioskLock(); }

  /// The 1 s poll: the heap-based memory warning and a kiosk-lock change (fullscreen has an event; display mode
  /// changes are rare, so a poll covers both).
  poll(): void {
    const h = this.env.heap();
    if (h) {
      const f = h.used / h.limit;
      if (!this.heapHigh && f > SystemInputs.heapWarning) { this.heapHigh = true; this.onMemoryWarning?.(); }
      else if (this.heapHigh && f < SystemInputs.heapClear) this.heapHigh = false;
    }
    const lock = this.kioskLock;
    if (this.lastLock !== null && lock !== this.lastLock) this.onKioskLockChange?.(lock);
    this.lastLock = lock;
  }

  /// Re-asserts the screen staying on (§6.5): on activation and every 60 s. The browser drops the lock when hidden.
  keepScreenOn(): void {
    const wl = this.env.wakeLock;
    if (!wl || this.requesting || (this.sentinel && !this.sentinel.released) || !this.env.visible()) return;
    this.requesting = true;
    wl.request('screen').then((s) => { this.sentinel = s; this.requesting = false; }, () => { this.requesting = false; });
  }

  get screenKeptOn(): boolean { return this.sentinel !== null && !this.sentinel.released; }
}
