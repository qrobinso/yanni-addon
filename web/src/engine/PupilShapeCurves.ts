// Port of FaceEngine/PupilShapeCurves.swift: PupilShapeFrame, the timing tables and shapeSpec so far (the spec table,
// OneShotSampler and FaceEngine.playPupilShape need them).
// TODO(WP6): rest of PupilShapeCurves.swift — makeShapeParams, shapeSample (the five transformations) and switchBack.
// Keep module-level code free of OneShots.ts exports (the two modules import each other; use them only inside functions).
import type { SplitMix64 } from '../core/random';
import { v2, v4, type V2, type V4 } from '../core/vec';
import type { OneShotKind } from './Commands';
import type { OneShotOutput } from './FaceState';
import { OneShotChannels, OneShotSpec, type OneShotParams, type OneShotRequest } from './OneShots';

/// The silhouette part of a pupil transformation for one frame: per-eye shape (raw `PupilShape`), morph and scale.
export class PupilShapeFrame {
  shape: V2;
  morph: V2;
  /// (left x, left y, right x, right y).
  scale: V4;
  constructor(shape: V2 = v2(0), morph: V2 = v2(0), scale: V4 = v4(1)) {
    this.shape = { ...shape }; this.morph = { ...morph }; this.scale = { ...scale };
  }
  /// The default pupils. Fresh each access.
  static get identity(): PupilShapeFrame { return new PupilShapeFrame(); }
  copy(): PupilShapeFrame { return new PupilShapeFrame(this.shape, this.morph, this.scale); }
  equals(o: PupilShapeFrame): boolean {
    return this.shape.x === o.shape.x && this.shape.y === o.shape.y && this.morph.x === o.morph.x &&
      this.morph.y === o.morph.y && this.scale.x === o.scale.x && this.scale.y === o.scale.y &&
      this.scale.z === o.scale.z && this.scale.w === o.scale.w;
  }
  /// True when this is the default pupil on both eyes (ellipse, morph 0, scale 1).
  get isIdentity(): boolean { return this.equals(PupilShapeFrame.identity); }
}

/// Allowed hold lengths (seconds).
export const holdRange: readonly [number, number] = [0.3, 3];
/// Coin flip: ease into the sliver over `flipIn`, swap at the sliver, open out over `flipOut` (170 ms in all).
export const flipIn = 0.07;
export const flipOut = 0.10;
export const flipHold = 0.02;
/// x scale at the coin flip's sliver.
export const sliver = 0.06;
/// Scale a transformed silhouette rests at (the pop peaks at 1.0).
export const shapeRest = 0.9;
/// Below this intensity the bounce, twinkle and pulse are dropped and bobs halve.
export const bounceIntensity = 0.5;
/// A switch back with nothing visible to flip eases the scale home this fast.
export const switchBackEase = 0.12;
/// Length of every switch back.
export const switchBackDuration = flipIn + flipOut;

export function shapeSpec(kind: OneShotKind, acting: number): OneShotSpec {
  return new OneShotSpec({
    kind, duration: shapeDuration(kind, 0), channels: OneShotChannels.pupilShape, cooldown: 0.3, stateScoped: false,
    priority: 10, accentTimes: shapeAccentTimesFor(kind, true), releaseStyle: 'switchBack', speedRange: [1, 1],
    actingChannels: acting,
  });
}

/// Default hold per transformation (seconds).
export function defaultHold(kind: OneShotKind): number {
  switch (kind) {
    case 'starEyes': return 1.0;
    case 'heartEyes': return 1.3;
    case 'noteEyes': return 1.5;
    case 'questionEyes': return 1.0;
    case 'exclaimEyes': return 0.6;
    default: return 0;
  }
}

/// Seconds before the hold starts (anticipation and pop / glance / flips).
export function shapeIntro(kind: OneShotKind): number {
  switch (kind) {
    case 'starEyes': return 0.46;
    case 'heartEyes': return 0.78;
    case 'noteEyes': return 0.24;
    case 'questionEyes': return 0.36;
    case 'exclaimEyes': return 0.3;
    default: return 0;
  }
}

/// Seconds after the hold (the return; for exclamation marks it includes the delighted squint).
export function shapeOutro(kind: OneShotKind): number {
  switch (kind) {
    case 'starEyes': return 0.24;
    case 'heartEyes': return 0.26;
    case 'noteEyes': return 0.2;
    case 'questionEyes': return 0.2;
    case 'exclaimEyes': return 1.1;
    default: return 0;
  }
}

/// Total base duration for a hold (0 = the default hold).
export function shapeDuration(kind: OneShotKind, hold: number): number {
  return shapeIntro(kind) + resolvedHold(kind, hold) + shapeOutro(kind);
}

export function resolvedHold(kind: OneShotKind, hold: number): number {
  const h = hold > 0 && Number.isFinite(hold) ? hold : defaultHold(kind);
  return Math.min(Math.max(h, holdRange[0]), holdRange[1]);
}

/// Swift `shapeAccentTimes(_:bounce:)`.
export function shapeAccentTimesFor(kind: OneShotKind, bounce: boolean): number[] {
  switch (kind) {
    case 'starEyes': return bounce ? [0.24, 0.40] : [0.24];
    case 'heartEyes': return [0.6];
    case 'noteEyes': return [0.11];
    case 'questionEyes': return [0.11, 0.23];
    case 'exclaimEyes': return [0.09];
    default: return [];
  }
}

/// Swift `shapeAccentTimes(_:_:)`.
export function shapeAccentTimes(kind: OneShotKind, p: OneShotParams): number[] {
  return shapeAccentTimesFor(kind, p.bounce);
}

const todo = (name: string): never => { throw new Error(`TODO(WP6): PupilShapeCurves.${name} is not ported yet`); };

export function makeShapeParams(_r: OneShotRequest, _rng: SplitMix64, _eyeGaze: V2): OneShotParams { return todo('makeShapeParams'); }
/// Samples a transformation: the acting into `o` (raw), the silhouette into `out`.
export function shapeSample(_kind: OneShotKind, _t: number, _p: OneShotParams, _o: OneShotOutput, _out: OneShotOutput): void {
  todo('shapeSample');
}
export function switchBack(_from: PupilShapeFrame, _t: number): PupilShapeFrame { return todo('switchBack'); }
