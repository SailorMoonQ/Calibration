// Document-driven guided capture sequence for the fisheye tab.
//
// The polar "dartboard" mode (polarCoverage.js) is hands-free area sampling:
// sweep the board around and let novelty/tilt gates decide when to snap. This
// module is the OTHER auto-capture mode — a scripted checklist that mirrors the
// operator manual (docs/fisheye-calibration-howto.md §2): walk the board through
// a fixed ordered list of positions+poses, two shots per action, then advance.
//
// Nothing here touches the solver. It only decides, for the currently active
// step, where the board should sit, what orientation it should be at, and
// whether the live board matches — driving the on-frame guidance overlay and the
// guided auto-capture state machine in FisheyeTab.

import { boardTiltDeg } from './polarCoverage.js';

// ── Pose / scale acceptance thresholds (heuristic, no intrinsics needed) ──────
const TILT_FRONTAL_MAX = 14;   // a "正对" frame must be flatter than this (deg)
const TILT_MIN = 22;           // a tilt/yaw frame must skew at least this much
const ROLL_MIN = 15;           // an in-plane roll frame must rotate at least this
const ROLL_FRONTAL_MAX = 12;   // ...while staying roughly fronto-parallel
// board span / image-circle diameter. On real fisheye captures a board that
// visually "fills the frame" still only spans ~0.55–0.65 of the circle diameter
// (the periphery is heavily compressed), so NEAR is set where a genuine close-in
// shot lands rather than at 1.0. Validated against /tmp/1 + /tmp/4 sample sets.
const SCALE_NEAR = 0.54;       // "拉近占满"
const SCALE_FAR = 0.38;        // "推远变小"
// region acceptance radius, as a fraction of the image-circle radius
const ACCEPT_CENTER = 0.38;
const ACCEPT_OFF = 0.42;

// Region unit-direction (screen coords: x right, y down) + radial fraction of
// the image-circle radius where the board centroid should sit.
const REGIONS = {
  center: { ux: 0,  uy: 0,  rf: 0.0,  accept: ACCEPT_CENTER },
  tl:     { ux: -1, uy: -1, rf: 0.55, accept: ACCEPT_OFF },
  tr:     { ux: 1,  uy: -1, rf: 0.55, accept: ACCEPT_OFF },
  bl:     { ux: -1, uy: 1,  rf: 0.55, accept: ACCEPT_OFF },
  br:     { ux: 1,  uy: 1,  rf: 0.55, accept: ACCEPT_OFF },
  top:    { ux: 0,  uy: -1, rf: 0.82, accept: ACCEPT_OFF },
  bottom: { ux: 0,  uy: 1,  rf: 0.82, accept: ACCEPT_OFF },
  left:   { ux: -1, uy: 0,  rf: 0.82, accept: ACCEPT_OFF },
  right:  { ux: 1,  uy: 0,  rf: 0.82, accept: ACCEPT_OFF },
};

// The ordered checklist. Counts ≈ the manual's §2 table; every action wants two
// shots (`shots: 2`) so a tiny variation is captured rather than a single frame.
//   region  → where the board centroid should land (see REGIONS)
//   pose    → 'frontal' | 'tilted' | 'roll' | 'dist'
//   scale   → for pose 'dist': 'near' | 'far' | 'mid'
//   glyph   → overlay hint shape: 'frontal'|'tiltV'|'tiltH'|'roll'|'near'|'far'|'mid'
export const GUIDED_STEPS = [
  { id: 'f_center', group: 'frontal', region: 'center', pose: 'frontal', glyph: 'frontal', shots: 2 },
  { id: 'f_tl',     group: 'frontal', region: 'tl',     pose: 'frontal', glyph: 'frontal', shots: 2 },
  { id: 'f_tr',     group: 'frontal', region: 'tr',     pose: 'frontal', glyph: 'frontal', shots: 2 },
  { id: 'f_bl',     group: 'frontal', region: 'bl',     pose: 'frontal', glyph: 'frontal', shots: 2 },
  { id: 'f_br',     group: 'frontal', region: 'br',     pose: 'frontal', glyph: 'frontal', shots: 2 },

  { id: 'e_top',    group: 'edge', region: 'top',    pose: 'frontal', glyph: 'frontal', shots: 2 },
  { id: 'e_bottom', group: 'edge', region: 'bottom', pose: 'frontal', glyph: 'frontal', shots: 2 },
  { id: 'e_left',   group: 'edge', region: 'left',   pose: 'frontal', glyph: 'frontal', shots: 2 },
  { id: 'e_right',  group: 'edge', region: 'right',  pose: 'frontal', glyph: 'frontal', shots: 2 },

  { id: 't_fwd',  group: 'tilt', region: 'center', pose: 'tilted', glyph: 'tiltV', shots: 2 },
  { id: 't_back', group: 'tilt', region: 'center', pose: 'tilted', glyph: 'tiltV', shots: 2 },

  { id: 'y_left',  group: 'yaw', region: 'center', pose: 'tilted', glyph: 'tiltH', shots: 2 },
  { id: 'y_right', group: 'yaw', region: 'center', pose: 'tilted', glyph: 'tiltH', shots: 2 },

  { id: 'r_roll', group: 'roll', region: 'center', pose: 'roll', glyph: 'roll', shots: 2 },

  { id: 'd_near', group: 'dist', region: 'center', pose: 'dist', scale: 'near', glyph: 'near', shots: 2 },
  { id: 'd_far',  group: 'dist', region: 'center', pose: 'dist', scale: 'far',  glyph: 'far',  shots: 2 },
  { id: 'd_mid',  group: 'dist', region: 'center', pose: 'dist', scale: 'mid',  glyph: 'mid',  shots: 2 },
];

export const GUIDED_TOTAL_SHOTS = GUIDED_STEPS.reduce((n, s) => n + s.shots, 0);

// Centroid of the detected corners ([[x,y],…]).
export function cornersCentroid(corners) {
  if (!corners?.length) return null;
  let sx = 0, sy = 0;
  for (const c of corners) { sx += c[0]; sy += c[1]; }
  return { x: sx / corners.length, y: sy / corners.length };
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

// Apparent board size: span of the four outer corners / image-circle diameter.
// ~1 means the board fills the circle; small means it's far away.
export function boardScale(corners, cols, rows, circle) {
  const n = cols * rows;
  if (!corners || corners.length < n || !circle?.r) return null;
  const quad = [corners[0], corners[cols - 1], corners[n - 1], corners[cols * (rows - 1)]];
  let maxD = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    maxD = Math.max(maxD, Math.hypot(quad[i][0] - quad[j][0], quad[i][1] - quad[j][1]));
  }
  return maxD / (2 * circle.r);
}

// One-shot analysis of the live board for the guided gates + overlay.
export function analyzeBoard(corners, board, circle) {
  const cols = board?.cols ?? 9, rows = board?.rows ?? 6;
  return {
    centroid: cornersCentroid(corners),
    tilt: boardTiltDeg(corners, cols, rows),
    roll: boardRollDeg(corners, cols),
    scale: boardScale(corners, cols, rows, circle),
  };
}

// Target point for a step's region, in image-pixel coords, plus the acceptance
// radius (px). Returns null without a circle.
export function regionTarget(region, circle) {
  if (!circle) return null;
  const r = REGIONS[region] || REGIONS.center;
  const L = Math.hypot(r.ux, r.uy) || 1;
  return {
    x: circle.cx + (r.ux / L) * r.rf * circle.r,
    y: circle.cy + (r.uy / L) * r.rf * circle.r,
    acceptR: r.accept * circle.r,
  };
}

export function regionOk(step, m, circle) {
  const t = regionTarget(step.region, circle);
  if (!t || !m.centroid) return false;
  return Math.hypot(m.centroid.x - t.x, m.centroid.y - t.y) <= t.acceptR;
}

// Does the live board's orientation/size satisfy the step's pose requirement?
export function poseOk(step, m) {
  switch (step.pose) {
    case 'frontal':
      return m.tilt != null && m.tilt <= TILT_FRONTAL_MAX
        && (m.roll == null || m.roll <= TILT_FRONTAL_MAX + 6);
    case 'tilted':
      return m.tilt != null && m.tilt >= TILT_MIN;
    case 'roll':
      return m.roll != null && m.roll >= ROLL_MIN
        && (m.tilt == null || m.tilt <= ROLL_FRONTAL_MAX + 8);
    case 'dist':
      if (m.scale == null) return false;
      if (step.scale === 'near') return m.scale >= SCALE_NEAR;
      if (step.scale === 'far') return m.scale <= SCALE_FAR;
      return m.scale > SCALE_FAR && m.scale < SCALE_NEAR;  // 'mid'
    default:
      return true;
  }
}

// The two-shots-per-action rule: the SECOND shot must differ from the first by a
// small but real amount, so we bank a slightly varied view rather than a near
// duplicate. A nudge in tilt, roll, or position all count.
export function differsEnough(sig, m, circle) {
  if (!sig || !m) return true;
  if (m.tilt != null && sig.tilt != null && Math.abs(m.tilt - sig.tilt) >= 3) return true;
  if (m.roll != null && sig.roll != null && Math.abs(m.roll - sig.roll) >= 3) return true;
  if (m.centroid && sig.centroid && circle?.r) {
    if (Math.hypot(m.centroid.x - sig.centroid.x, m.centroid.y - sig.centroid.y) >= circle.r * 0.05) return true;
  }
  return false;
}

// A signature of a captured shot, for the differsEnough check on the next one.
export function shotSignature(m) {
  return m ? { tilt: m.tilt, roll: m.roll, centroid: m.centroid } : null;
}
