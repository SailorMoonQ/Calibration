import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COVERAGE_COLS, COVERAGE_ROWS, cellGeometry, pickGuidanceCell, cellIndexFor,
} from './coverage.js';

const SIZE = [800, 500];              // 8x5 grid => each cell 100x100
const TOTAL = COVERAGE_COLS * COVERAGE_ROWS;

test('cellGeometry returns one centre per cell, row-major', () => {
  const geo = cellGeometry(SIZE);
  assert.equal(geo.length, TOTAL);
  assert.deepEqual(geo[0], { index: 0, x: 50, y: 50 });
  assert.deepEqual(geo[7], { index: 7, x: 750, y: 50 });
  assert.deepEqual(geo[8], { index: 8, x: 50, y: 150 });
  assert.deepEqual(geo[TOTAL - 1], { index: TOTAL - 1, x: 750, y: 450 });
});

test('cellGeometry centres round-trip through cellIndexFor', () => {
  for (const g of cellGeometry(SIZE)) {
    assert.equal(cellIndexFor(g.x, g.y, SIZE), g.index);
  }
});

test('cellGeometry returns empty without a usable size', () => {
  assert.deepEqual(cellGeometry(null), []);
  assert.deepEqual(cellGeometry([0, 500]), []);
});

test('pickGuidanceCell returns null once every cell has a capture', () => {
  assert.equal(pickGuidanceCell(new Array(TOTAL).fill(1)), null);
  assert.equal(pickGuidanceCell(null), null);
  assert.equal(pickGuidanceCell([]), null);
});

test('pickGuidanceCell picks an empty cell', () => {
  const counts = new Array(TOTAL).fill(3);
  counts[19] = 0;
  assert.equal(pickGuidanceCell(counts), 19);
});

test('pickGuidanceCell breaks ties toward the outer ring', () => {
  const counts = new Array(TOTAL).fill(3);
  counts[20] = 0;   // col 4, row 2 — dead centre (ring 0)
  counts[39] = 0;   // col 7, row 4 — corner (ring 2), and a LATER index than 20,
                    // so a no-op tie-break would return 20 and only a working
                    // ring weighting returns 39.
  assert.equal(pickGuidanceCell(counts), 39);
});

test('pickGuidanceCell skips masked-out cells', () => {
  const counts = new Array(TOTAL).fill(3);
  counts[0] = 0;
  const mask = new Array(TOTAL).fill(true);
  mask[0] = false;                 // the only empty cell is not coverable
  assert.equal(pickGuidanceCell(counts, mask), null);
});
