// Golden parity for the emotion layer: replays fixtures/golden/emotion/*.json.gz (recorded by
// tools/golden/Sources/golden-record/EmotionScenarios.swift, which documents the frame loop) on the TS EmotionLayer and
// compares every recorded field per frame. The engine is never ticked, so the traces don't depend on the modifiers.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { FaceEngine, makePersonTarget, type AgentState, type FaceCommand } from '../../src/engine';
import {
  ConversationSimulator, DecisionMessage, EmotionImpulse, EmotionLayer, type EmotionCondition, type ImpulseSource,
  type NudgeLook, type PAD3, type PersonalityPreset, type SimScenario,
} from '../../src/emotion';
import { defaultTolerance } from '../golden/harness';

type J = null | boolean | number | string | J[] | { [k: string]: J };
interface Input { frame: number; call: string; args: J[] }
interface EmotionGolden { scenario: string; dt: number; inputs: Input[]; fields: string[]; frames: Record<string, J>[] }

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/golden/emotion');
const names = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.endsWith('.json.gz')).map((f) => f.slice(0, -'.json.gz'.length)).sort() : [];
const load = (n: string): EmotionGolden => JSON.parse(gunzipSync(readFileSync(join(DIR, `${n}.json.gz`))).toString('utf8'));

const p3 = (j: J): PAD3 => { const a = j as number[]; return { x: a[0], y: a[1], z: a[2] }; };
const v3 = (v: PAD3): number[] => [v.x, v.y, v.z];

function describeCommand(c: FaceCommand): J {
  switch (c.kind) {
    case 'playOneShot': return ['playOneShot', c.oneShot];
    case 'playOneShotAt': return ['playOneShotAt', c.oneShot, c.hostTime];
    case 'reactionCue': {
      const q = c.cue;
      return ['reactionCue', q.kind, q.confidence, q.source, q.directedAtYanni, q.valence, q.hostTime, q.key, q.id];
    }
    case 'glance': return ['glance', c.at.x, c.at.y, c.duration];
    case 'play': return ['play', c.request.kind, c.request.intensity ?? null];
    default: return ['other'];
  }
}

/// Replays one scenario; returns the recorded-shape frames.
function replay(g: EmotionGolden): Record<string, J>[] {
  const engine = new FaceEngine({ modifiers: [] });
  const layer = new EmotionLayer(engine, { wallClock: () => 1_000_000 });
  let events: J[] = [], reports: J[] = [], gates: J[] = [], tags: J[] = [];
  layer.onEvent = (e): void => { events.push([e.kind, e.text]); };
  layer.onMoodReport = (r): void => {
    reports.push({ trigger: r.trigger, felt: [r.felt.p, r.felt.a, r.felt.d], mood: [r.mood.p, r.mood.a, r.mood.d],
      label: r.label, moodLabel: r.moodLabel, boredom: r.boredom, conditions: [...r.conditions] });
  };
  layer.onGate = (gt): void => {
    gates.push([gt.kind, gt.turnId]);
    engine.setAgentState(gt.kind === 'notForMe' ? 'notForMe' : 'confused');
  };
  const sim = new ConversationSimulator(layer);
  let host = 1000;
  layer.afterFrame(host);
  let seen = engine.state.commands.length;

  const apply = (i: Input): void => {
    const a = i.args;
    switch (i.call) {
      case 'state': engine.setAgentState(a[0] as AgentState); break;
      case 'impulse': {
        const target = { kind: a[0] as 'absolute' | 'relative', pad: p3(a[1]) };
        layer.apply({ kind: 'impulse', impulse: EmotionImpulse.make(target, a[2] as number, a[3] as ImpulseSource, a[4] as string) });
        break;
      }
      case 'nudge':
        layer.apply({ kind: 'nudge', nudge: { feeling: a[0] as string, strength: a[1] as number, look: a[2] as NudgeLook | null } });
        break;
      case 'condition': layer.setCondition(a[0] as EmotionCondition, a[1] as boolean); break;
      case 'message': layer.receiveData(a[0] as string); break;
      case 'audioStart': layer.sentenceAudioStarted(a[0] as string, a[1] as number, host + (a[2] as number)); break;
      case 'cancel': layer.cancelTurn(a[0] as string); break;
      case 'connect': layer.sessionConnected(); break;
      case 'sendMoodReportNow': layer.sendMoodReportNow(); break;
      case 'resetToBaseline': layer.resetToBaseline(); break;
      case 'environment': {
        const env = { boredom: Math.fround(a[0] as number), isPresent: a[1] as boolean | null };
        layer.environment = () => env;
        break;
      }
      case 'people':
        if (a[0]) engine.setPeople([makePersonTarget(1, { x: 0, y: 0 })], 1, 1); else engine.setPeople([], null, null);
        break;
      case 'bedtime': engine.setBedtime(a[0] as boolean); break;
      case 'moodOffset': engine.setMoodOffset(p3(a[0])); break;
      case 'personality': layer.personality = a[0] as PersonalityPreset; break;
      case 'baselineOverride': layer.baselineOverride = a[0] === null ? null : p3(a[0]); break;
      case 'moodTimeWarp': layer.moodTimeWarp = a[0] as number; break;
      case 'timeScale': layer.timeScale = a[0] as number; break;
      case 'frozen': layer.isFrozen = a[0] as boolean; break;
      case 'setSlowMood': layer.setSlowMood(p3(a[0])); break;
      case 'advance': layer.advance(a[0] as number); break;
      case 'stanceNeedsClaim': layer.stanceNeedsClaim = a[0] as boolean; break;
      case 'playExpressive': {
        const src = a[0] as Record<string, Record<string, number>>;
        const ans: Record<string, Record<string, number>> = {};
        for (const k of Object.keys(src)) {
          ans[k] = {};
          for (const n of Object.keys(src[k])) ans[k][n] = Math.fround(src[k][n]);
        }
        layer.playExpressive(ans, a[1] as string);
        break;
      }
      case 'sentenceTag': {
        const r = DecisionMessage.decode(a[0] as string);
        if (r.kind !== 'message' || r.message.kind !== 'decision') throw new Error('sentenceTag: not a decision');
        const t = layer.sentenceTag(r.message.decision);
        tags.push([t.pad === null ? null : v3(t.pad), t.strength, t.answer]);
        break;
      }
      case 'simulate': sim.start(a[0] as SimScenario, host); break;
      default: throw new Error(`unknown emotion call ${i.call}`);
    }
  };

  const byFrame = new Map<number, Input[]>();
  for (const i of g.inputs) byFrame.set(i.frame, [...(byFrame.get(i.frame) ?? []), i]);
  const out: Record<string, J>[] = [];
  for (let f = 0; f < g.frames.length; f++) {
    for (const i of byFrame.get(f) ?? []) apply(i);
    host = 1000 + (f + 1) * g.dt;
    layer.afterFrame(host);
    sim.tick(host);
    const st = engine.state, dyn = layer.dynamics, snap = layer.snapshot, cls = layer.classifierState;
    const cmds = st.commands;
    out.push({
      f, layerTime: layer.layerTime, felt: v3(dyn.felt), mood: v3(dyn.mood), emotion: v3(dyn.emotion), rest: v3(dyn.rest),
      baseline: v3(dyn.baseline), engineMood: [st.baseMood.pleasure, st.baseMood.arousal, st.baseMood.dominance],
      mix: st.emotionMix === null ? null : st.emotionMix.entries.map((e) => [e.name, e.weight]),
      mixIntensity: st.emotionMix?.intensity ?? null, weight: st.emotionWeight, label: layer.label,
      classLabel: cls.labelName, runnerUp: cls.runnerUpName, share: cls.runnerUpShare, moodLabel: snap.moodLabel,
      somber: snap.somber, conditions: [...snap.conditions], agentState: st.agentState, events, reports, gates,
      commands: cmds.slice(seen).map(describeCommand), tags,
    });
    seen = cmds.length;
    events = []; reports = []; gates = []; tags = [];
  }
  return out;
}

const numClose = (e: number, a: number): boolean =>
  e === a || Math.abs(e - a) <= Math.max(defaultTolerance.abs, defaultTolerance.rel * Math.abs(e));
const NUM = /^[+-]?\d+(\.\d+)?$/;

/// Strings equal, or equal token by token with numbers ("%.2f" log text) within one unit of their last digit (the
/// Swift values are Float, the TS ones double).
function textClose(e: string, a: string): boolean {
  if (e === a) return true;
  const te = e.split(/([\s()·#,]+)/), ta = a.split(/([\s()·#,]+)/);
  if (te.length !== ta.length) return false;
  return te.every((x, i) => {
    const y = ta[i];
    if (x === y) return true;
    if (!NUM.test(x) || !NUM.test(y)) return false;
    const unit = Math.pow(10, -((x.split('.')[1] ?? '').length));
    return Math.abs(Number(x) - Number(y)) <= unit * 1.01;
  });
}

/// The first difference under `path`, or null.
function diff(e: J, a: J, path: string): string | null {
  if (typeof e === 'number' && typeof a === 'number') return numClose(e, a) ? null : `${path}: expected ${e}, got ${a}`;
  if (typeof e === 'string' && typeof a === 'string') return textClose(e, a) ? null : `${path}: expected "${e}", got "${a}"`;
  if (Array.isArray(e) && Array.isArray(a)) {
    if (e.length !== a.length) return `${path}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`;
    for (let i = 0; i < e.length; i++) { const d = diff(e[i], a[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  if (e !== null && a !== null && typeof e === 'object' && typeof a === 'object' && !Array.isArray(e) && !Array.isArray(a)) {
    for (const k of Object.keys(e)) { const d = diff(e[k], a[k] ?? null, `${path}.${k}`); if (d) return d; }
    return null;
  }
  return e === a ? null : `${path}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`;
}

describe('emotion golden scenarios', () => {
  test('fixtures exist', () => { expect(names.length).toBeGreaterThan(0); });
  for (const name of names) {
    test(name, () => {
      const g = load(name);
      const got = replay(g);
      let report = '';
      for (let f = 0; f < g.frames.length && report === ''; f++) {
        for (const field of g.fields) {
          const d = diff(g.frames[f][field] ?? null, got[f][field] ?? null, `frame ${f} (${(f + 1) / 60}s) ${field}`);
          if (d) { report = d; break; }
        }
      }
      expect(report).toBe('');
    });
  }
});
