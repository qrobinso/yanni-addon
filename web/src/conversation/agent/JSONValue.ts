// Port of ConversationAgent/JSONValue.swift. A JSON value: Home Assistant WebSocket messages, which are free-form.
// port-note: plain JSON (what `JSON.parse` gives) instead of an enum; the subscripts become `at(v, ...keys)`.

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };

const isObject = (v: unknown): v is JSONObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `v[k1]?[k2]?…`: undefined as soon as a step isn't an object or lacks the key. */
export function at(v: JSONValue | undefined, ...keys: string[]): JSONValue | undefined {
  let cur: JSONValue | undefined = v;
  for (const k of keys) {
    if (!isObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export const stringValue = (v: JSONValue | undefined): string | null => (typeof v === 'string' ? v : null);
export const objectValue = (v: JSONValue | undefined): JSONObject | null => (isObject(v) ? v : null);
export const arrayValue = (v: JSONValue | undefined): JSONValue[] | null => (Array.isArray(v) ? v : null);
