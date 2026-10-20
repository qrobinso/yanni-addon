// Port of Tests/FaceEngineTests/PowerCareTests.swift.
import { describe, expect, test } from 'vitest';
import { ExpressionLibrary } from '../../src/model';
import { Brightness } from '../../src/engine/modifiers/Brightness';
import {
  Composer, Director, FaceEngine, FaceState, PowerCare, makePersonTarget, type Modifier,
} from '../../src/engine';

/// Swift LidsHarness (ComposerTests.swift): a director over a bare state, composed every step.
class LidsHarness {
  s: FaceState;
  readonly director: Director;
  private frameIndex = 0;
  constructor(modifiers: Modifier[], readonly fps = 60, seed = 1, readonly startTime = 0) {
    this.s = new FaceState(ExpressionLibrary.bundled(), seed);
    this.s.time = startTime;
    this.director = new Director(modifiers);
  }
  get dt(): number { return 1 / this.fps; }
  step(): void {
    this.frameIndex += 1;
    this.s.dt = this.dt;
    this.s.time = this.startTime + this.frameIndex / this.fps;
    this.s.frame += 1;
    this.director.run(this.s);
    Composer.compose(this.s);
    this.s.commands.length = 0;
  }
  run(seconds: number): void {
    const n = Math.round(seconds * this.fps);
    for (let i = 0; i < n; i++) this.step();
  }
}

// TODO(WP7): drop the casts once Brightness is the modifier (level, startupTau).
type BrightnessModifier = Modifier & { level: number };
const makeBrightness = (): BrightnessModifier => new Brightness() as unknown as BrightnessModifier;
const startupTau = (): number => (Brightness as unknown as { startupTau: number }).startupTau;

/// OLED / power care knobs on `Brightness` (hardening design §4.3, §6.4) and the launch fade (§6.2).
describe('PowerCare', () => {
  test('defaultsReproduceTheOriginalConstants', () => {
    const p = new PowerCare();
    expect(p.idleDimLevel === Brightness.idleDimLevel && p.idleDimDelay === Brightness.idleDimDelay && p.brightnessScale === 1)
      .toBe(true);
    expect(new FaceEngine().powerCare.equals(p)).toBe(true);
  });

  // needs WP7 (Brightness)
  test.skip('perDeviceDimLevelAndDelay', () => {
    const b = makeBrightness();
    const h = new LidsHarness([b], 60);
    h.s.agentState = 'idle';
    h.s.targetBrightness = 0.85;
    h.s.powerCare = new PowerCare(0.55, 10);
    h.run(9);
    expect(Math.abs(b.level - 0.85)).toBeLessThan(1e-3); // not yet
    h.run(12);
    expect(Math.abs(b.level - 0.55)).toBeLessThan(0.01);
  });

  // needs WP7 (Brightness)
  test.skip('brightnessCeilingIsSmoothed', () => {
    const b = makeBrightness();
    const h = new LidsHarness([b], 60);
    h.s.targetBrightness = 0.8;
    h.s.people = [makePersonTarget(1, { x: 0, y: 0 })];
    h.run(2);
    h.s.powerCare.brightnessScale = 0.85;
    h.step();
    expect(Math.abs(b.level - 0.8), 'no snap').toBeLessThan(0.01);
    h.run(10);
    expect(Math.abs(b.level - 0.68)).toBeLessThan(0.005);
  });

  test('validationClamps', () => {
    const v = new PowerCare(NaN, -5, 7).validated();
    expect(v.idleDimLevel === Brightness.idleDimLevel && v.idleDimDelay === 1 && v.brightnessScale === 1).toBe(true);
  });

  // needs WP7 (Brightness)
  test.skip('launchFadeStartsBlackAndArrives', () => {
    const b = makeBrightness();
    const h = new LidsHarness([b], 60);
    h.s.targetBrightness = 0.85;
    h.s.fadingInFromBlack = true;
    h.step();
    expect(b.level).toBeLessThan(0.05);
    h.run(startupTau());
    expect(Math.abs(b.level - 0.85 * (1 - Math.exp(-1)))).toBeLessThan(0.03);
    h.run(3);
    expect(Math.abs(b.level - 0.85)).toBeLessThan(0.01);
    expect(h.s.fadingInFromBlack).toBe(false);
  });
});
