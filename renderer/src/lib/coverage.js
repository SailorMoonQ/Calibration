// Coverage = how well the detected boards cover the image. We bin every
// detected corner into a `cols × rows` grid (column-major flat array, same
// layout CoverageGrid expects); a cell turns on once any frame puts a corner
// in it. Returns { cells: bool[], filled, total, percent }.

export const COVERAGE_COLS = 8;
export const COVERAGE_ROWS = 5;

export function computeCoverage(residuals, imageSize, cols = COVERAGE_COLS, rows = COVERAGE_ROWS) {
  const total = cols * rows;
  const cells = new Array(total).fill(false);
  if (!residuals?.length || !imageSize) return { cells, filled: 0, total, percent: 0 };
  const [w, h] = imageSize;
  if (!w || !h) return { cells, filled: 0, total, percent: 0 };

  for (const frame of residuals) {
    if (!frame) continue;
    for (const corner of frame) {
      // residual entries are [x, y, ex, ey]; only x, y matter for coverage.
      const x = corner[0], y = corner[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const ci = Math.min(cols - 1, Math.max(0, Math.floor((x / w) * cols)));
      const ri = Math.min(rows - 1, Math.max(0, Math.floor((y / h) * rows)));
      cells[ri * cols + ci] = true;
    }
  }

  const filled = cells.reduce((n, on) => n + (on ? 1 : 0), 0);
  return { cells, filled, total, percent: Math.round((filled / total) * 100) };
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
