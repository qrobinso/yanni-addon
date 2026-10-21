// Port of the SettingsHub / SettingsStore tests (YanniSettingsTests): validation, ordering, coalesced sparse saves,
// quarantine, reset, and the add-on sync (no echo of remote changes, the full hello).
import { describe, expect, test } from 'vitest';
import type { EntitySettings } from '@yanni/server/protocol';
import { SETTING_DEFAULTS, SETTING_KEYS } from '@yanni/server/settings';
import { SettingsHub, SettingsStore, resetAllSettings, sparse, type KeyValue, type Scheduler, type SettingsLink }
  from '../../src/settings';
import { OwnerAccess } from '../../src/app/OwnerAccess';

const memory = (): KeyValue & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

class ManualScheduler implements Scheduler {
  tasks: { at: number; run: () => void; cancelled: boolean }[] = [];
  now = 0;
  after(s: number, run: () => void) {
    const t = { at: this.now + s, run, cancelled: false };
    this.tasks.push(t);
    return { cancel: () => { t.cancelled = true; } };
  }
  advance(s: number) {
    this.now += s;
    for (const t of this.tasks.filter((x) => !x.cancelled && x.at <= this.now)) { t.cancelled = true; t.run(); }
  }
}

class FakeLink implements SettingsLink {
  sent: Partial<EntitySettings>[] = [];
  private fn: ((e: { values: Partial<EntitySettings>; origin: 'welcome' | 'homeassistant' | 'owner' }) => void) | undefined;
  sendSettings(v: Partial<EntitySettings>) { this.sent.push(v); return true; }
  on(_e: 'settings', fn: NonNullable<FakeLink['fn']>) { this.fn = fn; return () => { this.fn = undefined; }; }
  receive(values: Partial<EntitySettings>, origin: 'welcome' | 'homeassistant' | 'owner' = 'homeassistant') { this.fn?.({ values, origin }); }
}

function rig(stored?: unknown) {
  const kv = memory();
  if (stored !== undefined) kv.setItem(SettingsStore.key, typeof stored === 'string' ? stored : JSON.stringify(stored));
  const scheduler = new ManualScheduler();
  const hub = new SettingsHub(new SettingsStore(kv, scheduler));
  return { kv, scheduler, hub };
}

describe('SettingsHub', () => {
  test('a fresh install has every schema default', () => {
    const { hub } = rig();
    expect(hub.loadOutcome).toBe('fresh');
    expect(Object.keys(hub.settings).sort()).toEqual([...SETTING_KEYS].sort());
    expect(hub.settings).toEqual(SETTING_DEFAULTS);
  });

  test('loading keeps valid stored values and drops invalid or unknown ones', () => {
    const { hub } = rig({ sounds: false, chirp_volume: 400, ghost: 1, personality: 'shy', room_understanding: true });
    expect(hub.loadOutcome).toBe('loaded');
    expect([hub.settings.sounds, hub.settings.chirp_volume, hub.settings.personality]).toEqual([false, 70, 'shy']);
    expect(hub.settings.room_understanding).toBe(false);
    expect('ghost' in hub.settings).toBe(false);
  });

  test('an unreadable blob is quarantined and the defaults are used', () => {
    const { hub, kv } = rig('{nope');
    expect(hub.loadOutcome).toBe('quarantined');
    expect(kv.getItem(SettingsStore.corruptKey)).toBe('{nope');
    expect(kv.getItem(SettingsStore.key)).toBeNull();
    expect(hub.settings).toEqual(SETTING_DEFAULTS);
  });

  test('imports the old developer-tools switch once', () => {
    const kv = memory();
    kv.setItem('yanni.developerTools', 'true');
    const hub = new SettingsHub(new SettingsStore(kv, new ManualScheduler()));
    expect(hub.settings.developer_tools).toBe(true);
    expect(kv.getItem('yanni.developerTools')).toBeNull();
  });

  test('validates, ignores no-ops, and tells appliers then observers once per real change', () => {
    const { hub } = rig();
    const seen: string[] = [];
    hub.appliers.push({ name: 'a', apply: (o, n) => seen.push(`apply ${o.chirp_volume}→${n.chirp_volume}`) });
    hub.subscribe((c) => seen.push(`observe ${c.origin} ${c.keys.join()}`));
    hub.update('app', { chirp_volume: 40 });
    hub.update('app', { chirp_volume: 40 });
    hub.update('app', { chirp_volume: 101, taps_to_wake: 2.5 } as never);
    expect(seen).toEqual(['apply 70→40', 'observe app chirp_volume']);
    expect(() => { (hub.settings as { sounds: boolean }).sounds = false; }).toThrow();
  });

  test('a change made by an applier is queued and applied after, in order', () => {
    const { hub } = rig();
    const order: string[] = [];
    hub.appliers.push({ name: 'a', apply: (_o, n) => {
      order.push(`a quiet=${n.quiet_mode}`);
      if (n.quiet_mode && n.sounds) hub.update('system', { sounds: false });
    } });
    hub.update('app', { quiet_mode: true });
    expect(order).toEqual(['a quiet=true', 'a quiet=true']);
    expect(hub.settings.sounds).toBe(false);
  });

  test('saves coalesced and sparse; the tuning style only while pinned', () => {
    const { hub, kv, scheduler } = rig();
    hub.update('app', { chirp_volume: 10 });
    hub.update('app', { chirp_volume: 20 });
    hub.update('tuning', { tuning_style: { pupilScale: 1.2 } });
    expect(hub.store.writeCount).toBe(0);
    scheduler.advance(0.5);
    expect(hub.store.writeCount).toBe(1);
    expect(JSON.parse(kv.getItem(SettingsStore.key)!)).toEqual({ chirp_volume: 20 });
    hub.update('tuning', { pin_style: true });
    hub.flush();
    expect(JSON.parse(kv.getItem(SettingsStore.key)!)).toEqual({ chirp_volume: 20, pin_style: true, tuning_style: { pupilScale: 1.2 } });
    // A relaunch reads it back.
    const again = new SettingsHub(new SettingsStore(kv, scheduler));
    expect(again.settings.tuning_style).toEqual({ pupilScale: 1.2 });
    expect(sparse(again.settings)).toEqual({ chirp_volume: 20, pin_style: true, tuning_style: { pupilScale: 1.2 } });
  });

  test('a storage that throws never breaks the hub', () => {
    const bad: KeyValue = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} };
    const hub = new SettingsHub(new SettingsStore(bad, new ManualScheduler()));
    expect(hub.settings).toEqual(SETTING_DEFAULTS);
    hub.update('app', { sounds: false });
    expect(() => hub.flush()).not.toThrow();
    expect(hub.settings.sounds).toBe(false);
  });
});

describe('SettingsHub sync with the add-on', () => {
  test('local changes go out; remote ones are applied without an echo', () => {
    const { hub } = rig();
    const link = new FakeLink();
    hub.connect(link);
    hub.update('app', { sounds: false, chirp_volume: 30 });
    expect(link.sent).toEqual([{ sounds: false, chirp_volume: 30 }]);
    link.receive({ quiet_mode: true }, 'homeassistant');
    link.receive({ game_yo_yo: false }, 'owner');
    link.receive({ room: 'Den', sounds: false }, 'welcome');
    expect([hub.settings.quiet_mode, hub.settings.game_yo_yo, hub.settings.room]).toEqual([true, false, 'Den']);
    expect(link.sent).toHaveLength(1);
    expect(hub.lastOrigin).toBe('welcome');
    // Last writer wins: a later local change of the same key goes out again.
    hub.update('app', { quiet_mode: false });
    expect(link.sent.at(-1)).toEqual({ quiet_mode: false });
    // A system change (force wake clearing bedtime) is local too.
    link.receive({ bedtime: true });
    hub.update('system', { bedtime: false });
    expect(link.sent.at(-1)).toEqual({ bedtime: false });
  });

  test('the hello carries every value (the display is the source of truth); the tuning style only when pinned', () => {
    const { hub } = rig({ sounds: false, tuning_style: { pupilScale: 1.1 } });
    const hello = hub.helloValues();
    expect(Object.keys(hello).length).toBe(SETTING_KEYS.length - 1);
    expect(hello.sounds).toBe(false);
    expect('tuning_style' in hello).toBe(false);
  });

  test('reset: every default, the add-on told, the PIN cleared, the prompt shown again', async () => {
    const { hub, kv } = rig({ sounds: false, pin_prompt_shown: true, developer_tools: true });
    const link = new FakeLink();
    hub.connect(link);
    const access = new OwnerAccess(kv, () => 0);
    await access.setPIN('1234');
    resetAllSettings(hub, access);
    expect(access.isPINRequired).toBe(false);
    expect(hub.settings).toEqual(SETTING_DEFAULTS);
    expect(hub.lastOrigin).toBe('reset');
    expect(link.sent[0]).toEqual({ sounds: true, pin_prompt_shown: false, developer_tools: false });
    expect(Object.keys(link.sent[1]!).length).toBe(SETTING_KEYS.length - 1);
    expect(JSON.parse(kv.getItem(SettingsStore.key)!)).toEqual({});
  });
});
