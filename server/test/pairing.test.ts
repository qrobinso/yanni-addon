import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Devices, PAIR_ATTEMPTS_PER_MINUTE, PAIR_CODE_TTL_MS, PAIR_GLOBAL_FAILURES, SettingsStore } from '../src/store.js';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'yanni-'));
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  return { dir, clock, devices: new Devices(dir, clock.now) };
}

const codeOf = (r: ReturnType<Devices['createCode']>) => { if ('error' in r) throw new Error(r.error); return r.code; };

describe('pairing', () => {
  it('redeems a code once for a token that authenticates, stored only as a hash', () => {
    const { dir, devices } = rig();
    const code = codeOf(devices.createCode('Kitchen'));
    expect(code).toMatch(/^\d{6}$/);
    const r = devices.redeem(code, '10.0.0.5');
    if ('error' in r) throw new Error(r.error);
    expect(r.device.room).toBe('Kitchen');
    expect(r.device.id).toMatch(/^[0-9a-f]{8}$/);
    expect(devices.authenticate(r.token)?.id).toBe(r.device.id);
    expect(devices.authenticate(r.token + 'x')).toBeUndefined();
    expect(devices.authenticate('')).toBeUndefined();
    expect(readFileSync(join(dir, 'devices.json'), 'utf8')).not.toContain(r.token);
    expect(devices.redeem(code, '10.0.0.5')).toMatchObject({ status: 403 }); // one-time
    // Survives a restart.
    expect(new Devices(dir).authenticate(r.token)?.id).toBe(r.device.id);
  });

  it('a test code pairs a new display every time, only when configured', () => {
    const { dir } = rig();
    const devices = new Devices(dir, Date.now, '1111');
    const a = devices.redeem('1111', 'a'), b = devices.redeem('1111', 'a');
    if ('error' in a || 'error' in b) throw new Error('test code refused');
    expect(a.device.room).toBe('Test');
    expect(a.device.id).not.toBe(b.device.id);
    expect(new Devices(mkdtempSync(join(tmpdir(), 'yanni-'))).redeem('1111', 'a')).toMatchObject({ status: 403 });
  });

  it('expires codes after 10 minutes', () => {
    const { clock, devices } = rig();
    const code = codeOf(devices.createCode('Hall'));
    clock.advance(PAIR_CODE_TTL_MS + 1);
    expect(devices.redeem(code, 'a')).toMatchObject({ status: 403 });
  });

  it('rate-limits attempts per source', () => {
    const { clock, devices } = rig();
    const code = codeOf(devices.createCode('Hall'));
    for (let i = 0; i < PAIR_ATTEMPTS_PER_MINUTE; i++) expect(devices.redeem('000000x', 'a')).toMatchObject({ status: 403 });
    expect(devices.redeem(code, 'a')).toMatchObject({ status: 429 });
    clock.advance(60_001);
    expect(devices.redeem(code, 'a')).toHaveProperty('token');
  });

  it('kills every open code after too many wrong guesses from anywhere', () => {
    const { devices } = rig();
    const code = codeOf(devices.createCode('Hall'));
    for (let i = 0; i < PAIR_GLOBAL_FAILURES; i++) devices.redeem('bad', `10.0.${i}.1`);
    expect(devices.redeem(code, 'fresh')).toMatchObject({ status: 403 });
  });

  it('adopts a Swift install ID and refuses duplicates; revoke removes the device', () => {
    const { devices } = rig();
    const install = 'A1B2C3D4-0000-4000-8000-000000000000';
    const r = devices.redeem(codeOf(devices.createCode('Den', install)), 'a');
    if ('error' in r) throw new Error(r.error);
    expect(r.device.id).toBe('a1b2c3d4');
    expect(devices.createCode('Den', install)).toHaveProperty('error');
    expect(devices.createCode('Den', 'nothex!')).toHaveProperty('error');
    expect(devices.revoke('a1b2c3d4')).toBe(true);
    expect(devices.authenticate(r.token)).toBeUndefined();
  });

  it('settings store: last writer wins and reports what changed', () => {
    const { dir } = rig();
    const s = new SettingsStore(dir);
    expect(s.merge('abcd1234', { sounds: true, chirp_volume: 50 })).toEqual(['sounds', 'chirp_volume']);
    expect(s.merge('abcd1234', { sounds: true, chirp_volume: 70 })).toEqual(['chirp_volume']);
    expect(new SettingsStore(dir).get('abcd1234')).toEqual({ sounds: true, chirp_volume: 70 });
  });
});
