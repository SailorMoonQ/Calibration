// Coverage = how well the detected boards cover the image. We bin every
// detected corner into a `cols × rows` grid (column-major flat array, same
// layout CoverageGrid expects). Returns { cells, counts, meanErr, mask,
// filled, total, percent }.
//
// Two refinements drive the live capture UX:
//   • `mask` (fovCellMask) excludes cells outside the fisheye field of view —
//     the four frame corners never contain board, so demanding coverage there
//     would make 100% unreachable. Masked cells don't count toward `total`.
//   • coverage is capture-driven: a cell only turns on when an actual snapped
//     frame put enough board in it (see cellCornerCounts + the capture
//     threshold applied by the caller), not merely because the live board
//     swept across it.

export const COVERAGE_COLS = 8;
export const COVERAGE_ROWS = 5;

// Inscribed-ellipse field-of-view mask. A fisheye image fills the centred
// ellipse that touches the four edge midpoints; the rectangle's four corners
// (and any cell whose centre falls outside that ellipse) are black and never
// hold a board. `scale` shrinks (<1) or grows (>1) the ellipse for lenses whose
// image circle is smaller/larger than the frame. Returns bool[] — true = the
// cell is inside the field of view and should count toward coverage.
export function fovCellMask(imageSize, cols = COVERAGE_COLS, rows = COVERAGE_ROWS, scale = 1.0) {
  const total = cols * rows;
  const mask = new Array(total).fill(true);
  if (!imageSize) return mask;
  const [w, h] = imageSize;
  if (!w || !h) return mask;
  const rx = (w / 2) * scale, ry = (h / 2) * scale;
  const cxC = w / 2, cyC = h / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = ((c + 0.5) / cols) * w;
      const py = ((r + 0.5) / rows) * h;
      const nx = (px - cxC) / rx, ny = (py - cyC) / ry;
      mask[r * cols + c] = (nx * nx + ny * ny) <= 1;
    }
  }
  return mask;
}

// Per-cell corner tally for ONE frame ([[x, y], …] live-stream format). The
// caller turns this into "captured" by thresholding (a board only counts as
// having covered a cell when ≥ N of its corners land there, so a board edge
// merely clipping a cell does not mark it).
export function cellCornerCounts(corners, imageSize, cols = COVERAGE_COLS, rows = COVERAGE_ROWS) {
  const counts = new Array(cols * rows).fill(0);
  if (!corners?.length || !imageSize) return counts;
  const [w, h] = imageSize;
  if (!w || !h) return counts;
  for (const c of corners) {
    const idx = cellIndexFor(c[0], c[1], imageSize, cols, rows);
    if (idx != null) counts[idx] += 1;
  }
  return counts;
}

export function computeCoverage(residuals, imageSize, opts = {}) {
  const { cols = COVERAGE_COLS, rows = COVERAGE_ROWS, mask = null } = opts;
  const total = cols * rows;
  const cells = new Array(total).fill(false);
  const counts = new Array(total).fill(0);
  const errSum = new Array(total).fill(0);
  const valid = mask || new Array(total).fill(true);
  const validTotal = valid.reduce((n, v) => n + (v ? 1 : 0), 0) || total;

  const empty = () => ({
    cells, counts, meanErr: new Array(total).fill(null), mask: valid,
    filled: 0, total: validTotal, percent: 0,
  });
  if (!residuals?.length || !imageSize) return empty();
  const [w, h] = imageSize;
  if (!w || !h) return empty();

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
      if (!valid[idx]) continue;            // outside FOV — not coverable
      cells[idx] = true;
      counts[idx] += 1;
      const ex = corner[2], ey = corner[3];
      if (Number.isFinite(ex) && Number.isFinite(ey)) errSum[idx] += Math.hypot(ex, ey);
    }
  }

  const meanErr = counts.map((n, i) => (n > 0 ? errSum[i] / n : null));
  const filled = cells.reduce((n, on, i) => n + (on && valid[i] ? 1 : 0), 0);
  return { cells, counts, meanErr, mask: valid, filled, total: validTotal, percent: Math.round((filled / validTotal) * 100) };
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
