// Port of FaceEngine/Modifiers/Brightness.swift.
import type { FaceState } from '../FaceState';
import { LidMath } from '../LidMath';
import { Phase, type Modifier } from '../Modifier';
import { AgentStateBehavior } from './AgentStateBehavior';

/// Single owner of base brightness (Part D M4). Smooths toward `targetBrightness` with an exact exponential (τ ≈ 1.5 s)
/// and multiplies it into `brightness`. Within `AgentStateBehavior.fastWakeWindow` of a startled wake it brightens
/// with τ = `fastWakeTau`. The smoothed level alone also goes to `s.baseBrightness` (the mood background dims by it).
///
/// OLED care: idle (or drowsy) with nobody in view for `powerCare.idleDimDelay` seconds lowers the target to at most
/// `powerCare.idleDimLevel`. `powerCare.brightnessScale` is the governor's ceiling. A launch (`fadingInFromBlack`)
/// starts the smoothed level at 0 and rises on `startupTau`.
export class Brightness implements Modifier {
  readonly name = 'Brightness';
  readonly phase = Phase.output;
  isEnabled = true;

  static readonly tau = 1.5;
  static readonly fastWakeTau = 0.3;
  static readonly idleDimDelay = 20;
  static readonly idleDimLevel = 0.6;
  /// Launch fade (`FaceEngine.fadeInFromBlack`): the first frame starts at 0 and rises on this τ.
  static readonly startupTau = 0.4;

  private smoothed: number | null = null;
  /// Engine time since which the face has been idle with nobody in view.
  private emptySince: number | null = null;

  /// Current smoothed base brightness.
  get level(): number { return this.smoothed ?? 0; }

  update(s: FaceState): void {
    const raw = s.targetBrightness;
    let target = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0.85;
    const care = s.powerCare;
    if ((s.agentState === 'idle' || s.agentState === 'drowsy') && s.people.length === 0) {
      const since = this.emptySince ?? s.time;
      this.emptySince = since;
      if (s.time - since >= care.idleDimDelay) target = Math.min(target, care.idleDimLevel);
    } else {
      this.emptySince = null;
    }
    if (care.brightnessScale < 1) target *= care.brightnessScale;
    // The launch fade starts from black on the first frame and rises on the startup τ until it arrives.
    let b = this.smoothed ?? (s.fadingInFromBlack ? 0 : target);
    const fast = s.time - s.fastWakeAt < AgentStateBehavior.fastWakeWindow && target > b;
    const tau = s.fadingInFromBlack ? Brightness.startupTau : (fast ? Brightness.fastWakeTau : Brightness.tau);
    b += (target - b) * LidMath.expAlpha(s.dt, tau);
    if (!Number.isFinite(b)) b = target;
    if (s.fadingInFromBlack && b >= target - 0.01) s.fadingInFromBlack = false;
    this.smoothed = b;
    s.baseBrightness = b;
    s.brightness *= b;
  }
}
