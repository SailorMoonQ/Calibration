import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extentFromCircle, extentFromImageSize, minRadius,
  cornersCentroid, boardTiltDeg, boardRollDeg, boardScale, analyzeBoard,
} from './boardMetrics.js';

// A 3x2 fronto-parallel board (row-major, like OpenCV's findChessboardCorners),
// 100px wide, 50px tall, top-left at (100, 100).
const FLAT = [
  [100, 100], [150, 100], [200, 100],
  [100, 150], [150, 150], [200, 150],
];
const COLS = 3, ROWS = 2;

test('extentFromCircle turns a circle into a square extent', () => {
  assert.deepEqual(extentFromCircle({ cx: 10, cy: 20, r: 5 }), { cx: 10, cy: 20, rx: 5, ry: 5 });
  assert.equal(extentFromCircle(null), null);
});

test('extentFromImageSize covers the whole rectangle', () => {
  assert.deepEqual(extentFromImageSize([640, 480]), { cx: 320, cy: 240, rx: 320, ry: 240 });
  assert.equal(extentFromImageSize(null), null);
  assert.equal(extentFromImageSize([0, 480]), null);
});

test('minRadius takes the smaller half-axis', () => {
  assert.equal(minRadius({ cx: 0, cy: 0, rx: 320, ry: 240 }), 240);
  assert.equal(minRadius({ cx: 0, cy: 0, rx: 5, ry: 5 }), 5);
  assert.equal(minRadius(null), 0);
});

test('cornersCentroid averages the corners', () => {
  assert.deepEqual(cornersCentroid(FLAT), { x: 150, y: 125 });
  assert.equal(cornersCentroid([]), null);
  assert.equal(cornersCentroid(null), null);
});

test('boardTiltDeg reads ~0 for a fronto-parallel board', () => {
  const tilt = boardTiltDeg(FLAT, COLS, ROWS);
  assert.ok(tilt !== null && tilt < 0.5, `expected ~0, got ${tilt}`);
});

test('boardTiltDeg grows when the board is perspective-skewed', () => {
  // top edge shortened toward the centre => trapezoid => non-90° interior angles
  const skew = [
    [125, 100], [150, 100], [175, 100],
    [100, 150], [150, 150], [200, 150],
  ];
  const tilt = boardTiltDeg(skew, COLS, ROWS);
  assert.ok(tilt > 10, `expected a clear tilt, got ${tilt}`);
});

test('boardTiltDeg returns null when corners are short', () => {
  assert.equal(boardTiltDeg([[0, 0]], COLS, ROWS), null);
  assert.equal(boardTiltDeg(null, COLS, ROWS), null);
});

test('boardRollDeg reads 0 for a level board and ~30 for a rotated one', () => {
  assert.ok(boardRollDeg(FLAT, COLS) < 0.001);
  // top edge rotated 30° clockwise about corner 0
  const a = (30 * Math.PI) / 180;
  const rolled = FLAT.map(([x, y]) => {
    const dx = x - 100, dy = y - 100;
    return [100 + dx * Math.cos(a) - dy * Math.sin(a), 100 + dx * Math.sin(a) + dy * Math.cos(a)];
  });
  assert.ok(Math.abs(boardRollDeg(rolled, COLS) - 30) < 0.001);
});

test('boardRollDeg folds into [0,45] — a 60° rotation reads as 30', () => {
  const a = (60 * Math.PI) / 180;
  const rolled = FLAT.map(([x, y]) => {
    const dx = x - 100, dy = y - 100;
    return [100 + dx * Math.cos(a) - dy * Math.sin(a), 100 + dx * Math.sin(a) + dy * Math.cos(a)];
  });
  assert.ok(Math.abs(boardRollDeg(rolled, COLS) - 30) < 0.001);
});

test('boardScale divides the quad span by the extent diameter', () => {
  // quad corners: (100,100) (200,100) (200,150) (100,150) => max diagonal ~111.803
  const span = Math.hypot(100, 50);
  assert.ok(Math.abs(boardScale(FLAT, COLS, ROWS, { cx: 0, cy: 0, rx: 100, ry: 100 }) - span / 200) < 1e-9);
  // a non-square extent uses the SHORTER half-axis
  assert.ok(Math.abs(boardScale(FLAT, COLS, ROWS, { cx: 0, cy: 0, rx: 320, ry: 240 }) - span / 480) < 1e-9);
  assert.equal(boardScale(FLAT, COLS, ROWS, null), null);
});

test('analyzeBoard bundles the four measurements', () => {
  const m = analyzeBoard(FLAT, { cols: COLS, rows: ROWS }, { cx: 0, cy: 0, rx: 100, ry: 100 });
  assert.deepEqual(m.centroid, { x: 150, y: 125 });
  assert.ok(m.tilt < 0.5);
  assert.ok(m.roll < 0.001);
  assert.ok(m.scale > 0);
});
