// Port of the app's Kiosk/HealthCard.swift and HealthSnap (KioskModel+Health.swift): the Status page's Health card
// (hardening design §9.4) as data. Whoever draws Status renders `banners` and `rows`; the wording is the Swift card's.
// port-note: the signature, bundle ID, open-decision and MetricKit rows have no web equivalent and are left out.

export interface HealthSubsystem { name: string; state: string; problem: boolean; lastError: string | null }

export interface HealthSnap {
  overall: 'ok' | 'degraded' | 'safe_mode';
  launchMode: string;
  uptime: number;
  lastRestart: string;
  crashes24h: number;
  crashes7d: number;
  hangs: number;
  resourceLevel: number;
  resourceReason: string;
  thermal: string;
  lowPower: boolean;
  battery: number | null;
  plugged: boolean | null;
  footprintMB: number | null;
  leak: string[];
  awakeDelivery: string;
  subsystems: HealthSubsystem[];
  skipped: string[];
  device: string;
  tierHint: string;
  calibrated: boolean;
  kioskLock: boolean;
  /// Self-restart on a 15 s hang is armed.
  selfRestartOnHang: boolean;
  screenKeptOn: boolean;
}

export type HealthTint = 'green' | 'yellow' | 'orange' | 'red' | null;
export interface HealthRow { label: string; value: string; tint: HealthTint }
export interface HealthBanner { text: string; color: HealthTint }

export interface HealthCardModel {
  snap: HealthSnap;
  dot: HealthTint;
  /// "ok · up 3 h 12 min".
  title: string;
  banners: HealthBanner[];
  rows: HealthRow[];
}

export const HealthCard = {
  duration(s: number): string {
    const m = Math.trunc(s / 60);
    return m < 60 ? `${m} min` : m < 1440 ? `${Math.trunc(m / 60)} h ${m % 60} min` : `${Math.trunc(m / 1440)} d ${Math.trunc((m % 1440) / 60)} h`;
  },

  model(h: HealthSnap): HealthCardModel {
    const dot: HealthTint = h.overall === 'ok' ? 'green' : h.overall === 'safe_mode' ? 'red' : 'orange';
    const banners: HealthBanner[] = [];
    if (h.overall === 'safe_mode' || h.launchMode.startsWith('careful')) {
      banners.push(h.overall === 'safe_mode'
        ? { text: 'Safe mode: face, sleep, touch and Status only. Subsystems return one at a time after 30 min stable.', color: 'red' }
        : { text: `Careful start: ${h.launchMode}`, color: 'orange' });
    }
    const row = (label: string, value: string, tint: HealthTint = null): HealthRow => ({ label, value, tint });
    const rows: HealthRow[] = [
      row('launch', h.launchMode),
      row('last restart', h.lastRestart),
      row('crashes', `${h.crashes24h} in 24 h · ${h.crashes7d} in 7 d · hangs ${h.hangs}`),
      row('resource', `L${h.resourceLevel} · ${h.resourceReason}`, h.resourceLevel >= 3 ? 'orange' : null),
      row('power', `thermal ${h.thermal}` + (h.lowPower ? ' · Low Power Mode' : '')
        + ' · battery ' + (h.battery !== null ? `${h.battery}%` : '—')
        + (h.plugged === false ? ' · unplugged' : h.plugged === true ? ' · plugged in' : '')),
      row('memory', (h.footprintMB !== null ? `${h.footprintMB.toFixed(1)} MB` : '—')
        + (h.leak.length ? ' · leak: ' + h.leak.join(', ') : ' · leak alarm quiet'), h.leak.length ? 'red' : null),
      row('frames', h.awakeDelivery),
      ...h.subsystems.map((s) => row(s.name, s.state + (s.problem && s.lastError ? ` · ${s.lastError}` : ''), s.problem ? 'orange' : null)),
    ];
    if (h.skipped.length) rows.push(row('held back', h.skipped.join(', '), 'orange'));
    rows.push(row('device', `${h.device} · tier hint ${h.tierHint}`, h.calibrated ? null : 'orange'));
    rows.push(row('kiosk', (h.kioskLock ? 'lock on (fullscreen)' : 'lock off') + ' · screen kept on '
      + (h.screenKeptOn ? '✓' : '✗') + ' · self-restart on hang ' + (h.selfRestartOnHang ? 'armed' : 'off'),
    h.kioskLock ? null : 'orange'));
    return { snap: h, dot, title: `${h.overall.replace(/_/g, ' ')} · up ${HealthCard.duration(h.uptime)}`, banners, rows };
  },
};
