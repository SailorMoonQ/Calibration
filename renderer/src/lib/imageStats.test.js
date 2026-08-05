import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipping, downsample, frameStats, histogram, laplacianVar, luma, meanLuma, toGray,
} from './imageStats.js';

// Build an RGBA buffer from a per-pixel callback returning a grey level 0..255.
function rgba(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = fn(x, y);
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  return d;
}

const solid = (w, h, v) => rgba(w, h, () => v);

test('luma weights green most, blue least', () => {
  assert.ok(luma(0, 255, 0) > luma(255, 0, 0));
  assert.ok(luma(255, 0, 0) > luma(0, 0, 255));
  assert.equal(Math.round(luma(255, 255, 255)), 255);
  assert.equal(luma(0, 0, 0), 0);
});

test('toGray converts a colour buffer to one byte per pixel', () => {
  const g = toGray(solid(4, 3, 128), 4, 3);
  assert.equal(g.length, 12);
  assert.ok(g.every(v => v === 128));
});

test('histogram of a solid image is a single spike', () => {
  const h = histogram(toGray(solid(10, 10, 200), 10, 10));
  assert.equal(h[200], 100);
  assert.equal(h.reduce((a, b) => a + b, 0), 100);
});

test('histogram of a gradient spreads across buckets', () => {
  const g = toGray(rgba(256, 1, (x) => x), 256, 1);
  const h = histogram(g);
  assert.ok(h.every(v => v === 1), 'each level should appear exactly once');
});

test('clipping counts blown highlights and crushed shadows', () => {
  // 10 of 100 pixels pure white, 10 pure black, rest mid-grey.
  const g = toGray(rgba(10, 10, (x, y) => {
    const i = y * 10 + x;
    if (i < 10) return 255;
    if (i < 20) return 0;
    return 128;
  }), 10, 10);
  const c = clipping(histogram(g));
  assert.ok(Math.abs(c.high - 0.1) < 1e-9);
  assert.ok(Math.abs(c.low - 0.1) < 1e-9);
  assert.equal(c.total, 100);
});

test('clipping margin catches near-white pixels a sensor actually produces', () => {
  // 254 is blown out in practice; a margin of 0 would miss it entirely.
  const g = toGray(solid(10, 10, 254), 10, 10);
  assert.equal(clipping(histogram(g), 0).high, 0);
  assert.equal(clipping(histogram(g), 2).high, 1);
});

test('clipping of an empty histogram is zero, not NaN', () => {
  const c = clipping(new Uint32Array(256));
  assert.equal(c.high, 0);
  assert.equal(c.low, 0);
  assert.equal(c.total, 0);
});

test('meanLuma tracks overall brightness', () => {
  assert.equal(meanLuma(histogram(toGray(solid(8, 8, 0), 8, 8))), 0);
  assert.equal(meanLuma(histogram(toGray(solid(8, 8, 255), 8, 8))), 255);
  assert.equal(meanLuma(histogram(toGray(solid(8, 8, 100), 8, 8))), 100);
});

test('laplacianVar is zero for a flat image', () => {
  assert.equal(laplacianVar(toGray(solid(20, 20, 128), 20, 20), 20, 20), 0);
});

test('laplacianVar is much higher for a sharp edge than a blurred one', () => {
  const W = 32, H = 32;
  const sharp = toGray(rgba(W, H, (x) => (x < W / 2 ? 0 : 255)), W, H);
  // Same edge, ramped over 8 px — i.e. defocused.
  const blurred = toGray(rgba(W, H, (x) => {
    const t = (x - (W / 2 - 4)) / 8;
    return Math.max(0, Math.min(1, t)) * 255;
  }), W, H);
  const vs = laplacianVar(sharp, W, H);
  const vb = laplacianVar(blurred, W, H);
  assert.ok(vs > vb * 5, `sharp ${vs} should dwarf blurred ${vb}`);
});

test('laplacianVar rises monotonically as a checkerboard gets finer', () => {
  const W = 32, H = 32;
  const board = (cell) => toGray(
    rgba(W, H, (x, y) => (((x / cell) | 0) + ((y / cell) | 0)) % 2 ? 255 : 0), W, H);
  const coarse = laplacianVar(board(8), W, H);
  const fine = laplacianVar(board(2), W, H);
  assert.ok(fine > coarse, `fine ${fine} should exceed coarse ${coarse}`);
});

test('laplacianVar returns 0 rather than NaN for degenerate sizes', () => {
  assert.equal(laplacianVar(new Uint8ClampedArray(4), 2, 2), 0);
  assert.equal(laplacianVar(null, 10, 10), 0);
});

test('downsample returns the requested size', () => {
  const d = downsample(solid(640, 480, 100), 640, 480, 160, 120);
  assert.equal(d.w, 160);
  assert.equal(d.h, 120);
  assert.equal(d.data.length, 160 * 120 * 4);
});

test('downsample samples cell centres, not the top-left corner', () => {
  // A 64→16 reduction covers 4 source px per cell. Corner sampling would read
  // x=0,4,8… and never reach the last column; centre sampling reads x=2,6,10…
  const src = rgba(64, 1, (x) => x);
  const d = downsample(src, 64, 1, 16, 1);
  assert.equal(d.data[0], 2, 'first cell should read its centre, not x=0');
  assert.equal(d.data[15 * 4], 62, 'last cell should reach the far edge');
});

test('downsample is unbiased: clipped regions survive in proportion', () => {
  // A quarter of the frame blown out must still read as ~25% after reduction —
  // this is the property the clipping readout actually depends on.
  const src = rgba(64, 64, (x, y) => (x < 32 && y < 32 ? 255 : 100));
  const full = clipping(histogram(toGray(src, 64, 64)));
  const d = downsample(src, 64, 64, 16, 16);
  const small = clipping(histogram(toGray(d.data, d.w, d.h)));
  assert.ok(Math.abs(full.high - 0.25) < 1e-9);
  assert.ok(Math.abs(small.high - full.high) < 0.02, `${small.high} vs ${full.high}`);
});

test('downsample passes through when the target is not smaller', () => {
  const src = solid(8, 8, 50);
  const d = downsample(src, 8, 8, 160, 120);
  assert.equal(d.w, 8);
  assert.equal(d.data, src, 'should not copy when no work is needed');
});

test('downsample rejects degenerate input', () => {
  assert.equal(downsample(null, 10, 10, 5, 5), null);
  assert.equal(downsample(solid(4, 4, 0), 0, 10, 5, 5), null);
});

test('frameStats bundles the whole readout from one buffer', () => {
  const s = frameStats(solid(320, 240, 200), 320, 240);
  assert.equal(s.sampledW, 160);
  assert.equal(s.sampledH, 120);
  assert.equal(s.mean, 200);
  assert.equal(s.sharpness, 0);
  assert.equal(s.high, 0);
  assert.equal(s.low, 0);
  assert.equal(s.hist[200], 160 * 120);
});

test('frameStats flags an overexposed frame', () => {
  const s = frameStats(solid(320, 240, 255), 320, 240);
  assert.equal(s.high, 1);
  assert.ok(s.mean > 250);
});

test('frameStats flags an underexposed frame', () => {
  const s = frameStats(solid(320, 240, 0), 320, 240);
  assert.equal(s.low, 1);
  assert.equal(s.mean, 0);
});

test('frameStats returns null for an unusable buffer', () => {
  assert.equal(frameStats(null, 320, 240), null);
});

// ── edgeClipping ────────────────────────────────────────────────────────────

import { edgeClipping } from './imageStats.js';

// An image circle of radius r centred at (cx, cy); everything outside is dark.
function circleFrame(w, h, cx, cy, r) {
  return rgba(w, h, (x, y) => (Math.hypot(x - cx, y - cy) <= r ? 200 : 5));
}

test('a circle comfortably inside the frame clips no edge', () => {
  const d = circleFrame(200, 200, 100, 100, 80);
  const e = edgeClipping(d, 200, 200);
  assert.deepEqual(e.edges, []);
  assert.equal(e.anyVignette, true);
});

test('a circle overrunning the bottom reports exactly that edge', () => {
  // Centre pushed down so the circle passes the bottom but not the other sides.
  const d = circleFrame(200, 200, 100, 140, 90);
  const e = edgeClipping(d, 200, 200);
  assert.deepEqual(e.edges, ['bottom']);
  assert.equal(e.clipped.bottom, true);
  assert.equal(e.clipped.top, false);
});

test('an offset circle can clip two adjacent edges', () => {
  const d = circleFrame(200, 200, 140, 140, 100);
  const e = edgeClipping(d, 200, 200).edges.sort();
  assert.deepEqual(e, ['bottom', 'right']);
});

test('a circle larger than the frame clips all four edges', () => {
  const d = circleFrame(200, 200, 100, 100, 400);
  const e = edgeClipping(d, 200, 200);
  assert.deepEqual(e.edges.sort(), ['bottom', 'left', 'right', 'top']);
  // Four lit edges is a lens with no vignette at all, not a fisheye in trouble —
  // the caller needs to be able to tell those apart.
  assert.equal(e.anyVignette, false);
});

test('edges are judged on the middle band, not the corners', () => {
  // Corners of a circular image are dark by construction. Sampling there would
  // report "no clipping" for a circle that plainly runs off every side.
  const d = circleFrame(200, 200, 100, 100, 130);
  assert.equal(edgeClipping(d, 200, 200).clipped.bottom, true);
});

test('a single bright speck on a dark edge does not flip the verdict', () => {
  const d = rgba(200, 200, (x, y) => (y === 199 && x === 100 ? 255 : 5));
  assert.equal(edgeClipping(d, 200, 200).clipped.bottom, false,
    'median over the band should ignore one outlier');
});

test('a uniformly dark frame reports nothing clipped', () => {
  const d = solid(200, 200, 0);
  const e = edgeClipping(d, 200, 200);
  assert.deepEqual(e.edges, []);
});

test('edgeClipping rejects degenerate input', () => {
  assert.equal(edgeClipping(null, 200, 200), null);
  assert.equal(edgeClipping(solid(2, 2, 0), 2, 2), null);
});
