// Port of FaceEngine/Modifiers/SquashStretch.swift.
import { Units } from '../../model';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { Spring1, SpringParams } from '../Spring';

/// Motion-driven squash and stretch (Part D M5, C1a.4).
///
/// Uses the face's vertical velocity between the last two composed frames (canvas units/s; pose centre_y plus the
/// vertical stage offset): `s = 1 + min(gain·|v|, max)`, `sy *= s`, `sx /= √s` (volume-preserving), through a lightly
/// underdamped spring. While a blink is happening the target relaxes to 1 (blinks have their own squash).
export class SquashStretch implements Modifier {
  readonly name = 'SquashStretch';
  readonly phase = Phase.motion;
  isEnabled = true;

  /// Stretch per canvas unit/s of vertical face velocity.
  static readonly gain = 0.004;
  static readonly maxStretch = 0.12;
  static readonly smoothing = new SpringParams(30, 0.65);
  /// Treat the blink as active this long after it starts (Blink runs after us in the lids phase).
  static readonly blinkExclusion = 0.35;

  private lastOutputY: number | null = null;
  /// Frames seen. The first update sees the engine's initial (uncomposed) output.
  private updates = 0;
  private lastDt = 0;
  private stretch = new Spring1(1);

  /// Current stretch factor (≥ ~1).
  get value(): number { return this.stretch.value; }

  update(s: FaceState): void {
    // s.output is the previous frame's composed output; lastOutputY the one before it.
    const out = s.output;
    const y = Units.canvasY(out.pose.face('centerY')) + out.stageOffset.y + 0.5 * (out.eyeStageOffset.y + out.eyeStageOffset.w);
    let target = 1;
    this.updates += 1;
    const prev = this.lastOutputY;
    if (this.updates > 2 && prev !== null && this.lastDt > 1e-5 && Number.isFinite(y) && Number.isFinite(prev)) {
      const v = (y - prev) / this.lastDt;
      // Reduce Motion halves the elasticity (after the clamp, so it always halves).
      const el = Math.min(Math.max(s.elasticity, 0.5), 2) * s.motionScale;
      target = 1 + Math.min(SquashStretch.gain * el * Math.abs(v), SquashStretch.maxStretch * el);
    }
    this.lastOutputY = y;
    this.lastDt = s.dt;

    const blinking = s.blink > 0 || s.time - s.lastBlinkTime < SquashStretch.blinkExclusion;
    if (blinking) target = 1;

    this.stretch.step(target, SquashStretch.smoothing, s.dt);
    if (!Number.isFinite(this.stretch.value)) this.stretch = new Spring1(1);
    const k = Math.min(Math.max(this.stretch.value, 0.9), 1 + SquashStretch.maxStretch * 2.5);
    s.faceScaleMul.y *= k;
    s.faceScaleMul.x /= Math.sqrt(k);
  }
}
