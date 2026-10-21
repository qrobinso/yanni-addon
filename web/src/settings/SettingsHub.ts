// Port of YanniSettings/SettingsHub.swift: the single writer of the settings. Every change, whoever makes it, goes
// through `update(origin, change)`:
// 1. the change is applied to a copy and validated (invalid or unknown keys are dropped; nothing happens when the
//    result equals the current settings);
// 2. the hub stores the new value, so a nested `update` from an applier that sets the same value is a no-op;
// 3. a coalesced save is scheduled;
// 4. the appliers run in order, then the observers (the add-on sync, the panel, the status log).
// An `update` made while 2–4 run is queued and applied right after, in order.
//
// Sync with the add-on (DisplayClient): the display is the source of truth on (re)connect (its hello carries every
// value); after that the last writer wins. Changes made here (app, tuning, system, reset) go to the add-on; changes
// that came from it (Home Assistant, the owner pages, the welcome) are applied without an echo.
import type { EntitySettings } from '@yanni/server/protocol';
import { SETTING_DEFAULTS, isValidSetting, sameSetting, settingDef, type SettingKey, type Settings }
  from '@yanni/server/settings';
import { SettingsStore, settingsFrom, type KeyValue, type LoadOutcome } from './SettingsStore';

/** Who made a settings change. */
export type SettingsOrigin =
  /** The owner Settings panel. */
  | 'app'
  /** The developer Tuning tool. */
  | 'tuning'
  /** A Home Assistant command (through the add-on). */
  | 'homeassistant'
  /** The add-on's owner pages. */
  | 'owner'
  /** The add-on's merged values at (re)connect. */
  | 'welcome'
  /** A subsystem changed its own settings (force wake clearing the bedtime switch). */
  | 'system'
  /** Loading. */
  | 'migration'
  /** Reset all settings. */
  | 'reset';

export interface SettingsChange {
  old: Settings;
  new: Settings;
  origin: SettingsOrigin;
  /** The keys whose values differ. */
  keys: SettingKey[];
}

/** Pushes the slice of the settings a subsystem owns into it; writes only when that slice changed. `force` is set by
 *  `applyAll` (launch, a subsystem attached late, Reduce Motion changed). */
export interface SettingsApplier {
  name: string;
  apply(old: Settings, next: Settings, origin: SettingsOrigin, force: boolean): void;
}

/** The part of DisplayClient the hub syncs through. */
export interface SettingsLink {
  sendSettings(values: Partial<EntitySettings>): boolean;
  on(event: 'settings', fn: (e: { values: Partial<EntitySettings>; origin: 'welcome' | 'homeassistant' | 'owner' }) => void): () => void;
}

const LOCAL: ReadonlySet<SettingsOrigin> = new Set<SettingsOrigin>(['app', 'tuning', 'system', 'reset']);
/** The developer-tools switch before it was a setting. */
const LEGACY_DEVELOPER_KEY = 'yanni.developerTools';

export type SettingsPatch = Partial<Settings> | ((s: Settings) => Partial<Settings>);

export class SettingsHub {
  private _settings: Settings;
  readonly loadOutcome: LoadOutcome;
  lastOrigin: SettingsOrigin = 'migration';
  appliers: SettingsApplier[] = [];
  private observers = new Map<number, (c: SettingsChange) => void>();
  private nextObserver = 0;
  private applying = false;
  private queue: [SettingsOrigin, SettingsPatch][] = [];
  private links: SettingsLink[] = [];

  constructor(readonly store: SettingsStore = new SettingsStore()) {
    const { settings, outcome } = store.load();
    this._settings = Object.freeze({ ...settings, room_understanding: false }) as Settings;
    this.loadOutcome = outcome;
    this.importLegacy(store.storage);
  }

  /** The current settings (a frozen snapshot: change them only through `update`). */
  get settings(): Readonly<Settings> { return this._settings; }

  get<K extends SettingKey>(k: K): Settings[K] { return this._settings[k]; }

  /** Applies a change (see the file comment for the order of events). Returns nothing; observers see the result. */
  update(origin: SettingsOrigin, change: SettingsPatch): void {
    this.queue.push([origin, change]);
    if (this.applying) return;
    this.applying = true;
    try {
      while (this.queue.length) {
        const [o, c] = this.queue.shift()!;
        this.apply(o, c);
      }
    } finally { this.applying = false; }
  }

  private apply(origin: SettingsOrigin, change: SettingsPatch): void {
    const patch = typeof change === 'function' ? change(this._settings) : change;
    const next = { ...this._settings } as Settings;
    const keys: SettingKey[] = [];
    for (const [k, v] of Object.entries(patch) as [SettingKey, unknown][]) {
      if (!Object.hasOwn(SETTING_DEFAULTS, k)) continue;
      const def = settingDef(k);
      if (!isValidSetting(def, v) || sameSetting(def, v, next[k])) continue;
      (next as Record<SettingKey, unknown>)[k] = def.type === 'json' ? structuredClone(v) : v;
      keys.push(k);
    }
    // Room understanding needs an encrypted vision path, which doesn't exist on any platform yet: a stored or
    // Home Assistant "on" goes straight back off (Swift `SceneModel`), so the switch can't be on here.
    if (next.room_understanding) {
      next.room_understanding = false;
      const i = keys.indexOf('room_understanding');
      if (i >= 0) keys.splice(i, 1);
    }
    if (!keys.length) return;
    const old = this._settings;
    this._settings = Object.freeze(next) as Settings;
    this.lastOrigin = origin;
    this.store.scheduleSave(this._settings);
    for (const a of this.appliers) a.apply(old, this._settings, origin, false);
    if (LOCAL.has(origin)) {
      const out = Object.fromEntries(keys.map((k) => [k, this._settings[k]])) as Partial<EntitySettings>;
      for (const l of this.links) l.sendSettings(out);
    }
    const c: SettingsChange = { old, new: this._settings, origin, keys };
    for (const o of [...this.observers.values()]) o(c);
  }

  /** Runs every applier with the current settings, forced (launch, a subsystem attached late, Reduce Motion). */
  applyAll(): void {
    for (const a of this.appliers) a.apply(this._settings, this._settings, 'migration', true);
  }

  subscribe(fn: (c: SettingsChange) => void): () => void {
    const id = ++this.nextObserver;
    this.observers.set(id, fn);
    return () => { this.observers.delete(id); };
  }

  /** Writes any pending save (page hide). */
  flush(): void { this.store.flush(); }

  /** Every value, for the hello (the display is the source of truth on reconnect). The tuning style goes only while
   *  it is pinned, as it is stored. */
  helloValues(): Partial<EntitySettings> {
    const out = { ...this._settings } as Partial<Settings>;
    if (!this._settings.pin_style) delete out.tuning_style;
    return out as Partial<EntitySettings>;
  }

  /** Syncs with the add-on: its settings messages come in without an echo; local changes go out. Returns a detach. */
  connect(link: SettingsLink): () => void {
    this.links.push(link);
    const off = link.on('settings', ({ values, origin }) => this.update(origin, values as Partial<Settings>));
    return () => { off(); this.links = this.links.filter((l) => l !== link); };
  }

  /** Reset all settings (Swift `resetAll`): every value back to its default, and the add-on told. The PIN is cleared by
   *  `resetAllSettings`, which also owns the access store. */
  resetToDefaults(): void {
    this.update('reset', { ...SETTING_DEFAULTS, pin_prompt_shown: false } as Partial<Settings>);
    // A reset also tells the add-on the defaults it may not have (values that already were defaults here).
    const all = { ...this.helloValues() };
    for (const l of this.links) l.sendSettings(all);
    this.store.flush();
  }

  private importLegacy(storage: KeyValue | null): void {
    try {
      const v = storage?.getItem(LEGACY_DEVELOPER_KEY);
      if (v === null || v === undefined) return;
      if (v === 'true') {
        this._settings = Object.freeze({ ...this._settings, developer_tools: true }) as Settings;
        this.store.scheduleSave(this._settings);
      }
      storage?.removeItem(LEGACY_DEVELOPER_KEY);
    } catch { /* storage blocked */ }
  }
}

/** A hub over storage that isn't persisted (tests, demo pages). */
export function memoryHub(initial: Partial<Settings> = {}): SettingsHub {
  const m = new Map<string, string>();
  const kv: KeyValue = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  kv.setItem(SettingsStore.key, JSON.stringify(settingsFrom(initial)));
  return new SettingsHub(new SettingsStore(kv));
}

