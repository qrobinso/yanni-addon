// Sanity checks for the FaceModel files the Swift FaceModelTests don't cover directly (no Swift counterpart).
import { describe, expect, test } from 'vitest';
import {
  EdgeGeometry, FaceFrame, FacePose, Oklab, PupilShape, VocalContour, cloneFaceFrame, makeFaceFrame, maxOf, minOf,
  pupilShapeClamping,
} from '../../src/model';

describe('model helpers', () => {
  test('Oklab round trip and hex', () => {
    const c = Oklab.linear(0x5ff6ff);
    const back = Oklab.toLinear(Oklab.fromLinear(c));
    expect(Math.abs(back.x - c.x) + Math.abs(back.y - c.y) + Math.abs(back.z - c.z)).toBeLessThan(1e-6);
    expect(Oklab.hex(c)).toBe(0x5ff6ff);
    expect(Oklab.isInGamut(Oklab.fromLinear(c))).toBe(true);
    expect(Oklab.maxChroma({ x: 0.5, y: 0.4, z: 0.4 }, 0.5)).toBeLessThan(Math.hypot(0.4, 0.4));
  });

  test('VocalContour glides from start to end', () => {
    const v = new VocalContour({ start: 0, end: 4 });
    expect(v.pitch(0, 1)).toBe(0);
    expect(v.pitch(1, 1)).toBe(4);
    expect(VocalContour.flat(2).pitch(0.3, 1)).toBe(2);
  });

  test('FaceFrame defaults and deep clone', () => {
    const f = makeFaceFrame(FacePose.defaults);
    expect(f.color).toEqual(FaceFrame.defaultColor);
    expect(f.pupilShapeScale).toEqual({ x: 1, y: 1, z: 1, w: 1 });
    expect(f.brows.lane('left', 'rotation')).toBe(12);
    const g = cloneFaceFrame(f);
    g.color.x = 0; g.pose.set(0, 9);
    expect(f.color.x).toBe(0.11);
    expect(f.pose.get(0)).toBe(0);
    expect(FaceFrame.shape(f, 'left')).toBe(PupilShape.ellipse);
    expect(pupilShapeClamping(9)).toBe(PupilShape.ellipse);
  });

  test('EdgeGeometry reference', () => {
    const g = EdgeGeometry.reference;
    expect(g.isValid).toBe(true);
    expect(g.hasBrows).toBe(false);
    expect(g.visibleFraction('left', { x: 0, y: 0 })).toBeCloseTo(1, 12);
    // offsetX(fraction 0) puts the eye just beyond the edge.
    expect(g.visibleFraction('right', { x: g.offsetX('right', 0, 1), y: 0 })).toBe(0);
    expect(Math.abs(g.visibleFraction('right', { x: g.offsetX('right', 0.5, 1), y: 0 }) - 0.5)).toBeLessThan(1e-9);
  });

  test('maxOf / minOf', () => {
    expect(maxOf(1, 4, 2, 3)).toBe(4);
    expect(maxOf(1, 4, 2, 3, 7, 5)).toBe(7);
    expect(minOf(3, 1, 2, 0)).toBe(0);
  });
});
