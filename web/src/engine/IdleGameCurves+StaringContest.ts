// Port of FaceEngine/IdleGameCurves+StaringContest.swift.
//
// Staring contest (idle game 6). The pupils slide inward until the eyes glare at each other, the eyes lean in a touch,
// and the lids narrow to determined slits under furrowed brows. The hold: the lids tremble, faintly at first and more
// as the strain builds; the loser (the right eye, or the left when `p.side` < 0) twice nearly blinks, catching itself
// each time with its brow shooting up to prop the lid open. Then it blinks (a flustered blink-blink, brow up: "oops").
// The winner settles into a smug half-lid squint with a cocky brow and a little head tilt, still staring, while the
// loser looks away, down and to the side, sheepish. Everything eases home.
//
// Gentle on purpose (one of the two games Reduce Motion allows): every move is a glide or a well-damped spring, the
// pupils never dart, and the tremble lives in the lids.
// Module-level code uses plain math only (see IdleGameCurves.ts).
import { v2 } from '../core/vec';
import { ParamLayout, type Side } from '../model';
import { makeGazeOverride } from './Commands';
import { addLids, blinkPulse, brow, glide, hump, setEyeStage, springStep, window } from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { setEyeScale } from './IdleGameCurves';
import type { OneShotParams } from './OneShots';

const duration = 6.4;
const blink = 3.85;
const smug = blink + 0.22;

export const StaringContest = {
  duration,
  /// Glare set by ~0.9 s; the near-blinks; the blink; the smug squint (the accent, where the voice lands).
  narrow: 0.35,
  nearBlinks: [2.35, 3.15] as readonly number[],
  blink,
  smug,
  lookAway: blink + 0.36,
  release: duration - 0.75,
  accents: [smug] as readonly number[],
  /// Pupils inward (pupil travel), slit lids, the tremble's coverage at the start and at the peak of the strain.
  inward: 0.95,
  slitUpper: 0.36, slitLower: 0.24,
  /// Determined slant of the upper lids (degrees, inner end down); the smug half lid and the sheepish lids.
  slant: 9,
  smugUpper: 0.46, smugLower: 0.2,
  shyUpper: 0.24, shyLower: 0.1,
  trembleStart: 0.012, tremblePeak: 0.032,
};

const inward = (e: Side): number => (e === 'left' ? 1 : -1);

export function staringContest(t: number, p: OneShotParams, o: OneShotOutput): void {
  const S = StaringContest;
  const k = p.edge.intensity;
  const loser: Side = p.side > 0 ? 'right' : 'left';
  const winner: Side = p.side > 0 ? 'left' : 'right';
  const end = S.duration;

  // The gaze holds straight ahead (smooth); the per-eye pupil lanes do the glaring.
  if (t < end - 0.4) o.gaze = makeGazeOverride(v2(0, 0), 'smooth');

  const glare = glide(t, 0.08, 0.5) * (1 - glide(t, S.release, 0.6));
  const slit = springStep(t - S.narrow, 9, 0.85) * (1 - glide(t, S.release, 0.6));
  // The strain builds over the hold; the tremble rides on it and stops at the blink.
  const strain = glide(t, 1.0, S.blink - 1.0) * (1 - glide(t, S.blink - 0.05, 0.1));
  const after = glide(t, S.blink + 0.1, 0.25) * (1 - glide(t, S.release, 0.6)); // the outcome, smug and sheepish

  for (const e of ParamLayout.Side.allCases) {
    const isLoser = e === loser;
    const dIn = inward(e);
    const ph = p.v2 * 6.283 + (isLoser ? 1.7 : 0);
    // Pupils: inward (the loser's leave, sliding away and down, after the blink).
    const away = isLoser ? glide(t, S.lookAway, 0.45) * (1 - glide(t, S.release, 0.6)) : 0;
    o.delta.setEye(e, 'x', dIn * S.inward * glare * (1 - away) - dIn * 0.7 * away);
    o.delta.setEye(e, 'y', 0.38 * away);
    // The eyes lean in a touch (turned toward each other); the loser leans away after it gives up.
    const lean = glare * (1 - away);
    setEyeStage(o, e, v2(dIn * 1.6 * k * lean - dIn * 1.8 * k * away, 0.8 * k * away));
    setEyeScale(o, e, v2(1 - 0.05 * k * lean, 1));
    o.delta.setEye(e, 'angle', 3 * k * lean - 3 * k * away); // + tilts the top inward on both eyes (mirrored lane)

    // Lids: slits, a tremble (two incommensurate sines, small), the near-blinks, the blink, the outcome.
    const amp = S.trembleStart * slit + (S.tremblePeak - S.trembleStart) * strain * (isLoser ? 1.3 : 0.8);
    const tremble = amp * (0.6 * Math.sin(2 * Math.PI * 7.3 * t + ph) + 0.4 * Math.sin(2 * Math.PI * 11.1 * t + 2.3 * ph));
    // The outcome replaces the slit: smug half lid for the winner, soft sheepish lids for the loser.
    const u1 = isLoser ? S.shyUpper : S.smugUpper, l1 = isLoser ? S.shyLower : S.smugLower;
    const out = isLoser ? after : springStep(t - S.smug, 11, 0.7) * (1 - glide(t, S.release, 0.6));
    let upper = (S.slitUpper * slit) * (1 - out) + u1 * out + tremble;
    const lower = (S.slitLower * slit) * (1 - out) + l1 * out + 0.5 * tremble;
    // Upper lids slant inward-down while glaring (left lane: negative = inner end lower), level for the
    // smug half lid, inner end up for the sheepish loser.
    const slant = S.slant * slit * (1 - out) - (isLoser ? 4 * out : 0);
    o.delta.setEye(e, 'upperLidAngle', e === 'left' ? -slant : slant);
    let browY = -0.05 * slit, browInner = -0.12 * slit, browCurve = 0;
    let sy = 1;
    if (isLoser) {
      // Nearly blinks: the lid sags, and the brow shoots up to haul it back open (a little too wide).
      for (let i = 0; i < S.nearBlinks.length; i++) {
        const nb = S.nearBlinks[i];
        const depth = i === 0 ? 0.13 : 0.2;
        upper += depth * hump(t, nb, 0.3) - 0.12 * window(t, nb + 0.12, nb + 0.2, nb + 0.4, nb + 0.7);
        browY += 0.1 * window(t, nb + 0.06, nb + 0.14, nb + 0.35, nb + 0.75);
        browInner += 0.06 * window(t, nb + 0.06, nb + 0.14, nb + 0.35, nb + 0.75);
      }
      // The blink: blink-blink, flustered, with an "oops" brow.
      // Lid coverage is rate-limited, so the lids close over 0.12 s; the eye squash makes it read fast.
      const b = Math.max(blinkPulse(t, S.blink, 0.12, 0.04, 0.16),
        0.8 * blinkPulse(t, S.blink + 0.4, 0.1, 0.02, 0.14));
      upper += (1 - upper) * b;
      sy *= 1 - 0.65 * b;
      const oops = window(t, S.blink, S.blink + 0.12, S.lookAway + 0.2, S.lookAway + 0.6);
      // Sheepish: inner brow up.
      browY += 0.1 * oops - 0.03 * after;
      browInner += 0.12 * slit * after + 0.12 * after + 0.06 * oops;
    } else {
      // Smug: a cocky brow (outer end up, inner down) over the half lid.
      const smug = out;
      browInner += 0.12 * slit * smug - 0.04 * smug;
      browY += 0.05 * smug;
      browCurve += 0.12 * smug;
    }
    addLids(o, e, upper, lower);
    setEyeScale(o, e, v2(1, sy));
    brow(o, e, { y: browY, curvature: browCurve, inner: browInner });
  }
  // Lean in a hair while staring; the winner's little head tilt toward itself at the smug moment.
  o.faceScaleMul = v2(1 + 0.025 * k * glare * (1 - after));
  const tilt = springStep(t - S.smug, 8, 0.75) * (1 - glide(t, S.release, 0.6));
  o.delta.setFace('angle', inward(winner) * -3 * k * tilt);
  o.pupilSizeMul = v2(1 - 0.08 * slit * (1 - after));
}
