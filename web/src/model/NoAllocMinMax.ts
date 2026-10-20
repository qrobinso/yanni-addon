// Port of FaceModel/NoAllocMinMax.swift.
/// `max` / `min` of four or more values. Results are identical to Swift's `max(a, b, c, d, …)` / `min(…)`,
/// including their order of comparisons (so NaN handling matches Swift, not `Math.max`).

/** Swift.max(x, y): `y >= x ? y : x`. */
const smax = (x: number, y: number): number => (y >= x ? y : x);
/** Swift.min(x, y): `y < x ? y : x`. */
const smin = (x: number, y: number): number => (y < x ? y : x);

export function maxOf(a: number, b: number, c: number, d: number, e?: number, f?: number): number {
  let m = smax(smax(a, b), c);
  if (d >= m) m = d;
  if (e !== undefined && e >= m) m = e;
  if (f !== undefined && f >= m) m = f;
  return m;
}

export function minOf(a: number, b: number, c: number, d: number): number {
  let m = smin(smin(a, b), c);
  if (d < m) m = d;
  return m;
}
