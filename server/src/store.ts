import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SETTINGS_CHECKS, type EntitySettings } from './protocol.js';

export interface DeviceRecord {
  /** First 8 hex chars of installId: the MQTT node is `yanni_<id>`, topics `yanni/<id>/…`. */
  id: string;
  /** The Swift app's install ID when migrating an iPad (same node, topics and unique_ids), else a random UUID. */
  installId: string;
  room: string;
  /** sha256 hex of the device token (the token itself is never stored). */
  tokenHash: string;
  pairedAt: string;
}

function readJSON<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}

/** Write-then-rename, so a crash never leaves half a file. */
function writeJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const PAIR_CODE_TTL_MS = 10 * 60_000;
/** Attempts per source IP per minute. */
export const PAIR_ATTEMPTS_PER_MINUTE = 5;
/** Wrong codes (all sources) per 10 minutes before every open code is invalidated. */
export const PAIR_GLOBAL_FAILURES = 20;

interface PendingCode { code: string; room: string; installId: string; expiresAt: number }

/** Paired displays (/data/devices.json), one-time pairing codes (memory only) and token checks. */
export class Devices {
  private devices: DeviceRecord[];
  private codes: PendingCode[] = [];
  private attempts = new Map<string, number[]>();
  private failures: number[] = [];
  private readonly path: string;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.path = join(dataDir, 'devices.json');
    this.devices = readJSON<DeviceRecord[]>(this.path, []);
  }

  list(): readonly DeviceRecord[] { return this.devices; }
  get(id: string): DeviceRecord | undefined { return this.devices.find((d) => d.id === id); }

  /** A new 6-digit code (ingress only). `installId` adopts an existing Swift install's identity. */
  createCode(room: string, installId?: string): { code: string; expiresAt: number } | { error: string } {
    room = room.trim();
    if (!SETTINGS_CHECKS.room(room)) return { error: 'room must be 1-40 characters, no control characters' };
    const id = installId?.trim() || randomUUID();
    if (!/^[0-9a-fA-F-]{8,64}$/.test(id) || !/^[0-9a-fA-F]{8}/.test(id)) return { error: 'install ID must start with 8 hex digits' };
    if (this.get(id.slice(0, 8).toLowerCase())) return { error: 'a display with that install ID is already paired' };
    this.prune();
    let code: string;
    do { code = String(randomInt(0, 1_000_000)).padStart(6, '0'); } while (this.codes.some((c) => c.code === code));
    const expiresAt = this.now() + PAIR_CODE_TTL_MS;
    this.codes.push({ code, room, installId: id, expiresAt });
    return { code, expiresAt };
  }

  openCodes(): readonly PendingCode[] { this.prune(); return this.codes; }

  /** Redeems a code for a device token (the display keeps it in local storage). */
  redeem(code: unknown, source: string): { device: DeviceRecord; token: string } | { error: string; status: number } {
    const t = this.now();
    // Many sources (a scan): forget sources with no attempt in the last minute so the map stays small.
    if (this.attempts.size > 1000) for (const [k, v] of this.attempts) if (!v.some((x) => t - x < 60_000)) this.attempts.delete(k);
    const recent = (this.attempts.get(source) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= PAIR_ATTEMPTS_PER_MINUTE) return { error: 'too many attempts, wait a minute', status: 429 };
    recent.push(t);
    this.attempts.set(source, recent);
    this.prune();
    const hit = typeof code === 'string' ? this.codes.find((c) => c.code === code) : undefined;
    if (!hit) {
      this.failures = this.failures.filter((x) => t - x < 10 * 60_000);
      this.failures.push(t);
      // Brute force from many sources: kill every open code; the owner makes a new one.
      if (this.failures.length >= PAIR_GLOBAL_FAILURES) { this.codes = []; this.failures = []; }
      return { error: 'wrong or expired code', status: 403 };
    }
    this.codes = this.codes.filter((c) => c !== hit);
    const token = randomBytes(32).toString('base64url');
    const device: DeviceRecord = { id: hit.installId.slice(0, 8).toLowerCase(), installId: hit.installId, room: hit.room,
      tokenHash: sha256(token), pairedAt: new Date(t).toISOString() };
    if (this.get(device.id)) return { error: 'a display with that install ID is already paired', status: 409 };
    this.devices.push(device);
    this.save();
    return { device, token };
  }

  authenticate(token: unknown): DeviceRecord | undefined {
    if (typeof token !== 'string' || !token) return undefined;
    const h = Buffer.from(sha256(token), 'hex');
    return this.devices.find((d) => timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), h));
  }

  rename(id: string, room: string): void {
    const d = this.get(id);
    if (d && d.room !== room) { d.room = room; this.save(); }
  }

  revoke(id: string): boolean {
    const n = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === n) return false;
    this.save();
    return true;
  }

  private prune(): void { const t = this.now(); this.codes = this.codes.filter((c) => c.expiresAt > t); }
  private save(): void { writeJSON(this.path, this.devices); }
}

/** Per-display settings (/data/settings/<deviceId>.json): the last values seen from the display or HA. */
export class SettingsStore {
  private cache = new Map<string, Partial<EntitySettings>>();
  constructor(private readonly dataDir: string) {}

  private path(id: string) { return join(this.dataDir, 'settings', `${id}.json`); }

  get(id: string): Partial<EntitySettings> {
    let s = this.cache.get(id);
    if (!s) { s = readJSON<Partial<EntitySettings>>(this.path(id), {}); this.cache.set(id, s); }
    return s;
  }

  /** Last writer wins. Returns the keys whose values changed. */
  merge(id: string, values: Partial<EntitySettings>): (keyof EntitySettings)[] {
    const s = this.get(id) as Record<string, unknown>;
    const changed = (Object.keys(values) as (keyof EntitySettings)[]).filter((k) => s[k] !== values[k]);
    if (changed.length) { Object.assign(s, values); writeJSON(this.path(id), s); }
    return changed;
  }

  delete(id: string): void { this.cache.delete(id); rmSync(this.path(id), { force: true }); }
}
