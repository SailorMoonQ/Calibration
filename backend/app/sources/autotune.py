"""Closed-loop exposure/gain tuning against measured targets.

Why closed loop. V4L2 does not define what a gain unit means — the test rig's
IMX307 reports p95=39 at gain=0 (unity gain, not black) and reaches only 135 at
gain=128, while doubling exposure raises p95 by ~1.7x rather than 2x because the
ISP applies gamma. No open-loop formula can be written against that; measuring
the camera's actual response sidesteps the whole question.

What "good" means here is ordered, and the order matters more than any single
threshold:

  1. Brightness first. A dark frame has no corners to find — the black/white
     boundary that defines a chessboard corner simply is not in the data. This is
     never traded away.
  2. No clipping. Saturated whites destroy the same corners from the other side.
  3. Then minimise gain. Gain amplifies noise along with signal, and sub-pixel
     corner refinement fits a surface to local intensity, so noise perturbs it
     directly. But this is an optimisation applied AFTER 1 and 2 hold, not a
     constraint that may darken the picture.
  4. Exposure stays under the motion-blur limit if the target is reachable there.
     When it is not, the limit is exceeded and reported rather than silently
     returning an unusable dark frame.

Brightness is judged by the 95th percentile rather than the mean: on a
calibration board the mean moves with how much board is in shot, while the p95
tracks the white squares, which is the thing that must not saturate.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

log = logging.getLogger("calib.autotune")

# UVC exposure_time_absolute is in 100 µs units.
EXPOSURE_UNIT_MS = 0.1


@dataclass
class Targets:
    """What a tuned camera should look like. Every bound carries a tolerance so
    the loop stops at "good enough" instead of oscillating around an exact value
    it cannot hit on a quantised control."""

    p95: float = 200.0          # white squares just below saturation
    p95_tol: float = 12.0
    clip_high_max: float = 0.01  # ≤1% of pixels saturated
    clip_low_max: float = 0.02   # ≤2% crushed
    exposure_max_ms: float = 16.0   # handheld board; raise for a fixed rig
    allow_exceed_blur: bool = True  # dark-but-clean is worse than slightly soft
    max_iterations: int = 14

    def describe(self) -> dict:
        return {
            "p95": self.p95, "p95_tol": self.p95_tol,
            "clip_high_max": self.clip_high_max, "clip_low_max": self.clip_low_max,
            "exposure_max_ms": self.exposure_max_ms,
            "allow_exceed_blur": self.allow_exceed_blur,
        }


@dataclass
class Limits:
    """The two controls' ranges, as reported by the driver."""

    exp_min: int
    exp_max: int
    exp_step: int = 1
    gain_min: int = 0
    gain_max: int = 0
    gain_step: int = 1
    has_gain: bool = True


@dataclass
class Sample:
    """One measurement of the live frame."""

    p95: float
    clip_high: float
    clip_low: float
    mean: float = 0.0


@dataclass
class State:
    exposure: int
    gain: int


@dataclass
class Step:
    exposure: int
    gain: int
    reason: str
    done: bool = False
    notes: list[str] = field(default_factory=list)


def _snap(value: float, lo: int, hi: int, step: int) -> int:
    step = step or 1
    v = lo + round((value - lo) / step) * step
    return int(max(lo, min(hi, round(v))))


def in_tolerance(sample: Sample, targets: Targets, state: State | None = None) -> bool:
    """Whether the picture meets the targets.

    `state` is optional but matters when the caller refuses to exceed the
    motion-blur limit: a frame can be perfectly exposed and still be unusable
    because it took 100 ms to capture. Without this the loop would call an
    over-cap exposure "on target" and never bring it back down — which is
    exactly what happened on hardware when a previous run had left the exposure
    long.
    """
    ok = (
        abs(sample.p95 - targets.p95) <= targets.p95_tol
        and sample.clip_high <= targets.clip_high_max
        and sample.clip_low <= targets.clip_low_max
    )
    if ok and state is not None and not targets.allow_exceed_blur:
        if state.exposure * EXPOSURE_UNIT_MS > targets.exposure_max_ms:
            return False
    return ok


def plan_step(sample: Sample, state: State, targets: Targets, limits: Limits,
              history: list[tuple[State, Sample]] | None = None) -> Step:
    """Decide the next (exposure, gain) from what the camera just showed.

    Pure — no camera, no clock — so the control law can be tested against a
    simulated sensor rather than only against the one on the desk.

    `history` lets the step size be estimated from the camera's own measured
    response (a secant on the last two samples). Without it the step falls back
    to a fixed ratio, which converges more slowly but never diverges.
    """
    notes: list[str] = []
    exp_cap_units = int(targets.exposure_max_ms / EXPOSURE_UNIT_MS)
    soft_exp_max = min(limits.exp_max, exp_cap_units)

    # ── 2. clipping overrides the brightness target ───────────────────────────
    # A saturated white square is destroyed information; being on target for p95
    # while blowing out the highlights is not "good enough".
    if sample.clip_high > targets.clip_high_max:
        # Prefer cutting gain: it removes noise at the same time. Only shorten
        # exposure once gain is already at the floor.
        if limits.has_gain and state.gain > limits.gain_min:
            new_gain = _snap(state.gain - 0.15 * (limits.gain_max - limits.gain_min),
                             limits.gain_min, limits.gain_max, limits.gain_step)
            return Step(state.exposure, new_gain, "clip-high-lower-gain", notes=notes)
        new_exp = _snap(state.exposure * 0.8, limits.exp_min, limits.exp_max, limits.exp_step)
        if new_exp == state.exposure:
            new_exp = max(limits.exp_min, state.exposure - max(1, limits.exp_step))
        return Step(new_exp, state.gain, "clip-high-shorten-exposure", notes=notes)

    # Exposure over the cap while the caller refuses blur: shorten it and let
    # gain make up the light. Checked before the on-target test, because a frame
    # that is correctly exposed but motion-smeared is still not usable.
    if not targets.allow_exceed_blur and state.exposure > soft_exp_max:
        new_exp = _snap(soft_exp_max, limits.exp_min, limits.exp_max, limits.exp_step)
        if limits.has_gain and state.gain < limits.gain_max:
            new_gain = _snap(state.gain + 0.15 * (limits.gain_max - limits.gain_min),
                             limits.gain_min, limits.gain_max, limits.gain_step)
            notes.append("shortening exposure under the blur limit, gain compensates")
            return Step(new_exp, new_gain, "enforce-blur-limit", notes=notes)
        notes.append("shortening exposure under the blur limit")
        return Step(new_exp, state.gain, "enforce-blur-limit", notes=notes)

    if in_tolerance(sample, targets, state):
        # ── 3. on target: spend any headroom on lowering gain ─────────────────
        # Trading gain down for exposure up keeps brightness while cutting noise.
        # Only offered while exposure has room below the blur limit.
        if limits.has_gain and state.gain > limits.gain_min and state.exposure < soft_exp_max:
            room = soft_exp_max / max(1, state.exposure)
            if room >= 1.08:
                take = min(1.2, room)
                new_exp = _snap(state.exposure * take, limits.exp_min, soft_exp_max, limits.exp_step)
                new_gain = _snap(state.gain - 0.10 * (limits.gain_max - limits.gain_min),
                                 limits.gain_min, limits.gain_max, limits.gain_step)
                if new_exp > state.exposure and new_gain < state.gain:
                    notes.append("trading gain for exposure at constant brightness")
                    return Step(new_exp, new_gain, "polish-lower-gain", notes=notes)
        return Step(state.exposure, state.gain, "on-target", done=True, notes=notes)

    # ── 1. brightness ─────────────────────────────────────────────────────────
    want = targets.p95 / max(1.0, sample.p95)

    # Estimate the local exponent from the last two samples: how much p95 moved
    # for a given exposure ratio. Beats assuming linearity, which the gamma curve
    # makes wrong by ~30% in practice.
    k = 1.0
    if history:
        for prev_state, prev_sample in reversed(history[-3:]):
            if prev_state.gain == state.gain and prev_state.exposure != state.exposure \
               and prev_sample.p95 > 1 and sample.p95 > 1:
                import math
                r_exp = state.exposure / prev_state.exposure
                r_p95 = sample.p95 / prev_sample.p95
                if r_exp > 0 and r_p95 > 0 and abs(math.log(r_exp)) > 0.05:
                    k = math.log(r_p95) / math.log(r_exp)
                    k = max(0.3, min(1.5, k))
                    notes.append(f"measured exposure exponent {k:.2f}")
                break

    exp_ratio = want ** (1.0 / k)
    # Damp: overshooting a bright target saturates, and a saturated sample tells
    # the loop much less than a merely-too-dark one.
    exp_ratio = max(0.5, min(2.0, exp_ratio))

    if sample.p95 < targets.p95:
        target_exp = state.exposure * exp_ratio
        if target_exp <= soft_exp_max:
            new_exp = _snap(target_exp, limits.exp_min, soft_exp_max, limits.exp_step)
            if new_exp > state.exposure:
                return Step(new_exp, state.gain, "brighten-exposure", notes=notes)
        # Spend all the exposure headroom BEFORE touching gain — exposure adds
        # real signal, gain only amplifies what is already there, noise included.
        # Raising both in one step would burn gain that the remaining exposure
        # could have covered for free.
        if state.exposure < soft_exp_max:
            new_exp = _snap(soft_exp_max, limits.exp_min, soft_exp_max, limits.exp_step)
            if new_exp > state.exposure:
                notes.append("using the remaining exposure headroom before any gain")
                return Step(new_exp, state.gain, "brighten-exposure-to-cap", notes=notes)
        # Exposure cannot go further without blurring: now raise gain.
        if limits.has_gain and state.gain < limits.gain_max:
            new_gain = _snap(state.gain + 0.12 * (limits.gain_max - limits.gain_min),
                             limits.gain_min, limits.gain_max, limits.gain_step)
            notes.append("exposure at the blur limit; raising gain instead")
            return Step(state.exposure, new_gain, "brighten-gain", notes=notes)
        # Gain is maxed too. Either accept blur or stop and say the scene is dark.
        if targets.allow_exceed_blur and state.exposure < limits.exp_max:
            new_exp = _snap(state.exposure * exp_ratio, limits.exp_min, limits.exp_max, limits.exp_step)
            if new_exp > state.exposure:
                notes.append("exceeding the motion-blur limit: a dark frame has no corners at all")
                return Step(new_exp, state.gain, "brighten-exceed-blur", notes=notes)
        notes.append("at the end of both controls — the scene needs more light")
        return Step(state.exposure, state.gain, "too-dark-needs-light", done=True, notes=notes)

    # Too bright (but not clipping): drop gain first, it is the free win.
    if limits.has_gain and state.gain > limits.gain_min:
        new_gain = _snap(state.gain - 0.12 * (limits.gain_max - limits.gain_min),
                         limits.gain_min, limits.gain_max, limits.gain_step)
        if new_gain < state.gain:
            return Step(state.exposure, new_gain, "darken-lower-gain", notes=notes)
    new_exp = _snap(state.exposure * exp_ratio, limits.exp_min, limits.exp_max, limits.exp_step)
    if new_exp == state.exposure:
        notes.append("controls are too coarse to get closer")
        return Step(state.exposure, state.gain, "quantisation-limit", done=True, notes=notes)
    return Step(new_exp, state.gain, "darken-exposure", notes=notes)


def verdict(sample: Sample, targets: Targets, state: State, limits: Limits) -> dict:
    """Human-facing summary of where the loop ended up, and why."""
    ok = in_tolerance(sample, targets, state)
    exp_ms = state.exposure * EXPOSURE_UNIT_MS
    issues = []
    if sample.p95 < targets.p95 - targets.p95_tol:
        issues.append("too-dark")
    if sample.p95 > targets.p95 + targets.p95_tol:
        issues.append("too-bright")
    if sample.clip_high > targets.clip_high_max:
        issues.append("clipped-high")
    if sample.clip_low > targets.clip_low_max:
        issues.append("clipped-low")
    if exp_ms > targets.exposure_max_ms:
        issues.append("exceeds-blur-limit")
    if limits.has_gain and limits.gain_max > limits.gain_min:
        gf = (state.gain - limits.gain_min) / (limits.gain_max - limits.gain_min)
        if gf > 0.75:
            issues.append("high-gain")
    return {"ok": ok, "issues": issues, "exposure_ms": round(exp_ms, 2)}


# ── running the loop against a live camera ──────────────────────────────────

def measure_frame(frame) -> Sample | None:
    """Reduce one BGR frame to the numbers the controller needs.

    p95 rather than mean: on a calibration board the mean moves with how much
    board is in shot, while the 95th percentile tracks the white squares — the
    thing that must approach but not reach saturation."""
    import numpy as np

    if frame is None or getattr(frame, "size", 0) == 0:
        return None
    if frame.ndim == 3:
        g = (0.299 * frame[:, :, 2] + 0.587 * frame[:, :, 1] + 0.114 * frame[:, :, 0])
    else:
        g = frame.astype("float32")
    return Sample(
        p95=float(np.percentile(g, 95)),
        clip_high=float((g >= 253).mean()),
        clip_low=float((g <= 2).mean()),
        mean=float(g.mean()),
    )


def run_autotune(src, apply_control, limits: Limits, targets: Targets,
                 settle_s: float = 0.28, start: State | None = None) -> dict:
    """Measure → adjust → measure until the targets hold or the budget runs out.

    `apply_control(name, value)` writes one control; `src.read()` returns the
    newest frame. The settle wait is not optional: V4L2 accepts a write
    immediately but the sensor needs a few frames to actually deliver it, so
    measuring too early reads the PREVIOUS settings and the loop chases its own
    tail — converging on nonsense while every individual step looks sensible.
    """
    import time

    state = start or State(exposure=limits.exp_min, gain=limits.gain_min)
    history: list[tuple[State, Sample]] = []
    trace: list[dict] = []
    final_step = None

    for i in range(targets.max_iterations):
        time.sleep(settle_s)
        frame = src.read()
        sample = measure_frame(frame)
        if sample is None:
            return {"ok": False, "error": "no-frame", "trace": trace,
                    "state": {"exposure": state.exposure, "gain": state.gain}}

        history.append((State(state.exposure, state.gain), sample))
        step = plan_step(sample, state, targets, limits, history)
        trace.append({
            "i": i,
            "exposure": state.exposure, "gain": state.gain,
            "p95": round(sample.p95, 1), "mean": round(sample.mean, 1),
            "clip_high": round(sample.clip_high, 4), "clip_low": round(sample.clip_low, 4),
            "reason": step.reason, "notes": step.notes,
        })
        if step.done:
            final_step = step
            break

        if step.exposure != state.exposure:
            apply_control("exposure", step.exposure)
        if step.gain != state.gain:
            apply_control("gain", step.gain)
        state = State(step.exposure, step.gain)

    # One last look, so the reported result is what the camera is actually
    # producing rather than what the last-but-one iteration measured.
    time.sleep(settle_s)
    final = measure_frame(src.read())
    v = verdict(final, targets, state, limits) if final else {"ok": False, "issues": ["no-frame"]}
    return {
        "ok": v["ok"],
        "issues": v["issues"],
        "exposure_ms": v.get("exposure_ms"),
        "state": {"exposure": state.exposure, "gain": state.gain},
        "final": None if not final else {
            "p95": round(final.p95, 1), "mean": round(final.mean, 1),
            "clip_high": round(final.clip_high, 4), "clip_low": round(final.clip_low, 4),
        },
        "iterations": len(trace),
        "converged": bool(final_step and final_step.done and final_step.reason == "on-target"),
        "stopped_because": final_step.reason if final_step else "iteration-budget",
        "targets": targets.describe(),
        "trace": trace,
    }
