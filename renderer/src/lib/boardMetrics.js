// Geometry-neutral measurements of a detected calibration board.
//
// Everything here works off the raw corner list ([[x,y], …], row-major as
// OpenCV returns it) and knows nothing about the camera model — a fisheye and a
// pinhole board are measured identically. The camera-model-specific part is the
// EXTENT the measurement is normalised against (see below).
//
// An "extent" is the region of the image a board can meaningfully live in:
//   • fisheye → the detected image circle, as {cx, cy, rx: r, ry: r}
//   • pinhole → the whole frame,           as {cx: w/2, cy: h/2, rx: w/2, ry: h/2}
// Because a fisheye extent always has rx === ry, every formula below that takes
// min(rx, ry) reduces to the old circle-radius form exactly — that identity is
// what lets the fisheye path stay numerically unchanged.

export function extentFromCircle(circle) {
  if (!circle || !circle.r) return null;
  return { cx: circle.cx, cy: circle.cy, rx: circle.r, ry: circle.r };
}

export function extentFromImageSize(imageSize) {
  if (!imageSize) return null;
  const [w, h] = imageSize;
  if (!w || !h) return null;
  return { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 };
}

// The inscribed radius — the half-axis a board is guaranteed to fit within in
// every direction. All scale/acceptance thresholds normalise against this.
export function minRadius(extent) {
  if (!extent) return 0;
  return Math.min(extent.rx, extent.ry);
}

// Centroid of the detected corners.
export function cornersCentroid(corners) {
  if (!corners?.length) return null;
  let sx = 0, sy = 0;
  for (const c of corners) { sx += c[0]; sy += c[1]; }
  return { x: sx / corners.length, y: sy / corners.length };
}

// Board tilt proxy (degrees), with no need for intrinsics. From the four outer
// corners of the chessboard quad we measure how far its interior angles deviate
// from 90°: a fronto-parallel board projects to a near-rectangle (≈0°), while a
// tilted board's perspective skews the angles. Used to enforce *orientation*
// diversity (not just position) during capture. Returns null if corners are short.
export function boardTiltDeg(corners, cols, rows) {
  const n = cols * rows;
  if (!corners || corners.length < n) return null;
  const quad = [corners[0], corners[cols - 1], corners[n - 1], corners[cols * (rows - 1)]];
  const ang = (p, c, q) => {
    const v1x = p[0] - c[0], v1y = p[1] - c[1], v2x = q[0] - c[0], v2y = q[1] - c[1];
    const d = (v1x * v2x + v1y * v2y) / ((Math.hypot(v1x, v1y) || 1) * (Math.hypot(v2x, v2y) || 1));
    return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
  };
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.abs(ang(quad[(i + 3) % 4], quad[i], quad[(i + 1) % 4]) - 90);
  return s / 4;
}

// In-plane rotation (roll) proxy in degrees, |angle| ∈ [0,45]. From the board's
// top edge (corner 0 → corner cols-1) measured against the image horizontal.
// A chessboard reads the same every 90°, so we fold into [-45,45] and take |·|.
// Unlike boardTiltDeg (which only sees perspective skew), this catches a board
// rotated like a clock face while staying fronto-parallel.
export function boardRollDeg(corners, cols) {
  if (!corners || corners.length < cols) return null;
  const a = corners[0], b = corners[cols - 1];
  let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;  // -180…180
  deg = ((deg % 90) + 90) % 90;          // 0…90
  if (deg > 45) deg -= 90;               // -45…45
  return Math.abs(deg);
}

// Apparent board size: span of the four outer corners / the extent's inscribed
// diameter. ~1 means the board fills the short axis; small means it's far away.
export function boardScale(corners, cols, rows, extent) {
  const n = cols * rows;
  const r = minRadius(extent);
  if (!corners || corners.length < n || !r) return null;
  const quad = [corners[0], corners[cols - 1], corners[n - 1], corners[cols * (rows - 1)]];
  let maxD = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    maxD = Math.max(maxD, Math.hypot(quad[i][0] - quad[j][0], quad[i][1] - quad[j][1]));
  }
  return maxD / (2 * r);
}

// One-shot analysis of the live board for the guided gates + overlay.
export function analyzeBoard(corners, board, extent) {
  const cols = board?.cols ?? 9, rows = board?.rows ?? 6;
  return {
    centroid: cornersCentroid(corners),
    tilt: boardTiltDeg(corners, cols, rows),
    roll: boardRollDeg(corners, cols),
    scale: boardScale(corners, cols, rows, extent),
  };
}
