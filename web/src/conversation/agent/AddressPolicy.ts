// Port of ConversationAgent/AddressPolicy.swift. Plain (unencrypted) hosts must be local (design §12): RFC 1918,
// loopback, link-local, ULA, Tailscale's 100.64/10 and `.local` names. Other names are resolved and every address
// must be local.
// port-note: nothing in the add-on display uses it today (no Wyoming, no direct HA URL; the add-on relays HA). A
// browser has no DNS, so the resolver is injected; `inet_pton` is replaced by small IPv4/IPv6 literal parsers.

export type AddressVerdict =
  /** Allowed; `connectHost` is what to connect to (the checked address for a resolved name). */
  | { kind: 'local'; connectHost: string }
  | { kind: 'notLocal'; why: string };

/** Name → addresses (literals). A table in tests. */
export interface HostResolving {
  resolve(host: string): Promise<string[]>;
}

export class HostResolveFailed extends Error { override name = 'HostResolveFailed'; }

/** A fixed table (tests). */
export class StaticHostResolver implements HostResolving {
  constructor(readonly table: Record<string, string[]> = {}) {}
  async resolve(host: string): Promise<string[]> {
    const a = this.table[host.toLowerCase()];
    if (!a) throw new HostResolveFailed();
    return a;
  }
}

function parseV4(h: string): number | null {
  const parts = h.split('.');
  if (parts.length !== 4) return null;
  let a = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    a = a * 256 + Number(p);
  }
  return a;
}

function parseV6(h: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(h)) return null;
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    const parts = s.split(':');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === parts.length - 1 && p.includes('.')) {
        const v4 = parseV4(p);
        if (v4 === null) return null;
        out.push(Math.floor(v4 / 65536), v4 % 65536);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
        out.push(parseInt(p, 16));
      }
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const words = [...head, ...Array<number>(fill).fill(0), ...tail];
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

export const AddressPolicy = {
  /** Whether an IP literal is in a local range; null when `host` isn't an IP literal. */
  isLocalAddress(host: string): boolean | null {
    let h = host;
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    const pct = h.indexOf('%');
    if (pct >= 0) h = h.slice(0, pct); // fe80::1%en0
    const v4 = parseV4(h);
    if (v4 !== null) return AddressPolicy.isLocalV4(v4);
    const v6 = parseV6(h);
    if (v6 !== null) return AddressPolicy.isLocalV6(v6);
    return null;
  },

  isLocalV4(a: number): boolean {
    const o1 = Math.floor(a / 2 ** 24), o2 = Math.floor(a / 65536) % 256;
    if (o1 === 10 || o1 === 127) return true; // 10/8, loopback
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16/12
    if (o1 === 192 && o2 === 168) return true; // 192.168/16
    if (o1 === 169 && o2 === 254) return true; // link-local
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true; // 100.64/10 (Tailscale, CGNAT)
    return false;
  },

  isLocalV6(b: readonly number[]): boolean {
    if (b.length !== 16) return false;
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
    if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7
    if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) { // ::ffff:a.b.c.d
      return AddressPolicy.isLocalV4(((b[12] * 256 + b[13]) * 256 + b[14]) * 256 + b[15]);
    }
    return false;
  },

  /** `.local` (mDNS) names. */
  isLocalName(host: string): boolean {
    const h = host.toLowerCase().replace(/^\.+|\.+$/g, '');
    return h.endsWith('.local') && h.length > 6;
  },

  /** The full check, resolving names that aren't literals or `.local`. */
  async check(host: string, resolver: HostResolving): Promise<AddressVerdict> {
    const h = host.trim();
    if (h === '') return { kind: 'notLocal', why: 'no host' };
    const local = AddressPolicy.isLocalAddress(h);
    if (local !== null) return local ? { kind: 'local', connectHost: h } : { kind: 'notLocal', why: `${h} is not a local address` };
    if (AddressPolicy.isLocalName(h)) return { kind: 'local', connectHost: h };
    let addresses: string[];
    try { addresses = await resolver.resolve(h); } catch { return { kind: 'notLocal', why: `${h} did not resolve` }; }
    const first = addresses[0];
    if (first === undefined) return { kind: 'notLocal', why: `${h} did not resolve` };
    for (const a of addresses) if (AddressPolicy.isLocalAddress(a) !== true) return { kind: 'notLocal', why: `${h} resolves to a non-local address` };
    return { kind: 'local', connectHost: first };
  },
};
