// Port of YanniKioskTests/DiagnosticsTests.swift (the provisioning, open-decision and MetricKit tests have no web
// equivalent: MAPPING.md).
import { describe, expect, test } from 'vitest';
import { browserProfile } from '../../src/kiosk/DeviceProfile';
import { DiagnosticsExport, type DiagnosticsManifest } from '../../src/kiosk/DiagnosticsExport';
import { DiagnosticsLog } from '../../src/kiosk/DiagnosticsLog';
import { iPadEnv, memoryStore } from './support';

describe('DiagnosticsLog', () => {
  test('ring log batches and reads back', () => {
    const log = new DiagnosticsLog(memoryStore());
    log.add('app', 'launch normal');
    log.add('health', 'render ok');
    expect(log.readAll()).toEqual([]);          // batched: nothing written yet
    log.flush();
    const lines = log.readAll();
    expect(lines.map((l) => l.m)).toEqual(['launch normal', 'render ok']);
    expect(lines.map((l) => l.c)).toEqual(['app', 'health']);
  });

  test('ring rotates and caps its size', () => {
    const limit = 4096, count = 3;
    const log = new DiagnosticsLog(memoryStore(), limit, count);
    for (let i = 0; i < 2000; i++) {
      log.add('app', `line ${i} ` + 'x'.repeat(40));
      if (i % 50 === 0) log.flush();
    }
    log.flush();
    expect(log.totalBytes()).toBeLessThanOrEqual(limit * count + 8192);
    const lines = log.readAll();
    expect(lines[lines.length - 1].m.startsWith('line 1999')).toBe(true);   // newest kept
    expect(lines[0].m.startsWith('line 0 ')).toBe(false);                    // oldest dropped
  });

  test('long messages are truncated', () => {
    const log = new DiagnosticsLog(memoryStore());
    log.add('app', 'a'.repeat(5000));
    log.flush();
    expect(log.readAll()[0].m.length).toBeLessThanOrEqual(DiagnosticsLog.maxMessage + 1);
  });

  test('a full store loses the batch, never throws', () => {
    const s = memoryStore();
    const full = { ...s, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    const log = new DiagnosticsLog(full);
    log.add('app', 'x');
    expect(() => log.flush()).not.toThrow();
  });
});

describe('DiagnosticsExport', () => {
  const manifest = (): DiagnosticsManifest => ({ app: '1.0 (1)', os: 'test', device: browserProfile(iPadEnv(834, 1210), { maxFramesPerSecond: 120 }),
    uptimeSeconds: 100, kioskLock: true, displayMode: 'fullscreen', crossOriginIsolated: true, exportedAt: '2030-03-17T17:46:40.000Z' });

  test('export has the manifest and no secrets, transcripts or message text', async () => {
    const bundle = DiagnosticsExport.build({ manifest: manifest(),
      settings: { device: { roomName: 'Den' }, server: { token: 'abc' } },
      health: { overall: 'ok' }, events: ['Life: asleep → halfAwake (person)'],
      copies: { launches: [{ app: '1.0' }], leaky: { transcript: 'hello there' } } });
    expect(Object.keys(bundle).sort()).toEqual(['events', 'health', 'launches', 'manifest']);   // settings with a token, leaky dropped
    for (const v of Object.values(bundle)) expect(DiagnosticsExport.containsForbidden(JSON.stringify(v))).toBe(false);
    expect((bundle.manifest as DiagnosticsManifest).device.machine).toBe('iPad 1210x834@2');
    const blob = DiagnosticsExport.blob({ manifest: manifest(), events: [], copies: {} });
    expect(blob.type).toBe('application/json');
    expect(blob.size).toBeGreaterThan(100);
    expect(JSON.parse(await blob.text()).manifest.app).toBe('1.0 (1)');
    expect(DiagnosticsExport.fileName('2030-03-17T17:46:40.000Z')).toBe('yanni-diagnostics-2030-03-17T17-46-40.000Z.json');
  });

  test('scanner catches forbidden keys', () => {
    expect(DiagnosticsExport.containsForbidden('{"brokerPassword":"x"}')).toBe(true);
    expect(DiagnosticsExport.containsForbidden('{"text":"Dinner is ready"}')).toBe(true);
    expect(DiagnosticsExport.containsForbidden('{"pinEnabled":false,"roomName":"Den"}')).toBe(false);
  });
});
