import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUIDED_STEPS, GUIDED_TOTAL_SHOTS,
  FISHEYE_PROFILE, PINHOLE_PROFILE,
  regionTarget, regionOk, poseOk, differsEnough, shotSignature, targetHalfSize,
} from './guidedSequence.js';

const CIRCLE = { cx: 500, cy: 400, rx: 300, ry: 300 };   // fisheye-shaped extent
const RECT = { cx: 640, cy: 360, rx: 640, ry: 360 };     // pinhole 1280x720 extent

test('the checklist is 17 steps / 34 shots', () => {
  assert.equal(GUIDED_STEPS.length, 17);
  assert.equal(GUIDED_TOTAL_SHOTS, 34);
});

test('regionTarget places center at the extent centre', () => {
  const t = regionTarget('center', CIRCLE);
  assert.equal(t.x, 500);
  assert.equal(t.y, 400);
  assert.ok(Math.abs(t.acceptR - 0.38 * 300) < 1e-9);
});

test('regionTarget scales x by rx and y by ry independently', () => {
  const t = regionTarget('right', RECT);         // ux=1, uy=0, rf=0.82
  assert.ok(Math.abs(t.x - (640 + 0.82 * 640)) < 1e-9);
  assert.equal(t.y, 360);
  const b = regionTarget('bottom', RECT);        // ux=0, uy=1, rf=0.82
  assert.equal(b.x, 640);
  assert.ok(Math.abs(b.y - (360 + 0.82 * 360)) < 1e-9);
});

// THE REGRESSION GUARD for the extent generalisation: on a square extent
// (rx === ry === r, i.e. every fisheye) the new formula must reproduce the old
// circle formula exactly, for every region.
test('on a square extent regionTarget equals the old circle formula', () => {
  const r = 300, cx = 500, cy = 400;
  const OLD = {                                   // pre-refactor: ux/L * rf * r
    center: [0, 0, 0.0, 0.38], tl: [-1, -1, 0.55, 0.42], tr: [1, -1, 0.55, 0.42],
    bl: [-1, 1, 0.55, 0.42], br: [1, 1, 0.55, 0.42],
    top: [0, -1, 0.82, 0.42], bottom: [0, 1, 0.82, 0.42],
    left: [-1, 0, 0.82, 0.42], right: [1, 0, 0.82, 0.42],
  };
  for (const [region, [ux, uy, rf, accept]] of Object.entries(OLD)) {
    const L = Math.hypot(ux, uy) || 1;
    const want = { x: cx + (ux / L) * rf * r, y: cy + (uy / L) * rf * r, acceptR: accept * r };
    assert.deepEqual(regionTarget(region, { cx, cy, rx: r, ry: r }), want, `region ${region}`);
  }
});

test('regionTarget returns null without an extent', () => {
  assert.equal(regionTarget('center', null), null);
});

test('regionOk accepts inside the radius and rejects outside', () => {
  const step = { region: 'center' };
  const inside = { centroid: { x: 500 + 100, y: 400 } };     // 100 < 0.38*300 = 114
  const outside = { centroid: { x: 500 + 200, y: 400 } };
  assert.equal(regionOk(step, inside, CIRCLE), true);
  assert.equal(regionOk(step, outside, CIRCLE), false);
  assert.equal(regionOk(step, { centroid: null }, CIRCLE), false);
});

test('poseOk frontal uses the profile tilt ceiling', () => {
  const step = { pose: 'frontal' };
  assert.equal(poseOk(step, { tilt: 11, roll: 0 }, FISHEYE_PROFILE), true);   // <= 12
  assert.equal(poseOk(step, { tilt: 11, roll: 0 }, PINHOLE_PROFILE), false);  // >  10
  assert.equal(poseOk(step, { tilt: 9, roll: 0 }, PINHOLE_PROFILE), true);
});

test('poseOk tilted uses the profile tilt floor', () => {
  const step = { pose: 'tilted' };
  assert.equal(poseOk(step, { tilt: 8 }, FISHEYE_PROFILE), false);   // < 10
  assert.equal(poseOk(step, { tilt: 8 }, PINHOLE_PROFILE), true);    // >= 7
  assert.equal(poseOk(step, { tilt: null }, PINHOLE_PROFILE), false);
});

test('poseOk dist splits near/far/mid at the profile thresholds', () => {
  assert.equal(poseOk({ pose: 'dist', scale: 'near' }, { scale: 0.6 }, FISHEYE_PROFILE), true);
  assert.equal(poseOk({ pose: 'dist', scale: 'near' }, { scale: 0.6 }, PINHOLE_PROFILE), false);
  assert.equal(poseOk({ pose: 'dist', scale: 'near' }, { scale: 0.8 }, PINHOLE_PROFILE), true);
  assert.equal(poseOk({ pose: 'dist', scale: 'far' }, { scale: 0.3 }, PINHOLE_PROFILE), true);
  assert.equal(poseOk({ pose: 'dist', scale: 'mid' }, { scale: 0.5 }, PINHOLE_PROFILE), true);
  assert.equal(poseOk({ pose: 'dist', scale: null }, { scale: null }, PINHOLE_PROFILE), false);
});

test('poseOk roll needs rotation while staying flat', () => {
  const step = { pose: 'roll' };
  assert.equal(poseOk(step, { roll: 20, tilt: 5 }, FISHEYE_PROFILE), true);
  assert.equal(poseOk(step, { roll: 10, tilt: 5 }, FISHEYE_PROFILE), false);   // < ROLL_MIN
  assert.equal(poseOk(step, { roll: 20, tilt: 40 }, FISHEYE_PROFILE), false);  // not flat
});

test('differsEnough fires on any one of tilt / roll / scale / position', () => {
  const base = { tilt: 5, roll: 5, scale: 0.4, centroid: { x: 100, y: 100 } };
  assert.equal(differsEnough(null, base, CIRCLE), true);            // no prior shot
  assert.equal(differsEnough(base, { ...base }, CIRCLE), false);    // identical
  assert.equal(differsEnough(base, { ...base, tilt: 8 }, CIRCLE), true);
  assert.equal(differsEnough(base, { ...base, roll: 8 }, CIRCLE), true);
  assert.equal(differsEnough(base, { ...base, scale: 0.43 }, CIRCLE), true);
  assert.equal(differsEnough(base, { ...base, centroid: { x: 120, y: 100 } }, CIRCLE), true);  // 20 >= 300*0.03
});

test('shotSignature snapshots the four measurements', () => {
  const m = { tilt: 1, roll: 2, scale: 3, centroid: { x: 4, y: 5 }, extra: 'dropped' };
  assert.deepEqual(shotSignature(m), { tilt: 1, roll: 2, scale: 3, centroid: { x: 4, y: 5 } });
  assert.equal(shotSignature(null), null);
});

test('targetHalfSize keeps the board aspect and shrinks for edges/far', () => {
  const center = targetHalfSize({ region: 'center', group: 'frontal', pose: 'frontal' }, CIRCLE, 9, 6);
  assert.ok(Math.abs(center.halfW - 0.42 * 300) < 1e-9);
  assert.ok(Math.abs(center.halfH - center.halfW * (6 / 9)) < 1e-9);
  const edge = targetHalfSize({ region: 'top', group: 'edge', pose: 'frontal' }, CIRCLE, 9, 6);
  assert.ok(edge.halfW < center.halfW);
  const far = targetHalfSize({ region: 'center', group: 'dist', pose: 'dist', scale: 'far' }, CIRCLE, 9, 6);
  assert.ok(Math.abs(far.halfW - 0.27 * 300) < 1e-9);
});

test('targetHalfSize normalises against the SHORT axis on a rect extent', () => {
  const t = targetHalfSize({ region: 'center', group: 'frontal', pose: 'frontal' }, RECT, 9, 6);
  assert.ok(Math.abs(t.halfW - 0.42 * 360) < 1e-9);   // min(640, 360)
});
