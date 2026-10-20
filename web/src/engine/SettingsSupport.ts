// Shared helpers for the tolerant settings decoders (Swift Codable `decodeIfPresent ?? default`). No Swift file.

/// A Swift `ClosedRange<Float>`: [lowerBound, upperBound].
export type ClosedRangeF = readonly [number, number];

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/// Finite values clamped into `r`, non-finite ones replaced by `fallback`.
export const clampOr = (v: number, r: ClosedRangeF, fallback: number): number =>
  Number.isFinite(v) ? Math.min(Math.max(v, r[0]), r[1]) : fallback;

/// The value at `key` when it has the default's JS type, else the default (Swift's tolerant decode).
export function decodeField<T extends number | boolean | string>(o: Record<string, unknown>, key: string, d: T): T {
  const v = o[key];
  return typeof v === typeof d ? (v as T) : d;
}
