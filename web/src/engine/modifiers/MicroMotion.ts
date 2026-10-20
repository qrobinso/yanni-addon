// Port of FaceEngine/Modifiers/MicroMotion.swift.
import type { V2 } from '../../core/vec';
import { ParamLayout, Units } from '../../model';
import type { FaceState } from '../FaceState';
import { GazeClock, GazeLoopNoise, gazeLength } from '../GazeSupport';
import { Phase, type Modifier } from '../Modifier';
import { Spring2, SpringParams } from '../Spring';

const K = {
  headAmp: { x: 0.35, y: 0.30 },
  pupilCommonAmp: { x: 0.04, y: 0.04 },
  pupilOwnAmp: { x: 0.01, y: 0.01 },
  microMax: 0.08,
  microAmp: [0.025, 0.08] as const,
  microKeep: 0.35,
  microMedian: 1.1,
  microSigma: 0.4,
  microInterval: [0.6, 2.0] as const,
  microRetry: 0.25,
  microSpring: new SpringParams(80, 0.68),
  pursuitSuppress: 0.4, // gaze units/s
} as const;

const I = {
  cx: ParamLayout.index('centerX'), cy: ParamLayout.index('centerY'),
  lx: ParamLayout.index('left', 'x'), ly: ParamLayout.index('left', 'y'),
  rx: ParamLayout.index('right', 'x'), ry: ParamLayout.index('right', 'y'),
};

/// Keeps the face from ever being perfectly still: sub-perceptual head drift, fixational pupil drift (a shared
/// component plus a small per-eye one), and micro-saccades while fixating (every 0.6–2 s, a quick ≤ 0.08 conjugate
/// hop through an underdamped spring), deferred during big saccades and fast pursuit.
export class MicroMotion implements Modifier {
  readonly name = 'MicroMotion';
  readonly phase = Phase.attention;
  isEnabled = true;

  static readonly K = K;

  // Noise channels (lattice units/s chosen incommensurate so nothing visibly repeats).
  private headX = new GazeLoopNoise(0xA11CE, 0.23);
  private headY = new GazeLoopNoise(0xB0B, 0.19, 37.5);
  private eyeX = new GazeLoopNoise(0xC0FFEE, 0.37, 101.25);
  private eyeY = new GazeLoopNoise(0xD00D, 0.31, 211.5);
  private leftX = new GazeLoopNoise(0xE1, 0.61, 307.75);
  private leftY = new GazeLoopNoise(0xE2, 0.53, 401.125);
  private rightX = new GazeLoopNoise(0xE3, 0.57, 503.5);
  private rightY = new GazeLoopNoise(0xE4, 0.66, 607.25);

  private micro = new Spring2({ x: 0, y: 0 });
  private microTarget: V2 = { x: 0, y: 0 };
  private nextMicroAt = 0;
  private started = false;

  /// Current micro-saccade target / offset (normalised pupil units), for tests and the preview tool.
  get debugMicroTarget(): V2 { return this.microTarget; }
  get debugMicroValue(): V2 { return this.micro.value; }

  update(s: FaceState): void {
    const now = s.time, dt = s.dt;
    if (!this.started) {
      this.started = true;
      this.nextMicroAt = GazeClock.at(now - dt, s.rng.uniform(K.microInterval[0], K.microInterval[1]));
    }

    this.headX.advance(dt); this.headY.advance(dt);
    this.eyeX.advance(dt); this.eyeY.advance(dt);
    this.leftX.advance(dt); this.leftY.advance(dt);
    this.rightX.advance(dt); this.rightY.advance(dt);

    // Step first: a micro-saccade chosen this frame applies from `now` (frame-rate independent).
    this.micro.step(this.microTarget, K.microSpring, dt);

    if (GazeClock.due(now, this.nextMicroAt)) {
      if (s.isSaccading || gazeLength(s.gazeTarget.velocity) > K.pursuitSuppress) {
        this.nextMicroAt = GazeClock.at(now, K.microRetry);
      } else {
        const amp = s.rng.uniform(K.microAmp[0], K.microAmp[1]);
        const angle = s.rng.uniform(0, 2 * Math.PI);
        let t = { x: this.microTarget.x * K.microKeep + Math.cos(angle) * amp, y: this.microTarget.y * K.microKeep + Math.sin(angle) * amp };
        const len = gazeLength(t);
        if (len > K.microMax) t = { x: t.x * (K.microMax / len), y: t.y * (K.microMax / len) };
        this.microTarget = t;
        this.nextMicroAt = GazeClock.at(now, s.rng.lognormal(K.microMedian, K.microSigma, K.microInterval));
      }
    }

    const mv = this.micro.value;
    const cx = this.eyeX.sample() * K.pupilCommonAmp.x + mv.x;
    const cy = this.eyeY.sample() * K.pupilCommonAmp.y + mv.y;
    const d = s.delta.raw;
    d[I.cx] += Units.poseX(this.headX.sample() * K.headAmp.x);
    d[I.cy] += Units.poseY(this.headY.sample() * K.headAmp.y);
    d[I.lx] += cx + this.leftX.sample() * K.pupilOwnAmp.x;
    d[I.ly] += cy + this.leftY.sample() * K.pupilOwnAmp.y;
    d[I.rx] += cx + this.rightX.sample() * K.pupilOwnAmp.x;
    d[I.ry] += cy + this.rightY.sample() * K.pupilOwnAmp.y;
  }
}
