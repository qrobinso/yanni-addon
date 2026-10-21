// Port of YanniDevice/DeviceProfile.swift. What Yanni knows about the device it runs on (hardening design §4.2):
// runtime probes where the browser has them (refresh rate, memory, GPU adapter), the screen table for what none
// reports (display kind, camera edge, physical size, chip class), and the owner's overrides.
//
// An unknown tablet gets the conservative profile: `display = 'unknown'`, which every default treats as OLED, and
// `calibrated = false`. port-note: Swift's `.mac` family (the macOS preview) is `desktop` here (any desktop browser).
import { DeviceTable } from './DeviceTable';

export type Family = 'iPadPro' | 'iPadAir' | 'iPadMini' | 'iPad' | 'tablet' | 'desktop' | 'unknown';
export type DisplayKind = 'oled' | 'lcd' | 'miniLED' | 'unknown';
export type CameraEdge = 'long' | 'short' | 'aboveDisplay' | 'unknown';
export type ChipClass = 'unknown' | 'a12' | 'a13' | 'a14' | 'a15' | 'a16' | 'a17Pro' | 'm1' | 'm2' | 'm3' | 'm4' | 'm5';
export type TierHint = 'full' | 'standard' | 'reduced';

const CHIPS: readonly ChipClass[] = ['unknown', 'a12', 'a13', 'a14', 'a15', 'a16', 'a17Pro', 'm1', 'm2', 'm3', 'm4', 'm5'];
export const ChipClass = {
  rank: (c: ChipClass): number => Math.max(CHIPS.indexOf(c), 0),
  max: (a: ChipClass, b: ChipClass): ChipClass => (ChipClass.rank(b) > ChipClass.rank(a) ? b : a),
};

/// Defaults that matter for burn-in treat an unknown panel as OLED.
export const treatAsOLED = (d: DisplayKind): boolean => d === 'oled' || d === 'unknown';

export interface DeviceOverrides {
  display?: DisplayKind;
  /// 60 or 120.
  maxFramesPerSecond?: number;
}

export interface DeviceProfile {
  /// The screen key (`iPad 1210x834@2`), or `desktop` / `tablet <model>`.
  machine: string;
  family: Family;
  display: DisplayKind;
  /// Probe: the measured refresh rate (60 or 120).
  maxFramesPerSecond: number;
  /// Display active area, landscape width × height (table; null when unknown).
  physicalSizeMetres: [number, number] | null;
  cameraEdge: CameraEdge;
  chipClass: ChipClass;
  /// Probe: `navigator.deviceMemory` (whole GB, capped at 8 by the browser; 0 where it doesn't exist).
  memoryBytes: number;
  calibrated: boolean;
  name: string;
  /// The WebGPU adapter (`vendor architecture`), for the summary; null when unknown.
  gpu: string | null;
}

export interface MakeProfile {
  machine: string;
  isDesktop: boolean;
  /// The refresh-rate probe (null before one exists: the table's rate).
  maxFramesPerSecond?: number | null;
  memoryBytes?: number;
  gpuFloor?: ChipClass | null;
  gpu?: string | null;
  overrides?: DeviceOverrides;
}

export const DeviceProfile = {
  /// The table fills what no API reports, probes win where they exist, overrides last.
  make(o: MakeProfile): DeviceProfile {
    const memoryBytes = o.memoryBytes ?? 0;
    const gpu = o.gpu ?? null;
    let p: DeviceProfile;
    const row = o.isDesktop ? undefined : DeviceTable.row(o.machine, o.maxFramesPerSecond);
    if (o.isDesktop) {
      p = { machine: o.machine, family: 'desktop', display: 'lcd', maxFramesPerSecond: o.maxFramesPerSecond ?? 60,
        physicalSizeMetres: null, cameraEdge: 'aboveDisplay', chipClass: 'm1', memoryBytes, calibrated: true,
        name: 'Desktop browser (preview)', gpu };
    } else if (row) {
      p = { machine: o.machine, family: row.family, display: row.display, maxFramesPerSecond: row.maxHz,
        physicalSizeMetres: [...row.size], cameraEdge: row.camera, chipClass: row.chip, memoryBytes,
        calibrated: row.calibrated, name: row.name, gpu };
    } else {
      const chip = ChipClass.max(DeviceTable.chipGuess(o.machine), o.gpuFloor ?? 'unknown');
      p = { machine: o.machine, family: o.machine.startsWith('iPad') ? 'iPad' : o.machine.startsWith('tablet') ? 'tablet' : 'unknown',
        display: 'unknown', maxFramesPerSecond: 60, physicalSizeMetres: null, cameraEdge: 'unknown', chipClass: chip,
        memoryBytes, calibrated: false, name: `Unknown (${o.machine})`, gpu };
    }
    const probe = o.maxFramesPerSecond;
    if (probe != null && probe > 0) p.maxFramesPerSecond = probe;
    const ov = o.overrides ?? {};
    if (ov.display) p.display = ov.display;
    const f = ov.maxFramesPerSecond;
    if (f === 60 || f === 120) p.maxFramesPerSecond = Math.min(f, Math.max(p.maxFramesPerSecond, 60));
    return p;
  },

  /// The tier hint from the chip class (the perception benchmark stays the truth).
  tierHint(p: DeviceProfile): TierHint {
    switch (p.chipClass) {
      case 'm1': case 'm2': case 'm3': case 'm4': case 'm5': case 'a17Pro': return 'full';
      case 'a14': case 'a15': case 'a16': case 'unknown': return 'standard';
      case 'a12': case 'a13': return p.family === 'iPadPro' ? 'standard' : 'reduced';
    }
  },

  /// One line for the launch log and the Status page.
  summary(p: DeviceProfile): string {
    return `${p.name} · ${p.machine} · ${p.display} · ${p.maxFramesPerSecond} Hz · camera ${p.cameraEdge} · `
      + `${p.chipClass} · ${Math.floor(p.memoryBytes / 1_073_741_824)} GB` + (p.gpu ? ` · GPU ${p.gpu}` : '')
      + (p.calibrated ? '' : ' · uncalibrated');
  },
};

/// What the browser reports about the device (no UI dependency; every field injectable for tests).
export interface BrowserEnv {
  userAgent: string;
  maxTouchPoints: number;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  /// `navigator.deviceMemory` (GB) where it exists.
  deviceMemory?: number;
}

export const DeviceProbe = {
  env(): BrowserEnv {
    const n = navigator as Navigator & { deviceMemory?: number };
    return { userAgent: n.userAgent, maxTouchPoints: n.maxTouchPoints ?? 0, screenWidth: screen.width,
      screenHeight: screen.height, devicePixelRatio: globalThis.devicePixelRatio || 1, deviceMemory: n.deviceMemory };
  },

  /// iPadOS Safari reports itself as a Mac; a touch screen gives it away.
  isIPad: (e: BrowserEnv): boolean => /iPad/.test(e.userAgent) || (/Macintosh/.test(e.userAgent) && e.maxTouchPoints > 1),

  /// The table key: the screen in CSS px (landscape long × short) at its pixel ratio for an iPad, `tablet <model>`
  /// for another touch device, `desktop` otherwise.
  machine(e: BrowserEnv): { machine: string; isDesktop: boolean } {
    const long = Math.max(e.screenWidth, e.screenHeight), short = Math.min(e.screenWidth, e.screenHeight);
    const dpr = Math.round(e.devicePixelRatio * 100) / 100;
    if (DeviceProbe.isIPad(e)) return { machine: `iPad ${long}x${short}@${dpr}`, isDesktop: false };
    const mobile = /Android|Mobile|Silk|KF[A-Z]{2,}/.test(e.userAgent) || e.maxTouchPoints > 1;
    if (!mobile) return { machine: 'desktop', isDesktop: true };
    const model = /Android [\d.]+; ([^;)]+)/.exec(e.userAgent)?.[1]?.trim() ?? `${long}x${short}@${dpr}`;
    return { machine: `tablet ${model}`, isDesktop: false };
  },

  memoryBytes: (e: BrowserEnv): number => (e.deviceMemory ?? 0) * 1_073_741_824,
};

/// The profile for a browser (`maxFramesPerSecond` from the refresh-rate probe; `gpu` from the WebGPU adapter).
export function browserProfile(e: BrowserEnv, o: { maxFramesPerSecond?: number | null; gpu?: string | null;
  overrides?: DeviceOverrides } = {}): DeviceProfile {
  const m = DeviceProbe.machine(e);
  return DeviceProfile.make({ machine: m.machine, isDesktop: m.isDesktop, maxFramesPerSecond: o.maxFramesPerSecond,
    memoryBytes: DeviceProbe.memoryBytes(e), gpu: o.gpu, overrides: o.overrides });
}
