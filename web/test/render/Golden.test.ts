// Port of FaceRenderingTests/GoldenTests.swift: the CPU geometry against PyCozmo's own rasters (harness in golden.ts).
import { describe, expect, test } from 'vitest';
import { golden, goldenEntries, goldenPose, iou, minimumIoU, raster } from './golden';

describe('GoldenTests', () => {
  test('goldenSetIsComplete', () => {
    expect(goldenEntries.length).toBe(25);
    for (const e of goldenEntries) {
      expect(e.params.length).toBe(43);
      expect(e.rows.length).toBe(64);
    }
  });

  test.each(goldenEntries.map((e) => e.name))('matchesPyCozmo %s', (name) => {
    const entry = goldenEntries.find((e) => e.name === name)!;
    const score = iou(raster(goldenPose(entry.params)), golden(entry.rows));
    expect(score, `${name} IoU ${score}`).toBeGreaterThanOrEqual(minimumIoU);
  });
});
