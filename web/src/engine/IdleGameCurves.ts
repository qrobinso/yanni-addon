// Port of FaceEngine/IdleGameCurves.swift: the idle games' shared parts (idle games design §2).
//
// Each game is one one-shot: a spec row (`gameSpec`), a curve (one file per game, `IdleGameCurves+<Game>.ts`) and an
// entry in `gameSample`. The eyes are the props: nothing new is drawn. Curves are sums of spring steps and glides
// (closed form, frame-rate independent, like the edge antics), staged pupils first, then the eye shapes, then the face.
// Any travel toward a screen edge is resolved at trigger from `EdgeGeometry` (`makeGameParams`).
//
// Module-level code stays free of OneShots.ts exports (the two modules import each other; use them only inside
// functions).
import { SplitMix64 } from '../core/random';
import { EdgeGeometry, type Side } from '../model';
import { OneShotKind } from './Commands';
import { EdgeAnticContext, EdgeAnticParams, springPeakVelocityFactor, springStepVelocity } from './EdgeAnticCurves';
import type { OneShotOutput } from './FaceState';
import { OneShotChannels as C, OneShotParams, OneShotRequest, OneShotSpec, isIdleGame } from './OneShots';
import { Basketball, basketball } from './IdleGameCurves+Basketball';
import { CatchTheFly, catchTheFly } from './IdleGameCurves+CatchTheFly';
import { DanceBreak, danceBreak } from './IdleGameCurves+DanceBreak';
import { HideAndSeek, hideAndSeek } from './IdleGameCurves+HideAndSeek';
import { HulaHoop, hulaHoop } from './IdleGameCurves+HulaHoop';
import { Juggling, juggling } from './IdleGameCurves+Juggling';
import { Leapfrog, leapfrog } from './IdleGameCurves+Leapfrog';
import { PingPong, pingPong } from './IdleGameCurves+PingPong';
import { StaringContest, staringContest } from './IdleGameCurves+StaringContest';
import { YoYo, yoYo } from './IdleGameCurves+YoYo';
import type { V2 } from '../core/vec';

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

/// The `duration` and `accents` of one game (Swift `PingPong.duration`, `PingPong.accents`, …).
export function gameInfo(kind: OneShotKind): { duration: number; accents: readonly number[] } {
  switch (kind) {
    case 'pingPong': return PingPong;
    case 'basketball': return Basketball;
    case 'juggling': return Juggling;
    case 'yoYo': return YoYo;
    case 'leapfrog': return Leapfrog;
    case 'staringContest': return StaringContest;
    case 'hideAndSeek': return HideAndSeek;
    case 'catchTheFly': return CatchTheFly;
    case 'danceBreak': return DanceBreak;
    case 'hulaHoop': return HulaHoop;
    default: throw new Error(`gameInfo: ${kind} is not an idle game`);
  }
}

/// Resolves a game trigger: jitter, which side leads, the outcome variation and the screen travel. `p.edge.hide` > 0
/// marks a resolved trigger; the meaning of the travel fields is per game (see each curve).
export function makeGameParams(r: OneShotRequest, rng: SplitMix64, c: EdgeAnticContext): OneShotParams {
  const st = c.gameSettings.validated();
  const g = c.geometry?.isValid ? c.geometry : EdgeGeometry.reference;
  const p = new OneShotParams();
  const neutral = c.neutral;
  p.amp = 1;
  p.timeMul = (neutral ? 1 : rng.uniform(gameTimeJitter[0], gameTimeJitter[1])) * st.timingScale;
  p.side = c.sideHint > 0 ? 1 : (c.sideHint < 0 ? -1 : (neutral || rng.chance(0.5) ? 1 : -1));
  p.v1 = neutral ? 0.25 : rng.unit();
  p.v2 = neutral ? 0.5 : rng.unit();
  const i = r.intensity;
  p.intensity = st.intensity * (i === undefined ? 1 : Number.isFinite(i) ? Math.min(Math.max(i, 0.3), 1.3) : 1);
  const e = new EdgeAnticParams();
  e.intensity = p.intensity;
  switch (r.kind) {
    case 'pingPong': PingPong.resolve(g, e); break;
    case 'basketball': Basketball.resolve(g, e); break;
    case 'hulaHoop': HulaHoop.resolve(g, e); break;
    case 'yoYo': YoYo.resolve(g, e); break;
    case 'leapfrog': Leapfrog.resolve(g, e); break;
    case 'hideAndSeek': HideAndSeek.resolve(c.person, p, e); break;
    case 'catchTheFly': CatchTheFly.resolve(g, e); break;
    default: e.hide = 1;
  }
  e.hide = Math.max(e.hide, 1e-3);
  p.edge = e;
  return p;
}

let gameReferenceTable: OneShotParams[] | null = null;

/// The neutral trigger of a game on the reference screen with default settings (library sampling and tests).
export function gameReferenceParams(kind: OneShotKind): OneShotParams {
  if (!gameReferenceTable) {
    const rng = new SplitMix64(1);
    gameReferenceTable = OneShotKind.allCases.filter(isIdleGame)
      .map((k) => makeGameParams(OneShotRequest.make(k), rng, new EdgeAnticContext({ neutral: true })));
  }
  return gameReferenceTable[OneShotKind.ordinal(kind) - OneShotKind.ordinal('pingPong')];
}

/// Samples a game (raw, before the edge window).
export function gameSample(kind: OneShotKind, t: number, p: OneShotParams, o: OneShotOutput): void {
  switch (kind) {
    case 'pingPong': pingPong(t, p, o); break;
    case 'basketball': basketball(t, p, o); break;
    case 'juggling': juggling(t, p, o); break;
    case 'yoYo': yoYo(t, p, o); break;
    case 'leapfrog': leapfrog(t, p, o); break;
    case 'staringContest': staringContest(t, p, o); break;
    case 'hideAndSeek': hideAndSeek(t, p, o); break;
    case 'catchTheFly': catchTheFly(t, p, o); break;
    case 'danceBreak': danceBreak(t, p, o); break;
    case 'hulaHoop': hulaHoop(t, p, o); break;
    default: break; // pending games rest
  }
}

// MARK: Shared shaping

/// Damped sine with unit first peak (a spring's impulse response): 0 before `t0`, a kick and a decaying wobble.
export function kick(t: number, w: number, z: number): number {
  return springStepVelocity(t, w, z) / Math.max(w * springPeakVelocityFactor(z), 1e-4);
}

export function setEyeScale(o: OneShotOutput, side: Side, v: V2): void {
  if (side === 'left') { o.eyeScaleMul.x *= v.x; o.eyeScaleMul.y *= v.y; } else { o.eyeScaleMul.z *= v.x; o.eyeScaleMul.w *= v.y; }
}

/// Pupil silhouette scale per eye (x, y), ellipse shape: hides a pupil (`minPupilShapeScale`) or squeezes it.
export function setPupilScale(o: OneShotOutput, side: Side, v: V2): void {
  if (side === 'left') { o.pupilShapeScale.x = v.x; o.pupilShapeScale.y = v.y; } else { o.pupilShapeScale.z = v.x; o.pupilShapeScale.w = v.y; }
}
