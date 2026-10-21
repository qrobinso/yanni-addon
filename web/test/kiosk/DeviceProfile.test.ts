// Port of YanniDeviceTests/DeviceProfileTests.swift, against the browser's screen-keyed table.
import { describe, expect, test } from 'vitest';
import { DeviceDefaults } from '../../src/kiosk/DeviceDefaults';
import { browserProfile, DeviceProbe, DeviceProfile, treatAsOLED, type DeviceOverrides } from '../../src/kiosk/DeviceProfile';
import { DeviceTable } from '../../src/kiosk/DeviceTable';
import { desktopEnv, iPadEnv, iPadSafari } from './support';

const profile = (machine: string, fps: number | null = null, overrides: DeviceOverrides = {}) =>
  DeviceProfile.make({ machine, isDesktop: false, maxFramesPerSecond: fps, memoryBytes: 8 * 2 ** 30, overrides });

describe('DeviceProfile', () => {
  test('every table row looks up', () => {
    for (const row of DeviceTable.rows) {
      for (const id of row.ids) {
        const p = profile(id, row.maxHz);
        expect(p.calibrated).toBe(row.calibrated);
        expect(p.name).toBe(row.name);
        expect(p.display).toBe(row.display);
        expect(p.cameraEdge).toBe(row.camera);
        expect(p.chipClass).toBe(row.chip);
        expect(p.maxFramesPerSecond).toBe(row.maxHz);
        expect(p.physicalSizeMetres?.length).toBe(2);
      }
    }
    // A shared screen key is told apart by the refresh rate.
    expect(profile('iPad 1366x1024@2', 120).name).toBe('iPad Pro 12.9 (A12X–M2)');
    expect(profile('iPad 1366x1024@2', 60).name).toBe('iPad Air 13 (M2–M4)');
  });

  test('target device is OLED, 120 Hz, long-edge camera', () => {
    const p = profile('iPad 1210x834@2');
    expect(p.family === 'iPadPro' && p.display === 'oled' && p.maxFramesPerSecond === 120 && p.cameraEdge === 'long').toBe(true);
    const d = DeviceDefaults.for(p);
    expect(d.maxLuminanceCap).toBe(0.80);
    expect(d.idleDimLevel).toBe(0.55);
    expect(d.backgroundAPLBudget).toBe(DeviceDefaults.oledBackgroundAPLBudget);
    expect(d.backlightFollowsSleep).toBe(false);
    expect(d.burstCeilingFPS).toBe(120);
    expect(d.tierHint).toBe('full');
  });

  test('the owner\'s A12Z iPad Pro 11 is LCD at 120 Hz', () => {
    const p = browserProfile(iPadEnv(834, 1194), { maxFramesPerSecond: 120 });
    expect(p.name).toBe('iPad Pro 11 (A12X–M2)');
    expect(p.display).toBe('lcd');
    expect(DeviceDefaults.for(p).backlightFollowsSleep).toBe(true);
    expect(DeviceDefaults.for(p).tierHint).toBe('standard');
  });

  test('unknown model gets OLED-safe defaults', () => {
    const p = profile('iPad 999x700@2');
    expect(p.calibrated).toBe(false);
    expect(p.display === 'unknown' && treatAsOLED(p.display)).toBe(true);
    expect(p.cameraEdge).toBe('unknown');
    expect(p.family).toBe('iPad');
    const d = DeviceDefaults.for(p);
    expect(d.maxLuminanceCap).toBe(0.80);
    expect(d.idleDimLevel).toBe(0.55);
    expect(d.backgroundAPLBudget).toBe(0.15);
    expect(d.backlightFollowsSleep).toBe(false);
  });

  test('LCD defaults', () => {
    const d = DeviceDefaults.for(profile('iPad 1133x744@2'));
    expect(d.maxLuminanceCap).toBeNull();
    expect(d.idleDimLevel).toBe(0.70);
    expect(d.backgroundAPLBudget).toBe(0);
    expect(d.backlightFollowsSleep).toBe(true);
    expect(d.burstCeilingFPS).toBe(60);
  });

  test('probe wins over table', () => {
    const p = profile('iPad 1210x834@2', 60);
    expect(p.maxFramesPerSecond).toBe(60);
    expect(DeviceDefaults.for(p).burstCeilingFPS).toBe(60);
  });

  test('overrides apply last', () => {
    const p = profile('iPad 1210x834@2', null, { display: 'lcd', maxFramesPerSecond: 60 });
    expect(p.display === 'lcd' && p.maxFramesPerSecond === 60).toBe(true);
    expect(profile('iPad 1133x744@2', null, { maxFramesPerSecond: 120 }).maxFramesPerSecond).toBe(60);
    expect(JSON.parse(JSON.stringify({ display: 'oled' } satisfies DeviceOverrides)).display).toBe('oled');
  });

  test('desktop preview', () => {
    const p = browserProfile(desktopEnv, { maxFramesPerSecond: 120 });
    expect(p.family === 'desktop' && p.cameraEdge === 'aboveDisplay' && p.maxFramesPerSecond === 120).toBe(true);
    expect(p.memoryBytes).toBe(8 * 2 ** 30);
    const d = DeviceDefaults.for(p);
    expect(d.maxLuminanceCap === null && d.backgroundAPLBudget === 0 && !d.backlightFollowsSleep).toBe(true);
    expect(d.tierHint).toBe('full');
  });

  test('targets are the single definition', () => {
    expect(DeviceDefaults.awakeTargetFPS).toBe(60);
    expect(DeviceDefaults.asleepTargetFPS).toBe(30);
  });

  test('probes read the user agent and screen', () => {
    expect(DeviceProbe.isIPad(iPadEnv(834, 1210))).toBe(true);
    expect(DeviceProbe.machine(iPadEnv(834, 1210))).toEqual({ machine: 'iPad 1210x834@2', isDesktop: false });
    expect(DeviceProbe.machine({ ...iPadEnv(834, 1210), userAgent: iPadSafari.replace('Macintosh; Intel Mac OS X', 'iPad; CPU OS'), maxTouchPoints: 5 }).machine)
      .toBe('iPad 1210x834@2');
    expect(DeviceProbe.machine(desktopEnv)).toEqual({ machine: 'desktop', isDesktop: true });
    const tab = { ...desktopEnv, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/140 Safari/537.36', maxTouchPoints: 10 };
    expect(DeviceProbe.machine(tab).machine).toBe('tablet SM-X710');
    expect(browserProfile(tab).family).toBe('tablet');
    expect(browserProfile(tab).calibrated).toBe(false);
  });

  test('profile round-trips as JSON', () => {
    const p = profile('iPad 1376x1032@2');
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    expect(DeviceProfile.summary(p)).toContain('iPad Pro 13 (M4/M5) · iPad 1376x1032@2 · oled · 120 Hz');
  });
});
