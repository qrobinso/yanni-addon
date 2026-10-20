// Port of FaceModel/Expression.swift.
import { BrowLayout, BrowPose } from './BrowPose';
import { FacePose } from './FacePose';
import { ParamLayout, type EyeParam, type PupilParam, type Side } from './ParamLayout';
import { roundSwift } from '../core/vec';
import bundledJson from './expressions.json';

/// Pleasure / arousal / dominance coordinates, each in -1...1.
export interface PAD { p: number; a: number; d: number }
export const PAD = {
  get zero(): PAD { return { p: 0, a: 0, d: 0 }; },
  equals: (a: PAD | undefined, b: PAD | undefined): boolean =>
    a === b || (a !== undefined && b !== undefined && a.p === b.p && a.a === b.a && a.d === b.d),
};

export interface Expression {
  name: string;
  pose: FacePose;
  pad?: PAD;
  /// The eyebrows (eye-relative units, see `BrowLayout`). Undefined = the library Neutral's brows.
  brows?: BrowPose;
}

export const makeExpression = (name: string, pose: FacePose, pad?: PAD, brows?: BrowPose): Expression =>
  ({ name, pose, pad, brows });

export const cloneExpression = (e: Expression): Expression =>
  ({ name: e.name, pose: e.pose.copy(), pad: e.pad && { ...e.pad }, brows: e.brows?.copy() });

/// Swift `==`.
export const expressionEquals = (a: Expression, b: Expression): boolean =>
  a.name === b.name && a.pose.equals(b.pose) && PAD.equals(a.pad, b.pad) &&
  (a.brows === b.brows || (a.brows !== undefined && b.brows !== undefined && a.brows.equals(b.brows)));

/// The named expression set, loaded from and saved to `expressions.json`.
// A class standing in for a Swift struct: `get` returns the stored expression (treat it as read-only; clone it with
// `cloneExpression` before editing, then `set` it back). Use `copy()` where the Swift copies the library.
export class ExpressionLibrary {
  private readonly _expressions = new Map<string, Expression>();
  attribution: string;

  constructor(expressions: Expression[], attribution = '') {
    for (const e of expressions) this._expressions.set(e.name, e); // later duplicates win
    this.attribution = attribution;
  }

  get expressions(): ReadonlyMap<string, Expression> { return this._expressions; }

  /// Names sorted for stability.
  // port-note: JS sort compares UTF-16 code units, Swift compares Unicode scalars; identical for the ASCII names.
  get names(): string[] { return [...this._expressions.keys()].sort(); }

  get(name: string): Expression | undefined { return this._expressions.get(name); }

  /// Stores a copy of `e`.
  set(e: Expression): void { this._expressions.set(e.name, cloneExpression(e)); }

  copy(): ExpressionLibrary {
    return new ExpressionLibrary([...this._expressions.values()].map(cloneExpression), this.attribution);
  }

  /// Neutral pose used as the blending reference. Falls back to defaults if missing.
  // Not a copy: read-only.
  get neutral(): FacePose { return this._expressions.get('Neutral')?.pose ?? DEFAULT_POSE; }

  /// The Neutral expression's brows (the brow blending reference). Falls back to `BrowPose.restNeutral`. Read-only.
  get neutralBrows(): BrowPose { return this._expressions.get('Neutral')?.brows ?? REST_NEUTRAL; }

  /// The brows of `name`: its own, or the library Neutral's when it has none (or is unknown). Read-only.
  brows(name: string): BrowPose { return this._expressions.get(name)?.brows ?? this.neutralBrows; }

  // MARK: Loading

  /// The library bundled with the package (a fresh parse each call), or `fallback` if it is corrupt.
  static bundled(): ExpressionLibrary {
    try {
      return ExpressionLibrary.fromObject(bundledJson);
    } catch {
      return ExpressionLibrary.fallback;
    }
  }

  /// Minimal compiled-in set so the eyes never go blank if the JSON is missing or corrupt. Fresh each access.
  static get fallback(): ExpressionLibrary {
    const neutral = FacePose.defaults;
    const asleep = FacePose.defaults;
    asleep.addBoth('centerY', 50); asleep.addBoth('upperLidY', 0.45); asleep.addBoth('lowerLidY', 0.5);
    const happy = FacePose.defaults;
    happy.addBoth('upperInnerRadiusX', 0.5); happy.addBoth('upperOuterRadiusX', 0.5);
    happy.addBoth('lowerLidY', 0.4); happy.addBoth('lowerLidBend', 0.4);
    return new ExpressionLibrary([
      makeExpression('Neutral', neutral, undefined, BrowPose.restNeutral),
      makeExpression('Asleep', asleep),
      makeExpression('Happiness', happy),
    ], 'fallback');
  }

  /// Swift `init(jsonData:)`. Throws on malformed JSON or on values of the wrong type.
  static fromJSON(text: string): ExpressionLibrary {
    return ExpressionLibrary.fromObject(JSON.parse(text) as unknown);
  }

  /// Decodes an already parsed JSON value with the same rules as the Swift `Codable` shape.
  static fromObject(json: unknown): ExpressionLibrary {
    const file = obj(json, 'root');
    if (typeof file.version !== 'number' || !Number.isInteger(file.version)) throw new Error('version: expected Int');
    const attribution = file.attribution == null ? undefined : str(file.attribution, 'attribution');
    const exprs = obj(file.expressions, 'expressions');
    const list: Expression[] = [];
    for (const [name, raw] of Object.entries(exprs)) {
      const e = obj(raw, name);
      const pad = e.pad == null ? undefined : decodePAD(e.pad, `${name}.pad`);
      const brows = e.brows == null ? undefined : decodeBrows(e.brows, `${name}.brows`);
      list.push(makeExpression(name, decodePose(e, name), pad, brows));
    }
    return new ExpressionLibrary(list, attribution ?? '');
  }

  /// Diff-friendly JSON: PyCozmo key order, expressions sorted by name, values rounded to 4 decimals.
  /// Swift `jsonData()` (UTF-8 text).
  jsonText(): string {
    const eye = (pose: FacePose, side: Side, indent: string): string => {
      const lines: string[] = [];
      for (const p of ParamLayout.Eye.allCases) {
        if (ParamLayout.Eye.lidKey(p) === undefined) lines.push(`${indent}  "${ParamLayout.Eye.key(p)}": ${num(pose.eye(side, p))}`);
      }
      const lids: [string, EyeParam, EyeParam, EyeParam][] = [
        ['upper_lid', 'upperLidY', 'upperLidAngle', 'upperLidBend'],
        ['lower_lid', 'lowerLidY', 'lowerLidAngle', 'lowerLidBend'],
      ];
      for (const [group, y, a, b] of lids) {
        lines.push(`${indent}  "${group}": {"y": ${num(pose.eye(side, y))}, "angle": ${num(pose.eye(side, a))}, "bend": ${num(pose.eye(side, b))}}`);
      }
      const pupil = ParamLayout.Pupil.allCases.map((q) => `"${q}": ${num(pose.eye(side, q))}`).join(', ');
      lines.push(`${indent}  "pupil": {${pupil}}`);
      return '{\n' + lines.join(',\n') + `\n${indent}}`;
    };
    let out = `{\n  "version": 1,\n  "attribution": ${quote(this.attribution)},\n  "expressions": {\n`;
    const blocks: string[] = [];
    for (const name of this.names) {
      const e = this._expressions.get(name);
      if (!e) continue;
      const face = ParamLayout.Face.allCases.map((f) => `"${ParamLayout.Face.key(f)}": ${num(e.pose.face(f))}`).join(', ');
      let block = `    ${quote(name)}: {\n      "face": {${face}},\n`;
      block += `      "left": ${eye(e.pose, 'left', '      ')},\n`;
      block += `      "right": ${eye(e.pose, 'right', '      ')}`;
      if (e.pad) block += `,\n      "pad": {"p": ${num(e.pad.p)}, "a": ${num(e.pad.a)}, "d": ${num(e.pad.d)}}`;
      if (e.brows) {
        const b = e.brows;
        const brow = (side: Side): string =>
          '{' + BrowLayout.Lane.allCases.map((l) => `"${l}": ${num(b.lane(side, l))}`).join(', ') + '}';
        block += `,\n      "brows": {\n        "left": ${brow('left')},\n        "right": ${brow('right')}\n      }`;
      }
      block += '\n    }';
      blocks.push(block);
    }
    out += blocks.join(',\n') + '\n  }\n}\n';
    return out;
  }
}

const DEFAULT_POSE = FacePose.defaults;
const REST_NEUTRAL = BrowPose.restNeutral;

// MARK: - Writer helpers

function num(v: number): string {
  const r = roundSwift(v * 10_000) / 10_000;
  if (r === roundSwift(r)) return String(Math.trunc(r) + 0); // + 0 turns -0 into 0, like String(Int(-0.0))
  let s = r.toFixed(4);
  while (s.endsWith('0')) s = s.slice(0, -1);
  return s;
}

/// Swift JSONEncoder string: like JSON.stringify, but it escapes "/" as "\/" by default.
const quote = (s: string): string => JSON.stringify(s).replace(/\//g, '\\/');

// MARK: - JSON shape (decoding mirrors the Swift Codable structs: wrong types throw, missing keys take defaults)

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${path}: expected an object`);
  return v as Obj;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new Error(`${path}: expected a string`);
  return v;
}
/// decodeIfPresent(Float): null / missing → undefined.
function optNum(v: unknown, path: string): number | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'number') throw new Error(`${path}: expected a number`);
  return v;
}
/// `[String: Float]`: every value must be a number.
function numDict(v: unknown, path: string): Record<string, number> {
  const o = obj(v, path);
  for (const [k, x] of Object.entries(o)) if (typeof x !== 'number') throw new Error(`${path}.${k}: expected a number`);
  return o as Record<string, number>;
}

function decodePAD(v: unknown, path: string): PAD {
  const o = obj(v, path);
  const req = (k: 'p' | 'a' | 'd'): number => {
    if (typeof o[k] !== 'number') throw new Error(`${path}.${k}: expected a number`);
    return o[k] as number;
  };
  return { p: req('p'), a: req('a'), d: req('d') };
}

/// `"brows": {"left": {...}, "right": {...}}`. Missing lanes take their defaults; a missing side mirrors the other.
function decodeBrows(v: unknown, path: string): BrowPose {
  const o = obj(v, path);
  const left = o.left == null ? undefined : numDict(o.left, `${path}.left`);
  const right = o.right == null ? undefined : numDict(o.right, `${path}.right`);
  const b = BrowPose.defaults;
  for (const side of ParamLayout.Side.allCases) {
    const dict = (side === 'left' ? left : right) ?? (side === 'left' ? right : left);
    if (!dict) continue;
    for (const lane of BrowLayout.Lane.allCases) b.setLane(side, lane, dict[lane] ?? BrowLayout.Lane.defaultValue(lane));
  }
  return b;
}

/// Eye JSON: flat keys plus nested `upper_lid` / `lower_lid` and `pupil`. Missing keys take PyCozmo defaults.
function decodeEye(v: unknown, path: string): (p: EyeParam | PupilParam, isPupil: boolean) => number {
  const o = obj(v, path);
  const flat: Record<string, number | undefined> = {};
  for (const p of ParamLayout.Eye.allCases) {
    if (ParamLayout.Eye.lidKey(p) !== undefined) continue;
    const k = ParamLayout.Eye.key(p);
    flat[k] = optNum(o[k], `${path}.${k}`);
  }
  const sub = (k: string, fields: readonly string[]): Record<string, number | undefined> => {
    const out: Record<string, number | undefined> = {};
    if (o[k] == null) return out;
    const g = obj(o[k], `${path}.${k}`);
    for (const f of fields) out[f] = optNum(g[f], `${path}.${k}.${f}`);
    return out;
  };
  const upper = sub('upper_lid', ['y', 'angle', 'bend']);
  const lower = sub('lower_lid', ['y', 'angle', 'bend']);
  const pupil = sub('pupil', ParamLayout.Pupil.allCases);
  return (p, isPupil) => {
    if (isPupil) return pupil[p] ?? ParamLayout.Pupil.defaultValue(p as PupilParam);
    const e = p as EyeParam;
    const lid = ParamLayout.Eye.lidKey(e);
    if (lid) return (lid.group === 'upper_lid' ? upper : lower)[lid.field] ?? ParamLayout.Eye.defaultValue(e);
    return flat[ParamLayout.Eye.key(e)] ?? ParamLayout.Eye.defaultValue(e);
  };
}

function decodePose(e: Obj, path: string): FacePose {
  const face = e.face == null ? undefined : numDict(e.face, `${path}.face`);
  const eyes = {
    left: e.left == null ? undefined : decodeEye(e.left, `${path}.left`),
    right: e.right == null ? undefined : decodeEye(e.right, `${path}.right`),
  };
  const p = FacePose.defaults;
  for (const f of ParamLayout.Face.allCases) p.setFace(f, face?.[ParamLayout.Face.key(f)] ?? ParamLayout.Face.defaultValue(f));
  for (const side of ParamLayout.Side.allCases) {
    const eye = eyes[side];
    if (!eye) continue;
    for (const q of ParamLayout.Eye.allCases) p.setEye(side, q, eye(q, false));
    for (const q of ParamLayout.Pupil.allCases) p.setEye(side, q, eye(q, true));
  }
  return p;
}
