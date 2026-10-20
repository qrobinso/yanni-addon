// Port of FaceEmotion/Decision/DecisionMapper.swift.
import {
  makeReactionCue, reactionCueEquals, ReactionCueKind, type ExpressivePlan, type OneShotKind, type ReactionCue,
} from '../../engine';
import { MapperSettings } from '../EmotionSettings';
import { EmotionImpulse, P3, type PAD3 } from '../EmotionTypes';
import type { Decision } from './DecisionMessage';
import { ExpressiveMapper, parseSwiftFloat } from './ExpressiveMapper';

/// One beat per decision (and per perception event): nothing, an expression-only one-shot, or a reaction cue for the
/// face's pupil reaction arbiter.
export type DecisionBeat = { kind: 'none' } | { kind: 'oneShot'; oneShot: OneShotKind } | { kind: 'cue'; cue: ReactionCue };
export const DecisionBeat = {
  none: { kind: 'none' } as DecisionBeat,
  oneShot: (k: OneShotKind): DecisionBeat => ({ kind: 'oneShot', oneShot: k }),
  cue: (c: ReactionCue): DecisionBeat => ({ kind: 'cue', cue: c }),
  equals(a: DecisionBeat, b: DecisionBeat): boolean {
    if (a.kind === 'oneShot') return b.kind === 'oneShot' && a.oneShot === b.oneShot;
    if (a.kind === 'cue') return b.kind === 'cue' && reactionCueEquals(a.cue, b.cue);
    return b.kind === 'none';
  },
} as const;

/// What one decision does: an impulse and one beat, plus the read-outs the status card and replay rows show.
export interface DecisionEffects {
  /// Toward the probability-weighted PAD of the `feel` answers (null when there is no usable feel).
  impulse: EmotionImpulse | null;
  beat: DecisionBeat;
  /// The one-shot hint the decision qualified for (with its cooldown ready). When the beat is a cue it is the
  /// fallback if the arbiter rejects the cue for rarity.
  hint: OneShotKind | null;
  pad: PAD3;
  /// 1 − H(feel)/ln n.
  confidence: number;
  /// Σ k·p(k), 1…5.
  expectedIntensity: number;
  strength: number;
  /// The answer one-shot of a confident reply-sentence stance that became this decision's beat.
  stance: OneShotKind | null;
  /// The decision had a usable `feel` (a PAD the library knows).
  hasFeel: boolean;
  topFeel: string | null;
  topFeelP: number;
  /// The impulse's pleasure (the cue's valence; < −0.2 opens the somber window).
  valence: number;
  /// Pass B's brow / glance plan (question set 3), played at the sentence's audio start; null when none qualified.
  plan: ExpressivePlan | null;
  /// One-line summary for the log.
  summary: string;
}

const emptyEffects = (): DecisionEffects => ({
  impulse: null, beat: DecisionBeat.none, hint: null, pad: P3.zero, confidence: 0, expectedIntensity: 0, strength: 0,
  stance: null, hasFeel: false, topFeel: null, topFeelP: 0, valence: 0, plan: null, summary: '',
});

const PLAYFUL_HINTS: ReadonlySet<OneShotKind> = new Set<OneShotKind>(['laugh', 'delightedSquint', 'bigSurprise', 'curiousTilt']);

/// Decision probabilities → emotion-layer effects (decision model design §5). Pure apart from the hint cooldowns.
///
/// - Impulse: pad = Σ pᵢ·PADᵢ over the `feel` answers (names the library doesn't tag are dropped and the rest
///   renormalised); confidence = 1 − H/ln n; strength = min(1, gain × ((E/5)·confidence)^exponent).
/// - Cue: the top `reaction` answer, when it isn't `none` and its probability ≥ `cueThreshold`.
/// - Hint: when the top feel ≥ `hintTopFeel` and E ≥ `hintIntensity`: joke + Happiness/Excitement → laugh,
///   compliment + Happiness → delighted squint, Surprise/Amazement → big surprise, teasing + Annoyance → mock offense,
///   Confusion (understood) → curious tilt. Each has a cooldown, charged only when it plays.
/// - Stance (Pass B): P(yes-ish) / P(no-ish) ≥ `stanceThreshold` → nod / shake (big when the strong answer leads);
///   the decision's one beat, before a cue and the hint, at most one per reply.
/// - One beat: stance, else a cue, else the hint. Negative valence (< −0.1) gives no playful beat at all.
export class DecisionMapper {
  private _settings: MapperSettings;
  get settings(): MapperSettings { return this._settings; }
  set settings(v: MapperSettings) { this._settings = v.validated(); }
  /// Only a stance claimed by the babble voice plays (Yanni's own reply voice); Spoken: the first confident one.
  stanceNeedsClaim = false;
  private hintFiredAt = new Map<OneShotKind, number>();
  /// This reply's stance: its turn, the claimed sentence (null: none claimed yet) and whether it has played.
  private stanceTurn: string | null = null;
  private stanceIndex: number | null = null;
  private stanceFired = false;

  constructor(settings: MapperSettings = new MapperSettings()) { this._settings = settings.validated(); }

  static readonly playfulHints = PLAYFUL_HINTS;

  /// Maps a decision at layer time `now`. `pad(name)` looks up a library expression's PAD tag. Charges the hint's
  /// cooldown when the beat is that hint.
  map(d: Decision, now: number, hostTime: number | null, cueID: number, pad: (name: string) => PAD3 | null): DecisionEffects {
    const st = this._settings;
    const fx = DecisionMapper.feel(d, st, pad);
    if (fx.hasFeel && fx.strength > 0) {
      fx.impulse = EmotionImpulse.toward(fx.pad, fx.strength, 'decision',
        `${d.pass === 'utterance' ? 'A' : 'B'} ${fx.topFeel ?? '?'}`);
    }
    const negative = fx.hasFeel && fx.valence < -0.1;

    // Hint.
    const intent = d.pass === 'utterance' ? d.top('intent')?.name ?? null : null;
    const u = d.p('understood', 'yes');
    const understood = u === null ? true : u >= 0.5;
    let hint: OneShotKind | null = null;
    const top = fx.topFeel;
    if (top !== null && fx.topFeelP >= st.hintTopFeel && fx.expectedIntensity >= st.hintIntensity) {
      if (intent === 'joke' && (top === 'Happiness' || top === 'Excitement')) hint = 'laugh';
      else if (intent === 'compliment' && top === 'Happiness') hint = 'delightedSquint';
      else if (top === 'Surprise' || top === 'Amazement') hint = 'bigSurprise';
      else if (intent === 'teasing' && top === 'Annoyance') hint = 'mockOffense';
      else if (top === 'Confusion' && understood) hint = 'curiousTilt';
    }
    if (negative && hint !== null && PLAYFUL_HINTS.has(hint)) hint = null;
    if (hint !== null && !this.hintReady(hint, now)) hint = null;
    fx.hint = hint;

    // Cue.
    let cue: ReactionCue | null = null;
    const r = d.top('reaction');
    if (!negative && r !== null && r.name !== 'none' && r.p >= st.cueThreshold &&
      (ReactionCueKind.allCases as readonly string[]).includes(r.name) && r.name !== 'music') {
      const kind = r.name as ReactionCueKind;
      const a = d.p('addressed', 'yes');
      const directed = d.pass === 'sentence' ? true : a === null ? true : a >= st.directedThreshold;
      cue = makeReactionCue(kind, r.p, { source: 'conversation', directedAtYanni: directed, valence: fx.valence,
        hostTime, key: `${kind}:${d.speakerId ?? 'session'}`, id: cueID });
    }

    const k = d.pass === 'sentence' ? DecisionMapper.stanceAnswer(d, st.stanceThreshold) : null;
    if (k !== null && this.takeStance(d)) {
      fx.beat = DecisionBeat.oneShot(k);   // the stance wins over the cue and the hint (R4); the hint isn't charged
      fx.stance = k;
    } else if (cue !== null) {
      fx.beat = DecisionBeat.cue(cue);
    } else if (hint !== null) {
      fx.beat = DecisionBeat.oneShot(hint);
      this.chargeHint(hint, now);
    }
    if (d.pass === 'sentence') fx.plan = ExpressiveMapper.sentencePlan(d, st);
    const b = fx.beat;
    const beatText = b.kind === 'none' ? 'no beat'
      : b.kind === 'oneShot' ? (fx.stance !== null ? `stance ${b.oneShot}` : b.oneShot)
      : `cue ${b.cue.kind} ${b.cue.confidence.toFixed(2)}`;
    fx.summary = `${d.pass === 'utterance' ? 'A' : 'B'} ${d.turnId}${d.sentenceIndex === null ? '' : `#${d.sentenceIndex}`} ` +
      `${fx.topFeel ?? '—'} ${fx.topFeelP.toFixed(2)} · s ${fx.strength.toFixed(2)} · ${beatText}`;
    return fx;
  }

  /// Feel → PAD (probability-weighted over the library's tags), confidence (1 − H/ln n), expected intensity and the
  /// impulse strength; `beat` stays none. Pure.
  static feel(d: Decision, st: MapperSettings, pad: (name: string) => PAD3 | null): DecisionEffects {
    const fx = emptyEffects();
    let sum = P3.zero;
    let total = 0;
    const probs: number[] = [];
    for (const { name, p } of d.distribution('feel')) {
      if (!(p > 0)) continue;
      const v = pad(name);
      if (v === null) continue;
      sum = P3.add(sum, P3.scale(v, p));
      total += p;
      probs.push(p);
    }
    if (total > 0) {
      fx.pad = P3.div(sum, total);
      const n = probs.length;
      if (n > 1) {
        let h = 0;
        for (const p of probs) { const q = p / total; if (q > 0) h -= q * Math.log(q); }
        fx.confidence = Math.max(0, 1 - h / Math.log(n));
      } else {
        fx.confidence = 1;
      }
    }
    const top = d.top('feel');
    if (top !== null) { fx.topFeel = top.name; fx.topFeelP = total > 0 ? top.p / Math.max(total, 1e-6) : top.p; }
    let e = 0, et = 0;
    for (const { name, p } of d.distribution('intensity')) {
      const kv = parseSwiftFloat(name);
      if (kv === null || !(kv >= 1 && kv <= 5)) continue;
      e += kv * p; et += p;
    }
    fx.expectedIntensity = et > 0 ? e / et : 3;
    const raw = (fx.expectedIntensity / 5) * fx.confidence;
    fx.strength = total > 0 ? Math.min(1, st.strengthGain * Math.pow(Math.max(raw, 0), st.strengthExponent)) : 0;
    fx.valence = fx.pad.x;
    fx.hasFeel = total > 0;
    return fx;
  }

  /// The answer a sentence's `stance` asks for at `threshold` (summed yes-ish / no-ish), or null. Pure.
  static stanceAnswer(d: Decision, threshold: number): OneShotKind | null {
    const a = d.answers.stance;
    if (!a) return null;
    const p = (k: string): number => { const v = a[k] ?? 0; return Number.isFinite(v) ? Math.max(v, 0) : 0; };
    const yes = p('yes'), strongYes = p('strongYes'), no = p('no'), strongNo = p('strongNo');
    if (yes + strongYes >= threshold) return strongYes >= yes ? 'nodYesBig' : 'nodYes';
    if (no + strongNo >= threshold) return strongNo >= no ? 'shakeNoBig' : 'shakeNo';
    return null;
  }

  /// The babble voice claims a sentence's confident stance as its reply's one stance (it opens that chunk with the
  /// answer chirp). Returns the answer, or null when the sentence has none or the reply already claimed another.
  claimStance(d: Decision): OneShotKind | null {
    if (d.pass !== 'sentence') return null;
    const k = DecisionMapper.stanceAnswer(d, this._settings.stanceThreshold);
    if (k === null) return null;
    const idx = d.sentenceIndex ?? 0;
    if (this.stanceTurn === d.turnId) return this.stanceIndex === idx && !this.stanceFired ? k : null;
    this.stanceTurn = d.turnId;
    this.stanceIndex = idx;
    this.stanceFired = false;
    return k;
  }

  /// Whether this sentence's confident stance plays as its beat (and books it: once per reply).
  private takeStance(d: Decision): boolean {
    const idx = d.sentenceIndex ?? 0;
    if (this.stanceTurn === d.turnId) {
      if (this.stanceFired || !(this.stanceIndex === idx || (this.stanceIndex === null && !this.stanceNeedsClaim))) return false;
    } else {
      if (this.stanceNeedsClaim) return false;
      this.stanceTurn = d.turnId;
    }
    this.stanceIndex = idx;
    this.stanceFired = true;
    return true;
  }

  /// The hint's cooldown has passed.
  hintReady(k: OneShotKind, now: number): boolean {
    return now - (this.hintFiredAt.get(k) ?? -Infinity) >= this._settings.hintCooldown - 1e-9;
  }

  /// Books a hint as played.
  chargeHint(k: OneShotKind, now: number): void { this.hintFiredAt.set(k, now); }

  resetCooldowns(): void { this.hintFiredAt.clear(); }
}
