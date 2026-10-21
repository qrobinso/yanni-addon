// Port of FacePerception/Motion.swift.
import type { V2 } from '../core/vec';
import type { CameraGeometry } from './CameraGeometry';
import { NRect, clamp } from './PerceptionTypes';
import type { MotionGrid, PerceptionEvent } from './PerceptionTypes';

/// Motion-map tunables.
export interface MotionParams {
  /// A cell moves when its frame-to-frame luma change exceeds this …
  cellThreshold: number;
  /// … and exceeds `baselineMultiple` × its long-term average change.
  baselineMultiple: number;
  /// Long-term average time constant (seconds).
  baselineTau: number;
  /// Cells whose long-term average is above this (a TV, a curtain, a ceiling fan) are ignored.
  busyCell: number;
  /// Suppression after an exposure / white-balance change or a global brightness jump (seconds).
  exposureHold: number;
  globalJump: number;
  /// Blob strength = clamp(cells / `fullCells` × mean change / `fullContrast`, 0, 1); events below `minStrength` drop.
  fullCells: number;
  fullContrast: number;
  minStrength: number;
  /// At most one motion event per this many seconds.
  minInterval: number;
}
export const makeMotionParams = (o: Partial<MotionParams> = {}): MotionParams => ({
  cellThreshold: 0.08, baselineMultiple: 3, baselineTau: 60, busyCell: 0.04, exposureHold: 0.5, globalJump: 0.06,
  fullCells: 12, fullContrast: 0.2, minStrength: 0.2, minInterval: 1, ...o,
});

const NEIGHBOURS: readonly [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/// Motion not explained by a tracked person, from a coarse luma grid: per-cell differencing against a long-term
/// baseline, connected blobs, people's boxes masked out.
export class MotionDetector {
  params: MotionParams;
  previous: number[] = [];
  baseline: number[] = [];
  cols = 0; rows = 0;
  lastTime: number | null = null;
  holdUntil = -Infinity;
  lastEvent = -Infinity;
  previousMean: number | null = null;
  previousPeople: NRect[] = [];
  constructor(params: MotionParams = makeMotionParams()) { this.params = params; }

  reset(): void { this.previous = []; this.baseline = []; this.lastTime = null; this.previousMean = null; }

  /// Read-out of the long-term average per cell (tests, status).
  get baselineCells(): number[] { return this.baseline; }

  /// Returns at most one motion event (gaze-space position of the strongest blob, strength 0…1).
  update(grid: MotionGrid, time: number, people: NRect[], geometry: CameraGeometry): PerceptionEvent | null {
    const k = this.params;
    const n = grid.cols * grid.rows;
    if (!(n > 0) || grid.luma.length !== n) return null;
    const sum = (a: readonly number[]): number => { let s = 0; for (const v of a) s += v; return s; };
    if (grid.cols !== this.cols || grid.rows !== this.rows || this.previous.length !== n) {
      this.cols = grid.cols; this.rows = grid.rows;
      this.previous = [...grid.luma];
      this.baseline = new Array<number>(n).fill(0);
      this.lastTime = time;
      this.previousMean = sum(grid.luma) / n;
      return null;
    }
    const dt = Math.max(time - (this.lastTime ?? time), 0);
    this.lastTime = time;
    const mean = sum(grid.luma) / n;
    if (grid.exposureChanged || Math.abs(mean - (this.previousMean ?? mean)) > k.globalJump) this.holdUntil = time + k.exposureHold;
    this.previousMean = mean;

    const a = 1 - Math.exp(-dt / k.baselineTau);
    const active = new Array<boolean>(n).fill(false);
    const diff = new Array<number>(n).fill(0);
    const suppressed = time < this.holdUntil;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(grid.luma[i] - this.previous[i]);
      diff[i] = d;
      if (!suppressed) {
        active[i] = d > k.cellThreshold && d > k.baselineMultiple * this.baseline[i] && this.baseline[i] <= k.busyCell;
        this.baseline[i] += (d - this.baseline[i]) * a;
      }
    }
    this.previous = [...grid.luma];
    // port-note: the Swift `defer` that keeps `previousPeople` while suppressed only matters on this early return.
    if (suppressed || !(time - this.lastEvent >= k.minInterval)) { this.previousPeople = people; return null; }

    // Mask people, where they are and where they were a frame ago (a moving person leaves a trail of changed cells
    // behind them), boxes widened a little.
    const masks = [...people, ...this.previousPeople].map((r) => NRect.insetBy(r, 0.15));
    this.previousPeople = people;
    const cols = this.cols, rows = this.rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!active[r * cols + c]) continue;
        const centre = { x: (c + 0.5) / cols, y: (r + 0.5) / rows };
        if (masks.some((m) => NRect.contains(m, centre))) active[r * cols + c] = false;
      }
    }

    // Largest 4-connected blob.
    const seen = new Array<boolean>(n).fill(false);
    let best: { cells: number; sum: number; centre: V2 } | null = null;
    for (let start = 0; start < n; start++) {
      if (!active[start] || seen[start]) continue;
      const stack = [start];
      seen[start] = true;
      let cells = 0, s = 0, cx = 0, cy = 0;
      while (stack.length > 0) {
        const i = stack.pop() as number;
        cells += 1; s += diff[i];
        const r = Math.floor(i / cols), c = i % cols;
        cx += c + 0.5; cy += r + 0.5;
        for (const [dr, dc] of NEIGHBOURS) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          const j = rr * cols + cc;
          if (active[j] && !seen[j]) { seen[j] = true; stack.push(j); }
        }
      }
      if (best === null || cells > best.cells) best = { cells, sum: s, centre: { x: cx / cells / cols, y: cy / cells / rows } };
    }
    if (best === null) return null;
    const contrast = best.sum / best.cells;
    const strength = clamp(best.cells / k.fullCells * contrast / k.fullContrast, 0, 1);
    if (!(strength >= k.minStrength)) return null;
    this.lastEvent = time;
    return { kind: 'motion', at: geometry.gazePosition(best.centre), strength };
  }
}
