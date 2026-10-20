// Port of FaceEngine/Modifiers/Breathing.swift.
import { ParamLayout, Units } from '../../model';
import type { FaceState } from '../FaceState';
import { LidMath, LidNoise } from '../LidMath';
import { Phase, type Modifier } from '../Modifier';

const CENTER_Y = ParamLayout.index('centerY');

/// Slow breathing of the whole face (design C6, Part D H6/H7).
///
/// A smoothed, slightly asymmetric sine (quicker in-breath) whose period is integrated as φ += dt / T(t), so slow
/// noise modulation of the period (±15 %) never makes the phase jump. Period ≈ 4.5 s awake, ≈ 7 s asleep, blended
/// smoothly. Amplitude × `breathingDepth` (smoothed), with slow noise on top. Face scale_y ±1.2 %, centre_y ±0.8
/// canvas units; when asleep also a ±15 % brightness pulse.
export class Breathing implements Modifier {
  readonly name = 'Breathing';
  readonly phase = Phase.motion;
  isEnabled = true;

  static readonly awakePeriod = 4.5;
  static readonly asleepPeriod = 7;
  static readonly periodModulation = 0.15;
  static readonly periodNoiseRate = 0.045;
  static readonly amplitudeModulation = 0.2;
  static readonly amplitudeNoiseRate = 0.06;
  /// Face scale_y amplitude (fraction).
  static readonly scaleAmplitude = 0.012;
  /// Face centre_y amplitude in canvas units (inhale = up).
  static readonly centerAmplitude = 0.8;
  /// Brightness pulse amplitude while asleep.
  static readonly asleepBrightnessPulse = 0.15;
  /// Time constant for asleep/awake blending and depth changes.
  static readonly blendTau = 1.5;
  /// Inhale/exhale asymmetry of the wave.
  static readonly asymmetry = 0.3;

  /// Breath phase 0..<1.
  breathPhase = 0;
  /// Current wave value −1...1.
  wave = 0;
  private asleepWeight: number | null = null;
  private depth: number | null = null;
  private readonly periodNoise = new LidNoise(0xb2ea0001);
  private readonly ampNoise = new LidNoise(0xb2ea0002);

  update(s: FaceState): void {
    const dt = s.dt;
    const asleepTarget = s.agentState === 'asleep' ? 1 : 0;
    const depthTarget = Number.isFinite(s.breathingDepth) ? Math.max(s.breathingDepth, 0) : 1;
    const alpha = LidMath.expAlpha(dt, Breathing.blendTau);
    let w = this.asleepWeight ?? asleepTarget;
    w += (asleepTarget - w) * alpha;
    this.asleepWeight = w;
    let d = this.depth ?? depthTarget;
    d += (depthTarget - d) * alpha;
    this.depth = d;

    const t = s.time;
    const basePeriod = LidMath.mix(Breathing.awakePeriod, Breathing.asleepPeriod, w);
    const period = basePeriod * (1 + Breathing.periodModulation * this.periodNoise.at(t, Breathing.periodNoiseRate));
    this.breathPhase = LidMath.wrap01(this.breathPhase + dt / Math.max(period, 0.5));

    const theta = this.breathPhase * 2 * Math.PI;
    const v = Math.sin(theta + Breathing.asymmetry * Math.sin(theta));
    this.wave = v;
    const amp = d * (1 + Breathing.amplitudeModulation * this.ampNoise.at(t, Breathing.amplitudeNoiseRate));

    s.faceScaleMul.y *= 1 + Breathing.scaleAmplitude * amp * v;
    s.delta.raw[CENTER_Y] += Units.poseY(-Breathing.centerAmplitude * amp * v);
    s.brightness *= 1 + Breathing.asleepBrightnessPulse * w * v;
  }
}
