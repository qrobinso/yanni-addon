// Swift GazeInjector / GazeRig / len2 (GazeTrackingTests.swift): the shared rig for gaze, attention and micro-motion tests.
import { ExpressionLibrary, Units } from '../../src/model';
import type { V2 } from '../../src/core/vec';
import {
  Attention, Director, FaceState, GazeTracking, MicroMotion, Phase,
  type FaceCommand, type GazeIntent, type GazeOverride, type Modifier, type PersonTarget,
} from '../../src/engine';

/// Behaviour-phase stand-in for AgentStateBehavior / OneShotSampler.
export class GazeInjector implements Modifier {
  readonly name = 'GazeInjector';
  readonly phase = Phase.behaviour;
  isEnabled = true;
  intent: GazeIntent = { kind: 'idle' };
  override: GazeOverride | null = null;
  update(s: FaceState): void {
    s.gazeIntent = this.intent;
    s.oneShot.gaze = this.override;
  }
}

export class GazeRig {
  s: FaceState;
  readonly director: Director;
  readonly injector = new GazeInjector();
  readonly attention = new Attention();
  readonly tracking = new GazeTracking();
  readonly micro = new MicroMotion();

  constructor({ seed = 1, startTime = 0, micro = true }: { seed?: number; startTime?: number; micro?: boolean } = {}) {
    this.s = new FaceState(ExpressionLibrary.bundled(), seed);
    this.s.time = startTime;
    const mods: Modifier[] = [this.injector, this.attention, this.tracking];
    if (micro) mods.push(this.micro);
    this.director = new Director(mods);
  }

  get intent(): GazeIntent { return this.injector.intent; }
  set intent(v: GazeIntent) { this.injector.intent = v; }
  get override(): GazeOverride | null { return this.injector.override; }
  set override(v: GazeOverride | null) { this.injector.override = v; }

  send(c: FaceCommand): void { this.s.commands.push(c); }

  setPeople(people: PersonTarget[], primary: number | null): void {
    this.s.people.length = 0;
    this.s.people.push(...people);
    this.s.primaryPersonID = primary;
  }

  step(dt: number): void {
    this.s.dt = dt;
    this.s.time += dt;
    this.s.frame += 1;
    this.director.run(this.s);
    this.s.commands.length = 0;
  }

  /// Runs `seconds` at `fps`, calling `each` after every frame.
  run(seconds: number, each?: (r: GazeRig) => void, fps = 120): void {
    const n = Math.round(seconds * fps);
    for (let i = 0; i < n; i++) { this.step(1 / fps); each?.(this); }
  }

  // Convenience readouts (canvas units, before other modifiers).
  get leftEyeX(): number { return Units.canvasX(this.s.delta.eye('left', 'centerX')); }
  get rightEyeX(): number { return Units.canvasX(this.s.delta.eye('right', 'centerX')); }
  get headX(): number { return Units.canvasX(this.s.delta.face('centerX')); }
  get headY(): number { return Units.canvasY(this.s.delta.face('centerY')); }
  get leftEyeY(): number { return Units.canvasY(this.s.delta.eye('left', 'centerY')); }
  /// Pupil positions as written to the delta (normalised; includes convergence and, if enabled, drift).
  get leftPupil(): V2 { return { x: this.s.delta.eye('left', 'x'), y: this.s.delta.eye('left', 'y') }; }
  get rightPupil(): V2 { return { x: this.s.delta.eye('right', 'x'), y: this.s.delta.eye('right', 'y') }; }
}

export const len2 = (v: V2): number => Math.sqrt(v.x * v.x + v.y * v.y);
export const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const eq = (a: V2, b: V2): boolean => a.x === b.x && a.y === b.y;
