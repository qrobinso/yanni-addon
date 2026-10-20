// Port of YanniSettings/OwnerAccess.swift: the optional 4-digit owner PIN that gates Settings and Tuning (Status is
// never gated: it's read-only). Stored as a salted SHA-256 (local storage instead of the Keychain). Five wrong tries
// lock entry for 60 s.

export type Verdict = 'ok' | 'wrong' | { locked: number };

export interface KeyValue {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const KEY = 'yanni.ownerPIN';
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export class OwnerAccess {
  static readonly maxTries = 5;
  static readonly lockSeconds = 60;
  static readonly pinLength = 4;

  failures = 0;
  lockedUntil: number | undefined;

  constructor(private readonly store: KeyValue, private readonly now: () => number = () => performance.now() / 1000) {}

  /** crypto.subtle exists only in a secure context (HTTPS or localhost). */
  static get available(): boolean { return typeof crypto !== 'undefined' && crypto.subtle !== undefined; }

  get isPINRequired(): boolean { return this.read() !== undefined; }

  static isWellFormed(pin: string): boolean { return /^[0-9]{4}$/.test(pin); }

  /** Sets (or changes) the PIN. False for a malformed PIN or no storage. */
  async setPIN(pin: string): Promise<boolean> {
    if (!OwnerAccess.isWellFormed(pin) || !OwnerAccess.available) return false;
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    try { this.store.setItem(KEY, JSON.stringify({ salt, hash: await OwnerAccess.hash(pin, salt) })); } catch { return false; }
    this.failures = 0;
    this.lockedUntil = undefined;
    return true;
  }

  clearPIN(): void {
    try { this.store.removeItem(KEY); } catch { /* storage blocked: nothing stored either */ }
    this.failures = 0;
    this.lockedUntil = undefined;
  }

  async verify(pin: string): Promise<Verdict> {
    const t = this.now();
    if (this.lockedUntil !== undefined) {
      if (t < this.lockedUntil) return { locked: this.lockedUntil - t };
      this.lockedUntil = undefined;
      this.failures = 0;
    }
    const stored = this.read();
    if (!stored) return 'ok';
    if (OwnerAccess.available && await OwnerAccess.hash(pin, stored.salt) === stored.hash) {
      this.failures = 0;
      return 'ok';
    }
    this.failures += 1;
    if (this.failures >= OwnerAccess.maxTries) {
      this.lockedUntil = t + OwnerAccess.lockSeconds;
      return { locked: OwnerAccess.lockSeconds };
    }
    return 'wrong';
  }

  static async hash(pin: string, salt: string): Promise<string> {
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + pin))));
  }

  private read(): { salt: string; hash: string } | undefined {
    try {
      const v = JSON.parse(this.store.getItem(KEY) ?? 'null');
      return typeof v?.salt === 'string' && typeof v?.hash === 'string' ? v : undefined;
    } catch { return undefined; }
  }
}
