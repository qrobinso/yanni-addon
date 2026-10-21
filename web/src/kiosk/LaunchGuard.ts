// Port of YanniKiosk/LaunchGuard.swift. Crash-loop protection (hardening design §6.3): keeps the last 20 launches with
// breadcrumbs, classifies how the previous one ended, and decides careful start or safe mode.
//
// Browser mapping (MAPPING.md): `launches.json` is a localStorage key (writes are synchronous, so `flushNow` is free);
// the clean-exit marker is written on `pagehide` / hidden and cleared when visible again; the kernel boot time is a
// per-tab session stamp in sessionStorage, so a record from another browser session (tab closed, browser restarted,
// device rebooted) classifies as `reboot`, and a reload or a crash-relaunch in the same tab does not.
import type { KeyValue } from '../app/OwnerAccess';

export type ExitKind = 'clean' | 'reboot' | 'crash' | 'hang' | 'selfRestart' | 'crashTest';
export const ExitKind = {
  /// Counts toward the crash-loop rules.
  isUnclean: (k: ExitKind): boolean => k === 'crash' || k === 'hang' || k === 'selfRestart',
  /// The Home Assistant `last_restart` value.
  haValue: (k: ExitKind): 'clean' | 'reboot' | 'crash' | 'hang' | 'self_restart' =>
    k === 'selfRestart' ? 'self_restart' : k === 'crashTest' ? 'crash' : k,
};

export interface LaunchRecord {
  /// ISO 8601 wall time.
  start: string;
  /// Monotonic seconds at launch (the page's own clock: 0-ish).
  uptimeAtStart: number;
  /// The session stamp (Swift: kernel boot time).
  bootTime: number | null;
  app: string;
  os: string;
  /// `starting:<subsystem>`, `started:<subsystem>`, `hang`, `selfRestart`, `crashTest`, `safeMode`, …
  breadcrumbs: string[];
  aliveSeconds: number;
  cleanExit: boolean;
  debugged?: boolean | null;
  exit?: ExitKind | null;
  suspect?: string | null;
}

export const LaunchRecord = {
  maxBreadcrumbs: 40,
  make(o: Partial<LaunchRecord> & { start: string }): LaunchRecord {
    return { uptimeAtStart: 0, bootTime: null, app: '', os: '', breadcrumbs: [], aliveSeconds: 0, cleanExit: false, ...o };
  },
  /// The last `starting:` without a matching `started:`.
  openStart(r: LaunchRecord): string | null {
    const open: string[] = [];
    for (const b of r.breadcrumbs) {
      if (b.startsWith('starting:')) open.push(b.slice(9));
      if (b.startsWith('started:')) { const s = b.slice(8); for (let i = open.length - 1; i >= 0; i--) if (open[i] === s) open.splice(i, 1); }
    }
    return open.length ? open[open.length - 1] : null;
  },
};

export type LaunchMode = { kind: 'normal' } | { kind: 'careful'; skip: string[] } | { kind: 'safe'; suspects: string[] };
export const LaunchMode = {
  label(m: LaunchMode): string {
    switch (m.kind) {
      case 'normal': return 'normal';
      case 'careful': return `careful start (skipping ${m.skip.length ? m.skip.join(', ') : 'nothing'})`;
      case 'safe': return 'safe mode';
    }
  },
};

export interface LaunchDecision {
  mode: LaunchMode;
  /// How the previous run ended (null on the first launch).
  previousExit: ExitKind | null;
  previousStart: string | null;
  uncleanStreak: number;
}

export class LaunchGuard {
  static readonly keep = 20;
  static readonly quickExit = 180;
  static readonly loopWindow = 600;
  static readonly carefulSkip = 600;
  static readonly safeStable = 1800;
  static readonly probationStep = 600;
  static readonly probationOrder = ['audio', 'mqtt', 'perception', 'conversation', 'snapshots'];
  static readonly key = 'yanni.kiosk.launches';
  static readonly sessionKey = 'yanni.kiosk.session';

  readonly decision: LaunchDecision;
  /// Previous launches, newest first, each with its exit kind.
  readonly history: LaunchRecord[];
  private records: LaunchRecord[];

  /// Reads the history, classifies the previous launch, appends this one and decides the mode.
  constructor(private readonly store: KeyValue, o: { now?: Date; uptime?: number; bootTime: number | null; app: string;
    os: string; debugged?: boolean }) {
    const now = o.now ?? new Date();
    let records: LaunchRecord[] = [];
    try { const raw = store.getItem(LaunchGuard.key); if (raw) records = JSON.parse(raw) as LaunchRecord[]; } catch { records = []; }
    if (!Array.isArray(records)) records = [];
    const last = records[records.length - 1];
    if (last && last.exit == null) {
      last.exit = LaunchGuard.classify(last, o.bootTime);
      last.suspect = ExitKind.isUnclean(last.exit) ? LaunchRecord.openStart(last) : null;
    }
    this.decision = LaunchGuard.decide([...records].reverse(), now);
    this.history = [...records].reverse();
    const current = LaunchRecord.make({ start: now.toISOString(), uptimeAtStart: o.uptime ?? 0, bootTime: o.bootTime,
      app: o.app, os: o.os, debugged: o.debugged ?? false });
    if (this.decision.mode.kind === 'safe') current.breadcrumbs.push('safeMode');
    records.push(current);
    if (records.length > LaunchGuard.keep) records.splice(0, records.length - LaunchGuard.keep);
    this.records = records;
    this.save();
  }

  /// The tab session's stamp, made once per browser session (sessionStorage survives reloads, not a closed tab).
  static sessionStamp(session: KeyValue, now = Date.now() / 1000): number {
    const raw = Number(session.getItem(LaunchGuard.sessionKey));
    if (Number.isFinite(raw) && raw > 0) return raw;
    session.setItem(LaunchGuard.sessionKey, String(now));
    return now;
  }

  // ---- Rules ----

  static classify(r: LaunchRecord, bootTime: number | null): ExitKind {
    if (r.cleanExit || r.debugged === true) return 'clean';
    if (r.bootTime != null && bootTime != null && Math.abs(r.bootTime - bootTime) > 2) return 'reboot';
    if (r.breadcrumbs.includes('crashTest')) return 'crashTest';
    if (r.breadcrumbs.includes('hang')) return 'hang';
    if (r.breadcrumbs.includes('selfRestart')) return 'selfRestart';
    return 'crash';
  }

  /// Counts the quick unclean exits at the top of the history (newest first) within the loop window.
  static decide(previous: LaunchRecord[], now: Date): LaunchDecision {
    let streak = 0;
    const suspects: string[] = [];
    for (const r of previous) {
      const kind = r.exit;
      if (kind == null) break;
      if (kind === 'crashTest') continue;
      if (!(ExitKind.isUnclean(kind) && r.aliveSeconds < LaunchGuard.quickExit
        && (now.getTime() - Date.parse(r.start)) / 1000 <= LaunchGuard.loopWindow)) break;
      streak += 1;
      if (r.suspect && !suspects.includes(r.suspect)) suspects.push(r.suspect);
    }
    const mode: LaunchMode = streak >= 3 ? { kind: 'safe', suspects } : streak === 2 ? { kind: 'careful', skip: suspects } : { kind: 'normal' };
    return { mode, previousExit: previous[0]?.exit ?? null, previousStart: previous[0]?.start ?? null, uncleanStreak: streak };
  }

  /// Safe mode: which subsystems may run after `elapsed` seconds (none for 30 min, then one more every 10 min; a
  /// suspect comes last).
  static probationAllowed(elapsed: number, suspects: string[]): string[] {
    if (!(elapsed >= LaunchGuard.safeStable)) return [];
    const order = [...LaunchGuard.probationOrder.filter((s) => !suspects.includes(s)),
      ...LaunchGuard.probationOrder.filter((s) => suspects.includes(s))];
    const n = Math.trunc((elapsed - LaunchGuard.safeStable) / LaunchGuard.probationStep) + 1;
    return order.slice(0, n);
  }

  // ---- This launch ----

  get current(): LaunchRecord | undefined { return this.records[this.records.length - 1]; }

  breadcrumb(b: string): void {
    this.mutate((r) => {
      r.breadcrumbs.push(b);
      if (r.breadcrumbs.length > LaunchRecord.maxBreadcrumbs) r.breadcrumbs.splice(0, r.breadcrumbs.length - LaunchRecord.maxBreadcrumbs);
    });
  }

  starting(subsystem: string): void { this.breadcrumb(`starting:${subsystem}`); }
  started(subsystem: string): void { this.breadcrumb(`started:${subsystem}`); }

  /// Every 60 s and on hide (the quick-exit rule).
  noteAlive(seconds: number): void { this.mutate((r) => { r.aliveSeconds = Math.max(r.aliveSeconds, seconds); }); }

  /// Hidden / pagehide: the next launch reads this run as clean.
  markCleanExit(aliveSeconds: number): void {
    this.mutate((r) => { r.cleanExit = true; r.aliveSeconds = Math.max(r.aliveSeconds, aliveSeconds); });
  }

  /// Visible again: the marker no longer holds.
  markActive(): void { this.mutate((r) => { r.cleanExit = false; }); }

  /// Writes are already synchronous; kept for the Swift call sites.
  flushNow(): void { this.save(); }

  /// The stored history, for the diagnostics export.
  all(): LaunchRecord[] { return this.records.map((r) => ({ ...r, breadcrumbs: [...r.breadcrumbs] })); }

  private mutate(change: (r: LaunchRecord) => void): void {
    const r = this.current;
    if (!r) return;
    change(r);
    this.save();
  }

  private save(): void {
    try { this.store.setItem(LaunchGuard.key, JSON.stringify(this.records)); } catch { /* quota: the next write retries */ }
  }
}
