// Is this camera actually set up well enough to calibrate with?
//
// "Looks fine" is not a criterion anyone can act on, and the readouts next door
// (histogram, clip percentages, fps) each answer only part of the question. This
// turns them into one checklist with named thresholds, so "调好了" has a
// definition instead of an opinion.
//
// The thresholds are the same ones the closed-loop tuner drives to — they have
// to be, or the panel would call a freshly tuned camera unhealthy. Each check
// carries its own severity: brightness and clipping destroy corner information
// outright and are pass/fail, while gain and frame rate are costs to be aware of
// rather than reasons to stop.

export const HEALTH_TARGETS = {
  p95: 200,          // white squares just below saturation
  p95Tol: 12,
  clipHighMax: 0.01, // ≤1% of pixels saturated
  clipLowMax: 0.02,  // ≤2% crushed to black
  gainWarnFrac: 0.75,
  fpsSlack: 0.9,     // 90% of target still counts as holding the frame rate
  castMax: 0.06,     // channel deviation in the highlights, see below
};

// UVC exposure_time_absolute is in 100 µs units.
export const EXPOSURE_UNIT_MS = 0.1;

// One frame period — the longest an exposure can be without the sensor slowing
// down. This is physics, not a tuning preference: measured on the test rig at
// 1280×720, 33 ms → 30 fps, 60 ms → 16.6 fps, 200 ms → 5 fps, i.e. exactly
// 1000/exposure_ms once the exposure passes the frame period.
export function framePeriodMs(fpsTarget) {
  return fpsTarget > 0 ? 1000 / fpsTarget : Infinity;
}

// Over- or under-exposed, in one word.
//
// Both ends are checked twice — by level and by clipping — because they fail
// independently: a picture can sit at the right p95 and still have blown
// highlights if the contrast is high, and a dark picture crushes its blacks
// before its p95 looks obviously wrong.
//
// Level is decided BEFORE clipping, and the order is load-bearing. A
// high-contrast scene — a ceiling lamp above a dim board — is under the target
// on level while a fraction of a percent of it is blown, and checking clipping
// first labelled that "over-exposed" right beside a brightness line reading
// "too dark". Both statements were true and the pair was useless. The level is
// what the operator acts on; the clipping shows up as its own failing check.
export function exposureVerdict({ p95, clipHigh, clipLow }, targets = HEALTH_TARGETS) {
  if (p95 > targets.p95 + targets.p95Tol) return 'over';
  if (p95 < targets.p95 - targets.p95Tol) return 'under';
  if (clipHigh > targets.clipHighMax) return 'over';
  if (clipLow > targets.clipLowMax) return 'under';
  return 'ok';
}

function gainFraction(gain, gainMin, gainMax) {
  if (gain == null || gainMax == null || gainMin == null || gainMax <= gainMin) return null;
  return (gain - gainMin) / (gainMax - gainMin);
}

// The full checklist. `null` for anything not measurable right now (no gain
// control, frame rate unknown) drops that check rather than inventing a value —
// a missing measurement must never read as a pass.
export function evaluateHealth(m, targets = HEALTH_TARGETS) {
  const checks = [];
  const has = v => v != null && Number.isFinite(v);

  // Listed first because it comes first in the fixing order, not because it is
  // the most serious. Luma weights green at 0.587, so a cast shifts every
  // brightness number below it — reading "white level 167" while the picture is
  // green tells you nothing about the exposure until the cast is gone.
  if (has(m.cast)) {
    checks.push({
      id: 'colorCast',
      severity: 'advisory',
      ok: m.cast <= targets.castMax,
      value: m.cast,
      want: targets.castMax,
      detail: m.cast > targets.castMax ? (m.castChannel || null) : null,
    });
  }

  if (has(m.p95)) {
    const off = m.p95 - targets.p95;
    checks.push({
      id: 'brightness',
      severity: 'blocking',
      ok: Math.abs(off) <= targets.p95Tol,
      value: Math.round(m.p95),
      want: `${targets.p95} ± ${targets.p95Tol}`,
      detail: Math.abs(off) <= targets.p95Tol ? null : (off > 0 ? 'over' : 'under'),
    });
  }
  if (has(m.clipHigh)) {
    checks.push({
      id: 'clipHigh',
      severity: 'blocking',
      ok: m.clipHigh <= targets.clipHighMax,
      value: m.clipHigh,
      want: targets.clipHighMax,
    });
  }
  if (has(m.clipLow)) {
    checks.push({
      id: 'clipLow',
      severity: 'blocking',
      ok: m.clipLow <= targets.clipLowMax,
      value: m.clipLow,
      want: targets.clipLowMax,
    });
  }

  const gf = gainFraction(m.gain, m.gainMin, m.gainMax);
  if (gf != null) {
    checks.push({
      id: 'gain',
      severity: 'advisory',
      ok: gf <= targets.gainWarnFrac,
      value: gf,
      want: targets.gainWarnFrac,
    });
  }

  // Frame rate splits into two questions with different answers. The exposure
  // check is the one the tuner controls; the delivery check is the camera's own
  // ceiling, which no amount of tuning will lift.
  const period = framePeriodMs(m.fpsTarget);
  if (has(m.exposureMs) && Number.isFinite(period)) {
    checks.push({
      id: 'exposureBudget',
      severity: 'blocking',
      ok: m.exposureMs <= period * 1.02,
      value: m.exposureMs,
      want: period,
      detail: m.exposureMs > period * 1.02 ? `${(1000 / m.exposureMs).toFixed(1)}` : null,
    });
  }
  if (has(m.fps) && m.fps > 0 && m.fpsTarget > 0) {
    const holding = m.fps >= m.fpsTarget * targets.fpsSlack;
    const exposureIsTheCause = has(m.exposureMs) && m.exposureMs > period * 1.02;
    checks.push({
      id: 'frameRate',
      severity: 'advisory',
      ok: holding,
      value: m.fps,
      want: m.fpsTarget,
      // Naming the cause is the whole point: "shorten the exposure" and "this
      // camera cannot do 60 fps at this resolution" call for opposite actions.
      detail: holding ? null : (exposureIsTheCause ? 'exposure' : 'cameraCeiling'),
    });
  }

  const blocking = checks.filter(c => c.severity === 'blocking');
  return {
    checks,
    ok: blocking.length > 0 && blocking.every(c => c.ok),
    // No blocking check could be evaluated — say "unknown", never "ok".
    known: blocking.length > 0,
    verdict: has(m.p95) && has(m.clipHigh) && has(m.clipLow)
      ? exposureVerdict(m, targets)
      : 'unknown',
  };
}

// Pull the numbers the checklist needs out of the driver's control list, so the
// caller does not have to know which V4L2 id holds the exposure on this camera.
export function readControlMetrics(controls) {
  const by = {};
  for (const c of controls || []) by[c.id] = c;
  const exp = by.exposure_time_absolute || by.exposure_absolute;
  const gain = by.gain;
  return {
    exposureMs: exp && exp.value != null ? exp.value * EXPOSURE_UNIT_MS : null,
    gain: gain && !gain.inactive && gain.value != null ? gain.value : null,
    gainMin: gain ? gain.min : null,
    gainMax: gain ? gain.max : null,
  };
}
