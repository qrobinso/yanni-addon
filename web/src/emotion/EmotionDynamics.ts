// Port of FaceEmotion/EmotionDynamics.swift.
import { EmotionDynamicsSettings, PersonalityPreset } from './EmotionSettings';
import { P3, type ImpulseTarget, type PAD3 } from './EmotionTypes';

/// The affect core (WASABI's structure, reimplemented): a fast **emotion** kicked by impulses and fading within
/// seconds, a slow **mood** that integrates emotion and fades over minutes, both relative to a personality
/// **baseline**, plus a **rest** point that sustained conditions shift. Fixed 10 ms steps.
///
///     drive d:   ḋ = −d / τr                                   (an impulse kicks d; it releases with τr)
///     emotion e: ė = (d − e) / τa                              (rises toward the drive in ≈ τa, 80 ms)
///     mood m:    ṁ = α · e · headroom(m, e) − m / τ(axis, sign)
///     felt     = softClamp(B + (s·m_P, m_A, m_D) + r + e)
///
/// - Impulses move the coming peak of felt toward the target by `strength` of the way (never past it, however many
///   stack). `relative` impulses push by strength · δ. τr = emotionDecaySeconds / 3.3.
/// - Mood integrates only the impulse-driven emotion (never the rest shift); headroom eases it toward ±`moodCap`
///   (pleasure toward −`pleasureFloor`); it decays `sleepyDecayFactor` times faster while `sleepy`.
/// - Somber (bad news): for `somberSeconds` mood's pleasure counts only `somberPleasureScale` toward felt (eased).
/// - Baseline and rest changes ease in: nothing ever jumps.
///
/// Every step uses the same constants, so the same timeline sliced into any number of calls gives identical state.
/// A class standing in for a Swift struct: `copy()` where the Swift copies. Vectors are replaced, never mutated.
export class EmotionDynamics {
  /// The fixed step (seconds).
  static readonly step = 0.01;
  /// felt is linear to ±`softKnee`, then a tanh knee to ±1.
  static readonly softKnee = 0.85;
  /// τr = emotionDecaySeconds / this.
  static readonly releaseDivisor = 3.3;

  private _settings: EmotionDynamicsSettings;
  get settings(): EmotionDynamicsSettings { return this._settings; }
  set settings(v: EmotionDynamicsSettings) { this._settings = v.validated(); this.recompute(); }

  /// Where the baseline is heading (personality, preview override); `baseline` eases toward it.
  baselineTarget: PAD3;
  /// Where the rest point is heading (the layer sets it from the active conditions); `rest` eases toward it.
  restTarget: PAD3 = P3.zero;
  /// Drowsy, asleep or bedtime: mood decays faster.
  sleepy = false;
  /// Preview only: mood integrates and decays this many times faster (1…120).
  moodWarp = 1;
  /// Layer time until which the somber window holds.
  somberUntil = -Infinity;

  private _baseline: PAD3;
  private _rest: PAD3 = P3.zero;
  private _drive: PAD3 = P3.zero;
  private _emotion: PAD3 = P3.zero;
  private _mood: PAD3 = P3.zero;
  private _somberScale = 1;
  private _steps = 0;

  get baseline(): PAD3 { return this._baseline; }
  get rest(): PAD3 { return this._rest; }
  get drive(): PAD3 { return this._drive; }
  get emotion(): PAD3 { return this._emotion; }
  get mood(): PAD3 { return this._mood; }
  /// 1 normally, eased toward `somberPleasureScale` in the somber window.
  get somberScale(): number { return this._somberScale; }
  /// Steps taken (time = steps × step).
  get steps(): number { return this._steps; }
  get time(): number { return this._steps * EmotionDynamics.step; }

  // Per-step constants.
  private kAttack = 0;
  private kRelease = 0;
  private kRest = 0;
  private kBaseline = 0;
  private kSomber = 0;
  private _peakFactor = 1;
  /// Peak of the emotion after a unit kick of the drive (discrete system).
  get peakFactor(): number { return this._peakFactor; }

  constructor(settings: EmotionDynamicsSettings = new EmotionDynamicsSettings(),
    baseline: PAD3 = PersonalityPreset.baseline('playful')) {
    this._settings = settings.validated();
    this.baselineTarget = baseline;
    this._baseline = baseline;
    this.recompute();
  }

  copy(): EmotionDynamics { return Object.assign(Object.create(EmotionDynamics.prototype) as EmotionDynamics, this); }

  private recompute(): void {
    const h = EmotionDynamics.step;
    const st = this._settings;
    const tr = st.emotionDecaySeconds / EmotionDynamics.releaseDivisor;
    this.kAttack = Math.exp(-h / st.attackSeconds);
    this.kRelease = Math.exp(-h / tr);
    this.kRest = Math.exp(-h / st.conditionEaseSeconds);
    this.kBaseline = Math.exp(-h / st.baselineEaseSeconds);
    this.kSomber = Math.exp(-h / 0.5);
    // Peak of e after d = 1 (simulated with the same update as `step`).
    let d = 1, e = 0, peak = 0;
    for (let i = 0; i < 2000; i++) {
      d *= this.kRelease;
      e = d + (e - d) * this.kAttack;
      if (e < peak) break;
      peak = e;
    }
    this._peakFactor = Math.max(peak, 0.05);
  }

  // MARK: Output

  /// What Yanni feels: baseline + mood (somber-scaled pleasure) + rest + emotion, soft-clamped to the PAD cube.
  get felt(): PAD3 {
    const b = this._baseline, m = this._mood, r = this._rest, e = this._emotion;
    return EmotionDynamics.softClamp3({ x: b.x + m.x * this._somberScale + r.x + e.x, y: b.y + m.y + r.y + e.y,
      z: b.z + m.z + r.z + e.z });
  }

  /// The slow mood point (baseline + mood), soft-clamped.
  get moodPoint(): PAD3 { return EmotionDynamics.softClamp3(P3.add(this._baseline, this._mood)); }

  static softClamp3(v: PAD3): PAD3 {
    return { x: EmotionDynamics.softClamp(v.x), y: EmotionDynamics.softClamp(v.y), z: EmotionDynamics.softClamp(v.z) };
  }

  static softClamp(x: number): number {
    if (!Number.isFinite(x)) return 0;
    const a = Math.abs(x);
    const knee = EmotionDynamics.softKnee;
    if (a <= knee) return x;
    const k = 1 - knee;
    const y = knee + k * Math.tanh((a - knee) / k);
    return x < 0 ? -y : y;
  }

  /// The extremes the emotion will reach (relative to rest) if nothing else happens: the current value and the next
  /// 0.5 s of the drive's response (where any peak lies), per axis.
  futureExtremes(): { hi: PAD3; lo: PAD3 } {
    const d = [this._drive.x, this._drive.y, this._drive.z];
    const e = [this._emotion.x, this._emotion.y, this._emotion.z];
    const hi = e.map((v) => (v > 0 ? v : 0)), lo = e.map((v) => (v < 0 ? v : 0));
    for (let k = 0; k < 50; k++) {
      for (let i = 0; i < 3; i++) {
        d[i] *= this.kRelease;
        e[i] = d[i] + (e[i] - d[i]) * this.kAttack;
        hi[i] = Math.max(hi[i], e[i]);
        lo[i] = Math.min(lo[i], e[i]);
      }
    }
    return { hi: P3.fromArray(hi), lo: P3.fromArray(lo) };
  }

  // MARK: Inputs

  /// Applies an impulse now with `strength` already scaled (gain, reactivity) and clamped to 0…1 here.
  apply(target: ImpulseTarget, rawStrength: number): void {
    if (!Number.isFinite(rawStrength)) return;
    const s = Math.min(Math.max(rawStrength, 0), 1);
    if (!(s > 0)) return;
    let kick: PAD3;
    if (target.kind === 'absolute') {
      if (!P3.isFinite(target.pad)) return;
      // Superposition: the new peak ≤ the old trajectory's extreme + the kick, so measuring the distance to the
      // target from that extreme means felt never passes the target, however many impulses stack.
      const tt = P3.clamp(target.pad, -1, 1);
      const m = this._mood;
      const base = P3.add(P3.add(this._baseline, { x: m.x * this._somberScale, y: m.y, z: m.z }), this._rest);
      const { hi, lo } = this.futureExtremes();
      const k = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const t = P3.at(tt, i), b = P3.at(base, i);
        const now = b + P3.at(this._emotion, i);
        if (t > now) k[i] = Math.max(t - (b + P3.at(hi, i)), 0);
        else if (t < now) k[i] = Math.min(t - (b + P3.at(lo, i)), 0);
      }
      kick = P3.scale(P3.fromArray(k), s);
    } else {
      if (!P3.isFinite(target.pad)) return;
      kick = P3.scale(target.pad, s);
    }
    this._drive = P3.add(this._drive, P3.div(kick, this._peakFactor));
  }

  /// Moves the slow mood a little toward `target` (`gain × strength` of the way): for moments whose agent-state
  /// profile already shows the feeling (sheepish, not-for-me), so felt isn't counted twice.
  applyToMood(target: PAD3, strength: number, gain: number): void {
    if (!P3.isFinite(target) || !Number.isFinite(strength) || !Number.isFinite(gain)) return;
    const s = Math.min(Math.max(strength, 0), 1) * Math.min(Math.max(gain, 0), 1);
    const delta = P3.scale(P3.sub(target, this.felt), s);
    this._mood = this.clampMood(P3.add(this._mood, delta));
  }

  /// Opens the somber window (bad news).
  markSomber(t: number): void {
    this.somberUntil = Math.max(this.somberUntil, t + this._settings.somberSeconds);
  }

  /// Sets the mood directly (persistence restore, preview), clamped to the caps.
  setMood(m: PAD3): void {
    if (!P3.isFinite(m)) { this._mood = P3.zero; return; }
    this._mood = this.clampMood(m);
  }

  /// Emotion, drive, mood and rest back to zero; baseline snapped to its target.
  reset(): void {
    this._drive = P3.zero; this._emotion = P3.zero; this._mood = P3.zero; this._rest = P3.zero; this.restTarget = P3.zero;
    this._baseline = this.baselineTarget; this._somberScale = 1; this.somberUntil = -Infinity;
  }

  /// The mood decayed by `elapsed` seconds of quiet (persistence across launches).
  decayed(m: PAD3, elapsed: number): PAD3 {
    const t = Math.min(Math.max(elapsed, 0), 86_400);
    const st = this._settings;
    const tauP = m.x >= 0 ? st.moodTauPositive : st.moodTauNegative;
    return { x: m.x * Math.exp(-t / tauP), y: m.y * Math.exp(-t / st.moodTauArousal),
      z: m.z * Math.exp(-t / st.moodTauDominance) };
  }

  private clampMood(m: PAD3): PAD3 {
    const cap = this._settings.moodCap, floor = this._settings.pleasureFloor;
    return { x: Math.min(Math.max(m.x, -floor), cap), y: Math.min(Math.max(m.y, -cap), cap),
      z: Math.min(Math.max(m.z, -cap), cap) };
  }

  // MARK: Step

  /// One fixed step.
  step(): void {
    this._steps += 1;
    const h = EmotionDynamics.step;
    const t = this.time;

    this._baseline = P3.add(this.baselineTarget, P3.scale(P3.sub(this._baseline, this.baselineTarget), this.kBaseline));
    this._rest = P3.add(this.restTarget, P3.scale(P3.sub(this._rest, this.restTarget), this.kRest));

    this._drive = P3.scale(this._drive, this.kRelease);
    this._emotion = P3.add(this._drive, P3.scale(P3.sub(this._emotion, this._drive), this.kAttack));

    // Mood: integrate emotion with headroom, decay per axis.
    const st = this._settings;
    const warp = Math.min(Math.max(Number.isFinite(this.moodWarp) ? this.moodWarp : 1, 1), 120);
    const boost = this.sleepy ? st.sleepyDecayFactor : 1;
    const dm = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const m = P3.at(this._mood, i), e = P3.at(this._emotion, i);
      const cap = i === 0 && m < 0 ? st.pleasureFloor : st.moodCap;
      const headroom = m * e > 0 ? Math.max(1 - Math.abs(m) / cap, 0) : 1;
      const tau = i === 0 ? (m >= 0 ? st.moodTauPositive : st.moodTauNegative)
        : i === 1 ? st.moodTauArousal : st.moodTauDominance;
      dm[i] = st.moodGain * e * headroom - m * boost / tau;
    }
    this._mood = this.clampMood(P3.add(this._mood, P3.scale(P3.fromArray(dm), h * warp)));

    const somberTarget = t < this.somberUntil ? st.somberPleasureScale : 1;
    this._somberScale = somberTarget + (this._somberScale - somberTarget) * this.kSomber;

    // Settle exactly (so a quiet layer reports the baseline exactly).
    const tiny = (v: PAD3): boolean => Math.abs(v.x) < 1e-6 && Math.abs(v.y) < 1e-6 && Math.abs(v.z) < 1e-6;
    if (tiny(this._drive) && tiny(this._emotion)) { this._drive = P3.zero; this._emotion = P3.zero; }
    const m = this._mood;
    if (Math.abs(m.x) < 1e-6 || Math.abs(m.y) < 1e-6 || Math.abs(m.z) < 1e-6) {
      this._mood = { x: Math.abs(m.x) < 1e-6 ? 0 : m.x, y: Math.abs(m.y) < 1e-6 ? 0 : m.y,
        z: Math.abs(m.z) < 1e-6 ? 0 : m.z };
    }
    if (tiny(P3.sub(this._rest, this.restTarget))) this._rest = this.restTarget;
    if (tiny(P3.sub(this._baseline, this.baselineTarget))) this._baseline = this.baselineTarget;
    if (Math.abs(this._somberScale - somberTarget) < 1e-6) this._somberScale = somberTarget;

    if (!(P3.isFinite(this._drive) && P3.isFinite(this._emotion) && P3.isFinite(this._mood) && P3.isFinite(this._rest) &&
      P3.isFinite(this._baseline) && Number.isFinite(this._somberScale))) {
      this._drive = P3.zero; this._emotion = P3.zero; this._mood = P3.zero; this._rest = this.restTarget;
      this._baseline = this.baselineTarget; this._somberScale = 1;
    }
  }
}
