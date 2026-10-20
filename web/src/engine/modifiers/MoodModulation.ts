// Port of FaceEngine/Modifiers/MoodModulation.swift.
import { Modulation, type Mood } from '../AgentState';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { SpringParams } from '../Spring';

const clamp = (x: number): number => Math.min(Math.max(x, -1), 1);

/// Affect phase: PAD mood → `Modulation` (design C6 + H3), combined with the agent-state multipliers and
/// spring-smoothed so mood and state changes ease in (~0.5 s). Also runs the speech envelope follower.
export class MoodModulation implements Modifier {
  readonly name = 'MoodModulation';
  readonly phase = Phase.affect;
  isEnabled = true;

  // MARK: Tunable constants (L6: blink-rate vs arousal is explicit)
  static readonly speedPerArousal = 0.35;
  static readonly intensityBase = 0.9;
  static readonly intensityPerAbsPleasure = 0.2;
  static readonly intensityPerArousal = 0.1;
  static readonly blinkRatePerArousal = 0.3;
  /// Excited blinks are quicker, calm blinks lazier (duration multiplier = 1 − k·A).
  static readonly blinkDurationPerArousal = 0.15;
  static readonly lidHeavinessPerLowArousal = 0.25;
  static readonly glanceRatePerArousal = 0.6;
  static readonly maxLidHeaviness = 0.9;

  /// Smoothing spring for modulation values (critically damped; ~95 % in ≈ 0.6 s).
  static readonly smoothing = new SpringParams(8, 1);
  /// Speech envelope time constants (seconds).
  static readonly attack = 0.030;
  static readonly release = 0.120;

  /// Lanes: speed, intensity, bounciness, blinkRate, blinkDuration, lidHeaviness, glanceRate, (unused).
  private value = new Float64Array(8);
  private velocity = new Float64Array(8);
  private target = new Float64Array(8);
  private initialized = false;

  /// Mood-only modulation (no state, no smoothing).
  static moodModulation(m: Mood): Modulation {
    const p = clamp(m.pleasure), a = clamp(m.arousal);
    const o = Modulation.make();
    o.speed = 1 + MoodModulation.speedPerArousal * a;
    o.intensity = MoodModulation.intensityBase + MoodModulation.intensityPerAbsPleasure * Math.abs(p) + MoodModulation.intensityPerArousal * a;
    o.blinkRate = 1 - MoodModulation.blinkRatePerArousal * a;
    o.blinkDuration = 1 - MoodModulation.blinkDurationPerArousal * a;
    o.lidHeaviness = Math.max(0, -a) * MoodModulation.lidHeavinessPerLowArousal;
    o.glanceRate = 1 + MoodModulation.glanceRatePerArousal * a;
    o.bounciness = Math.max(p, 0) * Math.max(a, 0);
    return o;
  }

  /// Mood combined with agent-state multipliers: multiplicative, except lidHeaviness and bounciness (additive, clamped).
  static combined(mood: Mood, st: Modulation): Modulation {
    const m = MoodModulation.moodModulation(mood);
    const o = Modulation.make();
    o.speed = Math.max(m.speed * st.speed, 0.1);
    o.intensity = Math.max(m.intensity * st.intensity, 0);
    o.blinkRate = Math.max(m.blinkRate * st.blinkRate, 0);
    o.blinkDuration = Math.max(m.blinkDuration * st.blinkDuration, 0.2);
    o.glanceRate = Math.max(m.glanceRate * st.glanceRate, 0);
    o.lidHeaviness = Math.min(Math.max(m.lidHeaviness + st.lidHeaviness, 0), MoodModulation.maxLidHeaviness);
    o.bounciness = Math.min(Math.max(m.bounciness + st.bounciness, 0), 1);
    return o;
  }

  update(s: FaceState): void {
    const combined = MoodModulation.combined(s.mood, s.stateModulation);
    // Style elasticity adds springiness on top of mood and state (1 = neutral).
    const el = Number.isFinite(s.elasticity) ? Math.min(Math.max(s.elasticity, 0.5), 2) : 1;
    combined.bounciness = Math.min(Math.max(combined.bounciness + 0.3 * (el - 1), 0), 1);
    const t = this.target, v = this.value, vel = this.velocity;
    t[0] = combined.speed; t[1] = combined.intensity; t[2] = combined.bounciness; t[3] = combined.blinkRate;
    t[4] = combined.blinkDuration; t[5] = combined.lidHeaviness; t[6] = combined.glanceRate; t[7] = 0;
    if (!this.initialized) {
      v.set(t); vel.fill(0); this.initialized = true;
    } else {
      const { a, b, c, d } = MoodModulation.smoothing.coefficients(s.dt);
      for (let i = 0; i < 8; i++) {
        const x = v[i] - t[i];
        v[i] = t[i] + x * a + vel[i] * b;
        vel[i] = x * c + vel[i] * d;
      }
    }
    const out = Modulation.make();
    out.speed = v[0]; out.intensity = v[1]; out.bounciness = v[2]; out.blinkRate = v[3];
    out.blinkDuration = v[4]; out.lidHeaviness = v[5]; out.glanceRate = v[6];
    // Critically damped never overshoots, but keep hard floors exact (blinkRate 0 must mean 0).
    if (t[3] === 0 && out.blinkRate < 1e-3) out.blinkRate = 0;
    out.blinkRate = Math.max(out.blinkRate, 0);
    out.lidHeaviness = Math.max(out.lidHeaviness, 0);
    out.bounciness = Math.max(out.bounciness, 0);
    out.glanceRate = Math.max(out.glanceRate, 0);
    s.modulation = out;

    // Speech envelope follower: dt-exact one-pole, fast attack, slower release.
    const level = s.speechLevel;
    const tau = level > s.speechEnvelope ? MoodModulation.attack : MoodModulation.release;
    const k = 1 - Math.exp(-s.dt / tau);
    s.speechEnvelope += (level - s.speechEnvelope) * k;
  }
}
