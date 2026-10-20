// Port of FaceEngine/AnswerCurves.swift: only the accent table and the reduce-motion constant so far (the spec table
// in OneShots.ts needs them).
// TODO(WP6): rest of AnswerCurves.swift — answerMotion, yaw, pupils, the Tracks and the four curves below. Keep
// module-level code free of OneShots.ts exports (the two modules import each other; use them only inside functions).
import type { OneShotOutput } from './FaceState';
import type { OneShotParams } from './OneShots';

/// Accent offsets (base seconds) of the four answers, measured from the curves. The voice lands its chirps here.
export const AnswerAccents = {
  nodYes: [0.19, 0.46] as readonly number[],
  nodYesBig: [0.22, 0.47, 0.71, 0.875] as readonly number[],
  shakeNo: [0.205, 0.435, 0.64] as readonly number[],
  shakeNoBig: [0.195, 0.42, 0.645, 0.90] as readonly number[],
} as const;

/// Reduce Motion keeps this fraction of the answers' movement (head travel, tilt, turn, pupil lead).
export const answerReducedMotion = 0.4;

const todo = (name: string): never => { throw new Error(`TODO(WP6): AnswerCurves.${name} is not ported yet`); };

export function nodYes(_t: number, _p: OneShotParams, _o: OneShotOutput): void { todo('nodYes'); }
export function nodYesBig(_t: number, _p: OneShotParams, _o: OneShotOutput): void { todo('nodYesBig'); }
export function shakeNo(_t: number, _p: OneShotParams, _o: OneShotOutput): void { todo('shakeNo'); }
export function shakeNoBig(_t: number, _p: OneShotParams, _o: OneShotOutput): void { todo('shakeNoBig'); }
