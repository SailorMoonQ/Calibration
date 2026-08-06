import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEALTH_TARGETS,
  evaluateHealth,
  exposureVerdict,
  framePeriodMs,
  readControlMetrics,
} from './cameraHealth.js';

const GOOD = { p95: 200, clipHigh: 0.002, clipLow: 0.005 };

// ── the exposure verdict ────────────────────────────────────────────────────

test('a well-exposed frame reads as ok', () => {
  assert.equal(exposureVerdict(GOOD), 'ok');
});

test('blown highlights read as over-exposed even at the right level', () => {
  // The p95 sits on target, so a level-only test would call this fine — but 4%
  // of the picture is already saturated and those white squares are gone.
  assert.equal(exposureVerdict({ p95: 200, clipHigh: 0.04, clipLow: 0 }), 'over');
});

test('crushed blacks read as under-exposed even at the right level', () => {
  assert.equal(exposureVerdict({ p95: 200, clipHigh: 0, clipLow: 0.09 }), 'under');
});

test('a dark frame reads as under-exposed on level alone', () => {
  assert.equal(exposureVerdict({ p95: 80, clipHigh: 0, clipLow: 0 }), 'under');
});

test('a bright frame reads as over-exposed on level alone', () => {
  assert.equal(exposureVerdict({ p95: 245, clipHigh: 0, clipLow: 0 }), 'over');
});

test('over-exposure wins when both ends are clipped', () => {
  // A saturated white cannot be recovered; a lifted black still has signal.
  assert.equal(exposureVerdict({ p95: 200, clipHigh: 0.05, clipLow: 0.09 }), 'over');
});

// ── the frame-rate arithmetic ───────────────────────────────────────────────

test('60 fps means 16.7 ms of exposure and no more', () => {
  assert.ok(Math.abs(framePeriodMs(60) - 16.667) < 0.01);
});

test('no frame-rate target leaves the exposure unbounded', () => {
  assert.equal(framePeriodMs(0), Infinity);
});

// ── the checklist ───────────────────────────────────────────────────────────

test('a tuned camera passes everything', () => {
  const r = evaluateHealth({
    ...GOOD, exposureMs: 12, gain: 40, gainMin: 0, gainMax: 128, fps: 58, fpsTarget: 60,
  });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'ok');
  assert.ok(r.checks.every(c => c.ok), JSON.stringify(r.checks));
});

test('a long exposure fails the frame-rate budget and names the shortfall', () => {
  const r = evaluateHealth({
    ...GOOD, exposureMs: 200, gain: 40, gainMin: 0, gainMax: 128, fps: 5, fpsTarget: 60,
  });
  assert.equal(r.ok, false);
  const budget = r.checks.find(c => c.id === 'exposureBudget');
  assert.equal(budget.ok, false);
  assert.equal(budget.detail, '5.0', '200 ms of exposure is 5 fps');
  assert.equal(r.checks.find(c => c.id === 'frameRate').detail, 'exposure');
});

test('a slow camera at a short exposure is blamed on the camera, not the exposure', () => {
  // Measured: this rig tops out near 30 fps at 720p even at a 5 ms exposure.
  // Telling the user to shorten the exposure here would be advice they cannot
  // act on.
  const r = evaluateHealth({
    ...GOOD, exposureMs: 10, gain: 40, gainMin: 0, gainMax: 128, fps: 30, fpsTarget: 60,
  });
  assert.equal(r.checks.find(c => c.id === 'exposureBudget').ok, true);
  assert.equal(r.checks.find(c => c.id === 'frameRate').detail, 'cameraCeiling');
  assert.equal(r.ok, true, 'the camera ceiling is a cost, not a blocker');
});

test('high gain is a warning, not a failure', () => {
  const r = evaluateHealth({ ...GOOD, gain: 120, gainMin: 0, gainMax: 128 });
  assert.equal(r.checks.find(c => c.id === 'gain').ok, false);
  assert.equal(r.ok, true, 'noise costs accuracy but does not destroy corners');
});

test('a dark frame fails', () => {
  const r = evaluateHealth({ p95: 78, clipHigh: 0, clipLow: 0.05 });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'under');
  assert.equal(r.checks.find(c => c.id === 'brightness').detail, 'under');
});

test('the old guided endpoint fails the checklist', () => {
  // exp=160 gain=56 gave p95≈78 on the rig, and the old criteria ("no clipping,
  // low gain") called that done. It must not pass now.
  const r = evaluateHealth({
    p95: 78, clipHigh: 0, clipLow: 0.001, exposureMs: 16, gain: 56, gainMin: 0, gainMax: 128,
  });
  assert.equal(r.ok, false);
});

test('missing measurements are dropped, never counted as passes', () => {
  const r = evaluateHealth({ p95: null, clipHigh: null, clipLow: null, gain: 10, gainMin: 0, gainMax: 128 });
  assert.equal(r.known, false);
  assert.equal(r.ok, false, 'nothing was measured, so nothing is proven');
  assert.equal(r.verdict, 'unknown');
});

test('no frame-rate target means no frame-rate checks', () => {
  const r = evaluateHealth({ ...GOOD, exposureMs: 500, fps: 2, fpsTarget: 0 });
  assert.equal(r.checks.find(c => c.id === 'exposureBudget'), undefined);
  assert.equal(r.checks.find(c => c.id === 'frameRate'), undefined);
  assert.equal(r.ok, true);
});

test('an unknown frame rate raises no frame-rate complaint', () => {
  const r = evaluateHealth({ ...GOOD, exposureMs: 10, fps: 0, fpsTarget: 60 });
  assert.equal(r.checks.find(c => c.id === 'frameRate'), undefined);
});

test('the thresholds are the ones the tuner drives to', () => {
  // If these drift apart, the panel calls a freshly tuned camera unhealthy.
  assert.equal(HEALTH_TARGETS.p95, 200);
  assert.equal(HEALTH_TARGETS.p95Tol, 12);
  assert.equal(HEALTH_TARGETS.clipHighMax, 0.01);
  assert.equal(HEALTH_TARGETS.clipLowMax, 0.02);
});

// ── reading the driver's control list ───────────────────────────────────────

test('exposure is converted from V4L2 units to milliseconds', () => {
  const m = readControlMetrics([{ id: 'exposure_time_absolute', value: 166, min: 50, max: 10000 }]);
  assert.ok(Math.abs(m.exposureMs - 16.6) < 1e-9);
});

test('the older exposure_absolute spelling is understood', () => {
  const m = readControlMetrics([{ id: 'exposure_absolute', value: 100, min: 50, max: 10000 }]);
  assert.equal(m.exposureMs, 10);
});

test('a locked gain control reports no gain rather than a stale one', () => {
  // Writing an inactive control is silently ignored, so its value is not what
  // the sensor is using; reporting it would put a wrong number on screen.
  const m = readControlMetrics([{ id: 'gain', value: 61, min: 0, max: 128, inactive: 'auto_exposure' }]);
  assert.equal(m.gain, null);
  assert.equal(m.gainMax, 128, 'the range is still known');
});

test('a camera with no exposure control reports null, not zero', () => {
  const m = readControlMetrics([{ id: 'brightness', value: 36, min: -64, max: 64 }]);
  assert.equal(m.exposureMs, null);
  assert.equal(m.gain, null);
});

// ── colour cast ─────────────────────────────────────────────────────────────

test('a tinted picture is flagged, with the channel named', () => {
  const r = evaluateHealth({ ...GOOD, cast: 0.12, castChannel: 'green' });
  const c = r.checks.find(x => x.id === 'colorCast');
  assert.equal(c.ok, false);
  assert.equal(c.detail, 'green');
});

test('a colour cast does not block — the detector still finds the board', () => {
  const r = evaluateHealth({ ...GOOD, cast: 0.12, castChannel: 'green' });
  assert.equal(r.ok, true, 'a tint costs range, it does not destroy corners');
});

test('a neutral picture passes the cast check', () => {
  const r = evaluateHealth({ ...GOOD, cast: 0.02, castChannel: 'green' });
  assert.equal(r.checks.find(x => x.id === 'colorCast').ok, true);
});

test('no colour measurement means no cast check', () => {
  const r = evaluateHealth({ ...GOOD });
  assert.equal(r.checks.find(x => x.id === 'colorCast'), undefined);
});
