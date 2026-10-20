// Port of FaceEngine/Modifiers/BurnInDrift.swift.
import type { V2 } from '../../core/vec';
import { Canvas, ParamLayout, Units } from '../../model';
import type { FaceState } from '../FaceState';
import { LidMath } from '../LidMath';
import { Phase, type Modifier } from '../Modifier';
import { Spring1, SpringParams } from '../Spring';

const CENTER_X = ParamLayout.index('centerX'), CENTER_Y = ParamLayout.index('centerY');

/// Burn-in protection: the whole face drifts on a slow Lissajous path (design C7, Part D M4/M9).
///
/// ±8 canvas units in x (±10 asleep), proportionally (canvas aspect, ×0.5) in y, with periods of ≈7 and ≈11 minutes.
/// Phases come from wrapped time; the amplitude is spring-smoothed.
export class BurnInDrift implements Modifier {
  readonly name = 'BurnInDrift';
  readonly phase = Phase.output;
  isEnabled = true;

  static readonly awakeAmplitude = 8;
  static readonly asleepAmplitude = 10;
  /// y amplitude relative to x (canvas aspect 64/128).
  static readonly yRatio = Canvas.height / Canvas.width;
  static readonly periodX = 7 * 60;
  static readonly periodY = 11 * 60;
  static readonly phaseOffsetY = 0.18;
  /// Amplitude smoothing (critically damped, ~10 s).
  static readonly amplitudeSpring = new SpringParams(0.5, 1);

  private amplitude: Spring1 | null = null;

  /// Current offset in canvas units (for tests / preview).
  offset: V2 = { x: 0, y: 0 };

  update(s: FaceState): void {
    const target = s.agentState === 'asleep' ? BurnInDrift.asleepAmplitude : BurnInDrift.awakeAmplitude;
    const a = this.amplitude ?? new Spring1(target);
    a.step(target, BurnInDrift.amplitudeSpring, s.dt);
    this.amplitude = a;

    const t = Math.max(s.time, 0);
    const px = LidMath.wrap01(t / BurnInDrift.periodX);
    const py = LidMath.wrap01(t / BurnInDrift.periodY + BurnInDrift.phaseOffsetY);
    const x = a.value * Math.sin(px * 2 * Math.PI);
    const y = a.value * BurnInDrift.yRatio * Math.sin(py * 2 * Math.PI);
    this.offset = { x, y };
    s.delta.raw[CENTER_X] += Units.poseX(x);
    s.delta.raw[CENTER_Y] += Units.poseY(y);
  }
}
