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

import { analyzeBoard, boardScale, minRadius } from './boardMetrics.js';

// Re-exported so existing consumers (LiveDetectedFrame, FisheyeTab) keep one
// import site for "the guided sequence's view of the board".
export { analyzeBoard, boardScale };

// ── Pose / scale acceptance profiles ─────────────────────────────────────────
// The checklist itself (GUIDED_STEPS) and the region layout (REGIONS) are
// camera-model-independent — "put the board top-left, tilt it" means the same
// thing through any lens. What DOES differ is how much a given physical pose
// shows up in the picture, so the acceptance thresholds are per-model.
//
// TILT_* are readings of the boardTiltDeg perspective proxy, kept LOW on purpose.
// The limiter is not detectability but the auto-capture gate: a tilt step needs
// the pose held STILL + SHARP + continuously detected through the 500ms dwell,
// and the fast live detector drops out intermittently while the board is moving.
// A reading an operator can comfortably SUSTAIN tops out around 13–16° on a
// fisheye, so accept from 10° there.
export const FISHEYE_PROFILE = {
  name: 'fisheye',
  TILT_FRONTAL_MAX: 12,   // a "正对" frame must be flatter than this (deg)
  TILT_MIN: 10,           // a tilt/yaw frame must skew at least this much
  ROLL_MIN: 15,           // an in-plane roll frame must rotate at least this
  ROLL_FRONTAL_MAX: 12,   // ...while staying roughly fronto-parallel
  // board span / extent diameter. On real fisheye captures a board that visually
  // "fills the frame" still only spans ~0.55–0.65 of the circle diameter (the
  // periphery is heavily compressed), so NEAR sits where a genuine close-in shot
  // lands rather than at 1.0. Validated against the /tmp/1 + /tmp/4 sample sets.
  SCALE_NEAR: 0.54,       // "拉近占满"
  SCALE_FAR: 0.38,        // "推远变小"
};

// A pinhole lens has a narrower field of view and no radial compression, so:
//   • the same physical tilt produces LESS perspective skew → lower tilt gates;
//   • a board that fills the frame really does span ~0.9 of the short axis
//     (vs ~0.6 on a fisheye) → higher scale gates.
// NOTE: these four values are derived from the geometry, NOT yet validated on a
// real pinhole capture session. They only affect WHEN guided auto-capture fires,
// never the calibration result — retune against real footage.
export const PINHOLE_PROFILE = {
  name: 'pinhole',
  TILT_FRONTAL_MAX: 10,
  TILT_MIN: 7,
  ROLL_MIN: 15,
  ROLL_FRONTAL_MAX: 12,
  SCALE_NEAR: 0.75,
  SCALE_FAR: 0.40,
};

// region acceptance radius, as a fraction of the extent's inscribed radius
const ACCEPT_CENTER = 0.38;
const ACCEPT_OFF = 0.42;

// Region unit-direction (screen coords: x right, y down) + radial fraction of
// the extent's half-axes where the board centroid should sit.
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

// Target point for a step's region, in image-pixel coords, plus the acceptance
// radius (px). x scales with rx and y with ry, so a wide pinhole frame reaches
// its real left/right edges; on a square (fisheye) extent this reduces exactly
// to the old circle form. Returns null without an extent.
export function regionTarget(region, extent) {
  if (!extent) return null;
  const r = REGIONS[region] || REGIONS.center;
  const L = Math.hypot(r.ux, r.uy) || 1;
  return {
    x: extent.cx + (r.ux / L) * r.rf * extent.rx,
    y: extent.cy + (r.uy / L) * r.rf * extent.ry,
    acceptR: r.accept * minRadius(extent),
  };
}

export function regionOk(step, m, extent) {
  const t = regionTarget(step.region, extent);
  if (!t || !m.centroid) return false;
  return Math.hypot(m.centroid.x - t.x, m.centroid.y - t.y) <= t.acceptR;
}

// Does the live board's orientation/size satisfy the step's pose requirement?
export function poseOk(step, m, profile = FISHEYE_PROFILE) {
  switch (step.pose) {
    case 'frontal':
      return m.tilt != null && m.tilt <= profile.TILT_FRONTAL_MAX
        && (m.roll == null || m.roll <= profile.TILT_FRONTAL_MAX + 6);
    case 'tilted':
      return m.tilt != null && m.tilt >= profile.TILT_MIN;
    case 'roll':
      return m.roll != null && m.roll >= profile.ROLL_MIN
        && (m.tilt == null || m.tilt <= profile.ROLL_FRONTAL_MAX + 8);
    case 'dist':
      if (m.scale == null) return false;
      if (step.scale === 'near') return m.scale >= profile.SCALE_NEAR;
      if (step.scale === 'far') return m.scale <= profile.SCALE_FAR;
      return m.scale > profile.SCALE_FAR && m.scale < profile.SCALE_NEAR;  // 'mid'
    default:
      return true;
  }
}

// The two-shots-per-action rule: the SECOND shot must differ from the first by a
// small but real amount, so we bank a slightly varied view rather than a near
// duplicate. A nudge in tilt, roll, or position all count.
export function differsEnough(sig, m, extent) {
  if (!sig || !m) return true;
  if (m.tilt != null && sig.tilt != null && Math.abs(m.tilt - sig.tilt) >= 2) return true;
  if (m.roll != null && sig.roll != null && Math.abs(m.roll - sig.roll) >= 2) return true;
  if (m.scale != null && sig.scale != null && Math.abs(m.scale - sig.scale) >= 0.025) return true;
  const r = minRadius(extent);
  if (m.centroid && sig.centroid && r) {
    if (Math.hypot(m.centroid.x - sig.centroid.x, m.centroid.y - sig.centroid.y) >= r * 0.03) return true;
  }
  return false;
}

// A signature of a captured shot, for the differsEnough check on the next one.
export function shotSignature(m) {
  return m ? { tilt: m.tilt, roll: m.roll, scale: m.scale, centroid: m.centroid } : null;
}

// Recommended on-screen half-size of the target board, as a fraction of the
// extent's inscribed radius — bigger for centre/near, smaller for edges/far
// (docs/fisheye-calibration-howto.md §3: a centred board should fill ~1/3–1/2 of
// the frame, edge boards may be smaller). Aspect ≈ the real board's cols:rows so
// the operator matches shape, not just position.
export function targetHalfSize(step, extent, bCols, bRows) {
  const r = minRadius(extent);
  let frac;
  if (step.pose === 'dist') frac = step.scale === 'near' ? 0.5 : step.scale === 'far' ? 0.27 : 0.38;
  else if (step.group === 'edge') frac = 0.27;
  else if (step.region === 'center') frac = 0.42;
  else frac = 0.34;
  const halfW = frac * r;
  return { halfW, halfH: halfW * (bRows / Math.max(1, bCols)) };
}
