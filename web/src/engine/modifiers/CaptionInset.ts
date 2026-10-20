// Port of FaceEngine/Modifiers/CaptionInset.swift.
import { FaceFrame } from '../../model';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { Spring1, SpringParams } from '../Spring';

/// The caption band's spring (caption bubbles design §5): `s.captionInsetTarget` → `s.captionInset`, which the
/// renderer's viewport fits the face around. In: a lively spring (≈ 0.35 s, ≈ 3 % overshoot). Out: critically damped,
/// ≈ 0.5 s. Reduce Motion: critically damped and a little slower both ways. Snapped to exactly 0 once negligible.
export class CaptionInset implements Modifier {
  readonly name = 'CaptionInset';
  readonly phase = Phase.output;
  isEnabled = true;

  /// The band the caption model asks for while a bubble shows: the bottom 30 % of the screen.
  static readonly band = 0.3;
  static readonly rise = new SpringParams(13.6, 0.75);
  static readonly fall = new SpringParams(9.5, 1);
  static readonly riseReduced = new SpringParams(9, 1);
  static readonly fallReduced = new SpringParams(7.5, 1);

  private spring = new Spring1(0);

  update(s: FaceState): void {
    const max = FaceFrame.maxCaptionInset;
    const target = Number.isFinite(s.captionInsetTarget) ? Math.min(Math.max(s.captionInsetTarget, 0), max) : 0;
    if (this.spring.value === target && this.spring.velocity === 0) { s.captionInset = target; return; }
    const up = target > this.spring.value;
    const rm = s.captionInsetReduceMotion;
    this.spring.step(target, rm ? (up ? CaptionInset.riseReduced : CaptionInset.fallReduced) : (up ? CaptionInset.rise : CaptionInset.fall), Math.max(s.dt, 0));
    if (!Number.isFinite(this.spring.value) || !Number.isFinite(this.spring.velocity)) this.spring = new Spring1(target);
    if (Math.abs(this.spring.value - target) < 1e-4 && Math.abs(this.spring.velocity) < 1e-3) this.spring = new Spring1(target);
    this.spring.value = Math.min(Math.max(this.spring.value, 0), max);
    s.captionInset = this.spring.value;
  }
}
