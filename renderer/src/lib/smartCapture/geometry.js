// Geometry adapters for useSmartCapture.
//
// The auto-capture state machine only ever asks four things of the image: how
// many cells are there, which cell does a point fall in, where is a cell's
// centre, and which cell should the operator fill next. Everything else about
// "circle vs rectangle" stays behind this interface, so the state machine itself
// is written once and shared by the fisheye and pinhole tabs.
//
// A factory always returns a usable adapter, even when its geometry is not known
// yet (the fisheye circle is auto-detected and lands a few frames late). In that
// state `extent` is null, `bin` returns all zeros and `cellAt`/`cellCenter`
// return null — the state machine reads that as "no coverage information" and
// simply does not fire.

import { extentFromCircle, extentFromImageSize } from '../boardMetrics.js';
import {
  binPolar, polarCellAt, polarCellGeometry, totalPolarCells,
  pickGuidanceCell as pickPolarGuidance, RINGS, SECTORS,
} from '../polarCoverage.js';
import {
  cellCornerCounts, cellIndexFor, cellGeometry,
  pickGuidanceCell as pickRectGuidance, COVERAGE_COLS, COVERAGE_ROWS,
} from '../coverage.js';

// How much further out a target must sit before we tell the operator to move
// toward the rim rather than left/right/up/down. Fraction of the circle radius.
const RADIAL_CUE_FRAC = 0.33;

export function makePolarGeometry(circle, rings = RINGS, sectors = SECTORS) {
  const total = totalPolarCells(rings, sectors);
  const geo = circle ? polarCellGeometry(circle, rings, sectors) : [];
  return {
    kind: 'polar',
    totalCells: total,
    extent: extentFromCircle(circle),
    bin: (corners) => (circle ? binPolar(corners, circle, rings, sectors) : new Array(total).fill(0)),
    cellAt: (x, y) => (circle ? polarCellAt(x, y, circle, rings, sectors) : null),
    cellCenter: (index) => {
      const g = geo.find(c => c.index === index);
      return g ? { x: g.x, y: g.y } : null;
    },
    pickGuidance: (counts) => pickPolarGuidance(counts, rings, sectors),
    // A dartboard has rings, so "the target is much further out" is its own
    // instruction — more useful than a left/right nudge across a wedge.
    radialCue: (cur, target) => {
      if (!circle || !cur || !target) return null;
      const curR = Math.hypot(cur.x - circle.cx, cur.y - circle.cy);
      const tgtR = Math.hypot(target.x - circle.cx, target.y - circle.cy);
      return tgtR - curR > circle.r * RADIAL_CUE_FRAC ? 'moveOut' : null;
    },
  };
}

export function makeRectGeometry(imageSize, cols = COVERAGE_COLS, rows = COVERAGE_ROWS) {
  const total = cols * rows;
  const geo = cellGeometry(imageSize, cols, rows);
  return {
    kind: 'rect',
    totalCells: total,
    extent: extentFromImageSize(imageSize),
    bin: (corners) => (imageSize ? cellCornerCounts(corners, imageSize, cols, rows) : new Array(total).fill(0)),
    cellAt: (x, y) => cellIndexFor(x, y, imageSize, cols, rows),
    cellCenter: (index) => {
      const g = geo[index];
      return g ? { x: g.x, y: g.y } : null;
    },
    // A pinhole frame has no vignette, so every cell is coverable — no mask.
    pickGuidance: (counts) => pickRectGuidance(counts, null, cols, rows),
    // A rectangle has no rings; steering is purely left/right/up/down.
    radialCue: () => null,
  };
}
