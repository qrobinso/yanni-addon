// Port of FaceEmotion/EmotionClassifier.swift.
import { roundSwift } from '../core/vec';
import { ExpressionMix, mixEntry, type ExpressionLibrary } from '../model';
import { ClassifierSettings } from './EmotionSettings';
import { P3, type PAD3 } from './EmotionTypes';

export interface Candidate { name: string; pad: PAD3 }

/// PAD → the expression the feeling reads as (emotion layer design §5.1).
///
/// - Candidates: the allow-listed library expressions with PAD tags (Neutral never: inside the deadzone the face is
///   the state profile exactly).
/// - Activation: `aᵢ = 1 − smoothstep(rSat, rAct, |x − Pᵢ|)`.
/// - Point: the layer classifies `point(baseline, deviation, offset)`: the emotion's deviation from the reference
///   (baseline + `moodShare` × mood) placed at the baseline, small deviations amplified by up to `deviationGain`, plus
///   the life cycle's offset as is.
/// - Deadzone: within `deadzone` of the baseline nothing shows, and the weight ramps in over `deadzoneRamp`.
/// - Label (decided on a fixed 50 ms grid): the most active candidate, the current one's distance getting a `margin`
///   bonus; a challenger must win continuously for `dwell` (`fastDwell` after a big jump of felt).
/// - Mix: the label plus the runner-up when its activation is ≥ `runnerUpRatio` × the label's; the runner-up's share
///   is quantised to 0.1 with half-step hysteresis.
/// - Weight and intensity (per frame, continuous): weight = deadzone ramp × the label's activation; intensity = the
///   projection of x − ref onto Pᵢ − ref, clamped 0.3…1.1.
/// A class standing in for a Swift struct: `copy()` where the Swift copies.
export class EmotionClassifier {
  /// The decision grid (seconds).
  static readonly interval = 0.05;
  static readonly historyCount = 7;

  private _candidates: Candidate[] = [];
  private _label: number | null = null;
  private _runnerUp: number | null = null;
  private _runnerUpShare = 0;
  private _challenger: number | null = null;
  private challengerSince = 0;
  private hasChallenger = false;
  /// Felt samples on the 50 ms grid for the jump check (ring).
  private history: PAD3[] = Array.from({ length: EmotionClassifier.historyCount }, () => P3.zero);
  private historyNext = 0;
  private historyFilled = 0;
  private _mixVersion = 0;

  get candidates(): readonly Candidate[] { return this._candidates; }
  /// Index into `candidates` (null: nothing, the deadzone).
  get label(): number | null { return this._label; }
  get runnerUp(): number | null { return this._runnerUp; }
  /// Runner-up share of the mix (0…0.5, quantised to 0.1).
  get runnerUpShare(): number { return this._runnerUpShare; }
  get challenger(): number | null { return this._challenger; }
  /// Bumped when label, runner-up or share change (the layer rebuilds its mix then).
  get mixVersion(): number { return this._mixVersion; }

  get labelName(): string | null { return this._label === null ? null : this._candidates[this._label].name; }
  get runnerUpName(): string | null { return this._runnerUp === null ? null : this._candidates[this._runnerUp].name; }
  get challengerName(): string | null { return this._challenger === null ? null : this._candidates[this._challenger].name; }

  copy(): EmotionClassifier {
    const c = Object.assign(Object.create(EmotionClassifier.prototype) as EmotionClassifier, this);
    c.history = [...this.history];
    return c;
  }

  /// Rebuilds the candidates from the library and allow-list (keeps the label when it survives).
  setCandidates(library: ExpressionLibrary, allowList: readonly string[]): void {
    const current = this.labelName;
    const c: Candidate[] = [];
    for (const name of allowList) {
      if (ClassifierSettings.excluded.has(name)) continue;
      const p = library.get(name)?.pad;
      if (!p) continue;
      c.push({ name, pad: { x: p.p, y: p.a, z: p.d } });
    }
    this._candidates = c;
    const i = current === null ? -1 : c.findIndex((x) => x.name === current);
    this._label = i >= 0 ? i : null;
    this._runnerUp = null; this._runnerUpShare = 0; this._challenger = null; this.hasChallenger = false;
    this._mixVersion += 1;
  }

  /// The point to classify: baseline + deviation × g′ + offset, g′ = gain / (1 + (gain − 1)·|deviation| / reach).
  static point(baseline: PAD3, deviation: PAD3, offset: PAD3, s: ClassifierSettings): PAD3 {
    const r = P3.length(deviation);
    const g = s.deviationGain / (1 + (s.deviationGain - 1) * r / s.deviationReach);
    return P3.add(P3.add(baseline, P3.scale(deviation, Number.isFinite(g) ? g : 1)), offset);
  }

  static activation(d: number, s: ClassifierSettings): number {
    const span = Math.max(s.activationRadius - s.saturationRadius, 1e-4);
    const t = Math.min(Math.max((d - s.saturationRadius) / span, 0), 1);
    return 1 - t * t * (3 - 2 * t);
  }

  /// One decision on the 50 ms grid. `x` = effective PAD (felt + life offset), `ref` = baseline + moodShare × mood.
  update(x: PAD3, ref: PAD3, time: number, s: ClassifierSettings): void {
    if (!P3.isFinite(x) || !P3.isFinite(ref)) return;
    const n = EmotionClassifier.historyCount;
    // Jump check against the sample 0.3 s ago.
    let jumped = false;
    if (this.historyFilled >= n - 1) {
      const old = this.history[(this.historyNext + 1) % n];
      jumped = P3.length(P3.sub(x, old)) > s.jumpThreshold;
    }
    this.history[this.historyNext] = x;
    this.historyNext = (this.historyNext + 1) % n;
    this.historyFilled = Math.min(this.historyFilled + 1, n);

    const cands = this._candidates;
    let best: number | null = null;
    let bestA = 0;
    if (P3.length(P3.sub(x, ref)) >= s.deadzone) {
      for (let i = 0; i < cands.length; i++) {
        let d = P3.length(P3.sub(x, cands[i].pad));
        if (i === this._label) d -= s.margin;
        const a = EmotionClassifier.activation(d, s);
        if (a > bestA) { best = i; bestA = a; }
      }
    }
    if (bestA <= 0) best = null;

    let changed = false;
    if (best === this._label) {
      this.hasChallenger = false; this._challenger = null;
    } else if (this.hasChallenger && this._challenger === best) {
      const need = jumped ? s.fastDwell : s.dwell;
      if (time - this.challengerSince >= need - 1e-9) {
        this._label = best;
        this.hasChallenger = false; this._challenger = null;
        changed = true;
      }
    } else {
      this.hasChallenger = true; this._challenger = best; this.challengerSince = time;
      if (s.dwell <= 0 || (jumped && s.fastDwell <= 0)) {
        this._label = best; this.hasChallenger = false; this._challenger = null; changed = true;
      }
    }

    // Runner-up (only alongside a label; recomputed without the margin bonus).
    let newRunner: number | null = null;
    let share = 0;
    const l = this._label;
    if (l !== null) {
      const la = EmotionClassifier.activation(P3.length(P3.sub(x, cands[l].pad)), s);
      let ra = 0;
      for (let i = 0; i < cands.length; i++) {
        if (i === l) continue;
        const a = EmotionClassifier.activation(P3.length(P3.sub(x, cands[i].pad)), s);
        if (a > ra) { ra = a; newRunner = i; }
      }
      if (newRunner !== null && la > 0 && ra >= s.runnerUpRatio * la) {
        share = ra / (la + ra);
      } else {
        newRunner = null;
      }
    }
    // Quantise the share to 0.1 with half-step hysteresis.
    let q = this._runnerUpShare;
    if (newRunner === null) q = 0;
    else if (newRunner !== this._runnerUp || Math.abs(share - this._runnerUpShare) > 0.075) q = roundSwift(share * 10) / 10;
    if (q <= 0) { newRunner = null; q = 0; }
    if (newRunner !== this._runnerUp || q !== this._runnerUpShare) changed = true;
    this._runnerUp = newRunner;
    this._runnerUpShare = q;
    if (changed) this._mixVersion += 1;
  }

  /// The label's weight (deadzone ramp × activation) and intensity at `x` (per frame, continuous).
  weightAndIntensity(x: PAD3, ref: PAD3, s: ClassifierSettings): { weight: number; intensity: number } {
    const l = this._label;
    if (l === null || !P3.isFinite(x) || !P3.isFinite(ref)) return { weight: 0, intensity: 0 };
    const off = P3.sub(x, ref);
    const r = P3.length(off);
    const t = Math.min(Math.max((r - s.deadzone) / s.deadzoneRamp, 0), 1);
    const ramp = t * t * (3 - 2 * t);
    const p = this._candidates[l].pad;
    const w = ramp * EmotionClassifier.activation(P3.length(P3.sub(x, p)), s);
    const axis = P3.sub(p, ref);
    const n2 = P3.dot(axis, axis);
    const intensity = n2 < 0.0025 ? 1 : Math.min(Math.max(P3.dot(off, axis) / n2, 0.3), 1.1);
    return { weight: Number.isFinite(w) ? w : 0, intensity: Number.isFinite(intensity) ? intensity : 1 };
  }

  /// The mix for the current label (null when nothing shows). Allocates; call only when `mixVersion` changed.
  mix(intensity: number): ExpressionMix | null {
    const l = this._label;
    if (l === null) return null;
    const r = this._runnerUp;
    if (r !== null && this._runnerUpShare > 0) {
      return new ExpressionMix([mixEntry(this._candidates[l].name, 1 - this._runnerUpShare),
        mixEntry(this._candidates[r].name, this._runnerUpShare)], intensity);
    }
    return new ExpressionMix([mixEntry(this._candidates[l].name, 1)], intensity);
  }

  /// Clears the label (reset).
  reset(): void {
    this._label = null; this._runnerUp = null; this._runnerUpShare = 0; this._challenger = null; this.hasChallenger = false;
    this.historyFilled = 0;
    this._mixVersion += 1;
  }
}

/// The slow mood in plain words for the LLM (cheerful, playful, calm, a bit bored, a bit down, unsure, excited), with a
/// 5 s dwell so it never flickers.
export class MoodLabeler {
  static readonly labels: readonly string[] = ['playful', 'cheerful', 'excited', 'calm', 'a bit bored', 'a bit down',
    'unsure'];
  static readonly dwell = 5;

  private _label = 'playful';
  private candidate = 'playful';
  private candidateSince = 0;

  get label(): string { return this._label; }

  /// The bucket for a mood point (baseline + mood) and the life cycle's boredom.
  static bucket(m: PAD3, boredom: number): string {
    if (boredom >= 0.5) return 'a bit bored';
    if (m.x < 0.05) return 'a bit down';
    if (m.z < -0.1) return 'unsure';
    if (m.y > 0.4 && m.x > 0.2) return 'excited';
    if (m.x > 0.4) return 'cheerful';
    if (m.y < 0) return 'calm';
    return 'playful';
  }

  /// Starts at the bucket for `mood` without dwell.
  reset(mood: PAD3, boredom: number): void {
    this._label = MoodLabeler.bucket(mood, boredom);
    this.candidate = this._label;
  }

  /// True when the label changed.
  update(mood: PAD3, boredom: number, time: number): boolean {
    const b = MoodLabeler.bucket(mood, boredom);
    if (b === this._label) { this.candidate = b; return false; }
    if (b !== this.candidate) { this.candidate = b; this.candidateSince = time; return false; }
    if (time - this.candidateSince < MoodLabeler.dwell) return false;
    this._label = b;
    return true;
  }
}
