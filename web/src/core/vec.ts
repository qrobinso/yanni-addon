// SIMD2/3/4<Float> stand-ins: plain mutable objects plus free functions. Hot paths mutate in place.
export interface V2 { x: number; y: number }
export interface V3 { x: number; y: number; z: number }
export interface V4 { x: number; y: number; z: number; w: number }

export const v2 = (x = 0, y = x): V2 => ({ x, y });
export const v3 = (x = 0, y = x, z = x): V3 => ({ x, y, z });
export const v4 = (x = 0, y = x, z = x, w = x): V4 => ({ x, y, z, w });

export const add2 = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub2 = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul2 = (a: V2, b: V2): V2 => ({ x: a.x * b.x, y: a.y * b.y });
export const scale2 = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });
export const len2 = (a: V2): number => Math.hypot(a.x, a.y);
export const dot2 = (a: V2, b: V2): number => a.x * b.x + a.y * b.y;
export const eq2 = (a: V2, b: V2): boolean => a.x === b.x && a.y === b.y;

export const add3 = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale3 = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const mix3 = (a: V3, b: V3, t: number): V3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

export const add4 = (a: V4, b: V4): V4 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z, w: a.w + b.w });
export const scale4 = (a: V4, s: number): V4 => ({ x: a.x * s, y: a.y * s, z: a.z * s, w: a.w * s });

export const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Swift `.rounded()` (schoolbook: half away from zero). */
export const roundSwift = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));
