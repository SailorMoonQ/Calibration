import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actualSquareMm, printedSizeMm, previewQuery } from './boardgen.js';

test('actualSquareMm reproduces the backend pixel rounding exactly', () => {
  // 25 mm at 300 dpi is 295.28 px/square, rendered as 295 → 24.9767 mm. The
  // dialog and the caption printed on the sheet must not disagree here.
  assert.ok(Math.abs(actualSquareMm(0.025, 300) - 24.9767) < 1e-3);
});

test('printedSizeMm counts charuco cols/rows as squares', () => {
  const board = { type: 'charuco', cols: 11, rows: 8, sq: 0.045, marker: 0.034 };
  const { w, h } = printedSizeMm(board, 300);
  assert.ok(Math.abs(w - 11 * actualSquareMm(0.045, 300)) < 1e-6);
  assert.ok(Math.abs(h - 8 * actualSquareMm(0.045, 300)) < 1e-6);
});

test('printedSizeMm counts chess cols/rows as inner corners, so one square more', () => {
  const board = { type: 'chess', cols: 9, rows: 6, sq: 0.025 };
  const { w, h } = printedSizeMm(board, 300);
  assert.ok(Math.abs(w - 10 * actualSquareMm(0.025, 300)) < 1e-6);
  assert.ok(Math.abs(h - 7 * actualSquareMm(0.025, 300)) < 1e-6);
});

test('previewQuery renames the renderer board fields to the backend parameters', () => {
  const board = { type: 'charuco', cols: 7, rows: 5, sq: 0.025, marker: 0.019,
                  dictionary: 'DICT_5X5_100' };

  const qs = previewQuery(board, { mode: 'page', dpi: 300, paper: 'A4',
                                   marginMm: 10, maxPx: 1600 });

  assert.equal(qs.get('board_type'), 'charuco');
  assert.equal(qs.get('square'), '0.025');    // the renderer calls this `sq`
  assert.equal(qs.get('marker'), '0.019');
  assert.equal(qs.get('margin_mm'), '10');
  assert.equal(qs.get('max_px'), '1600');
});

test('previewQuery omits marker for a chess board', () => {
  const board = { type: 'chess', cols: 9, rows: 6, sq: 0.025 };

  const qs = previewQuery(board, { mode: 'page', dpi: 300, paper: 'A4',
                                   marginMm: 10, maxPx: 1600 });

  assert.equal(qs.has('marker'), false);
});
