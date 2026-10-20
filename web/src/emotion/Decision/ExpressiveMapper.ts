// Port of FaceEmotion/Decision/ExpressiveMapper.swift.
import {
  ExpressiveBrow, ExpressiveGaze, ExpressivePlan, makeReactionCue, type OneShotKind, type ReactionCueKind,
  type ReactionCueSource,
} from '../../engine';
import { MapperSettings } from '../EmotionSettings';
import { EmotionImpulse, type PAD3 } from '../EmotionTypes';
import { Decision, type Answers } from './DecisionMessage';

/// What one expressive answer set does (expressive decisions design §8): the plan, the mood impulse and the read-outs
/// for the status card.
export interface ExpressiveDecision {
  plan: ExpressivePlan;
  impulse: EmotionImpulse | null;
  /// The chosen response family (`react`) and its probability.
  react: string;
  confidence: number;
  /// Σ k·p(k), 1…5.
  expectedIntensity: number;
  /// One line: family, brow, gaze, pupil, move.
  summary: string;
}

interface Family { expression: string; pad: PAD3; brow: ExpressiveBrow }
interface Signature { react: string; brow: string; gaze: string; pupil: string; move: string }
const sigEquals = (a: Signature, b: Signature): boolean =>
  a.react === b.react && a.brow === b.brow && a.gaze === b.gaze && a.pupil === b.pupil && a.move === b.move;

const isBrow = (s: string): s is ExpressiveBrow => (ExpressiveBrow.allCases as readonly string[]).includes(s);
const isGaze = (s: string): s is ExpressiveGaze => (ExpressiveGaze.allCases as readonly string[]).includes(s);

/// Expressive answers (`react`, `intensity`, `brow`, `gaze`, `pupil`, `move`; question set 3) → an `ExpressivePlan`
/// and an impulse. Pure apart from the per-key variety memory.
///
/// - `react` top < `reactThreshold` or `ignore` → null (the reflex only).
/// - E = expected intensity: overlay 0.5 + 0.1125·(E − 1), hold 0.8 + 0.25·E s, move amplitude 0.7…1.
/// - Each sub-action: its top answer ≥ `actionThreshold` and not `none`; a missing brow takes the family default.
/// - Variety: the plan signature is kept per trigger key; a repeat swaps its move, pupil and glance for the runner-up
///   (≥ `runnerUpThreshold`) or none, and alternates the sceptical brow's side.
export class ExpressiveMapper {
  settings: MapperSettings;

  static readonly families: ReadonlyMap<string, Family> = new Map<string, Family>([
    ['delight', { expression: 'Happiness', pad: { x: 0.75, y: 0.5, z: 0.3 }, brow: 'raise' }],
    ['curiosity', { expression: 'Curious', pad: { x: 0.3, y: 0.4, z: -0.1 }, brow: 'sceptical' }],
    ['playful', { expression: 'Excitement', pad: { x: 0.7, y: 0.7, z: 0.4 }, brow: 'none' }],
    ['shy', { expression: 'Embarrassment', pad: { x: 0.3, y: 0.3, z: -0.5 }, brow: 'worried' }],
    ['sceptical', { expression: 'Skepticism', pad: { x: -0.1, y: 0.1, z: 0.4 }, brow: 'sceptical' }],
    ['sympathetic', { expression: 'Concerned', pad: { x: -0.2, y: 0, z: -0.3 }, brow: 'worried' }],
  ]);
  static readonly moves: ReadonlyMap<string, OneShotKind> = new Map<string, OneShotKind>([
    ['perk', 'perkUp'], ['bounce', 'laugh'], ['tilt', 'curiousTilt'], ['dance', 'dance'], ['doubleTake', 'doubleTake'],
    ['nod', 'nodYes'], ['shake', 'shakeNo'],
  ]);
  static readonly pupils: ReadonlyMap<string, ReactionCueKind> = new Map<string, ReactionCueKind>([
    ['stars', 'delight'], ['hearts', 'affection'], ['question', 'curiosity'], ['exclaim', 'reveal'], ['notes', 'music'],
  ]);
  static readonly memoryCapacity = 32;

  private last = new Map<string, Signature>();
  private side = 1;

  constructor(settings: MapperSettings = new MapperSettings()) { this.settings = settings.validated(); }

  /// Maps one answer set for trigger `key` (e.g. "gesture:wave"). `source` / `hostTime` / `cueID` go on the pupil cue.
  map(answers: Answers, key: string, source: ReactionCueSource = 'perception', hostTime: number | null = null,
    cueID = 0): ExpressiveDecision | null {
    const st = this.settings.validated();
    const d = new Decision({ version: 3, pass: 'utterance', turnId: 'expressive', answers });
    const top = d.top('react');
    if (top === null || top.name === 'ignore' || !(top.p >= st.reactThreshold)) return null;
    const fam = ExpressiveMapper.families.get(top.name);
    if (!fam) return null;
    const e = ExpressiveMapper.expectedIntensity(d);

    const pickA = (q: string, skipping: string | null = null): string => {
      for (const a of d.distribution(q)) {
        if (a.name === 'none' || a.name === skipping) continue;
        return a.p >= (skipping === null ? st.actionThreshold : st.runnerUpThreshold) ? a.name : 'none';
      }
      return 'none';
    };
    let sig: Signature = { react: top.name, brow: pickA('brow'), gaze: pickA('gaze'), pupil: pickA('pupil'),
      move: pickA('move') };
    if (!isBrow(sig.brow) || sig.brow === 'none') sig.brow = fam.brow;
    const prev = this.last.get(key);
    if (prev !== undefined && sigEquals(prev, sig)) {
      const first = { ...sig };
      sig = { ...sig };
      sig.move = first.move === 'none' ? 'none' : pickA('move', first.move);
      sig.pupil = first.pupil === 'none' ? 'none' : pickA('pupil', first.pupil);
      sig.gaze = first.gaze === 'none' ? 'none' : pickA('gaze', first.gaze);
      if (sigEquals(sig, first)) sig.gaze = first.gaze === 'lookAt' ? 'glanceAround' : 'lookAt';
    }
    if (this.last.size >= ExpressiveMapper.memoryCapacity && !this.last.has(key)) this.last.clear();
    this.last.set(key, sig);
    this.side = -this.side;

    const plan = new ExpressivePlan({
      expression: fam.expression, intensity: 0.5 + 0.1125 * (e - 1), hold: 0.8 + 0.25 * e,
      brow: isBrow(sig.brow) ? sig.brow : fam.brow, browSide: this.side,
      gaze: isGaze(sig.gaze) ? sig.gaze : 'none', move: ExpressiveMapper.moves.get(sig.move) ?? null,
      moveIntensity: 0.7 + 0.075 * (e - 1),
    });
    const kind = ExpressiveMapper.pupils.get(sig.pupil);
    if (kind !== undefined) {
      plan.cue = makeReactionCue(kind, d.p('pupil', sig.pupil) ?? top.p, { source, directedAtYanni: true,
        valence: fam.pad.x, hostTime, key: `${kind}:${key}`, id: cueID });
    }
    const strength = Math.min(0.6, 0.15 + 0.1 * e) * top.p;
    const summary = `${top.name} ${top.p.toFixed(2)} · E ${e.toFixed(1)} · brow ${sig.brow} · gaze ${sig.gaze} · ` +
      `pupil ${sig.pupil} · move ${sig.move}`;
    return { plan: plan.validated(), impulse: EmotionImpulse.toward(fam.pad, strength, 'perception', `expressive ${top.name}`),
      react: top.name, confidence: top.p, expectedIntensity: e, summary };
  }

  /// Pass B's `brow` / `gaze` (≥ `sentenceActionThreshold`) → a brow-and-glance plan with no overlay (the mood already
  /// shows the feeling), or null. Pure.
  static sentencePlan(d: Decision, st: MapperSettings): ExpressivePlan | null {
    const topA = (q: string): string | null => {
      const t = d.top(q);
      if (t === null || t.name === 'none' || !(t.p >= st.sentenceActionThreshold)) return null;
      return t.name;
    };
    const b = topA('brow'), g = topA('gaze');
    const brow: ExpressiveBrow = b !== null && isBrow(b) ? b : 'none';
    const gaze: ExpressiveGaze = g !== null && isGaze(g) ? g : 'none';
    if (brow === 'none' && gaze === 'none') return null;
    return new ExpressivePlan({ expression: null, intensity: 0, onset: 0.2, hold: 0.9, release: 0.5, brow,
      browAmount: 0.8, browSide: (d.sentenceIndex ?? 0) % 2 === 0 ? 1 : -1, gaze });
  }

  static expectedIntensity(d: Decision): number {
    let e = 0, t = 0;
    for (const { name, p } of d.distribution('intensity')) {
      const v = parseSwiftFloat(name);
      if (v === null || !(v >= 1 && v <= 5)) continue;
      e += v * p; t += p;
    }
    return t > 0 ? e / t : 3;
  }

  reset(): void { this.last.clear(); this.side = 1; }
}

/// Swift `Float(String)` for decimal literals, "inf" and "nan"; null otherwise. port-note: hex literals read as null.
export function parseSwiftFloat(s: string): number | null {
  if (!/^[+-]?((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|inf(inity)?|nan)$/i.test(s)) return null;
  return Number(s.replace(/inf(inity)?/i, 'Infinity').replace(/nan/i, 'NaN'));
}
