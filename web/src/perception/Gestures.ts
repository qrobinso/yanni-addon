// Port of FacePerception/Gestures.swift.
import type { V2, V3 } from '../core/vec';
import type { HandShape } from './HandShapes';
import {
  GestureKind, type BodyDetection, type FaceDetection, type NRect,
} from './PerceptionTypes';

const WAVE = GestureKind.index(GestureKind.wave);
const BYE = GestureKind.index(GestureKind.byeWave(0));
const THUMBS_UP = GestureKind.index(GestureKind.thumbsUp);
const OPEN_PALM = GestureKind.index(GestureKind.openPalm);
const POINT = GestureKind.index(GestureKind.point({ x: 0, y: 0 }));

/// Gesture tunables (starting values; the evaluator tunes them, the preview's gesture lab shows them live).
export class GestureParams {
  minJointConfidence = 0.3;
  // Wave.
  waveWindow = 1.5;
  waveReversals = 2;
  /// Amplitude ≥ this × shoulder width (body pose) …
  waveAmplitudeShoulders = 0.6;
  /// … or ≥ this × palm width (hand pose alone).
  waveAmplitudePalms = 1.2;
  waveOpenFraction = 0.6;
  /// The wrist no more than this far (metres) below head height.
  waveHeadBand = 0.3;
  /// Hand-pose wrists feed the wave only this near (and only for someone without a body-pose reading).
  waveHandPoseMaxDistance = 2;
  /// No waves beyond this (reduced tier: 2 m).
  waveMaxDistance = 3.5;
  // Hand shapes (near–mid).
  handGestureMaxDistance = 2.5;
  thumbMaxAngleDegrees = 35;
  curlRatio = 1.1;
  extendRatio = 1.6;
  spreadDegrees = 15;
  peaceSpreadDegrees = 10;
  palmMaxSpeed = 0.3;
  /// Static shapes: held this long with ≥ `kOfNFraction` of ≥ `minResults` hand results positive.
  shapeHold = 0.4;
  palmHold = 0.5;
  kOfNFraction = 0.6;
  minResults = 3;
  /// Hysteresis: a fired gesture re-arms after its candidate has been absent this long.
  rearm = 0.5;
  /// Onset: the body-pose wrist rose this much (metres) within `onsetWindow`, or the hand became active within it.
  onsetRise = 0.1;
  onsetWindow = 2;
  newHandGap = 1;
  // Two-hand heart.
  heartTipMetres = 0.03;
  heartMaxDistance = 2;
  // High-five approach.
  highFiveMaxDistance = 1.2;
  highFiveGrowth = 1.25;
  highFiveWindow = 0.5;
  // Aimed at Yanni (design §6.5).
  /// Within `engageMaxDistance`: `lookingAtMe` reached the enter level within this long.
  lookWindow = 1.5;
  engageMaxDistance = 1.6;
  /// Beyond it: facing ≥ this.
  farFacing = 0.5;
  /// Dancing counts as directed when facing ≥ `danceFacing` for `danceFacingHold` seconds.
  danceFacing = 0.3;
  danceFacingHold = 4;
  directedScoreMin = 0.5;
  /// One gesture per person per this long (a two-hand gesture beats the one-hand shapes it contains).
  precedenceWindow = 0.8;
  /// Bye: moving toward a frame edge, distance rising past `engageMaxDistance`, or the turn released this recently.
  byeReleaseWindow = 4;
  /// Per-gesture switches (bit `GestureKind.index`).
  enabledMask = 0x3FFF;

  copy(): GestureParams { return Object.assign(new GestureParams(), this); }
  equals(o: GestureParams): boolean {
    return (Object.keys(this) as (keyof GestureParams)[]).every((k) => this[k] === o[k]);
  }

  get waveEnabled(): boolean { return this.isEnabled(GestureKind.wave); }
  set waveEnabled(v: boolean) { this.setEnabled(WAVE, v); this.setEnabled(BYE, v); }
  get thumbsUpEnabled(): boolean { return this.isEnabled(GestureKind.thumbsUp); }
  set thumbsUpEnabled(v: boolean) { this.setEnabled(THUMBS_UP, v); }
  get openPalmEnabled(): boolean { return this.isEnabled(GestureKind.openPalm); }
  set openPalmEnabled(v: boolean) { this.setEnabled(OPEN_PALM, v); }
  get pointEnabled(): boolean { return (this.enabledMask & (1 << POINT)) !== 0; }
  set pointEnabled(v: boolean) { this.setEnabled(POINT, v); }

  isEnabled(k: GestureKind): boolean { return (this.enabledMask & (1 << GestureKind.index(k))) !== 0; }
  setEnabled(i: number, on: boolean): void {
    if (on) this.enabledMask |= 1 << i; else this.enabledMask &= ~(1 << i);
  }
}

/// What the recogniser needs to know about a person this frame.
export interface GesturePerson {
  id: number;
  /// Viewer frame.
  headCentre: V2;
  bodyBox: NRect | null;
  faceBox: NRect | null;
  /// Fresh this frame.
  body: BodyDetection | null;
  face: FaceDetection | null;
  distance: number;
  /// Gaze space.
  position: V2;
  /// Gaze units per second.
  velocity: V2;
  positionMetres: V3;
  facing: number;
  /// Last time `lookingAtMe` was at or above the engagement enter level.
  lastLook: number;
  engaged: boolean;
  primary: boolean;
  /// The turn was released within `byeReleaseWindow`.
  releasedRecently: boolean;
}
export const makeGesturePerson = (o: Pick<GesturePerson, 'id' | 'headCentre' | 'distance' | 'position'> &
  Partial<GesturePerson>): GesturePerson => ({
  bodyBox: null, faceBox: null, body: null, face: null, velocity: { x: 0, y: 0 }, positionMetres: { x: 0, y: 0, z: 1.5 },
  facing: 0, lastLook: -Infinity, engaged: false, primary: false, releasedRecently: false, ...o,
});

/// Hand-shape flags kept per hand result (bit per static shape).
export type ShapeBit = 0 | 1 | 2 | 3 | 4;
export const ShapeBit = {
  thumbsUp: 0 as ShapeBit, thumbsDown: 1 as ShapeBit, openPalm: 2 as ShapeBit, peace: 3 as ShapeBit, point: 4 as ShapeBit,
  allCases: [0, 1, 2, 3, 4] as readonly ShapeBit[],
  kind(b: ShapeBit): GestureKind {
    switch (b) {
      case 0: return GestureKind.thumbsUp;
      case 1: return GestureKind.thumbsDown;
      case 2: return GestureKind.openPalm;
      case 3: return GestureKind.peace;
      case 4: return GestureKind.point({ x: 0, y: 0 });
    }
  },
  holds(b: ShapeBit, s: HandShape): boolean {
    switch (b) {
      case 0: return s.thumbsUp;
      case 1: return s.thumbsDown;
      case 2: return s.openPalm;
      case 3: return s.peace;
      case 4: return s.pointDirection !== null;
    }
  },
} as const;

/// One hand result in a hand track.
export interface HandResult {
  t: number;
  flags: number;
  open: boolean;
  wristM: V2;
  size: number;
  pointDir: V2;
  /// Gaze position of the wrist.
  at: V2;
}
export const makeHandResult = (o: Partial<HandResult> = {}): HandResult => ({
  t: -Infinity, flags: 0, open: false, wristM: { x: 0, y: 0 }, size: 0, pointDir: { x: 0, y: 0 }, at: { x: 0, y: 0 }, ...o,
});

/// Candidate state of one static shape on one hand (design §6.5: idle → candidate → fired → refractory → idle).
export interface ShapeState { start: number | null; armed: boolean; lastPositive: number }
export const makeShapeState = (): ShapeState => ({ start: null, armed: true, lastPositive: -Infinity });

/// A person's hand of one side: a fixed ring of recent results.
export class HandTrack {
  static readonly capacity = 24;
  ring: HandResult[] = Array.from({ length: HandTrack.capacity }, () => makeHandResult());
  head = 0;
  count = 0;
  lastAt = -Infinity;
  activeSince = -Infinity;
  shapes: ShapeState[] = ShapeBit.allCases.map(() => makeShapeState());
  shape: HandShape | null = null;
  highFiveArmedAt = -Infinity;

  // port-note: like the Swift, reset() keeps `highFiveArmedAt`.
  reset(): void {
    this.head = 0; this.count = 0; this.lastAt = -Infinity; this.activeSince = -Infinity; this.shape = null;
    for (let i = 0; i < this.shapes.length; i++) this.shapes[i] = makeShapeState();
  }

  add(r: HandResult, newHandGap: number): void {
    if (r.t - this.lastAt > newHandGap) this.activeSince = r.t;
    this.lastAt = r.t;
    this.ring[this.head] = r;
    this.head = (this.head + 1) % HandTrack.capacity;
    this.count = Math.min(this.count + 1, HandTrack.capacity);
  }

  /// The `k`-th newest result.
  back(k: number): HandResult { return this.ring[(this.head - 1 - k + HandTrack.capacity * 2) % HandTrack.capacity]; }
}
