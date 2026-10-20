// Port of FaceEngine/Modifiers/LidHeaviness.swift.
import { Ease } from '../Easing';
import type { FaceState } from '../FaceState';
import { LidNoise } from '../LidMath';
import { Phase, type Modifier } from '../Modifier';
import { Spring1, SpringParams } from '../Spring';

/// Heavy upper lids from `modulation.lidHeaviness` (design C6, Part D C3).
///
/// Writes upper-lid coverage as a fraction of the remaining opening. The heaviness is spring-smoothed and drifts
/// slowly with noise; every so often the eyes "fight" the sleepiness and lift a little. A small, slowly varying
/// asymmetry keeps the two eyes from looking like one sprite.
export class LidHeaviness implements Modifier {
  readonly name = 'LidHeaviness';
  readonly phase = Phase.lids;
  isEnabled = true;

  /// Smoothing of the heaviness input (critically damped, ~0.6 s settle).
  static readonly smoothing = new SpringParams(6, 1);
  static readonly driftAmount = 0.18;
  static readonly driftRate = 0.11;
  static readonly asymmetryAmount = 0.07;
  static readonly asymmetryRate = 0.07;
  /// "Fighting sleep": occasional lifts of up to this fraction of the coverage.
  static readonly fightAmount = 0.35;
  static readonly fightRate = 0.21;
  static readonly maxCoverage = 0.95;

  private level: Spring1 | null = null;
  private readonly drift = new LidNoise(0x11d00001);
  private readonly asym = new LidNoise(0x11d00002);
  private readonly fight = new LidNoise(0x11d00003);

  update(s: FaceState): void {
    const raw = s.modulation.lidHeaviness;
    const target = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), LidHeaviness.maxCoverage) : 0;
    const spring = this.level ?? new Spring1(target);
    spring.step(target, LidHeaviness.smoothing, s.dt);
    this.level = spring;
    const h = Math.max(spring.value, 0);
    if (!(h > 1e-4)) return;

    const t = s.time;
    const d = this.drift.at(t, LidHeaviness.driftRate);
    const a = this.asym.at(t, LidHeaviness.asymmetryRate);
    // Lifts happen only on the upper part of the fight noise, so they come and go irregularly.
    const f = Ease.smoothstep((this.fight.at(t, LidHeaviness.fightRate) - 0.25) / 0.5) * LidHeaviness.fightAmount;

    const base = h * (1 + LidHeaviness.driftAmount * d - f);
    const left = Math.min(Math.max(base + h * LidHeaviness.asymmetryAmount * a, 0), LidHeaviness.maxCoverage);
    const right = Math.min(Math.max(base - h * LidHeaviness.asymmetryAmount * a, 0), LidHeaviness.maxCoverage);
    s.lidCoverage.x += left;
    s.lidCoverage.z += right;
  }
}
