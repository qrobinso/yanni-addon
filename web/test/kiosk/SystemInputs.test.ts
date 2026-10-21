// The browser signals (SystemInputs), the CSS backlight, the burn-in sequence and the Health card model, against fake
// browser APIs and fake timers.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BacklightFollower } from '../../src/kiosk/Backlight';
import { BurnInCheckModel } from '../../src/kiosk/BurnInCheck';
import { HealthCard, type HealthSnap } from '../../src/kiosk/HealthCard';
import { Thermal } from '../../src/kiosk/ResourceGovernor';
import { SystemInputs, type BatteryLike, type SystemEnv } from '../../src/kiosk/SystemInputs';

function fakeEnv() {
  const battery = Object.assign(new EventTarget(), { level: 0.42, charging: true }) as BatteryLike;
  let pressureCb: ((r: { state: string }[]) => void) | null = null;
  const sentinel = Object.assign(new EventTarget(), { released: false });
  const heap = { used: 100, limit: 1000 };
  let lock = false;
  let requests = 0;
  const env: SystemEnv = {
    getBattery: async () => battery,
    PressureObserver: class { constructor(cb: (r: { state: string }[]) => void) { pressureCb = cb; } async observe() {} disconnect() {} },
    wakeLock: { request: async () => { requests += 1; return sentinel; } },
    kioskLock: () => lock,
    heap: () => heap,
    visible: () => true,
  };
  return { env, battery, sentinel, heap, setLock: (on: boolean) => { lock = on; }, pressure: (s: string) => pressureCb?.([{ state: s }]),
    requests: () => requests };
}

describe('SystemInputs', () => {
  test('battery, plug debounce and Compute Pressure', async () => {
    const f = fakeEnv();
    const s = new SystemInputs(f.env);
    let changes = 0;
    s.onPowerChange = () => { changes += 1; };
    s.start();
    await Promise.resolve(); await Promise.resolve();
    expect(s.batteryPercent).toBe(42);
    expect(s.plugged(0)).toBe(true);
    f.battery.charging = false;
    expect(s.pluggedRaw).toBe(false);
    expect(s.plugged(10)).toBe(true);       // debounced
    expect(s.plugged(10 + SystemInputs.unpluggedDebounce)).toBe(false);
    expect(s.thermal).toBe(Thermal.nominal);
    f.pressure('serious');
    expect(s.thermal).toBe(Thermal.serious);
    expect(changes).toBeGreaterThanOrEqual(2);
    expect(s.lowPowerMode).toBe(false);
  });

  test('frame-time pressure raises the thermal state, smoothed', () => {
    const s = new SystemInputs(fakeEnv().env);
    s.noteFrameDrop(1);
    expect(s.thermal).toBe(Thermal.nominal);    // one bad second is not heat
    for (let i = 0; i < 30; i++) s.noteFrameDrop(0.5);
    expect(s.thermal).toBe(Thermal.serious);
    for (let i = 0; i < 60; i++) s.noteFrameDrop(0);
    expect(s.thermal).toBe(Thermal.nominal);
  });

  test('heap memory warning is edge-triggered; kiosk lock changes are reported', () => {
    const f = fakeEnv();
    const s = new SystemInputs(f.env);
    let warnings = 0;
    const locks: boolean[] = [];
    s.onMemoryWarning = () => { warnings += 1; };
    s.onKioskLockChange = (on) => locks.push(on);
    s.poll();
    f.heap.used = 950; s.poll(); s.poll();
    expect(warnings).toBe(1);
    f.heap.used = 500; s.poll();
    f.heap.used = 950; s.poll();
    expect(warnings).toBe(2);
    f.setLock(true); s.poll(); s.poll();
    expect(locks).toEqual([true]);
    expect(s.kioskLock).toBe(true);
  });

  test('the wake lock is re-requested once released', async () => {
    const f = fakeEnv();
    const s = new SystemInputs(f.env);
    s.keepScreenOn();
    await Promise.resolve();
    expect(s.screenKeptOn).toBe(true);
    s.keepScreenOn();
    expect(f.requests()).toBe(1);
    f.sentinel.released = true;
    expect(s.screenKeptOn).toBe(false);
    s.keepScreenOn();
    expect(f.requests()).toBe(2);
    const none = new SystemInputs({ ...f.env, wakeLock: undefined, getBattery: undefined, PressureObserver: undefined });
    none.start();
    none.keepScreenOn();
    expect(none.screenKeptOn).toBe(false);
    expect(none.batteryPercent).toBeNull();
    expect(none.plugged(0)).toBeNull();
  });
});

describe('BacklightFollower', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('eases down to 20 % over 3 s on asleep, restores at once', () => {
    const el = { style: { filter: '' } };
    const b = new BacklightFollower(true, el);
    b.phaseChanged(true);
    vi.advanceTimersByTime(1500);
    expect(b.level).toBeGreaterThan(0.2);
    expect(b.level).toBeLessThan(1);
    vi.advanceTimersByTime(1600);
    expect(b.level).toBeCloseTo(0.2, 6);
    expect(el.style.filter).toBe('brightness(0.200)');
    b.phaseChanged(false);
    expect(el.style.filter).toBe('');
  });

  test('never on OLED', () => {
    const el = { style: { filter: '' } };
    new BacklightFollower(false, el).phaseChanged(true);
    vi.advanceTimersByTime(5000);
    expect(el.style.filter).toBe('');
  });
});

describe('BurnInCheck', () => {
  test('six 20 s steps, then done', () => {
    expect(BurnInCheckModel.steps).toEqual(['grey18', 'grey50', 'red', 'green', 'blue', 'ramp']);
    expect(BurnInCheckModel.step(0)).toBe('grey18');
    expect(BurnInCheckModel.step(19.9)).toBe('grey18');
    expect(BurnInCheckModel.step(20)).toBe('grey50');
    expect(BurnInCheckModel.step(119)).toBe('ramp');
    expect(BurnInCheckModel.step(120)).toBeNull();
    expect(BurnInCheckModel.field('grey18')).toBe('rgb(46, 46, 46)');
    expect(BurnInCheckModel.field('ramp')).toContain('linear-gradient');
    expect(BurnInCheckModel.value(45)).toBe('Step 3 of 6: red');
  });
});

describe('HealthCard', () => {
  const snap = (o: Partial<HealthSnap> = {}): HealthSnap => ({
    overall: 'ok', launchMode: 'normal', uptime: 3 * 3600 + 12 * 60, lastRestart: 'first launch', crashes24h: 0, crashes7d: 0,
    hangs: 0, resourceLevel: 0, resourceReason: 'nominal', thermal: 'nominal', lowPower: false, battery: 80, plugged: true,
    footprintMB: 120.4, leak: [], awakeDelivery: 'awake 60.0 fps', subsystems: [{ name: 'render', state: 'ok', problem: false, lastError: null }],
    skipped: [], device: 'iPad', tierHint: 'full', calibrated: true, kioskLock: true, selfRestartOnHang: false, screenKeptOn: true, ...o });

  test('rows, banners and the dot', () => {
    const m = HealthCard.model(snap());
    expect(m.dot).toBe('green');
    expect(m.title).toBe('ok · up 3 h 12 min');
    expect(m.banners).toEqual([]);
    expect(m.rows.find((r) => r.label === 'power')?.value).toBe('thermal nominal · battery 80% · plugged in');
    expect(m.rows.find((r) => r.label === 'memory')?.value).toBe('120.4 MB · leak alarm quiet');
    const safe = HealthCard.model(snap({ overall: 'safe_mode', skipped: ['audio'], kioskLock: false, leak: ['footprint slope'],
      subsystems: [{ name: 'audio', state: 'restarting (2)', problem: true, lastError: 'audio interrupted' }] }));
    expect(safe.dot).toBe('red');
    expect(safe.banners[0].color).toBe('red');
    expect(safe.rows.find((r) => r.label === 'held back')?.tint).toBe('orange');
    expect(safe.rows.find((r) => r.label === 'audio')?.value).toBe('restarting (2) · audio interrupted');
    expect(safe.rows.find((r) => r.label === 'kiosk')?.tint).toBe('orange');
    expect(HealthCard.duration(59)).toBe('0 min');
    expect(HealthCard.duration(2 * 86_400 + 3 * 3600)).toBe('2 d 3 h');
  });
});
