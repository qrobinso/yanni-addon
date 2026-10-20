// Port of Tests/FaceEngineTests/FrameRateDemandTests.swift.
import { describe, expect, test } from 'vitest';
import { FaceEngine, makePersonTarget } from '../../src/engine';

/// How often the idle face asks for the 120 fps burst (hardening design §6.6): blinks never do; only genuinely fast
/// motion (saccades, one-shots) does.
describe('FrameRateDemand', () => {
  // needs WP5, WP6, WP7 (full default stack)
  test.skip('blinksNeverAskForTheBurst', () => {
    const engine = new FaceEngine({ seed: 7 });
    engine.setPeople([makePersonTarget(1, { x: 0.2, y: 0 })], 1);
    const dt = 1.0 / 60;
    let fast = 0, blinkFrames = 0, fastBlinkFrames = 0, frames = 0;
    for (let i = 0; i < 60 * 120; i++) {
      const f = engine.tick(dt);
      frames += 1;
      if (f.wantsHighFrameRate) fast += 1;
      if (engine.state.blink > 0.001) {
        blinkFrames += 1;
        if (f.wantsHighFrameRate) fastBlinkFrames += 1;
      }
    }
    const fastShare = fast / frames;
    const blinkShare = blinkFrames > 0 ? fastBlinkFrames / blinkFrames : 0;
    expect(blinkFrames, 'the idle face blinks').toBeGreaterThan(100);
    // A blink coinciding with a saccade may still ask; a blink on its own never does.
    expect(blinkShare).toBeLessThan(0.25);
    expect(fastShare).toBeLessThan(0.12);
  });
});
