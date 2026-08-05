import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePolarGeometry, makeRectGeometry } from './geometry.js';
import { totalPolarCells, polarCellAt, binPolar, polarCellGeometry } from '../polarCoverage.js';
import { COVERAGE_COLS, COVERAGE_ROWS } from '../coverage.js';

const CIRCLE = { cx: 500, cy: 400, r: 300 };
const SIZE = [800, 500];

test('polar adapter reports the polar cell count and a square extent', () => {
  const g = makePolarGeometry(CIRCLE);
  assert.equal(g.kind, 'polar');
  assert.equal(g.totalCells, totalPolarCells());
  assert.deepEqual(g.extent, { cx: 500, cy: 400, rx: 300, ry: 300 });
});

test('polar adapter delegates bin / cellAt / cellCenter to polarCoverage', () => {
  const g = makePolarGeometry(CIRCLE);
  const corners = [[500, 400], [700, 400], [500, 600]];
  assert.deepEqual(g.bin(corners), binPolar(corners, CIRCLE));
  assert.equal(g.cellAt(500, 400), polarCellAt(500, 400, CIRCLE));
  const want = polarCellGeometry(CIRCLE).find(c => c.index === 3);
  assert.deepEqual(g.cellCenter(3), { x: want.x, y: want.y });
  assert.equal(g.cellCenter(9999), null);
});

test('polar adapter radialCue asks for "moveOut" only on a big outward jump', () => {
  const g = makePolarGeometry(CIRCLE);
  // target 200px further out than the current position; 200 > 300*0.33 = 99
  assert.equal(g.radialCue({ x: 500, y: 400 }, { x: 700, y: 400 }), 'moveOut');
  // only 50px further out => not a radial move
  assert.equal(g.radialCue({ x: 500, y: 400 }, { x: 550, y: 400 }), null);
  // moving inward is never "moveOut"
  assert.equal(g.radialCue({ x: 780, y: 400 }, { x: 520, y: 400 }), null);
});

test('polar adapter degrades safely without a circle', () => {
  const g = makePolarGeometry(null);
  assert.equal(g.extent, null);
  assert.equal(g.totalCells, totalPolarCells());
  assert.deepEqual(g.bin([[1, 2]]), new Array(totalPolarCells()).fill(0));
  assert.equal(g.cellAt(1, 2), null);
  assert.equal(g.cellCenter(0), null);
  assert.equal(g.radialCue({ x: 0, y: 0 }, { x: 1, y: 1 }), null);
});

test('rect adapter covers the whole frame', () => {
  const g = makeRectGeometry(SIZE);
  assert.equal(g.kind, 'rect');
  assert.equal(g.totalCells, COVERAGE_COLS * COVERAGE_ROWS);
  assert.deepEqual(g.extent, { cx: 400, cy: 250, rx: 400, ry: 250 });
  assert.equal(g.cellAt(50, 50), 0);
  assert.deepEqual(g.cellCenter(0), { x: 50, y: 50 });
});

test('rect adapter bins corners into cells', () => {
  const g = makeRectGeometry(SIZE);
  const counts = g.bin([[50, 50], [60, 60], [750, 450]]);
  assert.equal(counts[0], 2);
  assert.equal(counts[COVERAGE_COLS * COVERAGE_ROWS - 1], 1);
});

test('rect adapter has no radial semantics', () => {
  const g = makeRectGeometry(SIZE);
  assert.equal(g.radialCue({ x: 400, y: 250 }, { x: 750, y: 250 }), null);
});

test('rect adapter degrades safely without a size', () => {
  const g = makeRectGeometry(null);
  assert.equal(g.extent, null);
  assert.deepEqual(g.bin([[1, 2]]), new Array(COVERAGE_COLS * COVERAGE_ROWS).fill(0));
  assert.equal(g.cellAt(1, 2), null);
  assert.equal(g.cellCenter(0), null);
});

test('both adapters stop guiding once every cell has a capture', () => {
  const p = makePolarGeometry(CIRCLE);
  const r = makeRectGeometry(SIZE);
  assert.equal(p.pickGuidance(new Array(p.totalCells).fill(1)), null);
  assert.equal(r.pickGuidance(new Array(r.totalCells).fill(1)), null);
  const pc = new Array(p.totalCells).fill(1); pc[5] = 0;
  assert.equal(p.pickGuidance(pc), 5);
  const rc = new Array(r.totalCells).fill(1); rc[5] = 0;
  assert.equal(r.pickGuidance(rc), 5);
});
