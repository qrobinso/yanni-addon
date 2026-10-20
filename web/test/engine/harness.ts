// Shared harness for the lids / body / composer tests (Swift ComposerTests.swift's LidsProbe / LidsHarness).
import { Composer, Director, FaceState, type Modifier, type Phase } from '../../src/engine';
import { ExpressionLibrary, FacePose, type Side } from '../../src/model';

const library = ExpressionLibrary.bundled();

/// A modifier that runs an arbitrary closure (test input injection).
export class LidsProbe implements Modifier {
  isEnabled = true;
  constructor(readonly name: string, readonly phase: Phase, private readonly body: (s: FaceState) => void) {}
  update(s: FaceState): void { this.body(s); }
}

/// Drives a director + composer at a fixed frame rate, like `FaceEngine.tick`.
export class LidsHarness {
  s: FaceState;
  readonly director: Director;
  frameIndex = 0;
  constructor(modifiers: Modifier[], readonly fps = 60, seed = 1, readonly startTime = 0) {
    this.s = new FaceState(library, seed);
    this.s.time = startTime;
    this.director = new Director(modifiers);
  }
  get dt(): number { return 1 / this.fps; }
  get elapsed(): number { return this.s.time - this.startTime; }
  step(): void {
    this.frameIndex += 1;
    this.s.dt = this.dt;
    this.s.time = this.startTime + this.frameIndex / this.fps;
    this.s.frame += 1;
    this.director.run(this.s);
    Composer.compose(this.s);
    this.s.commands.length = 0;
  }
  run(seconds: number, each: (h: LidsHarness) => void = () => {}): void {
    const n = Math.round(seconds * this.fps);
    for (let i = 0; i < n; i++) { this.step(); each(this); }
  }
}

/// Visible opening of an eye as a fraction of the unscaled eye height.
export const visibleOpening = (p: FacePose, side: Side): number =>
  Math.max(1 - p.eye(side, 'upperLidY') - p.eye(side, 'lowerLidY'), 0) * p.eye(side, 'scaleY');

export const opening = (p: FacePose, side: Side): number => 1 - p.eye(side, 'upperLidY') - p.eye(side, 'lowerLidY');
