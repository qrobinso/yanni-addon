// Port of YanniSettings/SettingsStore.swift: the settings as one sparse JSON blob in local storage (only values that
// differ from the defaults, so a tuned default in a later build reaches every display that never changed it). Writes
// are coalesced (at most one per `coalesceInterval` while a slider drags); `flush()` writes now (page hide).
// Loading never fails: an unreadable blob is moved to `yanni.settings.corrupt` and the defaults are used. Every read
// and write is wrapped, because storage can throw (private mode, quota, blocked site data).
import { SETTING_DEFAULTS, SETTING_KEYS, isValidSetting, sameSetting, settingDef, type SettingKey, type Settings }
  from '@yanni/server/settings';

export interface KeyValue {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Delayed actions (tests drive a manual one). */
export interface Scheduler {
  after(seconds: number, action: () => void): { cancel(): void };
}

export const timerScheduler: Scheduler = {
  after(seconds, action) {
    const t = setTimeout(action, seconds * 1000);
    return { cancel: () => clearTimeout(t) };
  },
};

export type LoadOutcome = 'loaded' | 'fresh' | 'quarantined';

/** A full settings value: the defaults with every valid stored value over them (invalid or unknown keys dropped). */
export function settingsFrom(stored: unknown): Settings {
  const s = { ...SETTING_DEFAULTS } as Settings;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return s;
  const o = stored as Record<string, unknown>;
  for (const k of SETTING_KEYS) {
    if (Object.hasOwn(o, k) && isValidSetting(settingDef(k), o[k])) (s as Record<SettingKey, unknown>)[k] = o[k];
  }
  return s;
}

/** The values that differ from the defaults (Swift `SettingsCodec.encodeSparse`). The tuning style is stored only
 *  while it is pinned (Swift `TuningSettings`), so an experiment from Tuning never silently sticks. */
export function sparse(s: Settings): Partial<Settings> {
  const out: Partial<Record<SettingKey, unknown>> = {};
  for (const k of SETTING_KEYS) {
    if (k === 'tuning_style' && !s.pin_style) continue;
    if (!sameSetting(settingDef(k), s[k], SETTING_DEFAULTS[k])) out[k] = s[k];
  }
  return out as Partial<Settings>;
}

export class SettingsStore {
  static readonly key = 'yanni.settings';
  static readonly corruptKey = 'yanni.settings.corrupt';
  coalesceInterval = 0.5;
  /** Blobs written (tests). */
  writeCount = 0;
  private pending: Settings | undefined;
  private timer: { cancel(): void } | undefined;

  constructor(readonly storage: KeyValue | null = SettingsStore.localStorage(), readonly scheduler: Scheduler = timerScheduler) {}

  static localStorage(): KeyValue | null {
    try { return globalThis.localStorage ?? null; } catch { return null; }
  }

  load(): { settings: Settings; outcome: LoadOutcome } {
    let text: string | null = null;
    try { text = this.storage?.getItem(SettingsStore.key) ?? null; } catch { /* blocked: defaults */ }
    if (text === null) return { settings: settingsFrom({}), outcome: 'fresh' };
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { raw = undefined; }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      try {
        this.storage?.setItem(SettingsStore.corruptKey, text);
        this.storage?.removeItem(SettingsStore.key);
      } catch { /* nothing more to do */ }
      return { settings: settingsFrom({}), outcome: 'quarantined' };
    }
    return { settings: settingsFrom(raw), outcome: 'loaded' };
  }

  /** Coalesced save: the latest value is written at most once per `coalesceInterval`. */
  scheduleSave(s: Settings): void {
    this.pending = s;
    if (this.timer) return;
    this.timer = this.scheduler.after(this.coalesceInterval, () => { this.timer = undefined; this.flush(); });
  }

  get hasPendingSave(): boolean { return this.pending !== undefined; }

  flush(): void {
    this.timer?.cancel();
    this.timer = undefined;
    const p = this.pending;
    this.pending = undefined;
    if (!p) return;
    try {
      this.storage?.setItem(SettingsStore.key, JSON.stringify(sparse(p)));
      this.writeCount += 1;
    } catch { /* storage full or blocked: the next change tries again */ }
  }
}
