import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeOpticalCenter, centerOffset, fieldOfView, frameLoss,
  kAfterRoi, maxCenteredRoi, roiFor,
} from './opticalCenter.js';

const K = (fx, fy, cx, cy) => [[fx, 0, cx], [0, fy, cy], [0, 0, 1]];
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// A 1280×720 camera with the principal point dead centre.
const CENTERED = K(900, 900, 640, 360);
const SIZE = [1280, 720];

test('centerOffset is zero for a perfectly centred principal point', () => {
  const o = centerOffset(CENTERED, SIZE);
  assert.equal(o.dx, 0);
  assert.equal(o.dy, 0);
  assert.equal(o.distance, 0);
});

test('centerOffset signs follow image coordinates: right and down are positive', () => {
  const o = centerOffset(K(900, 900, 700, 400), SIZE);
  assert.equal(o.dx, 60);
  assert.equal(o.dy, 40);
  assert.ok(near(o.distance, Math.hypot(60, 40)));
});

test('centerOffset reports the offset as a share of the frame', () => {
  const o = centerOffset(K(900, 900, 640 + 128, 360 + 72), SIZE);
  assert.ok(near(o.fracX, 0.1));
  assert.ok(near(o.fracY, 0.1));
});

test('centerOffset rejects unusable input instead of returning zeros', () => {
  assert.equal(centerOffset(null, SIZE), null);
  assert.equal(centerOffset(CENTERED, null), null);
  assert.equal(centerOffset(CENTERED, [0, 720]), null);
  assert.equal(centerOffset(K(0, 900, 640, 360), SIZE), null, 'fx=0 is not a camera');
  assert.equal(centerOffset(K(NaN, 900, 640, 360), SIZE), null);
});

test('fieldOfView matches the closed form for a known focal length', () => {
  const f = fieldOfView(CENTERED, SIZE);
  const want = 2 * Math.atan(1280 / (2 * 900)) * 180 / Math.PI;
  assert.ok(near(f.horizontal, want, 1e-9));
});

test('fieldOfView is symmetric on a square frame with square pixels', () => {
  const f = fieldOfView(K(500, 500, 400, 400), [800, 800]);
  assert.ok(near(f.horizontal, f.vertical));
  assert.ok(f.diagonal > f.horizontal, 'the diagonal spans more than either axis');
});

test('fieldOfView widens monotonically as focal length shrinks', () => {
  // arctan saturates, so the relationship is monotonic but NOT proportional to
  // 1/f — asserting a ratio here would be asserting the wrong physics.
  const angles = [400, 800, 1600, 3200].map(
    f => fieldOfView(K(f, f, 640, 360), SIZE).horizontal);
  for (let i = 1; i < angles.length; i++) {
    assert.ok(angles[i] < angles[i - 1], `f grew but FOV did not shrink: ${angles}`);
  }
  // And it can never reach or exceed 180°, however short the lens.
  assert.ok(fieldOfView(K(1, 1, 640, 360), SIZE).horizontal < 180);
});

test('fieldOfView does not depend on where the principal point is', () => {
  // FOV comes from focal length and frame size; moving cx must not change it.
  const a = fieldOfView(K(900, 900, 640, 360), SIZE);
  const b = fieldOfView(K(900, 900, 100, 700), SIZE);
  assert.deepEqual(a, b);
});

test('maxCenteredRoi is the whole frame when the axis is already centred', () => {
  const r = maxCenteredRoi(CENTERED, SIZE);
  assert.deepEqual(r, { left: 0, top: 0, width: 1280, height: 720 });
});

test('maxCenteredRoi shrinks by twice the offset', () => {
  // cx is 60 px right of centre, so the widest centred window loses 120 px.
  const r = maxCenteredRoi(K(900, 900, 700, 360), SIZE);
  assert.equal(r.width, 2 * (1280 - 700));
  assert.equal(r.width, 1160);
  assert.equal(r.height, 720);
  assert.equal(r.left, 700 - 1160 / 2);
});

test('maxCenteredRoi handles an offset toward the top-left too', () => {
  const r = maxCenteredRoi(K(900, 900, 500, 300), SIZE);
  assert.equal(r.width, 2 * 500);
  assert.equal(r.height, 2 * 300);
  assert.equal(r.left, 0);
  assert.equal(r.top, 0);
});

test('maxCenteredRoi never returns a negative size for a degenerate principal point', () => {
  for (const cx of [0, 1280, -50, 5000]) {
    const r = maxCenteredRoi(K(900, 900, cx, 360), SIZE);
    assert.ok(r.width >= 0, `cx=${cx} gave width ${r.width}`);
    assert.ok(r.height >= 0);
  }
});

test('THE core property: after applying maxCenteredRoi the axis is at the new centre', () => {
  // This is what the whole feature exists to achieve. Check it across a spread
  // of offsets, including asymmetric ones.
  for (const [cx, cy] of [[640, 360], [700, 360], [500, 300], [640, 500], [820, 190]]) {
    const k = K(900, 900, cx, cy);
    const roi = maxCenteredRoi(k, SIZE);
    const k2 = kAfterRoi(k, roi);
    const off = centerOffset(k2, [roi.width, roi.height]);
    assert.ok(Math.abs(off.dx) <= 0.5, `cx=${cx}: residual dx ${off.dx}`);
    assert.ok(Math.abs(off.dy) <= 0.5, `cy=${cy}: residual dy ${off.dy}`);
  }
});

test('kAfterRoi leaves focal lengths untouched', () => {
  const k = K(900, 950, 700, 400);
  const k2 = kAfterRoi(k, { left: 120, top: 80, width: 1160, height: 640 });
  assert.equal(k2[0][0], 900);
  assert.equal(k2[1][1], 950);
});

test('kAfterRoi shifts the principal point by exactly the crop origin', () => {
  const k = K(900, 900, 700, 400);
  const k2 = kAfterRoi(k, { left: 120, top: 80, width: 1160, height: 640 });
  assert.equal(k2[0][2], 700 - 120);
  assert.equal(k2[1][2], 400 - 80);
});

test('kAfterRoi with a zero-origin crop is a no-op on the principal point', () => {
  const k = K(900, 900, 640, 360);
  assert.deepEqual(kAfterRoi(k, { left: 0, top: 0, width: 1280, height: 720 }), k);
});

test('roiFor honours a smaller request and stays centred on the axis', () => {
  const k = K(900, 900, 700, 400);
  const r = roiFor(k, SIZE, 800, 400);
  assert.equal(r.width, 800);
  assert.equal(r.height, 400);
  assert.equal(r.clamped, false);
  assert.equal(r.left, 700 - 400);
  assert.equal(r.top, 400 - 200);
  // still centred
  const off = centerOffset(kAfterRoi(k, r), [r.width, r.height]);
  assert.ok(Math.abs(off.dx) <= 0.5 && Math.abs(off.dy) <= 0.5);
});

test('roiFor clamps an oversized request and says so', () => {
  const k = K(900, 900, 700, 360);
  const r = roiFor(k, SIZE, 5000, 5000);
  const max = maxCenteredRoi(k, SIZE);
  assert.equal(r.width, max.width);
  assert.equal(r.height, max.height);
  assert.equal(r.clamped, true);
});

test('roiFor never produces a degenerate window', () => {
  const r = roiFor(K(900, 900, 640, 360), SIZE, 0, -10);
  assert.ok(r.width >= 2 && r.height >= 2);
});

test('frameLoss is zero for a full-frame crop and grows with the crop', () => {
  assert.ok(near(frameLoss(SIZE, { width: 1280, height: 720 }).lost, 0));
  const half = frameLoss(SIZE, { width: 640, height: 720 });
  assert.ok(near(half.kept, 0.5));
  assert.ok(near(half.lost, 0.5));
});

test('frameLoss rejects a degenerate roi rather than dividing by zero', () => {
  assert.equal(frameLoss(SIZE, { width: 0, height: 720 }), null);
  assert.equal(frameLoss(null, { width: 10, height: 10 }), null);
});

test('analyzeOpticalCenter bundles a consistent picture', () => {
  const k = K(900, 900, 700, 400);
  const a = analyzeOpticalCenter(k, SIZE);
  assert.equal(a.offset.dx, 60);
  assert.equal(a.roi.width, 1160);
  assert.equal(a.kAfter[0][2], 700 - a.roi.left);
  // Cropping can only narrow the field of view, never widen it.
  assert.ok(a.fovAfter.horizontal < a.fov.horizontal);
  assert.ok(a.loss.lost > 0 && a.loss.lost < 1);
});

test('analyzeOpticalCenter returns null rather than a half-filled result', () => {
  assert.equal(analyzeOpticalCenter(null, SIZE), null);
  assert.equal(analyzeOpticalCenter(CENTERED, null), null);
  assert.equal(analyzeOpticalCenter(K(900, 900, 640, 360), [0, 0]), null);
});

test('a centred camera loses nothing', () => {
  const a = analyzeOpticalCenter(CENTERED, SIZE);
  assert.ok(near(a.loss.lost, 0));
  assert.deepEqual(a.fovAfter, a.fov);
});
