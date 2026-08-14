// Shared calibration-target defaults so every tab agrees on what an
// "uncustomised" board looks like. Each tab still renders its own
// <TargetPanel> and holds its own board state — only the initial value
// is centralised here, so the user can pick once and we don't ship four
// inconsistent defaults.
//
// 11 cols × 8 rows is the de-facto board the rig comes shipped with;
// 0.045 m squares match the printed pattern. Charuco markers are 0.75 ×
// the square (standard convention for the OpenCV ChArUco generator).
export const DEFAULT_BOARD_COLS = 11;
export const DEFAULT_BOARD_ROWS = 8;
export const DEFAULT_BOARD_SQUARE_M = 0.045;
export const DEFAULT_BOARD_MARKER_M = 0.034;  // ≈ 0.75 × square
export const DEFAULT_BOARD_DICT = 'DICT_5X5_100';

// The dictionaries the backend actually accepts (_io._ARUCO_DICTS). Anything
// else silently falls back to DICT_5X5_100 there, so the picker must not offer
// options that don't exist.
export const BOARD_DICTS = Object.freeze([
  'DICT_4X4_50', 'DICT_4X4_100',
  'DICT_5X5_50', 'DICT_5X5_100',
  'DICT_6X6_250', 'DICT_7X7_250',
]);

export const DEFAULT_BOARD = Object.freeze({
  type: 'charuco',
  cols: DEFAULT_BOARD_COLS,
  rows: DEFAULT_BOARD_ROWS,
  sq:   DEFAULT_BOARD_SQUARE_M,
  marker: DEFAULT_BOARD_MARKER_M,
  dictionary: DEFAULT_BOARD_DICT,
});

// Convenience for tabs that historically used the plain chess board
// (extrinsics / intrinsics / fisheye). Same dimensions, no marker —
// the user can still flip type → charuco via the panel and a marker
// field appears.
export const DEFAULT_CHESS_BOARD = Object.freeze({
  type: 'chess',
  cols: DEFAULT_BOARD_COLS,
  rows: DEFAULT_BOARD_ROWS,
  sq:   DEFAULT_BOARD_SQUARE_M,
  dictionary: DEFAULT_BOARD_DICT,
});
