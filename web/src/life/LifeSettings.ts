// Port of FaceLife/LifeSettings.swift.

const clampRange = (v: number, r: readonly [number, number], fallback: number): number =>
  Number.isFinite(v) ? Math.min(Math.max(v, r[0]), r[1]) : fallback;

/// Life-cycle settings (in-app settings now, mirrored by Home Assistant later). Persisted with `LifeSettingsStore`.
/// Decoding is tolerant (missing or unreadable keys keep their defaults) and every value is range-checked by
/// `validated()`, which the controller applies on every assignment.
///
/// Times of day are minutes since local midnight (0…1439), read from the wall clock in the current calendar and time
/// zone. `bedtimeStart == bedtimeEnd` means no schedule.
export class LifeSettings {
  /// Minutes without activity before idle turns drowsy.
  minutesToDrowsy = 3;
  /// Further minutes without activity before drowsy falls asleep.
  minutesToAsleep = 3;
  /// The nightly schedule is on.
  bedtimeEnabled = false;
  /// Bedtime start / end, minutes since local midnight (22:00 and 07:00 by default; may cross midnight).
  bedtimeStart = 22 * 60;
  bedtimeEnd = 7 * 60;
  /// The manual bedtime switch (the app's switch, or Home Assistant from any automation). Force wake clears it.
  manualBedtime = false;
  /// Taps within 4 s needed to wake Yanni at bedtime (or under a force-sleep hold). Daytime: one tap.
  tapsToWake = 3;
  /// At bedtime, people in view may half-wake and wake Yanni. Off: they never do (taps still can).
  wakeOnMotionAtBedtime = false;
  /// After a night wake, minutes without activity before Yanni drifts back to sleep.
  bedtimeAwakeMinutes = 1;
  /// Idle and alone, mood drifts slightly toward bored (and perks up again when something happens).
  idleMoodDrift = true;
  /// Sheepish / confused / has-a-message with nobody in view for this many minutes: the life cycle takes over again.
  aloneTakeoverMinutes = 2;

  /// Defaults with `fields` overridden (not validated, like assigning the Swift struct's vars).
  constructor(fields: Partial<LifeSettingsFields> = {}) { Object.assign(this, fields); }

  // MARK: Ranges

  static readonly minutesRange = [0.25, 120] as const;
  static readonly bedtimeAwakeRange = [0.25, 30] as const;
  static readonly takeoverRange = [0.5, 60] as const;
  static readonly tapsRange = [1, 6] as const;
  static readonly minutesPerDay = 24 * 60;

  copy(): LifeSettings { return new LifeSettings(this); }

  /// A copy with `fields` changed (Swift: `var s = settings; s.x = …`).
  with(fields: Partial<LifeSettingsFields>): LifeSettings { return new LifeSettings({ ...this, ...fields }); }

  equals(o: LifeSettings): boolean {
    return KEYS.every((k) => Object.is(this[k], o[k]));
  }

  /// Every value clamped into its range; non-finite numbers fall back to the default.
  validated(): LifeSettings {
    const d = new LifeSettings();
    const s = this.copy();
    const minute = (m: number): number => ((m % LifeSettings.minutesPerDay) + LifeSettings.minutesPerDay) % LifeSettings.minutesPerDay;
    s.minutesToDrowsy = clampRange(s.minutesToDrowsy, LifeSettings.minutesRange, d.minutesToDrowsy);
    s.minutesToAsleep = clampRange(s.minutesToAsleep, LifeSettings.minutesRange, d.minutesToAsleep);
    s.bedtimeAwakeMinutes = clampRange(s.bedtimeAwakeMinutes, LifeSettings.bedtimeAwakeRange, d.bedtimeAwakeMinutes);
    s.aloneTakeoverMinutes = clampRange(s.aloneTakeoverMinutes, LifeSettings.takeoverRange, d.aloneTakeoverMinutes);
    s.bedtimeStart = minute(s.bedtimeStart);
    s.bedtimeEnd = minute(s.bedtimeEnd);
    s.tapsToWake = Math.min(Math.max(s.tapsToWake, LifeSettings.tapsRange[0]), LifeSettings.tapsRange[1]);
    return s;
  }

  /// True when the schedule has a window at all (enabled, start ≠ end).
  get hasSchedule(): boolean { return this.bedtimeEnabled && this.bedtimeStart !== this.bedtimeEnd; }

  /// Whether `m` (minutes since local midnight) falls in the bedtime window [start, end), which may cross midnight.
  static isInWindow(m: number, start: number, end: number): boolean {
    if (start === end) return false;
    return start < end ? (m >= start && m < end) : (m >= start || m < end);
  }

  // MARK: Codable (tolerant)

  toJSON(): LifeSettingsFields {
    const o = {} as Record<string, unknown>;
    for (const k of KEYS) o[k] = this[k];
    return o as unknown as LifeSettingsFields;
  }

  /// Missing or unreadable keys keep their defaults; the result is validated.
  static decode(json: unknown): LifeSettings {
    const d = new LifeSettings();
    const c = json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    const s = new LifeSettings();
    for (const k of KEYS) {
      const v = c[k];
      const want = typeof d[k];
      // Swift decodes Int keys only from integral numbers.
      if (typeof v === want && (!INT_KEYS.has(k) || Number.isInteger(v))) (s as unknown as Record<string, unknown>)[k] = v;
    }
    return s.validated();
  }
}

export interface LifeSettingsFields {
  minutesToDrowsy: number; minutesToAsleep: number; bedtimeEnabled: boolean; bedtimeStart: number; bedtimeEnd: number;
  manualBedtime: boolean; tapsToWake: number; wakeOnMotionAtBedtime: boolean; bedtimeAwakeMinutes: number;
  idleMoodDrift: boolean; aloneTakeoverMinutes: number;
}

const KEYS: readonly (keyof LifeSettingsFields)[] = [
  'minutesToDrowsy', 'minutesToAsleep', 'bedtimeEnabled', 'bedtimeStart', 'bedtimeEnd', 'manualBedtime',
  'tapsToWake', 'wakeOnMotionAtBedtime', 'bedtimeAwakeMinutes', 'idleMoodDrift', 'aloneTakeoverMinutes',
];
const INT_KEYS = new Set<string>(['bedtimeStart', 'bedtimeEnd', 'tapsToWake']);

/// The key-value storage the store writes to (`localStorage` in the browser).
export interface KeyValueStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/// Saves `LifeSettings` (JSON in key-value storage), mirroring `VoiceSettingsStore`.
export class LifeSettingsStore {
  static readonly defaultKey = 'yanni.lifeSettings';
  constructor(readonly storage: KeyValueStorage = globalThis.localStorage, readonly key = LifeSettingsStore.defaultKey) {}

  /// The saved settings (validated), or null when nothing (readable) was saved.
  load(): LifeSettings | null {
    const text = this.storage.getItem(this.key);
    if (text === null) return null;
    let j: unknown;
    try { j = JSON.parse(text); } catch { return null; }
    return j !== null && typeof j === 'object' && !Array.isArray(j) ? LifeSettings.decode(j) : null;
  }

  save(settings: LifeSettings): void { this.storage.setItem(this.key, JSON.stringify(settings)); }
}
