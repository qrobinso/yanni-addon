// Port of FaceEngine/IdleGameCurves.swift: only the shared constants and gameSpec so far.
// TODO(WP6): rest of IdleGameCurves.swift — makeGameParams, the lazy reference table, gameSample — and the ten
// IdleGameCurves+<Game>.swift files (one TS file each, e.g. IdleGameCurves+PingPong.ts). `gameInfo` must return each
// game's `duration` and `accents` (the spec table calls it on first use of a game's spec). Keep module-level code free
// of OneShots.ts exports (the two modules import each other; use them only inside functions).
import type { SplitMix64 } from '../core/random';
import type { OneShotKind } from './Commands';
import type { EdgeAnticContext } from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { OneShotChannels as C, OneShotSpec, type OneShotParams, type OneShotRequest } from './OneShots';

/// Playback-speed clamp for the games (mood can't rush a rally or stretch a held beat much).
export const gameSpeedRange: readonly [number, number] = [0.9, 1.15];
/// Per-trigger timing jitter.
export const gameTimeJitter: readonly [number, number] = [0.96, 1.04];

export function gameSpec(kind: OneShotKind, duration: number, accents: readonly number[]): OneShotSpec {
  return new OneShotSpec({
    kind, duration, channels: C.translate | C.angle | C.scale | C.lids | C.gaze | C.pupils | C.closure,
    cooldown: Math.ceil(duration + 0.5), stateScoped: true, priority: 3, accentTimes: [...accents],
    // An interrupted game swoops home on the release spring: no eye is ever left off its place.
    releaseStyle: 'spring', allowedStates: ['idle', 'noticing'], speedRange: gameSpeedRange,
  });
}

const todo = (name: string): never => { throw new Error(`TODO(WP6): IdleGameCurves.${name} is not ported yet`); };

/// The `duration` and `accents` of one game (Swift `PingPong.duration`, `PingPong.accents`, …).
export function gameInfo(_kind: OneShotKind): { duration: number; accents: readonly number[] } { return todo('gameInfo'); }
export function makeGameParams(_r: OneShotRequest, _rng: SplitMix64, _c: EdgeAnticContext): OneShotParams { return todo('makeGameParams'); }
export function gameReferenceParams(_kind: OneShotKind): OneShotParams { return todo('gameReferenceParams'); }
/// Samples a game (raw, before the edge window).
export function gameSample(_kind: OneShotKind, _t: number, _p: OneShotParams, _o: OneShotOutput): void { todo('gameSample'); }
