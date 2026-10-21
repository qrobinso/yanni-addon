// Port of FacePerception/Hungarian.swift.

/// Minimum-cost assignment (Hungarian / Kuhn–Munkres, O(n³)) for small rectangular matrices.
export const Hungarian = {
  /// `cost[r][c]`; returns for each row the assigned column or null (more rows than columns). Pairs whose cost
  /// exceeds `gate` are left unassigned.
  assign(cost: readonly (readonly number[])[], gate = Infinity): (number | null)[] {
    const rows = cost.length;
    const cols = rows > 0 ? cost[0].length : 0;
    if (rows === 0 || cols === 0) return new Array<number | null>(rows).fill(null);
    const n = Math.max(rows, cols);
    const big = 1e6;
    // Square, padded matrix (1-based for the classic potentials formulation).
    const a: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(n + 1).fill(big));
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (r < rows && c < cols) {
          const v = cost[r][c];
          a[r + 1][c + 1] = Number.isFinite(v) ? Math.min(v, big) : big;
        } else {
          a[r + 1][c + 1] = big / 2;   // dummy
        }
      }
    }
    const u = new Array<number>(n + 1).fill(0), v = new Array<number>(n + 1).fill(0);
    const p = new Array<number>(n + 1).fill(0), way = new Array<number>(n + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Array<number>(n + 1).fill(Infinity);
      const used = new Array<boolean>(n + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = Infinity;
        let j1 = 0;
        for (let j = 1; j <= n; j++) {
          if (used[j]) continue;
          const cur = a[i0][j] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= n; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else { minv[j] -= delta; }
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do {
        const j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0 !== 0);
    }
    const result = new Array<number | null>(rows).fill(null);
    for (let j = 1; j <= n; j++) {
      const r = p[j] - 1, c = j - 1;
      if (r >= 0 && r < rows && c < cols && cost[r][c] <= gate) result[r] = c;
    }
    return result;
  },
} as const;
