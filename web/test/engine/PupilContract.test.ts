// Port of Tests/FaceEngineTests/PupilContractTests.swift.
import { describe, expect, test } from 'vitest';
import { Composer, ExpressionSprings, FaceState } from '../../src/engine';
import { ExpressionLibrary, ParamLayout } from '../../src/model';

describe('PupilContract', () => {
  test('bothPupilsUseTheSameSpringGroups', () => {
    for (const p of ParamLayout.Pupil.allCases) {
      expect(ExpressionSprings.group(ParamLayout.index('left', p))).toBe(ExpressionSprings.group(ParamLayout.index('right', p)));
    }
    expect(ExpressionSprings.group(ParamLayout.index('left', 'x'))).toBe('pupilPosition');
    expect(ExpressionSprings.group(ParamLayout.index('right', 'size'))).toBe('pupilSize');
    expect(ExpressionSprings.lidMask[ParamLayout.index('left', 'y')]).toBe(0);
  });

  test('allPupilLanesAreSoftClamped', () => {
    for (const side of ParamLayout.Side.allCases) {
      for (const p of ParamLayout.Pupil.allCases) expect(Composer.isSoftClamped(ParamLayout.index(side, p))).toBe(true);
    }
  });

  test('pupilSizeMultiplierIsClampedAndClosureScaleReported', () => {
    const s = new FaceState(ExpressionLibrary.bundled(), 1);
    s.pupilSizeMul = { x: 3, y: 0.1 };
    s.blink = 1;
    Composer.compose(s);
    const base = s.basePose;
    const [lo, hi] = Composer.pupilSizeMulRange;
    expect(s.output.pose.eye('left', 'size')).toBeLessThanOrEqual(base.eye('left', 'size') * hi + 1e-3);
    expect(s.output.pose.eye('right', 'size')).toBeGreaterThanOrEqual(Math.min(base.eye('right', 'size') * lo, 0.15) - 1e-3);
    expect(Math.abs(s.output.closureScale.y - Composer.blinkSquashY)).toBeLessThan(1e-4);
    expect(s.output.closureScale.x).toBeGreaterThan(1);
  });
});
