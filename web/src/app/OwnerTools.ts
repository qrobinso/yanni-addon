// The owner menu's full screens: Settings (the settings hub's panel), Status and Tuning (the owner tools' inspector),
// with the kiosk services as the Status page sees them (StatusKioskPort: the Health card, the diagnostics export, the
// burn-in check).
import type { KioskServices } from '../kiosk';
import type { HealthTint } from '../kiosk/HealthCard';
import { openStatus, openTuning, type InspectorExtras } from '../preview';
import type { StatusCard, StatusKioskPort, Tint } from '../preview/DevStatus';
import { openSettingsPanel, resetAllSettings, type SettingsHub } from '../settings';
import type { AppContext } from './AppContext';
import type { OwnerAccess } from './OwnerAccess';
import type { OwnerDestination } from './OwnerMenu';

const tint = (t: HealthTint): Tint | undefined => (t === 'green' ? 'good' : t === 'red' ? 'bad' : t === null ? undefined : 'warn');

export function statusKioskPort(kiosk: KioskServices): StatusKioskPort {
  return {
    healthCard(): StatusCard {
      const c = kiosk.healthCard();
      return { id: 'health', title: 'Health', detail: c.title, rows: c.rows.map((r) => ({ label: r.label, value: r.value, tint: tint(r.tint) })),
        level: c.dot === 'red' ? 'error' : c.dot === 'green' || c.dot === null ? 'running' : 'degraded',
        note: c.banners.map((b) => b.text).join(' · ') || undefined };
    },
    exportDiagnostics: () => kiosk.downloadDiagnostics(),
    burnInRefresh: () => kiosk.runBurnInCheck(),
  };
}

export interface OwnerToolsDeps {
  /** Read when a screen opens (the menu is built before the context). */
  ctx: () => AppContext;
  hub: SettingsHub;
  access: OwnerAccess;
  kiosk: () => KioskServices | undefined;
  appVersion: string;
  root: HTMLElement;
  /** Everything a reset clears besides the settings and the PIN (clips, announcements). */
  onReset: () => void;
  settingsOpenChange: (open: boolean) => void;
}

export function ownerTools(d: OwnerToolsDeps): Record<OwnerDestination, () => void> {
  const extras = (): InspectorExtras => {
    const k = d.kiosk();
    return { kiosk: k ? statusKioskPort(k) : undefined,
      settings: { get: () => d.hub.settings, change: (v: Parameters<SettingsHub['update']>[1]) => d.hub.update('tuning', v) } };
  };
  return {
    settings: () => {
      d.settingsOpenChange(true);
      openSettingsPanel(d.ctx(), d.hub, d.access, { root: d.root, appVersion: d.appVersion,
        onReset: () => { d.onReset(); resetAllSettings(d.hub, d.access); },
        burnInCheck: () => void d.kiosk()?.runBurnInCheck(),
        onClose: () => d.settingsOpenChange(false) });
    },
    status: () => { openStatus(d.ctx(), extras()); },
    tuning: () => { openTuning(d.ctx(), extras()); },
  };
}
