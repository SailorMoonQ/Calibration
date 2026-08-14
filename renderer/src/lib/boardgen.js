// Derived numbers for the board-generator dialog.
//
// These MUST mirror backend/app/calib/boardgen.py: the dialog quotes the square
// size that will reach the paper, and the sheet itself carries the same figure in
// its caption. Two roundings that disagree would put two different numbers in
// front of the operator, one of which is the value they type into `square`.

const MM_PER_INCH = 25.4;

export function pxPerSquare(squareM, dpi) {
  return Math.round((squareM * 1000) / MM_PER_INCH * dpi);
}

export function actualSquareMm(squareM, dpi) {
  return (pxPerSquare(squareM, dpi) / dpi) * MM_PER_INCH;
}

// `cols`/`rows` mean squares for charuco but inner corners for chess — the same
// off-by-one that `_render_chess` handles on the backend.
export function squareCount(board) {
  return board.type === 'chess'
    ? { x: board.cols + 1, y: board.rows + 1 }
    : { x: board.cols, y: board.rows };
}

export function printedSizeMm(board, dpi) {
  const square = actualSquareMm(board.sq, dpi);
  const { x, y } = squareCount(board);
  return { w: x * square, h: y * square };
}

// Board fields are named differently on the two sides (`sq` vs `square`, `type`
// vs `board_type`) — same mapping client.js applies for the detect stream.
export function previewQuery(board, { mode, dpi, paper, marginMm, maxPx }) {
  const qs = new URLSearchParams({
    board_type: board.type,
    cols: String(board.cols),
    rows: String(board.rows),
    square: String(board.sq),
    mode,
    dpi: String(dpi),
    paper,
    margin_mm: String(marginMm),
    max_px: String(maxPx),
  });
  if (board.marker != null && board.type === 'charuco') qs.set('marker', String(board.marker));
  if (board.dictionary) qs.set('dictionary', board.dictionary);
  return qs;
}
