// Port of Tests/FaceEmotionTests/Support.swift (without the allocation counter).
import { FaceEngine, isModifierRegistered, type AgentState, type Modifier } from '../../src/engine';
import {
  ConversationSimulator, Decision, EmotionLayer, EmotionSettings, P3, type DecisionPass, type GateEvent, type MoodReport,
  type MoodStore, type PAD3, type PersonalityPreset,
} from '../../src/emotion';

/// Engine + layer driven like the app: engine frame at the presentation time, then `afterFrame`.
export class Rig {
  readonly engine: FaceEngine;
  readonly layer: EmotionLayer;
  host = 1000;
  gates: GateEvent[] = [];
  reports: MoodReport[] = [];
  tickEngine = true;

  constructor(o: { settings?: EmotionSettings; personality?: PersonalityPreset; store?: MoodStore | null;
    wallClock?: () => number; state?: AgentState } = {}) {
    this.engine = new FaceEngine();
    this.engine.setAgentState(o.state ?? 'idle');
    this.layer = new EmotionLayer(this.engine, { settings: o.settings ?? new EmotionSettings(),
      personality: o.personality ?? 'playful', moodStore: o.store ?? null, wallClock: o.wallClock ?? ((): number => 1_000_000) });
    this.layer.onGate = (g): void => {
      this.gates.push(g);
      this.engine.setAgentState(g.kind === 'notForMe' ? 'notForMe' : 'confused');
    };
    this.layer.onMoodReport = (r): void => { this.reports.push(r); };
    this.engine.tick(1 / 60, this.host);
    this.layer.afterFrame(this.host);
  }

  /// Runs `seconds` of frames at `fps`, calling `each` after every frame.
  run(seconds: number, fps = 60, each?: (r: Rig) => void): void {
    const n = Math.round(seconds * fps);
    const dt = 1 / fps;
    for (let i = 0; i < n; i++) {
      this.host += dt;
      if (this.tickEngine) this.engine.tick(dt, this.host);
      this.layer.afterFrame(this.host);
      each?.(this);
    }
  }

  get felt(): PAD3 { return this.layer.felt; }
  get engineMood(): PAD3 {
    const m = this.engine.state.baseMood;
    return { x: m.pleasure, y: m.arousal, z: m.dominance };
  }
  modifier<T = Modifier>(name: string): T { return this.engine.director.modifier(name) as unknown as T; }
}

export const approx = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
export const maxAbs = (v: PAD3): number => P3.maxAbs(v);
export const pad = (x: number, y: number, z: number): PAD3 => ({ x, y, z });
/// All of these modifiers are ported and registered (tests that need the real face skip until then).
export const hasModifiers = (...names: string[]): boolean => names.every(isModifierRegistered);

/// Decision builders.
export function decision(o: { pass?: DecisionPass; turn?: string; index?: number; feel: Record<string, number>;
  intensity?: number; intent?: string | null; reaction?: [string, number] | null; addressed?: number | null }): Decision {
  const pass = o.pass ?? 'utterance';
  return new Decision({ pass, turnId: o.turn ?? 't1', sentenceIndex: pass === 'sentence' ? (o.index ?? 0) : null,
    answers: ConversationSimulator.answers(o.feel, o.intensity ?? 4, { intent: o.intent ?? null, reaction: o.reaction ?? null,
      addressed: pass === 'utterance' ? (o.addressed === undefined ? 0.95 : o.addressed) : null }) });
}
