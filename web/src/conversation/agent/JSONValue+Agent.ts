// Port of ConversationAgent/JSONValue+Agent.swift.
import type { JSONValue } from './JSONValue';

export const doubleValue = (v: JSONValue | undefined): number | null => (typeof v === 'number' ? v : null);
export function intValue(v: JSONValue | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v !== Math.round(v) || Math.abs(v) >= 9e15) return null;
  return v;
}
export const boolValue = (v: JSONValue | undefined): boolean | null => (typeof v === 'boolean' ? v : null);
export const isNull = (v: JSONValue | undefined): boolean => v === null;

function sorted(v: JSONValue): JSONValue {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === 'object') {
    const o: { [k: string]: JSONValue } = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sorted(v[k]);
    return o;
  }
  return v;
}

/** Compact JSON text (sorted keys, so encodings are stable in tests and fixtures). */
export function jsonString(v: JSONValue): string {
  try { return JSON.stringify(sorted(v)) ?? 'null'; } catch { return 'null'; }
}

export const parseJSON = (text: string): JSONValue => JSON.parse(text) as JSONValue;

/** A string or `null` (Swift's `Optional<String>.json`). */
export const jsonOrNull = (s: string | null | undefined): JSONValue => s ?? null;
