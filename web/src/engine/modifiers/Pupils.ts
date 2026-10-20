// Port of FaceEngine/Modifiers/Pupils.swift.
import type { Mood } from '../AgentState';
import { Ease } from '../Easing';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { Spring1, SpringParams } from '../Spring';

const K = {
  pleasureGain: 0.18,
  arousalGain: 0.10,
  threatGain: 0.6,
  constrict: new SpringParams(14, 1),
  dilate: new SpringParams(4, 1),
} as const;

/// Pupil dilation from mood (sclera/pupil design §4). Attention phase, after GazeTracking.
///
/// `mul = exp(0.18·P⁺ + 0.10·A⁺·smoothstep(0, 0.1, D) − 0.6·threat)`, `threat = smoothstep(0.4, 0.9, A)·smoothstep(0, 0.6, −D)`.
/// The multiplier follows a critically damped spring, fast constricting (ω 14) and slow dilating (ω 4), and is
/// multiplied into `s.pupilSizeMul` (Composer clamps the product to 0.65…1.25).
export class Pupils implements Modifier {
  readonly name = 'Pupils';
  readonly phase = Phase.attention;
  isEnabled = true;

  static readonly K = K;

  private spring: Spring1 | null = null;
  /// Last frame's target: the spring steps toward it, and this frame's applies from `now` (fps-independent).
  private lastTarget = 1;

  /// Current smoothed dilation multiplier.
  get level(): number { return this.spring?.value ?? 1; }

  /// Target multiplier for a mood.
  static target(m: Mood): number {
    const p = Number.isFinite(m.pleasure) ? Math.min(Math.max(m.pleasure, -1), 1) : 0;
    const a = Number.isFinite(m.arousal) ? Math.min(Math.max(m.arousal, -1), 1) : 0;
    const d = Number.isFinite(m.dominance) ? Math.min(Math.max(m.dominance, -1), 1) : 0;
    const threat = Ease.smoothstep((a - 0.4) / 0.5) * Ease.smoothstep(-d / 0.6);
    const e = K.pleasureGain * Math.max(p, 0) + K.arousalGain * Math.max(a, 0) * Ease.smoothstep(d / 0.1) - K.threatGain * threat;
    return Math.exp(e);
  }

  update(s: FaceState): void {
    const t = Pupils.target(s.mood);
    let sp: Spring1;
    if (this.spring !== null) {
      sp = this.spring;
      sp.step(this.lastTarget, this.lastTarget < sp.value ? K.constrict : K.dilate, s.dt);
    } else {
      sp = new Spring1(t);
    }
    if (!(Number.isFinite(sp.value) && Number.isFinite(sp.velocity))) sp = new Spring1(t);
    this.spring = sp;
    this.lastTarget = t;
    s.pupilSizeMul = { x: s.pupilSizeMul.x * sp.value, y: s.pupilSizeMul.y * sp.value };
  }
}
