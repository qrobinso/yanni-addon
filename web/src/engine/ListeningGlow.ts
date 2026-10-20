// Port of FaceEngine/ListeningGlow.swift.
import { v3, v4, type V3, type V4 } from '../core/vec';
import { FaceFrame, Oklab } from '../model';
import type { FaceState } from './FaceState';
import { LidMath } from './LidMath';
import { MoodPalette } from './MoodPalette';
import type { ClosedRangeF } from './SettingsSupport';
import { Spring1, SpringParams } from './Spring';

/// The listening glow's settings (listening glow design §6): the owner's switch, Reduce Motion, and the resource
/// governor's motion budget. A class standing in for a Swift struct: `copy()` where the Swift copies.
export class ListeningGlowConfig {
  /// The owner's "Listening glow" switch. Off: the mic target is ignored and a glow already showing fades.
  enabled = true;
  /// Reduce Motion: a soft fade in place, no rise, undulation, drift or pulse.
  reduceMotion = false;
  /// The governor's motion budget, 0…1: 1 full undulation, 0.5 half (slower), 0 a static glow.
  motion = 1;

  copy(): ListeningGlowConfig { return Object.assign(new ListeningGlowConfig(), this); }
  equals(o: ListeningGlowConfig): boolean {
    return this.enabled === o.enabled && this.reduceMotion === o.reduceMotion && this.motion === o.motion;
  }

  validated(): ListeningGlowConfig {
    const c = this.copy();
    c.motion = Number.isFinite(this.motion) ? Math.min(Math.max(this.motion, 0), 1) : 1;
    return c;
  }
}

const fin3 = (v: V3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/// The glow that rises from the bottom edge while the mic is open (listening glow design). Owned by `MoodColor` and
/// stepped after `MoodBackground`: it writes `s.glowLevel`, `glowHeight`, `glowMotion`, `glowColor`, `glowColor2` and
/// `glowPhase`.
///
/// - **Envelope:** an underdamped spring up (peak ≈ 0.5 s, ≈ 7 % overshoot), critically damped down (≈ 0.7 s),
///   snapped to exactly 0 once negligible. Reduce Motion: critically damped both ways.
/// - **Motion:** phase accumulators (wrapped at 2π, advanced only while it shows) for three edge waves and the colour
///   band drift; a 0.22 Hz pulse; a voice swell while the person speaks.
/// - **Mic level:** smoothed again here, it raises brightness and height a little, speeds the waves and raises the
///   crests with a finer ripple. Reduce Motion: brightness only.
/// - **Colour:** a lighter, more saturated relative of the mood background (when it shows) or of the crescent colour.
///
/// A class standing in for a Swift struct; `update` is dt-exact.
export class ListeningGlow {
  static readonly rise = new SpringParams(8.3, 0.65);
  static readonly fade = new SpringParams(7, 1);
  static readonly riseReduced = new SpringParams(6, 1);
  static readonly fadeReduced = new SpringParams(5, 1);
  static readonly offEpsilon = 0.004;
  static readonly peakHeight = 0.21;
  static readonly waveHz: V4 = v4(0.05, 0.11, -0.17, 0.07);
  static readonly pulseHz = 0.22;
  static readonly pulseDepth = 0.06;
  static readonly voiceLevelGain = 0.12;
  static readonly voiceHeightGain = 0.15;
  static readonly voiceSpeedUp = 0.6;
  static readonly voiceAttack = 0.15;
  static readonly voiceRelease = 0.5;
  static readonly micAttack = 0.12;
  static readonly micRelease = 0.35;
  static readonly micLevelGain = 0.16;
  static readonly micHeightGain = 0.22;
  static readonly micSpeedUp = 1.0;
  static readonly micReducedGain = 0.6;
  static readonly backgroundLift = 0.12;
  static readonly lightBackgroundDip = -0.08;
  static readonly chromaGain = 2.0;
  static readonly bandHueTurn = 0.55;
  static readonly minChroma = 0.2;
  static readonly maxLightness = 0.9;
  static readonly glowHueTurn = 0.35;

  private envelope = new Spring1(0);
  private voice = 0;
  private mic = 0;
  private phase: V4 = v4(0);
  private pulsePhase = 0;

  /// The envelope 0…≈1.07 (before pulse and voice).
  get currentLevel(): number { return this.envelope.value; }
  get currentVoice(): number { return this.voice; }
  get currentMic(): number { return this.mic; }

  /// Steps the glow. `crescentLab` is MoodColor's smoothed crescent colour (Oklab).
  update(s: FaceState, crescentLab: V3): void {
    const G = ListeningGlow;
    const cfg = s.glowConfig;
    const dt = Math.max(s.dt, 0);
    const target = cfg.enabled ? s.glowTarget : 0;
    const rm = cfg.reduceMotion;
    const up = target > this.envelope.value;
    this.envelope.step(target, rm ? (up ? G.riseReduced : G.fadeReduced) : (up ? G.rise : G.fade), dt);
    if (!Number.isFinite(this.envelope.value) || !Number.isFinite(this.envelope.velocity)) this.envelope = new Spring1(target);
    if (target === 0 && Math.abs(this.envelope.value) < G.offEpsilon && Math.abs(this.envelope.velocity) < 0.05) this.envelope = new Spring1(0);
    if (target === 0 && this.envelope.value < 0) this.envelope.value = 0;

    const voiceIn = s.glowVoice;
    this.voice += (voiceIn - this.voice) * LidMath.expAlpha(dt, voiceIn > this.voice ? G.voiceAttack : G.voiceRelease);
    if (!Number.isFinite(this.voice)) this.voice = 0;
    const micIn = cfg.enabled && Number.isFinite(s.glowMic) ? Math.min(Math.max(s.glowMic, 0), 1) : 0;
    this.mic += (micIn - this.mic) * LidMath.expAlpha(dt, micIn > this.mic ? G.micAttack : G.micRelease);
    if (!Number.isFinite(this.mic)) this.mic = 0;

    const env = Math.max(this.envelope.value, 0);
    if (!(env > 0)) {
      s.glowLevel = 0;
      s.glowHeight = 0;
      s.glowRipple = 0;
      return;
    }

    // Motion: phases advance only while it shows; the governor slows and then stops them; Reduce Motion stops them.
    const motion = rm ? 0 : cfg.motion;
    const twoPi = 2 * Math.PI;
    if (motion > 0) {
      const speed = motion * (1 + G.voiceSpeedUp * this.voice + G.micSpeedUp * this.mic);
      const k = twoPi * dt * speed;
      const p = this.phase, w = G.waveHz;
      const wrap = (v: number): number => v - Math.floor(v / twoPi) * twoPi;
      this.phase = v4(wrap(p.x + w.x * k), wrap(p.y + w.y * k), wrap(p.z + w.z * k), wrap(p.w + w.w * k));
      this.pulsePhase += twoPi * G.pulseHz * dt * motion;
      if (this.pulsePhase >= twoPi) this.pulsePhase -= twoPi;
    }
    const pulse = 1 + G.pulseDepth * motion * Math.sin(this.pulsePhase);
    const voiceGain = rm ? 0.5 : 1;
    const micGain = rm ? G.micReducedGain : 1;
    s.glowLevel = env * pulse * (1 + G.voiceLevelGain * voiceGain * this.voice + G.micLevelGain * micGain * this.mic);
    s.glowHeight = G.peakHeight * (rm ? 1 : env) * (1 + 0.5 * (pulse - 1))
      * (1 + G.voiceHeightGain * voiceGain * this.voice + (rm ? 0 : G.micHeightGain * this.mic));
    s.glowMotion = motion;
    s.glowRipple = motion * this.mic;
    s.glowPhase = { ...this.phase };

    const weight = s.backgroundStrength * s.backgroundPresence;
    const [a, b] = G.colours(Oklab.fromLinear(s.backgroundColor), weight, crescentLab);
    s.glowColor = Oklab.toLinearClamped(a, FaceFrame.defaultColor);
    s.glowColor2 = Oklab.toLinearClamped(b, FaceFrame.defaultColor);
  }

  /// The two glow colours (Oklab) for a background colour (Oklab), how coloured the background is (strength ×
  /// presence, 0 black … 1) and the crescent colour (Oklab). Continuous in every input.
  static colours(background: V3, weight: number, crescent: V3): [V3, V3] {
    const G = ListeningGlow, ss = G.smoothstep;
    const bg = fin3(background) ? background : v3(0);
    const cr = fin3(crescent) ? crescent : Oklab.fromLinear(FaceFrame.defaultColor);
    // Over a coloured background: lighter and more saturated, same hue; a near-grey one borrows the crescent's hue.
    const bgC = Math.sqrt(bg.y * bg.y + bg.z * bg.z);
    const borrow = 1 - ss(0.0, 0.06, bgC);
    const bdx = bgC > 1e-6 ? bg.y / bgC : 0, bdy = bgC > 1e-6 ? bg.z / bgC : 0;
    // Vivid: chroma raised to at least `minChroma` (the gamut fit trims it).
    const rx = bg.y * G.chromaGain + cr.y * (0.5 * borrow), ry = bg.z * G.chromaGain + cr.z * (0.5 * borrow);
    const rawC = Math.sqrt(rx * rx + ry * ry);
    const gk = rawC > 1e-6 ? Math.max(rawC, G.minChroma) / rawC : 0;
    const gx = rawC > 1e-6 ? rx * gk : bdx * G.minChroma, gy = rawC > 1e-6 ? ry * gk : bdy * G.minChroma;
    const ca = Math.cos(-G.glowHueTurn), sa = Math.sin(-G.glowHueTurn);
    const lift = G.backgroundLift + (G.lightBackgroundDip - G.backgroundLift) * ss(0.62, 0.8, bg.x);
    const overBG = v3(Math.min(bg.x + lift, G.maxLightness), gx * ca - gy * sa, gx * sa + gy * ca);
    // Over black: the crescent's colour, lightness held in a band, a little richer.
    const overBlack = v3(Math.min(Math.max(cr.x, 0.72), 0.86), cr.y * 1.1, cr.z * 1.1);
    const k = ss(0, 0.6, Number.isFinite(weight) ? weight : 0);
    const a = G.fit(v3(overBlack.x + (overBG.x - overBlack.x) * k, overBlack.y + (overBG.y - overBlack.y) * k,
      overBlack.z + (overBG.z - overBlack.z) * k));
    const c = Math.cos(-G.bandHueTurn), sn = Math.sin(-G.bandHueTurn);
    const b = G.fit(v3(a.x - 0.03, a.y * c - a.z * sn, a.y * sn + a.z * c));
    return [a, b];
  }

  /// Fits a colour into the sRGB gamut at its lightness (hue kept).
  static fit(lab: V3): V3 {
    const l = Math.min(Math.max(lab.x, 0), 1);
    return MoodPalette.banded(lab, [l, l] as ClosedRangeF, Infinity);
  }

  static smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  }
}
