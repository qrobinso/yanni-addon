// Port of FaceEngine/EdgeAnticCurves.swift: only EdgeAnticContext and EdgeAnticParams so far (OneShotSampler and
// OneShotParams need them).
// TODO(WP6): rest of EdgeAnticCurves.swift — the tuning constants, edgeSpec, the reference table (build it lazily: the
// spec table calls edgeSpec on first use), the spring/glide primitives, makeEdgeParams and the five curves. Keep
// module-level code free of OneShots.ts exports (the two modules import each other; use them only inside functions).
import type { V2 } from '../core/vec';
import type { EdgeGeometry } from '../model';
import type { OneShotKind } from './Commands';
import { EdgeAnticSettings } from './EdgeAnticSettings';
import type { OneShotOutput } from './FaceState';
import { IdleGameSettings } from './IdleGameSettings';
import type { OneShotParams, OneShotSpec } from './OneShots';
import type { OneShotChannels } from './OneShots';
import type { SplitMix64 } from '../core/random';

/// What an edge antic needs at trigger time (OneShotSampler fills it from `FaceState`).
export class EdgeAnticContext {
  /// The screen; null uses `EdgeGeometry.reference`.
  geometry: EdgeGeometry | null;
  settings: EdgeAnticSettings;
  /// +1 right, −1 left, 0 random.
  sideHint: number;
  /// The face's current centre offset from rest (canvas units, from last frame's pose).
  faceOffset: V2;
  /// Neutral trigger (no jitter, side +1, mid holds): nominal timings and accent times.
  neutral: boolean;
  /// Idle game tunables for a game trigger (the sampler copies `FaceState.idleGameSettings`).
  gameSettings = new IdleGameSettings();
  /// The primary person's screen-relative gaze point at a game trigger, null when no one is in frame.
  person: V2 | null = null;

  constructor(o: { geometry?: EdgeGeometry | null; settings?: EdgeAnticSettings; sideHint?: number; faceOffset?: V2;
    neutral?: boolean } = {}) {
    this.geometry = o.geometry ?? null;
    this.settings = o.settings ?? new EdgeAnticSettings();
    this.sideHint = o.sideHint ?? 0;
    this.faceOffset = o.faceOffset ? { ...o.faceOffset } : { x: 0, y: 0 };
    this.neutral = o.neutral ?? false;
  }
}

/// One edge antic trigger's timeline and travel, in base seconds and canvas units. Resolved once at trigger from the
/// screen geometry and settings. The meaning of the travel fields depends on the antic (see each curve).
export class EdgeAnticParams {
  /// Base duration; 0 = not an edge antic trigger.
  baseDuration = 0;
  /// The accent the voice lands on (base seconds).
  accent = 0;
  /// Return keyframe: the end of the hidden / held segment, where the face starts coming back.
  returnAt = 0;
  /// Squash / stretch / tilt / overshoot multiplier.
  intensity = 1;
  /// Main travel magnitudes (canvas units, ≥ 0, measured toward the side edge or down).
  hide = 0;
  near = 0;
  far = 0;
  /// Eye-shape lead (canvas units): the eye centres move this much before the face follows.
  lead = 0;
  /// Spring frequencies of the big moves, lowered per trigger so stage speed stays under the bound.
  omega1 = 0;
  omega2 = 0;
  omega3 = 0;
  /// Damping of the pop-up's spring up.
  zeta = 0;
  /// Timeline marks (base seconds).
  t1 = 0;
  t2 = 0;
  t3 = 0;
  t4 = 0;
  /// Delay before a peeking eye becomes visible again (base seconds).
  reveal = 0;

  copy(): EdgeAnticParams { return Object.assign(new EdgeAnticParams(), this); }
  equals(o: EdgeAnticParams): boolean {
    return (Object.keys(this) as (keyof EdgeAnticParams)[]).every((k) => this[k] === o[k]);
  }
}

const todo = (name: string): never => { throw new Error(`TODO(WP6): EdgeAnticCurves.${name} is not ported yet`); };

export function edgeSpec(_kind: OneShotKind, _channels: OneShotChannels, _priority: number): OneShotSpec { return todo('edgeSpec'); }
export function referenceParams(_kind: OneShotKind): OneShotParams { return todo('referenceParams'); }
export function makeEdgeParams(_kind: OneShotKind, _rng: SplitMix64, _c: EdgeAnticContext): OneShotParams { return todo('makeEdgeParams'); }
export function shyPeek(_t: number, _p: OneShotParams, _o: OneShotOutput): void { todo('shyPeek'); }
export function popUp(_t: number, _p: OneShotParams, _o: OneShotOutput): void { todo('popUp'); }
export function curiousLean(_t: number, _p: OneShotParams, _o: OneShotOutput): void { todo('curiousLean'); }
export function pretendExit(_t: number, _p: OneShotParams, _o: OneShotOutput): void { todo('pretendExit'); }
export function sleepySink(_t: number, _p: OneShotParams, _o: OneShotOutput): void { todo('sleepySink'); }
