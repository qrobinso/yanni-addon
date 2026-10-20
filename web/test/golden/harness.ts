// Golden parity harness: replays a recorded Swift scenario (fixtures/golden/<name>.json.gz, format in FORMAT.md) on the
// TS FaceEngine and compares every recorded field per frame. Mirrors tools/golden/Sources/golden-record (Recorder.swift,
// Calls.swift): inputs of frame f in file order → engine.tick(dt, (f+1)*dt) → record.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { BrowLayout, EdgeGeometry, type FaceFrame } from '../../src/model';
import { SplitMix64 } from '../../src/core/random';
import {
  AgentState, EdgeAnticContext, FaceCommand, FaceEngine, OneShotKind, OneShotLibrary, defaultModifierOrder,
  makeModifiers, makePersonTarget, type PersonTarget,
} from '../../src/engine';

// GOLDEN_FIXTURES overrides the folder (diagnostics against traces recorded elsewhere).
const FIXTURES = process.env.GOLDEN_FIXTURES ?? join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/golden');

type J = null | boolean | number | string | J[] | { [k: string]: J };
export interface GoldenInput { frame: number; call: string; args: J[] }
export type GoldenFrame = Record<string, J>;
export interface GoldenFile {
  scenario: string;
  seed: string;
  dt: number;
  modifiers: string; // 'default' | 'core' | 'subset:A,B,…'
  life: boolean;
  hostTime: string;
  inputs: GoldenInput[];
  fields: string[];
  frames: GoldenFrame[];
}
export interface Layout { pose: string[]; brows: string[]; oneShotKinds: string[]; agentStates: string[] }

const cache = new Map<string, GoldenFile>();

/// Every fixture name in fixtures/golden (without extension).
export function goldenNames(): string[] {
  return readdirSync(FIXTURES).filter((f) => f.endsWith('.json.gz')).map((f) => f.slice(0, -'.json.gz'.length)).sort();
}

export function loadGolden(name: string): GoldenFile {
  const hit = cache.get(name);
  if (hit) return hit;
  const gz = join(FIXTURES, `${name}.json.gz`), plain = join(FIXTURES, `${name}.json`);
  const text = existsSync(gz) ? gunzipSync(readFileSync(gz)).toString('utf8') : readFileSync(plain, 'utf8');
  const g = JSON.parse(text) as GoldenFile;
  cache.set(name, g);
  return g;
}

let layoutCache: Layout | undefined;
export function loadLayout(): Layout {
  return (layoutCache ??= JSON.parse(readFileSync(join(FIXTURES, 'layout.json'), 'utf8')) as Layout);
}

/// The Swift modifier names a scenario's engine runs, in registration order: `core` = the engine-core gate,
/// `default` = makeDefaultModifiers, `subset:A,B,…` = exactly those (a proposed recorder extension for per-package
/// gates; the names must be in makeDefaultModifiers order).
export function scenarioModifiers(g: Pick<GoldenFile, 'modifiers'>): readonly string[] {
  if (g.modifiers === 'core') return ['OneShotSampler', 'OneShotApply'];
  if (g.modifiers.startsWith('subset:')) {
    const names = new Set(g.modifiers.slice('subset:'.length).split(','));
    return defaultModifierOrder.filter((n) => names.has(n));
  }
  return defaultModifierOrder;
}

/// True once `kind`'s curve is ported (the curve-file stubs throw `TODO(WPx)` until then).
export function isCurvePorted(kind: OneShotKind): boolean {
  try {
    const ctx = new EdgeAnticContext({ geometry: EdgeGeometry.reference });
    const p = OneShotLibrary.makeParams(kind, new SplitMix64(1), { x: 0, y: 0 }, ctx);
    OneShotLibrary.sample(kind, 0.1, p);
    OneShotLibrary.spec(kind);
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('TODO(')) return false;
    throw e;
  }
}

const KIND_CALLS = new Set(['playEdgeAntic', 'playIdleGame', 'playPupilShape']);

/// Everything a scenario needs beyond the modifiers: FaceLife for life scenarios, and the curve of every one-shot
/// kind its script plays whose curve file isn't ported yet (as "curve:<kind>").
export function scenarioRequirements(g: Pick<GoldenFile, 'life' | 'inputs'>): string[] {
  const out = g.life ? ['FaceLife'] : [];
  const kinds = new Set<OneShotKind>();
  for (const i of g.inputs) {
    const c = i.call === 'send' ? (i.args[0] as { case?: J; kind?: J } | null) : null;
    const k = KIND_CALLS.has(i.call) ? i.args[0] : c?.case === 'playOneShot' ? c.kind : undefined;
    const kind = typeof k === 'string' ? OneShotKind.fromRaw(k) : undefined;
    if (kind) kinds.add(kind);
  }
  for (const k of kinds) if (!isCurvePorted(k)) out.push(`curve:${k}`);
  return out;
}

export function makeEngine(g: GoldenFile): FaceEngine {
  return new FaceEngine({ seed: BigInt(g.seed), modifiers: makeModifiers(scenarioModifiers(g)) });
}

// MARK: - Inputs (Calls.swift)

const num = (j: J): number => {
  if (typeof j !== 'number') throw new Error(`expected a number, got ${JSON.stringify(j)}`);
  return j;
};
const obj = (j: J): { [k: string]: J } => {
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error(`expected an object, got ${JSON.stringify(j)}`);
  return j;
};
const arr = (j: J): J[] => {
  if (!Array.isArray(j)) throw new Error(`expected an array, got ${JSON.stringify(j)}`);
  return j;
};
const v2 = (j: J): { x: number; y: number } => { const a = arr(j); return { x: num(a[0]), y: num(a[1]) }; };
const kindArg = (j: J): OneShotKind => {
  const k = OneShotKind.fromRaw(String(j));
  if (!k) throw new Error(`unknown OneShotKind ${String(j)}`);
  return k;
};
const optFloat = (a: J[], i: number): number | undefined => (i < a.length && a[i] !== null ? num(a[i]) : undefined);

function person(j: J): PersonTarget {
  const o = obj(j);
  return makePersonTarget(num(o.id), v2(o.position), num(o.distance), num(o.salience), num(o.facing), num(o.lookingAtMe));
}

function command(j: J): FaceCommand {
  const o = obj(j);
  switch (o.case) {
    case 'playOneShot': return FaceCommand.playOneShot(kindArg(o.kind));
    case 'glance': return FaceCommand.glance(v2(o.at), num(o.duration));
    case 'stimulus': return FaceCommand.stimulus(v2(o.at), num(o.strength));
    case 'restGaze': return FaceCommand.restGaze(v2(o.at));
    case 'blink': return FaceCommand.blink;
    case 'tap': return FaceCommand.tap(v2(o.at));
    case 'scratch': return FaceCommand.scratch(v2(o.at), num(o.intensity));
    case 'attend': return FaceCommand.attend(o.personID === undefined || o.personID === null ? null : num(o.personID));
    default: throw new Error(`unsupported FaceCommand case ${String(o.case)}`);
  }
}

function geometry(j: J): EdgeGeometry {
  const o = obj(j);
  return new EdgeGeometry({
    visibleHalfExtent: v2(o.visibleHalfExtent),
    leftEyeCenter: v2(o.leftEyeCenter), rightEyeCenter: v2(o.rightEyeCenter),
    leftEyeHalfSize: v2(o.leftEyeHalfSize), rightEyeHalfSize: v2(o.rightEyeHalfSize),
    leftBrowCenter: v2(o.leftBrowCenter), leftBrowHalfSize: v2(o.leftBrowHalfSize),
    rightBrowCenter: v2(o.rightBrowCenter), rightBrowHalfSize: v2(o.rightBrowHalfSize),
  });
}

/// Applies one input to the engine (Calls.swift `apply`). `life.*` calls need FaceLife (not ported yet).
export function applyInput(e: FaceEngine, input: GoldenInput): void {
  const a = input.args;
  switch (input.call) {
    case 'setAgentState': {
      const s = AgentState.fromRaw(String(a[0]));
      if (!s) throw new Error(`unknown AgentState ${String(a[0])}`);
      e.setAgentState(s);
      break;
    }
    case 'setMood': {
      const m = obj(a[0]);
      e.setMood({ pleasure: num(m.pleasure), arousal: num(m.arousal), dominance: num(m.dominance) });
      break;
    }
    case 'setMoodOffset': { const v = arr(a[0]); e.setMoodOffset({ x: num(v[0]), y: num(v[1]), z: num(v[2]) }); break; }
    case 'setPeople':
      e.setPeople(arr(a[0]).map(person), a[1] === null ? null : num(a[1]), a[2] === null ? null : num(a[2]));
      break;
    case 'send': e.send(command(a[0])); break;
    case 'setEdgeGeometry': e.setEdgeGeometry(a[0] === null ? null : geometry(a[0])); break;
    case 'setBedtime': e.setBedtime(a[0] === true); break;
    case 'setSpeechLevel': e.setSpeechLevel(num(a[0])); break;
    case 'setListeningGlow': e.setListeningGlow(num(a[0])); break;
    case 'setListeningVoice': e.setListeningVoice(num(a[0])); break;
    case 'setListeningLevel': e.setListeningLevel(num(a[0])); break;
    case 'setCaptionInset': e.setCaptionInset(num(a[0]), a.length > 1 ? a[1] === true : false); break;
    case 'playPupilShape': e.playPupilShape(kindArg(a[0]), optFloat(a, 1)); break;
    case 'cancelPupilShape': e.cancelPupilShape(); break;
    case 'playEdgeAntic': e.playEdgeAntic(kindArg(a[0]), optFloat(a, 1) ?? 0); break;
    case 'cancelEdgeAntics': e.cancelEdgeAntics(a[0] === true); break;
    case 'playIdleGame': e.playIdleGame(kindArg(a[0]), optFloat(a, 1) ?? 0); break;
    case 'cancelIdleGames': e.cancelIdleGames(); break;
    case 'noteFriendlyTouch': e.noteFriendlyTouch(num(a[0])); break;
    case 'fadeInFromBlack': e.fadeInFromBlack(); break;
    default: throw new Error(`unsupported call ${input.call} (life.* needs the FaceLife port)`);
  }
}

// MARK: - Recording (Recorder.swift)

const v4a = (v: { x: number; y: number; z: number; w: number }): number[] => [v.x, v.y, v.z, v.w];

/// One frame in the recorder's shape (life fields excluded).
export function recordFrame(e: FaceEngine, f: number, fr: FaceFrame): GoldenFrame {
  const st = e.state;
  return {
    f,
    pose: Array.from(fr.pose.raw),
    brightness: fr.brightness,
    wantsHighFrameRate: fr.wantsHighFrameRate,
    isAsleep: fr.isAsleep,
    color: [fr.color.x, fr.color.y, fr.color.z],
    closureScale: [fr.closureScale.x, fr.closureScale.y],
    stageOffset: [fr.stageOffset.x, fr.stageOffset.y],
    eyeStageOffset: v4a(fr.eyeStageOffset),
    pupilShape: [fr.pupilShape.x, fr.pupilShape.y],
    pupilMorph: [fr.pupilMorph.x, fr.pupilMorph.y],
    pupilShapeScale: v4a(fr.pupilShapeScale),
    brows: BrowLayout.usedIndices.map((i) => fr.brows.raw[i]),
    browPresence: fr.browPresence,
    browOffset: v4a(fr.browOffset),
    backgroundColor: [fr.backgroundColor.x, fr.backgroundColor.y, fr.backgroundColor.z],
    backgroundStrength: fr.backgroundStrength,
    backgroundPresence: fr.backgroundPresence,
    backgroundBrightness: fr.backgroundBrightness,
    glowLevel: fr.glowLevel,
    glowHeight: fr.glowHeight,
    glowMotion: fr.glowMotion,
    glowRipple: fr.glowRipple,
    glowColor: [fr.glowColor.x, fr.glowColor.y, fr.glowColor.z],
    glowColor2: [fr.glowColor2.x, fr.glowColor2.y, fr.glowColor2.z],
    glowPhase: v4a(fr.glowPhase),
    captionInset: fr.captionInset,
    oneShots: [...st.activeOneShots],
    agentState: st.agentState,
    mood: [st.mood.pleasure, st.mood.arousal, st.mood.dominance],
  };
}

// MARK: - Comparison

export interface Tolerance { abs: number; rel: number }
export const defaultTolerance: Tolerance = { abs: 1e-3, rel: 1e-4 };

/// Fields compared exactly (ints, booleans, strings).
const EXACT = new Set(['f', 'wantsHighFrameRate', 'isAsleep', 'pupilShape', 'agentState']);
const COMPONENTS: Record<number, string[]> = { 2: ['x', 'y'], 3: ['x', 'y', 'z'], 4: ['x', 'y', 'z', 'w'] };

export interface Mismatch {
  frame: number;
  field: string;
  /// Lane name (layout.json names for pose and brows, x/y/z/w for vectors); empty for scalars.
  lane: string;
  index: number;
  expected: J;
  actual: J;
}

const numEq = (e: J, a: J, tol: Tolerance): boolean => {
  if (e === null) return typeof a === 'number' && !Number.isFinite(a);
  if (typeof e !== 'number' || typeof a !== 'number') return e === a;
  if (!Number.isFinite(a)) return false;
  const d = Math.abs(a - e);
  return d <= tol.abs || d <= tol.rel * Math.abs(e);
};

function laneName(field: string, i: number, len: number, layout: Layout): string {
  if (field === 'pose') return layout.pose[i] ?? String(i);
  if (field === 'brows') return layout.brows[i] ?? String(i);
  if (field === 'glowPhase') return ['drift', 'w1', 'w2', 'w3'][i] ?? String(i);
  if (field === 'eyeStageOffset' || field === 'browOffset' || field === 'pupilShapeScale') return ['lx', 'ly', 'rx', 'ry'][i] ?? String(i);
  if (field === 'pupilShape' || field === 'pupilMorph') return ['left', 'right'][i] ?? String(i);
  if (field === 'mood') return ['P', 'A', 'D'][i] ?? String(i);
  if (field === 'color' || field === 'backgroundColor' || field === 'glowColor' || field === 'glowColor2') return ['r', 'g', 'b'][i] ?? String(i);
  return COMPONENTS[len]?.[i] ?? String(i);
}

/// Every mismatching lane of one frame (fields in the file's order; life fields are skipped).
export function compareFrame(expected: GoldenFrame, actual: GoldenFrame, fields: readonly string[],
  tol: Tolerance = defaultTolerance, layout: Layout = loadLayout()): Mismatch[] {
  const out: Mismatch[] = [];
  const f = Number(expected.f);
  for (const field of fields) {
    if (!(field in actual)) continue; // life fields: not recorded by this harness
    const e = expected[field], a = actual[field];
    if (field === 'oneShots') {
      const es = [...arr(e)].map(String).sort(), as = [...arr(a)].map(String).sort();
      if (es.join(',') !== as.join(',')) out.push({ frame: f, field, lane: '', index: -1, expected: e, actual: a });
      continue;
    }
    if (Array.isArray(e)) {
      const aa = Array.isArray(a) ? a : [];
      if (aa.length !== e.length) {
        out.push({ frame: f, field, lane: 'length', index: -1, expected: e.length, actual: aa.length });
        continue;
      }
      for (let i = 0; i < e.length; i++) {
        const ok = EXACT.has(field) ? e[i] === aa[i] : numEq(e[i], aa[i], tol);
        if (!ok) out.push({ frame: f, field, lane: laneName(field, i, e.length, layout), index: i, expected: e[i], actual: aa[i] });
      }
      continue;
    }
    const ok = EXACT.has(field) || typeof e !== 'number' ? e === a : numEq(e, a, tol);
    if (!ok) out.push({ frame: f, field, lane: '', index: -1, expected: e, actual: a });
  }
  return out;
}

export interface GoldenOptions {
  tolerance?: Tolerance;
  /// Stop after this many frames (default: all).
  maxFrames?: number;
  /// How many trailing inputs a mismatch report lists (default 5).
  contextInputs?: number;
}

export interface GoldenResult {
  name: string;
  ok: boolean;
  framesCompared: number;
  /// The first diverging frame's mismatches (empty when ok).
  mismatches: Mismatch[];
  /// Human-readable report of the first divergence ('' when ok).
  report: string;
}

/// Plays the scenario through `onFrame(f, expected, actual)`; stops when it returns false.
function replay(g: GoldenFile, opts: GoldenOptions, onFrame: (f: number, e: GoldenFrame, a: GoldenFrame) => boolean): number {
  if (g.life) throw new Error(`${g.scenario}: life scenarios need the FaceLife port`);
  const engine = makeEngine(g);
  const byFrame = new Map<number, GoldenInput[]>();
  for (const i of g.inputs) {
    const l = byFrame.get(i.frame);
    if (l) l.push(i); else byFrame.set(i.frame, [i]);
  }
  const n = Math.min(g.frames.length, opts.maxFrames ?? Infinity);
  let f = 0;
  for (; f < n; f++) {
    for (const i of byFrame.get(f) ?? []) applyInput(engine, i);
    const fr = engine.tick(g.dt, (f + 1) * g.dt);
    if (!onFrame(f, g.frames[f], recordFrame(engine, f, fr))) return f + 1;
  }
  return f;
}

const fmt = (v: J): string => (typeof v === 'number' ? String(v) : JSON.stringify(v));

function describe(g: GoldenFile, ms: Mismatch[], contextInputs: number): string {
  const f = ms[0].frame;
  const lines = [`${g.scenario}: first divergence at frame ${f} (t = ${((f + 1) * g.dt).toFixed(4)} s), ${ms.length} lane(s):`];
  for (const m of ms.slice(0, 12)) {
    const where = m.lane ? `${m.field}[${m.index}] ${m.lane}` : m.field;
    const d = typeof m.expected === 'number' && typeof m.actual === 'number' ? `  Δ ${(m.actual - m.expected).toExponential(3)}` : '';
    lines.push(`  ${where}: expected ${fmt(m.expected)}, actual ${fmt(m.actual)}${d}`);
  }
  if (ms.length > 12) lines.push(`  … ${ms.length - 12} more`);
  const recent = g.inputs.filter((i) => i.frame <= f).slice(-contextInputs);
  lines.push(recent.length ? `  last inputs:` : '  no inputs before this frame');
  for (const i of recent) lines.push(`    frame ${i.frame}: ${i.call}(${i.args.map(fmt).join(', ')})`);
  return lines.join('\n');
}

/// Replays a scenario and stops at the first diverging frame.
export function runGolden(name: string, opts: GoldenOptions = {}): GoldenResult {
  const g = loadGolden(name);
  const tol = opts.tolerance ?? defaultTolerance;
  const layout = loadLayout();
  let first: Mismatch[] = [];
  const count = replay(g, opts, (_f, e, a) => {
    const ms = compareFrame(e, a, g.fields, tol, layout);
    if (ms.length) { first = ms; return false; }
    return true;
  });
  return {
    name, ok: first.length === 0, framesCompared: count, mismatches: first,
    report: first.length ? describe(g, first, opts.contextInputs ?? 5) : '',
  };
}

export interface FieldDivergence {
  field: string;
  /// First diverging frame and lane, or null when the field never diverged.
  first: Mismatch | null;
  /// Largest absolute error seen on any lane (numeric fields).
  maxAbsError: number;
  /// Frames with at least one mismatching lane.
  badFrames: number;
}

/// Diagnostic mode: plays the whole scenario (or `maxFrames`) and reports, per field, where it first diverged, its
/// worst error and how many frames disagree. Use it to tell a single drifting lane from a desynchronised RNG.
export function compareUntilDivergence(name: string, opts: GoldenOptions = {}): { result: GoldenResult; fields: FieldDivergence[]; table: string } {
  const g = loadGolden(name);
  const tol = opts.tolerance ?? defaultTolerance;
  const layout = loadLayout();
  const per = new Map<string, FieldDivergence>(g.fields.map((f) => [f, { field: f, first: null, maxAbsError: 0, badFrames: 0 }]));
  let firstFrame: Mismatch[] = [];
  const count = replay(g, opts, (_f, e, a) => {
    const ms = compareFrame(e, a, g.fields, tol, layout);
    if (ms.length && !firstFrame.length) firstFrame = ms;
    const seen = new Set<string>();
    for (const m of ms) {
      const d = per.get(m.field)!;
      d.first ??= m;
      if (typeof m.expected === 'number' && typeof m.actual === 'number') d.maxAbsError = Math.max(d.maxAbsError, Math.abs(m.actual - m.expected));
      if (!seen.has(m.field)) { seen.add(m.field); d.badFrames++; }
    }
    return true;
  });
  const fields = [...per.values()];
  const rows = fields.filter((d) => d.first).map((d) =>
    `  ${d.field.padEnd(22)} first f${d.first!.frame} ${d.first!.lane || ''}`.padEnd(64) + ` bad ${d.badFrames}/${count}  max|Δ| ${d.maxAbsError.toExponential(2)}`);
  const result: GoldenResult = {
    name, ok: firstFrame.length === 0, framesCompared: count, mismatches: firstFrame,
    report: firstFrame.length ? describe(g, firstFrame, opts.contextInputs ?? 5) : '',
  };
  return { result, fields, table: rows.length ? `${name}: diverging fields\n${rows.join('\n')}` : `${name}: no divergence in ${count} frames` };
}
