// The kiosk services (hardening design §4–§10), ported from YanniKiosk, FaceRuntime, YanniDevice and the app's Kiosk/
// folder. main.ts calls `startKiosk(ctx, opts)` once the app is wired; MAPPING.md lists every iOS → browser mapping.
//
// To restore the life phase before the first frame, make the boot early and hand it in:
//   const boot = new KioskBoot({ appVersion });  boot.restoreLife(life);  …  startKiosk(ctx, { appVersion, boot });
import type { AppContext } from '../app/AppContext';
import { runBurnInCheck } from './BurnInCheck';
import type { DiagnosticsLog } from './DiagnosticsLog';
import { DiagnosticsExport } from './DiagnosticsExport';
import type { HealthCardModel } from './HealthCard';
import { KioskModel, type KioskOptions, type KioskStatusFields } from './KioskModel';
import type { ResourceGovernor } from './ResourceGovernor';
import type { HealthSupervisor } from './HealthSupervisor';
import type { VitalsMonitor } from './VitalsMonitor';

export interface KioskServices {
  readonly model: KioskModel;
  readonly governor: ResourceGovernor;
  readonly health: HealthSupervisor;
  /// The ring log: mirror the app event log into it with `diagnostics.add(category, message)` (never message text).
  readonly diagnostics: DiagnosticsLog;
  readonly vitals: VitalsMonitor;
  /// Home Assistant's diagnostic sensors (server/src/entities.ts), ready for `client.sendState`.
  statusFields(): KioskStatusFields;
  healthCard(): HealthCardModel;
  /// The JSON bundle (no transcripts, message text, images or secrets).
  exportDiagnostics(): Promise<Blob>;
  /// Builds the bundle and offers it as a download (Status' "Export diagnostics").
  downloadDiagnostics(): Promise<void>;
  /// Full-screen grey / red / green / blue / ramp, 20 s each; a tap exits.
  runBurnInCheck(): Promise<void>;
  /// The face's screen-reader description ("awake and looking at you"), throttled (changes at most every 3 s).
  spokenState(): string;
  /// Whether a subsystem may start on this launch (careful start / safe mode).
  allows(subsystem: string): boolean;
  /// The owner's kiosk settings changed: `restartOnHang` = restart_verified && self_restart_on_hang,
  /// `maintenanceRestart` = restart_verified && maintenance_restart, `oledBackgroundBudget` = oled_background_budget / 100.
  configure(o: Pick<KioskOptions, 'restartOnHang' | 'maintenanceRestart' | 'oledBackgroundBudget'>): void;
  leaveSafeMode(): void;
  crashNow(): void;
  stop(): void;
}

export function startKiosk(ctx: AppContext, opts: KioskOptions): KioskServices {
  const m = new KioskModel(ctx, opts);
  m.start();
  ctx.logEvent('kiosk', `launch: ${m.healthSnap().launchMode}`);
  const exportDiagnostics = async () => m.exportDiagnostics();
  return {
    model: m,
    governor: m.governor,
    health: m.supervisor,
    diagnostics: m.boot.diagnostics,
    vitals: m.vitals,
    statusFields: () => m.statusFields(),
    healthCard: () => m.healthCard(),
    exportDiagnostics,
    async downloadDiagnostics() {
      const blob = await exportDiagnostics();
      DiagnosticsExport.download(blob, DiagnosticsExport.fileName((opts.wall ?? (() => new Date()))().toISOString()));
    },
    runBurnInCheck: () => runBurnInCheck(),
    spokenState: () => m.access.value,
    allows: (s) => m.boot.allows(s) && !m.skipped.has(s),
    configure: (o) => m.configure(o),
    leaveSafeMode: () => m.leaveSafeMode(),
    crashNow: () => m.crashNow(),
    stop: () => m.stop(),
  };
}

export { KioskBoot } from './KioskBoot';
export { KioskModel, type KioskOptions, type KioskStatusFields } from './KioskModel';
export { FaceSpokenState, SpokenStateThrottle, FaceAccessibility, LoadDot } from './FaceSpokenState';
export { HealthCard, type HealthCardModel, type HealthSnap } from './HealthCard';
export { BurnInCheckModel, runBurnInCheck } from './BurnInCheck';
export { DiagnosticsExport } from './DiagnosticsExport';
export { ResourceGovernor, Thermal } from './ResourceGovernor';
export { KioskApply } from './KioskApply';
export { DeviceProfile, browserProfile } from './DeviceProfile';
export { DeviceDefaults } from './DeviceDefaults';
