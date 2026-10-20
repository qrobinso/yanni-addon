// Port of FaceEngine/MoodBackground.swift.
import { v3, type V3 } from '../core/vec';
import { ExpressionMix, Oklab, type ExpressionLibrary } from '../model';
import type { Mood } from './AgentState';
import { BackgroundBurst } from './BackgroundBurst';
import { FaceAffect } from './FaceAffect';
import type { FaceState } from './FaceState';
import { LidMath } from './LidMath';
import { MoodPalette } from './MoodPalette';
import type { ClosedRangeF } from './SettingsSupport';
import { AgentStateBehavior } from './modifiers/AgentStateBehavior';
import { Spring1, SpringParams, springCoefficients } from './Spring';

export type MoodBackgroundMode = 'black' | 'mood' | 'fixed';

/// The mood background's settings (mood background design §5). The device profile and Accessibility set the last two.
/// A class standing in for a Swift struct: `copy()` where the Swift copies.
export class MoodBackgroundConfig {
  static readonly modes: readonly MoodBackgroundMode[] = ['black', 'mood', 'fixed'];
  mode: MoodBackgroundMode = 'black';
  /// How far the background mixes from the theme background (black) toward the colour, 0…1.
  strength = 1;
  /// The fixed colour (linear RGB).
  fixedColor: V3 = v3(0.02, 0.05, 0.12);
  /// Colour transition speed multiplier, 0.25…2 (1 = ≈ 3 s to settle).
  speed = 1;
  /// Keep the colour at bedtime (also during a night wake). Off: black all bedtime.
  colourAtBedtime = false;
  /// Smallest Oklab lightness gap between the sclera and the background (0.12; Increase Contrast 0.18).
  readabilityGap = 0.12;
  /// Oklab L of the sclera fill the gap is measured against (the ivory #FBF4E4).
  scleraLightness = 0.968;
  /// Reduce Motion: colour transitions at half speed; colour bursts softer, longer and lower.
  reduceMotion = false;
  /// One-shot colour bursts over the mood colour (mood mode only).
  colourBursts = true;
  /// Colour burst strength multiplier, 0…1.
  burstStrength = 1;

  copy(): MoodBackgroundConfig { const c = Object.assign(new MoodBackgroundConfig(), this); c.fixedColor = { ...this.fixedColor }; return c; }

  equals(o: MoodBackgroundConfig): boolean {
    return this.mode === o.mode && this.strength === o.strength && this.fixedColor.x === o.fixedColor.x &&
      this.fixedColor.y === o.fixedColor.y && this.fixedColor.z === o.fixedColor.z && this.speed === o.speed &&
      this.colourAtBedtime === o.colourAtBedtime && this.readabilityGap === o.readabilityGap &&
      this.scleraLightness === o.scleraLightness && this.reduceMotion === o.reduceMotion &&
      this.colourBursts === o.colourBursts && this.burstStrength === o.burstStrength;
  }

  validated(): MoodBackgroundConfig {
    const c = this.copy();
    const fin = Number.isFinite;
    c.strength = fin(this.strength) ? Math.min(Math.max(this.strength, 0), 1) : 1;
    c.speed = fin(this.speed) ? Math.min(Math.max(this.speed, 0.25), 2) : 1;
    c.readabilityGap = fin(this.readabilityGap) ? Math.min(Math.max(this.readabilityGap, 0), 0.4) : 0.12;
    c.burstStrength = fin(this.burstStrength) ? Math.min(Math.max(this.burstStrength, 0), 1) : 1;
    c.scleraLightness = fin(this.scleraLightness) ? Math.min(Math.max(this.scleraLightness, 0.5), 1) : 0.968;
    const f = this.fixedColor;
    const cl = (v: number): number => Math.min(Math.max(v, 0), 1);
    c.fixedColor = fin(f.x) && fin(f.y) && fin(f.z) ? v3(cl(f.x), cl(f.y), cl(f.z)) : new MoodBackgroundConfig().fixedColor;
    return c;
  }

  /// Highest background lightness the readability rule allows.
  get maxLightness(): number { return this.scleraLightness - this.readabilityGap; }
}

interface TargetKey { mode: MoodBackgroundMode; fixed: V3; maxL: number }
const keyEquals = (a: TargetKey, b: TargetKey): boolean =>
  a.mode === b.mode && a.fixed.x === b.fixed.x && a.fixed.y === b.fixed.y && a.fixed.z === b.fixed.z && a.maxL === b.maxL;
const fin3 = (v: V3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const c1 = (v: number): number => Math.min(Math.max(v, -1), 1);

/// The background half of the mood-colour subsystem (mood background design): a second palette read from the same
/// affect at the same moment as the crescent, smoothed far more calmly because it fills the screen. `MoodColor` owns
/// one and steps it after its own crescent colour; it writes `s.backgroundColor` / `backgroundStrength` /
/// `backgroundPresence`.
///
/// - **Input:** mood + `expressionInfluence` · a low-passed (τ `expressionTau`) PAD delta of the shown expression (the
///   touch reaction overlay left out).
/// - **Target:** `MoodPalette.background` banded (L `band`, capped at the readability limit; chroma ≤ `chromaCap`), or
///   the fixed colour (L capped the same way).
/// - **Colour:** a critically damped spring in Oklab (ω `omega` × speed). A sudden mood step bypasses the low-pass and
///   switches to ω `fastOmega` for `fastHold` seconds.
/// - **Strength:** mode black → 0, else `strength`; on its own spring.
/// - **Presence (life cycle):** 1 awake; 0 asleep, half awake, at bedtime without `colourAtBedtime`, and while the
///   governor suppresses it.
/// - **Colour bursts:** `burst` blends a short one-shot accent over the smoothed colour.
///
/// A class standing in for a Swift struct; `update` is dt-exact.
export class MoodBackground {
  /// Oklab lightness band of every mood colour.
  static readonly band: ClosedRangeF = [0.64, 0.84] as ClosedRangeF;
  /// Chroma cap.
  static readonly chromaCap = 0.16;
  static readonly omega = 1.6;
  static readonly fastOmega = 3;
  static readonly fastHold = 2;
  static readonly stepThreshold = 0.3;
  static readonly stepTau = 0.5;
  static readonly expressionTau = 1.5;
  static readonly presenceOut = new SpringParams(1.6, 1);
  static readonly presenceIn = new SpringParams(3.2, 1);
  static readonly presenceFastIn = new SpringParams(7, 1);
  static readonly strengthSpring = new SpringParams(3.2, 1);

  /// One-shot colour bursts: an accent layer blended over the smoothed mood colour (never into it).
  burst = new BackgroundBurst();

  private _palette: MoodPalette = MoodPalette.background;
  /// The background palette (anchor colours are editable in the preview; never persisted).
  get palette(): MoodPalette { return this._palette; }
  set palette(p: MoodPalette) { this._palette = p; this.targetPAD = null; }

  private exprLP: V3 = v3(0);
  private moodFollower: V3 = v3(0);
  private fastUntil = -Infinity;
  private targetPAD: V3 | null = null;
  private targetKey: TargetKey = { mode: 'black', fixed: v3(0), maxL: 0 };
  private target: V3 = v3(0);
  private value: V3 = v3(0);
  private velocity: V3 = v3(0);
  private presence = new Spring1(0);
  private strength = new Spring1(0);
  private initialized = false;

  get currentLab(): V3 { return this.value; }
  get targetLab(): V3 { return this.target; }
  get currentPresence(): number { return this.presence.value; }
  get currentStrength(): number { return this.strength.value; }
  /// True while the fast spring (a sudden mood step) is on.
  isFast(time: number): boolean { return time < this.fastUntil; }

  /// Life-cycle presence target for this state.
  static presenceTarget(s: FaceState): number {
    if (s.backgroundSuppressed) return 0;
    if (s.isBedtime && !s.backgroundConfig.colourAtBedtime) return 0;
    return s.agentState === 'asleep' || s.agentState === 'halfAwake' ? 0 : 1;
  }

  /// The colour the palette gives for a background PAD point under `config` (banded, readability-capped).
  colourLab(pad: V3, config: MoodBackgroundConfig): V3 {
    return this._palette.bandedLab(pad, MoodBackground.lightnessBand(config), MoodBackground.chromaCap);
  }

  /// The band with its top lowered to the readability limit.
  static lightnessBand(config: MoodBackgroundConfig): ClosedRangeF {
    const top = Math.min(MoodBackground.band[1], config.maxLightness);
    return [Math.min(MoodBackground.band[0], top), top] as ClosedRangeF;
  }

  /// The fixed colour in Oklab with its lightness capped at the readability limit.
  static fixedLab(config: MoodBackgroundConfig): V3 {
    const f = config.fixedColor, cl = (v: number): number => Math.min(Math.max(v, 0), 1);
    const lab = Oklab.fromLinear(v3(cl(f.x), cl(f.y), cl(f.z)));
    const top = config.maxLightness;
    if (!(lab.x > top)) return lab;
    return MoodPalette.banded(lab, [0, top] as ClosedRangeF, Infinity);
  }

  /// Steps the background. `mixDelta` is the shown expression's PAD delta (MoodColor's cache, overlay excluded).
  update(s: FaceState, mixDelta: V3, expressionInfluence: number): void {
    const cfg = s.backgroundConfig;
    const dt = Math.max(s.dt, 0);
    const k = Number.isFinite(expressionInfluence) ? Math.max(expressionInfluence, 0) : 0;
    const exprTarget = fin3(mixDelta) ? v3(mixDelta.x * k, mixDelta.y * k, mixDelta.z * k) : v3(0);
    const mood = FaceAffect.combine(s.mood, v3(0), 0);

    if (!this.initialized) {
      this.exprLP = exprTarget;
      this.moodFollower = mood;
    } else {
      // Sudden mood step → fast path (bypass the expression low-pass).
      const a = LidMath.expAlpha(dt, MoodBackground.stepTau);
      const mf = this.moodFollower;
      this.moodFollower = v3(mf.x + (mood.x - mf.x) * a, mf.y + (mood.y - mf.y) * a, mf.z + (mood.z - mf.z) * a);
      const dx = mood.x - this.moodFollower.x, dy = mood.y - this.moodFollower.y, dz = mood.z - this.moodFollower.z;
      if (dx * dx + dy * dy + dz * dz > MoodBackground.stepThreshold * MoodBackground.stepThreshold) {
        this.fastUntil = s.time + MoodBackground.fastHold;
        this.exprLP = exprTarget;
      }
      const b = LidMath.expAlpha(dt, MoodBackground.expressionTau);
      const e = this.exprLP;
      this.exprLP = v3(e.x + (exprTarget.x - e.x) * b, e.y + (exprTarget.y - e.y) * b, e.z + (exprTarget.z - e.z) * b);
    }
    const pad = v3(c1(mood.x + this.exprLP.x), c1(mood.y + this.exprLP.y), c1(mood.z + this.exprLP.z));

    // Target (recomputed only when the PAD point or the settings move).
    const key: TargetKey = { mode: cfg.mode, fixed: { ...cfg.fixedColor }, maxL: cfg.maxLightness };
    const tp = this.targetPAD;
    const moved = tp === null ? true : (tp.x - pad.x) ** 2 + (tp.y - pad.y) ** 2 + (tp.z - pad.z) ** 2 > 1e-8;
    if (!keyEquals(key, this.targetKey) || (cfg.mode !== 'fixed' && moved) || !this.initialized) {
      this.targetKey = key;
      this.targetPAD = pad;
      this.target = cfg.mode === 'fixed' ? MoodBackground.fixedLab(cfg) : this.colourLab(pad, cfg);
    }

    // Colour spring in Oklab (exact closed form).
    const presenceGoal = MoodBackground.presenceTarget(s);
    const strengthGoal = cfg.mode === 'black' ? 0 : cfg.strength;
    if (!this.initialized) {
      this.value = { ...this.target }; this.velocity = v3(0);
      this.presence = new Spring1(presenceGoal);
      this.strength = new Spring1(strengthGoal);
      this.initialized = true;
    } else {
      let w = s.time < this.fastUntil ? MoodBackground.fastOmega : MoodBackground.omega * cfg.speed;
      if (cfg.reduceMotion) w *= 0.5;
      const { a, b, c, d } = springCoefficients(w, 1, dt);
      const t = this.target, v = this.value, vel = this.velocity;
      const x = v3(v.x - t.x, v.y - t.y, v.z - t.z);
      this.value = v3(t.x + x.x * a + vel.x * b, t.y + x.y * a + vel.y * b, t.z + x.z * a + vel.z * b);
      this.velocity = v3(x.x * c + vel.x * d, x.y * c + vel.y * d, x.z * c + vel.z * d);
      if (!(fin3(this.value) && fin3(this.velocity))) { this.value = { ...t }; this.velocity = v3(0); }

      const fastWake = s.time - s.fastWakeAt < AgentStateBehavior.fastWakeWindow;
      const pSpring = presenceGoal < this.presence.value ? MoodBackground.presenceOut
        : (fastWake ? MoodBackground.presenceFastIn : MoodBackground.presenceIn);
      this.presence.step(presenceGoal, pSpring, dt);
      this.strength.step(strengthGoal, MoodBackground.strengthSpring, dt);
      if (!Number.isFinite(this.presence.value)) this.presence = new Spring1(presenceGoal);
      if (!Number.isFinite(this.strength.value)) this.strength = new Spring1(strengthGoal);
    }

    // One-shot colour bursts on top of the mood colour (the spring above never sees them).
    const shown = this.burst.step(s, this.value, MoodBackground.lightnessBand(cfg), this.presence.value, this.strength.value);
    s.backgroundColor = Oklab.toLinearClamped(shown, v3(0));
    s.backgroundPresence = Math.min(Math.max(this.presence.value, 0), 1);
    s.backgroundStrength = Math.min(Math.max(this.strength.value, 0), 1);
  }

  // MARK: Reference moods (preview presets)

  /// The six reference panels as mood presets: (title, background anchor, matching expression).
  static readonly referenceMoods: readonly { title: string; anchor: string; expression: string }[] = [
    { title: 'Smug & happy', anchor: 'happy', expression: 'Happiness' },
    { title: 'Worried', anchor: 'worried', expression: 'Concerned' },
    { title: 'Anxious', anchor: 'anxious', expression: 'Fear' },
    { title: 'Dismayed', anchor: 'sad', expression: 'Sadness' },
    { title: 'Angry', anchor: 'angry', expression: 'Anger' },
    { title: 'Goofy & content', anchor: 'content', expression: 'Curious' },
  ];

  /// The mood that, with `expression` shown, puts the background's effective PAD exactly on `anchor`'s PAD.
  static presetMood(anchor: string, expression: string, library: ExpressionLibrary,
    palette: MoodPalette = MoodPalette.background, expressionInfluence = 0.5): Mood {
    const p = (palette.anchors.find((a) => a.name === anchor) ?? palette.anchors[0]).pad;
    const d = FaceAffect.padDelta(ExpressionMix.single(expression), library);
    return {
      pleasure: c1(p.x - d.x * expressionInfluence),
      arousal: c1(p.y - d.y * expressionInfluence),
      dominance: c1(p.z - d.z * expressionInfluence),
    };
  }
}
