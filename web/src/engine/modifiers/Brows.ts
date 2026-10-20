// Port of FaceEngine/Modifiers/Brows.swift.
import { v2, type V2, type V4 } from '../../core/vec';
import { Canvas, FacePose, Units, type Side } from '../../model';
import type { FaceState } from '../FaceState';
import { Phase, type Modifier } from '../Modifier';
import { Spring1, Spring2, SpringParams } from '../Spring';

const scratch = new FacePose();
const finite = (v: number, d: number): number => (Number.isFinite(v) ? v : d);

/// Output phase: the eyebrows' secondary motion (eyebrows design §4).
///
/// - **Follow-through.** A bouncy spring chases each brow's anchor (its eye's top, in canvas units) and the brow is
///   drawn `followGain` × the lag behind it (clamped). Fast scale modulation reaches the brows only at
///   `modulationWeight` and through the spring. Blinks never move the anchor.
/// - **Drowsy relaxation.** Lid heaviness lowers the brows a little, drops their outer ends and flattens the arch.
///
/// All amplitudes scale with `s.browIntensity` (0 = static brows). Exact closed-form springs.
export class Brows implements Modifier {
  readonly name = 'Brows';
  readonly phase = Phase.output;
  isEnabled = true;

  static readonly followSpring = new SpringParams(14, 0.42);
  static readonly followGain = 0.5;
  static readonly maxFollow: V2 = v2(2, 3);
  static readonly modulationWeight = 0.5;
  /// An anchor jump larger than this (canvas units) re-seats the spring.
  static readonly teleport = 40;
  static readonly nominalEyeScale = 1.18;
  static readonly nominalSpacing = 0.85;
  static readonly relaxY = -0.035;
  static readonly relaxOuter = -0.05;
  static readonly relaxCurvature = -0.1;
  static readonly relaxRotation = -2;
  static readonly relaxHeaviness = 0.35;
  static readonly relaxSpring = new SpringParams(4, 1);

  private follow = [new Spring2(v2(0)), new Spring2(v2(0))];
  private seeded = false;
  private relax = new Spring1(0);

  /// Current follow-through (canvas units, left xy, right xy) and relaxation 0…1.
  followThrough: V4 = { x: 0, y: 0, z: 0, w: 0 };
  relaxation = 0;

  /// Anchor of one brow in canvas units relative to the face's rest centre, with and without the frame's
  /// multiplicative scale modulation.
  static anchors(s: FaceState, side: Side): { rigid: V2; all: V2 } {
    const pose = scratch.copyFrom(s.basePose).addInPlace(s.delta);
    const fsx = finite(pose.face('scaleX'), 1), fsy = finite(pose.face('scaleY'), 1);
    const fmx = finite(s.faceScaleMul.x, 1), fmy = finite(s.faceScaleMul.y, 1);
    const emy = finite(side === 'left' ? s.eyeScaleMul.y : s.eyeScaleMul.w, 1);
    const sign = side === 'left' ? -1 : 1;
    const relX = sign * Canvas.eyeSpacing * Brows.nominalSpacing + Units.canvasX(finite(pose.eye(side, 'centerX'), 0));
    const relY = Units.canvasY(finite(pose.eye(side, 'centerY'), 0));
    const faceX = Units.canvasX(finite(pose.face('centerX'), 0)), faceY = Units.canvasY(finite(pose.face('centerY'), 0));
    const stX = s.stageOffset.x + (side === 'left' ? s.eyeStageOffset.x : s.eyeStageOffset.z);
    const stY = s.stageOffset.y + (side === 'left' ? s.eyeStageOffset.y : s.eyeStageOffset.w);
    const half = 0.5 * Canvas.eyeHeight * Brows.nominalEyeScale * finite(pose.eye(side, 'scaleY'), 1);
    const anchor = (mx: number, my: number, ey: number): V2 => {
      const cx = faceX + relX * (fsx * mx) + stX;
      const cy = faceY + relY * (fsy * my) + stY;
      return { x: cx, y: cy - half * fsy * my * ey };
    };
    const rigid = anchor(1, 1, 1), all = anchor(fmx, fmy, emy);
    const ok = Number.isFinite(rigid.x) && Number.isFinite(rigid.y) && Number.isFinite(all.x) && Number.isFinite(all.y);
    return ok ? { rigid, all } : { rigid: v2(0), all: v2(0) };
  }

  update(s: FaceState): void {
    const bi = Number.isFinite(s.browIntensity) ? Math.min(Math.max(s.browIntensity, 0), 2) : 1;
    const dt = Math.max(s.dt, 0);
    const mf = Brows.maxFollow;

    // Follow-through.
    const out = [0, 0, 0, 0];
    for (let i = 0; i < 2; i++) {
      const a = Brows.anchors(s, i === 0 ? 'left' : 'right');
      const w = Brows.modulationWeight;
      const target = { x: a.rigid.x + w * (a.all.x - a.rigid.x), y: a.rigid.y + w * (a.all.y - a.rigid.y) };
      const f = this.follow[i];
      const jx = f.value.x - target.x, jy = f.value.y - target.y;
      if (!this.seeded || jx * jx + jy * jy > Brows.teleport * Brows.teleport
        || !Number.isFinite(f.value.x) || !Number.isFinite(f.velocity.x)) {
        this.follow[i] = new Spring2(target);
      } else {
        f.step(target, Brows.followSpring, dt);
      }
      const fv = this.follow[i].value;
      // Swift pointwiseMin(pointwiseMax(lag, -max), max).
      const lx = Math.min(Math.max((fv.x - target.x) * Brows.followGain, -mf.x), mf.x);
      const ly = Math.min(Math.max((fv.y - target.y) * Brows.followGain, -mf.y), mf.y);
      out[2 * i] = (lx + (target.x - a.all.x)) * bi;
      out[2 * i + 1] = (ly + (target.y - a.all.y)) * bi;
    }
    this.seeded = true;
    this.followThrough = { x: out[0], y: out[1], z: out[2], w: out[3] };
    const bo = s.browOffset;
    s.browOffset = { x: bo.x + out[0], y: bo.y + out[1], z: bo.z + out[2], w: bo.w + out[3] };

    // Drowsy relaxation.
    const h = s.modulation.lidHeaviness;
    const k = Number.isFinite(h) ? Math.min(Math.max(h / Brows.relaxHeaviness, 0), 1) : 0;
    this.relax.step(k, Brows.relaxSpring, dt);
    const r = Math.min(Math.max(this.relax.value, 0), 1) * bi;
    this.relaxation = r;
    if (r > 1e-4) {
      s.browDelta.addBoth('y', Brows.relaxY * r);
      s.browDelta.addBoth('outer', Brows.relaxOuter * r);
      s.browDelta.addBoth('curvature', Brows.relaxCurvature * r);
      s.browDelta.addBoth('rotation', Brows.relaxRotation * r);
    }
  }
}
