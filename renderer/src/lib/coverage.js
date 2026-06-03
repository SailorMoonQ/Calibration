// Coverage = how well the detected boards cover the image. We bin every
// detected corner into a `cols × rows` grid (column-major flat array, same
// layout CoverageGrid expects); a cell turns on once any frame puts a corner
// in it. Returns { cells: bool[], counts: int[], meanErr: (number|null)[],
// filled, total, percent }. `counts` and `meanErr` are populated only when the
// frames carry per-corner residuals ([x, y, ex, ey]) — they drive the post-solve
// quality colouring (red/amber/green per cell).

export const COVERAGE_COLS = 8;
export const COVERAGE_ROWS = 5;

export function computeCoverage(residuals, imageSize, cols = COVERAGE_COLS, rows = COVERAGE_ROWS) {
  const total = cols * rows;
  const cells = new Array(total).fill(false);
  const counts = new Array(total).fill(0);
  const errSum = new Array(total).fill(0);
  if (!residuals?.length || !imageSize) {
    return { cells, counts, meanErr: new Array(total).fill(null), filled: 0, total, percent: 0 };
  }
  const [w, h] = imageSize;
  if (!w || !h) {
    return { cells, counts, meanErr: new Array(total).fill(null), filled: 0, total, percent: 0 };
  }

  for (const frame of residuals) {
    if (!frame) continue;
    for (const corner of frame) {
      // residual entries are [x, y, ex, ey]; x, y place the corner in the grid,
      // (ex, ey) is its reprojection error vector (absent → treated as 0).
      const x = corner[0], y = corner[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const ci = Math.min(cols - 1, Math.max(0, Math.floor((x / w) * cols)));
      const ri = Math.min(rows - 1, Math.max(0, Math.floor((y / h) * rows)));
      const idx = ri * cols + ci;
      cells[idx] = true;
      counts[idx] += 1;
      const ex = corner[2], ey = corner[3];
      if (Number.isFinite(ex) && Number.isFinite(ey)) errSum[idx] += Math.hypot(ex, ey);
    }
  }

  const meanErr = counts.map((n, i) => (n > 0 ? errSum[i] / n : null));
  const filled = cells.reduce((n, on) => n + (on ? 1 : 0), 0);
  return { cells, counts, meanErr, filled, total, percent: Math.round((filled / total) * 100) };
}

// Merge one frame's detected corners ([[x, y], …] — the live-stream format) into
// an existing boolean coverage array, returning a new array. Used during capture
// to grow live coverage one snap at a time, before any calibration has run.
export function mergeCornersIntoCells(cells, corners, imageSize, cols = COVERAGE_COLS, rows = COVERAGE_ROWS) {
  const next = cells.slice();
  if (!corners?.length || !imageSize) return next;
  const [w, h] = imageSize;
  if (!w || !h) return next;
  for (const c of corners) {
    const idx = cellIndexFor(c[0], c[1], imageSize, cols, rows);
    if (idx != null) next[idx] = true;
  }
  return next;
}

// Which cell would a (x, y) point land in? Returns the same flat index used by `cells[]`.
// Returns null if image_size is missing or the point falls outside [0, w) × [0, h).
export function cellIndexFor(x, y, imageSize, cols = COVERAGE_COLS, rows = COVERAGE_ROWS) {
  if (!imageSize) return null;
  const [w, h] = imageSize;
  if (!w || !h) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x >= w || y < 0 || y >= h) return null;
  const ci = Math.min(cols - 1, Math.floor((x / w) * cols));
  const ri = Math.min(rows - 1, Math.floor((y / h) * rows));
  return ri * cols + ci;
}
