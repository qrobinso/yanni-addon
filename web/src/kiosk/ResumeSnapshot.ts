// Port of YanniKiosk/ResumeSnapshot.swift. What a relaunch needs to come back as it was (hardening design §6.2): JSON
// in localStorage, ≤ 2 KB, written on life-phase change, every 60 s and on hide.
import type { KeyValue } from '../app/OwnerAccess';
import type { LifeResumeState } from '../life/LifeResume';

export interface ResumeSnapshot {
  version: number;
  /// ISO 8601 wall clock at the save.
  savedAt: string;
  /// Monotonic seconds at the save and the session stamp (a different session means the browser restarted).
  savedUptime: number;
  bootTime: number | null;
  life: LifeResumeState;
  lastActivity: string | null;
  /// The governor's level (a hot device stays careful after a relaunch).
  resourceLevel: number;
  orientation: number | null;
}

export const ResumeSnapshot = {
  version: 1,
  /// A relaunch within this long restores; older snapshots start fresh.
  maxAge: 600,
  make(o: Omit<ResumeSnapshot, 'version' | 'lastActivity' | 'resourceLevel' | 'orientation'>
    & Partial<Pick<ResumeSnapshot, 'lastActivity' | 'resourceLevel' | 'orientation'>>): ResumeSnapshot {
    return { version: ResumeSnapshot.version, lastActivity: null, resourceLevel: 0, orientation: null, ...o };
  },
  /// Seconds since the save, or null when the snapshot is too old, from the future, or unusable.
  restorableElapsed(s: ResumeSnapshot, now: Date): number | null {
    const e = (now.getTime() - Date.parse(s.savedAt)) / 1000;
    if (s.version !== ResumeSnapshot.version || !Number.isFinite(e) || e < -5 || e > ResumeSnapshot.maxAge) return null;
    return Math.max(e, 0);
  },
};

export class ResumeStore {
  static readonly key = 'yanni.kiosk.resume';
  constructor(private readonly store: KeyValue) {}

  load(): ResumeSnapshot | null {
    try {
      const raw = this.store.getItem(ResumeStore.key);
      const s = raw ? JSON.parse(raw) as ResumeSnapshot : null;
      return s && typeof s === 'object' && s.life ? s : null;
    } catch { return null; }
  }

  save(s: ResumeSnapshot): void {
    try { this.store.setItem(ResumeStore.key, JSON.stringify(s)); } catch { /* quota: the next save retries */ }
  }

  clear(): void { this.store.removeItem(ResumeStore.key); }
}
