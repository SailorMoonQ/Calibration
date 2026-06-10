// Polar ("dartboard") coverage for circular fisheye lenses.
//
// A rectangular grid is the wrong model for a fisheye: the valid image is a
// CIRCLE, and what calibration actually needs is samples spread across
// incidence angle (centre → edge) and around every direction. So we bin the
// detected board into concentric RINGS × angular SECTORS laid over the image
// circle:
//   • ring 0 is a single centre disk (sectors are meaningless near the centre),
//   • rings 1…RINGS-1 are split into SECTORS wedges.
// Flat index layout: centre = 0, then ring r (≥1), sector s → 1 + (r-1)*SECTORS + s.
//
// None of this touches the calibration solver — it only decides what the live
// overlay shows and which cells a snapped frame marks as covered.

export const RINGS = 3;
export const SECTORS = 8;

export function totalPolarCells(rings = RINGS, sectors = SECTORS) {
  return 1 + (rings - 1) * sectors;
}

export function polarIndex(ring, sector, sectors = SECTORS) {
  if (ring <= 0) return 0;
  return 1 + (ring - 1) * sectors + ((sector % sectors) + sectors) % sectors;
}

// Which polar cell does an image point fall in? Returns a flat index, or null
// when the point lies outside the circle (i.e. in the black border / corners).
export function polarCellAt(x, y, circle, rings = RINGS, sectors = SECTORS) {
  if (!circle || !circle.r) return null;
  const dx = x - circle.cx, dy = y - circle.cy;
  const rn = Math.hypot(dx, dy) / circle.r;
  if (!Number.isFinite(rn) || rn > 1) return null;
  const ring = Math.min(rings - 1, Math.floor(rn * rings));
  if (ring === 0) return 0;
  let ang = Math.atan2(dy, dx);            // -π…π
  if (ang < 0) ang += Math.PI * 2;          // 0…2π
  const sector = Math.min(sectors - 1, Math.floor((ang / (Math.PI * 2)) * sectors));
  return polarIndex(ring, sector, sectors);
}

// Per-cell corner tally for ONE frame ([[x, y], …]).
export function binPolar(corners, circle, rings = RINGS, sectors = SECTORS) {
  const counts = new Array(totalPolarCells(rings, sectors)).fill(0);
  if (!corners?.length || !circle) return counts;
  for (const c of corners) {
    const idx = polarCellAt(c[0], c[1], circle, rings, sectors);
    if (idx != null) counts[idx] += 1;
  }
  return counts;
}

// Geometry of every cell, for drawing the dartboard and placing guidance.
// Angles in radians, radii in pixels. Centre cell has a0/a1 spanning the full
// circle. Returns [{ index, ring, sector, r0, r1, a0, a1, midR, midA, x, y }].
export function polarCellGeometry(circle, rings = RINGS, sectors = SECTORS) {
  const out = [];
  if (!circle) return out;
  const { cx, cy, r } = circle;
  const push = (index, ring, sector, r0, r1, a0, a1) => {
    const midR = (r0 + r1) / 2, midA = (a0 + a1) / 2;
    out.push({ index, ring, sector, r0, r1, a0, a1, midR, midA,
      x: cx + Math.cos(midA) * midR, y: cy + Math.sin(midA) * midR });
  };
  push(0, 0, 0, 0, (r / rings), 0, Math.PI * 2);
  for (let ring = 1; ring < rings; ring++) {
    const r0 = (ring / rings) * r, r1 = ((ring + 1) / rings) * r;
    for (let s = 0; s < sectors; s++) {
      const a0 = (s / sectors) * Math.PI * 2, a1 = ((s + 1) / sectors) * Math.PI * 2;
      push(polarIndex(ring, s, sectors), ring, s, r0, r1, a0, a1);
    }
  }
  return out;
}

// Pick the cell to guide the user toward next: the emptiest cell, breaking ties
// toward the outer rings (the high-distortion edge that matters most and is the
// hardest to fill). Returns a flat index, or null when everything has ≥1 capture.
export function pickGuidanceCell(counts, rings = RINGS, sectors = SECTORS) {
  if (!counts?.length) return null;
  const geo = polarCellGeometry({ cx: 0, cy: 0, r: 1 }, rings, sectors);
  let best = null, bestScore = Infinity;
  for (const g of geo) {
    const n = counts[g.index] ?? 0;
    // lower count wins; among equal counts, larger ring (outer) wins → subtract ring.
    const score = n * 100 - g.ring;
    if (score < bestScore) { bestScore = score; best = g.index; }
  }
  // Only guide while something is still empty; once all covered, stop nagging.
  return counts[best] === 0 ? best : null;
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

// Detect the fisheye image circle from a frame's pixels (RGBA Uint8ClampedArray).
// Uses the ANGULAR-AVERAGED radial brightness profile: at each radius we average
// luminance over many angles, then take the radius where the profile first falls
// below half the inner-disk mean. Averaging over angle is what makes this robust
// — dark scene content (the black checker squares, a person's clothing) only dips
// individual rays, but the border is dark at every angle, so it dominates the
// mean. Returns { cx, cy, r } or null when no clear disk is found.
export function detectCircleFromImageData(data, w, h) {
  if (!data || !w || !h) return null;
  const STEP = 2, ANG = 64;
  const lum = (x, y) => {
    const xi = x | 0, yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -1;
    const i = (yi * w + xi) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };

  // Centre = centroid of the lit disk, not the geometric image centre. The
  // fisheye image disk is the only bright region (its surround is the lens's
  // black border), so a luminance-thresholded centroid pins the optical centre —
  // which matters because the polar rings are drawn around this point and a real
  // lens's centre is usually offset from w/2,h/2. Falls back to dead-centre only
  // when the threshold finds nothing usable.
  const THRESH = 30;
  let csx = 0, csy = 0, lit = 0;
  for (let y = 0; y < h; y += STEP) {
    for (let x = 0; x < w; x += STEP) {
      if (lum(x, y) >= THRESH) { csx += x; csy += y; lit++; }
    }
  }
  const sampled = Math.ceil(w / STEP) * Math.ceil(h / STEP);
  if (lit < sampled * 0.05) return null;          // too dark to be a real image
  const cx = Math.min(w - 1, Math.max(0, csx / lit));
  const cy = Math.min(h - 1, Math.max(0, csy / lit));

  const maxR = Math.min(w, h) * 0.62;            // a bit past the half-height edge
  const rs = [];
  for (let r = 0; r < maxR; r += STEP) rs.push(r);
  const prof = new Array(rs.length).fill(0);
  for (let k = 0; k < rs.length; k++) {
    const r = rs[k];
    let sum = 0, n = 0;
    for (let a = 0; a < ANG; a++) {
      const ang = (a / ANG) * Math.PI * 2;
      const v = lum(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
      if (v >= 0) { sum += v; n++; }
    }
    prof[k] = n ? sum / n : 0;
  }
  const q = Math.max(1, rs.length >> 2);
  let inSum = 0;
  for (let k = 0; k < q; k++) inSum += prof[k];
  const inner = inSum / q;
  if (inner < 25) return null;                   // too dark to be a real image
  const half = inner * 0.5;
  let edge = maxR;
  for (let k = 0; k < rs.length; k++) {
    if (rs[k] > maxR * 0.3 && prof[k] < half) { edge = rs[k]; break; }
  }
  if (!Number.isFinite(edge) || edge < Math.min(w, h) * 0.2) return null;
  return { cx, cy, r: edge };
}
