// Port of YanniKiosk/DiagnosticsExport.swift. The Diagnostics export (hardening design §9.4): one JSON bundle the owner
// downloads from Status (nothing is uploaded). Contents: manifest, settings (no secrets: the display never holds the
// HA token), launches, the ring log, the health summary, the vitals and the last events. **Never** camera frames,
// snapshots, transcripts or announcement text: every part is scanned for forbidden keys before it is included, and
// the whole bundle once more (defence in depth).
//
// port-note: the Swift zip folder is a single JSON object here (no zip in the browser without a dependency); the
// manifest drops the provisioning profile and the open owner decisions (no web equivalent, MAPPING.md).
import type { DeviceProfile } from './DeviceProfile';

export interface DiagnosticsManifest {
  app: string;
  /// The user agent (Swift: the OS version string).
  os: string;
  device: DeviceProfile;
  uptimeSeconds: number;
  kioskLock: boolean;
  displayMode: string;
  crossOriginIsolated: boolean;
  exportedAt: string;
}

export interface DiagnosticsInputs {
  manifest: DiagnosticsManifest;
  settings?: unknown;
  health?: unknown;
  /// The last events (event log), plain text without transcripts.
  events: string[];
  /// Parts copied in as they are (launches, the ring log, the resume snapshot, vitals, soak log).
  copies: Record<string, unknown>;
}

export const DiagnosticsExport = {
  /// Keys and words that must never appear in an export (secrets, speech, message text, images).
  forbidden: ['password', 'token', '"pin"', 'pinhash', 'transcript', '"text"', 'jpeg', 'snapshotdata', 'imagedata',
    'announcementtext'],

  /// True when the text contains a forbidden key (case-insensitive).
  containsForbidden(s: string): boolean {
    const l = s.toLowerCase();
    return DiagnosticsExport.forbidden.some((f) => l.includes(f));
  },

  /// The bundle as an object: each part is kept only when its JSON passes the scan.
  build(i: DiagnosticsInputs): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const put = (name: string, v: unknown) => {
      if (v === undefined) return;
      const s = JSON.stringify(v);
      if (s === undefined || DiagnosticsExport.containsForbidden(s)) return;
      out[name] = v;
    };
    put('manifest', i.manifest);
    put('settings', i.settings);
    put('health', i.health);
    put('events', i.events);
    for (const [k, v] of Object.entries(i.copies)) put(k, v);
    return out;
  },

  /// `yanni-diagnostics-<time>.json`.
  fileName(exportedAt: string): string { return `yanni-diagnostics-${exportedAt.replace(/:/g, '-')}.json`; },

  /// The downloadable bundle. Throws if the scrubbed bundle still trips the scanner (never ships a leak).
  blob(i: DiagnosticsInputs): Blob {
    const json = JSON.stringify(DiagnosticsExport.build(i), null, 2);
    if (DiagnosticsExport.containsForbidden(json)) throw new Error('diagnostics bundle failed the privacy scan');
    return new Blob([json], { type: 'application/json' });
  },

  /// Offers a blob as a file download (the share sheet's stand-in).
  download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
