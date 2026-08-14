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
  4. Exposure stays under its cap if the target is reachable there. When it is
     not, the cap is exceeded and reported rather than silently returning an
     unusable dark frame.

The exposure cap has two independent sources and the tighter one wins:

  * motion blur — a handheld board smears past ~16 ms;
  * frame rate — a sensor cannot integrate for longer than one frame period, so
    exposure above 1000/fps costs frame rate one-for-one. Measured on the test
    rig (IMX307, 1280x720): 33 ms → 30 fps, 60 ms → 16.6 fps, 200 ms → 5.0 fps,
    i.e. exactly 1000/exposure_ms once the exposure exceeds the frame period.
    `exposure_dynamic_framerate` makes no difference; the trade is physical.

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
    fps_target: float = 0.0         # 0 = frame rate is not a constraint
    allow_exceed_blur: bool = True  # dark-but-clean is worse than slightly soft
    max_iterations: int = 14

    def exposure_cap_ms(self) -> float:
        """The exposure ceiling actually in force: the tighter of the blur limit
        and the frame period. Exposure above one frame period cannot happen —
        the sensor simply reads out slower — so a frame-rate requirement is a
        hard exposure cap, not a preference."""
        if self.fps_target > 0:
            return min(self.exposure_max_ms, 1000.0 / self.fps_target)
        return self.exposure_max_ms

    def cap_reason(self) -> str:
        """Which of the two limits is binding — the operator needs to know which
        knob to turn (steady the board, or accept fewer frames)."""
        if self.fps_target > 0 and 1000.0 / self.fps_target < self.exposure_max_ms:
            return "fps"
        return "blur"

    def describe(self) -> dict:
        return {
            "p95": self.p95, "p95_tol": self.p95_tol,
            "clip_high_max": self.clip_high_max, "clip_low_max": self.clip_low_max,
            "exposure_max_ms": self.exposure_max_ms,
            "fps_target": self.fps_target,
            "exposure_cap_ms": round(self.exposure_cap_ms(), 2),
            "cap_reason": self.cap_reason(),
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
        if state.exposure * EXPOSURE_UNIT_MS > targets.exposure_cap_ms():
            return False
    return ok


def _gain_slope(sample: Sample, state: State,
                history: list[tuple[State, Sample]] | None) -> float | None:
    """How much p95 moves per unit of gain, measured here rather than assumed.

    V4L2 does not say what a gain unit is, and on this sensor it is neither
    linear nor dB — measured, one unit is worth about 1.8 levels of p95 near the
    middle of the range. A fixed 12%-of-range step is far too coarse at that
    slope: it jumps clean over the tolerance band, and the loop then ping-pongs
    between the two values that straddle it until the iteration budget runs out.
    """
    if not history:
        return None
    for prev_state, prev_sample in reversed(history[:-1]):
        if prev_state.exposure == state.exposure and prev_state.gain != state.gain:
            d_gain = state.gain - prev_state.gain
            d_p95 = sample.p95 - prev_sample.p95
            if not d_gain:
                return None
            slope = d_p95 / d_gain
            # A non-positive slope means the pair carries no usable information
            # about gain — the scene changed under us, or the sensor was already
            # saturated. Fall back to the blind step rather than inverting it.
            return slope if slope > 0 else None
    return None


def _gain_toward(aim_p95: float, sample: Sample, state: State,
                 limits: Limits, history, fallback_frac: float) -> int:
    """Next gain value, aimed at a given p95 when the local response is known and
    stepped blindly by `fallback_frac` of the range when it is not."""
    span = limits.gain_max - limits.gain_min
    slope = _gain_slope(sample, state, history)
    if slope and slope > 0:
        delta = (aim_p95 - sample.p95) / slope
        # Cap the move so one bad slope estimate cannot throw the gain across
        # its whole range.
        delta = max(-0.25 * span, min(0.25 * span, delta))
    else:
        delta = fallback_frac * span
    new_gain = _snap(state.gain + delta, limits.gain_min, limits.gain_max, limits.gain_step)
    # Never stall: a step that rounds to nothing must still move one notch in the
    # intended direction, or the loop spins on the spot.
    if new_gain == state.gain:
        nudge = max(1, limits.gain_step) * (1 if fallback_frac > 0 else -1)
        new_gain = _snap(state.gain + nudge, limits.gain_min, limits.gain_max, limits.gain_step)
    return new_gain


def _distance(sample: Sample, targets: Targets) -> float:
    """How far a measurement is from "good", as one number.

    Clipping is weighted far above the brightness miss because clipped pixels are
    destroyed information while a p95 a few levels off is merely not ideal."""
    d = abs(sample.p95 - targets.p95)
    if sample.clip_high > targets.clip_high_max:
        d += 1000 * (sample.clip_high - targets.clip_high_max)
    if sample.clip_low > targets.clip_low_max:
        d += 500 * (sample.clip_low - targets.clip_low_max)
    return d


def plan_step(sample: Sample, state: State, targets: Targets, limits: Limits,
              history: list[tuple[State, Sample]] | None = None) -> Step:
    """Decide the next (exposure, gain) from what the camera just showed.

    Pure — no camera, no clock — so the control law can be tested against a
    simulated sensor rather than only against the one on the desk.

    `history` lets the step size be estimated from the camera's own measured
    response (a secant on the last two samples). Without it the step falls back
    to a fixed ratio, which converges more slowly but never diverges.

    It also drives the dead-end guard: when the controls are too coarse to land
    inside the tolerance band, the law will propose a setting it has already
    tried, and would then oscillate between the two values that straddle the
    band until the budget ran out — ending on whichever side it happened to stop.
    Observed on hardware at gain 78 (p95 187) and gain 93 (p95 215) against a
    target of 200 ± 12. Revisiting a setting means there is nothing left to
    learn, so the loop stops on the best measurement it actually took.
    """
    step = _plan_raw(sample, state, targets, limits, history)
    if step.done or not history:
        return step

    visited = {(s.exposure, s.gain) for s, _ in history}
    if (step.exposure, step.gain) not in visited:
        return step

    allowed = history
    if not targets.allow_exceed_blur:
        cap_units = targets.exposure_cap_ms() / EXPOSURE_UNIT_MS
        under_cap = [h for h in history if h[0].exposure <= cap_units]
        allowed = under_cap or history
    best_state, best_sample = min(allowed, key=lambda h: _distance(h[1], targets))
    reason = ("on-target" if in_tolerance(best_sample, targets, best_state)
              else "quantisation-limit")
    notes = [] if reason == "on-target" else [
        "the controls are too coarse to land inside the tolerance band; "
        "settling on the closest setting measured"
    ]
    return Step(best_state.exposure, best_state.gain, reason, done=True, notes=notes)


def _plan_raw(sample: Sample, state: State, targets: Targets, limits: Limits,
              history: list[tuple[State, Sample]] | None = None) -> Step:
    """The control law itself. See `plan_step`, which wraps this with the
    dead-end guard."""
    notes: list[str] = []
    exp_cap_units = int(targets.exposure_cap_ms() / EXPOSURE_UNIT_MS)
    soft_exp_max = min(limits.exp_max, exp_cap_units)

    # ── 2. clipping overrides the brightness target ───────────────────────────
    # A saturated white square is destroyed information; being on target for p95
    # while blowing out the highlights is not "good enough".
    if sample.clip_high > targets.clip_high_max:
        # Prefer cutting gain: it removes noise at the same time. Only shorten
        # exposure once gain is already at the floor.
        #
        # How far to cut is proportional to how far the picture is from where it
        # should be, not a fixed slice of the range. A blown-out frame at p95 233
        # gets a large cut; one sitting on target at p95 201 with a lamp clipping
        # 1.7% of the pixels gets a small one. The fixed 15% step made the second
        # case oscillate — down 19 units to p95 167 (too dark), back up, and round
        # again for nine iterations, because in a high-contrast scene "p95 on
        # target" and "nothing clipping" can be genuinely incompatible and the
        # loop has to converge on the compromise rather than bounce between the
        # two failures.
        if limits.has_gain and state.gain > limits.gain_min:
            aim = min(sample.p95 - 5.0, targets.p95)
            new_gain = _gain_toward(aim, sample, state, limits, history, -0.15)
            return Step(state.exposure, new_gain, "clip-high-lower-gain", notes=notes)
        new_exp = _snap(state.exposure * 0.8, limits.exp_min, limits.exp_max, limits.exp_step)
        if new_exp == state.exposure:
            new_exp = max(limits.exp_min, state.exposure - max(1, limits.exp_step))
        return Step(new_exp, state.gain, "clip-high-shorten-exposure", notes=notes)

    # Exposure over its cap: shorten it and let gain make up the light. Checked
    # before the on-target test, because a frame that is correctly exposed but
    # motion-smeared — or that took four frame periods to capture — is still not
    # the frame that was asked for.
    #
    # Two ways in. The caller may refuse to exceed the cap at all, in which case
    # this always runs. Or the picture may already be on target at an over-cap
    # exposure — then the cap is worth ATTEMPTING even when exceeding it is
    # permitted, because being on target here says nothing about whether the same
    # brightness is reachable within the cap. If it turns out not to be, the
    # brighten path pushes the exposure back out and the dead-end guard settles on
    # the better of the two. Without this, a run that inherited a long exposure
    # from the previous run declared itself on target and quietly kept the camera
    # at 30 fps when 60 was asked for.
    over_cap = state.exposure > soft_exp_max
    if over_cap and (not targets.allow_exceed_blur or in_tolerance(sample, targets)):
        new_exp = _snap(soft_exp_max, limits.exp_min, limits.exp_max, limits.exp_step)
        if limits.has_gain and state.gain < limits.gain_max:
            new_gain = _snap(state.gain + 0.15 * (limits.gain_max - limits.gain_min),
                             limits.gain_min, limits.gain_max, limits.gain_step)
            notes.append(f"shortening exposure under the {targets.cap_reason()} limit, gain compensates")
            return Step(new_exp, new_gain, "enforce-blur-limit", notes=notes)
        notes.append(f"shortening exposure under the {targets.cap_reason()} limit")
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
            new_gain = _gain_toward(targets.p95, sample, state, limits, history, 0.12)
            notes.append(f"exposure at the {targets.cap_reason()} limit; raising gain instead")
            return Step(state.exposure, new_gain, "brighten-gain", notes=notes)
        # Gain is maxed too. Either accept blur or stop and say the scene is dark.
        if targets.allow_exceed_blur and state.exposure < limits.exp_max:
            new_exp = _snap(state.exposure * exp_ratio, limits.exp_min, limits.exp_max, limits.exp_step)
            if new_exp > state.exposure:
                notes.append("exceeding the exposure cap: a dark frame has no corners at all")
                return Step(new_exp, state.gain, "brighten-exceed-blur", notes=notes)
        notes.append("at the end of both controls — the scene needs more light")
        return Step(state.exposure, state.gain, "too-dark-needs-light", done=True, notes=notes)

    # Too bright (but not clipping): drop gain first, it is the free win.
    if limits.has_gain and state.gain > limits.gain_min:
        new_gain = _gain_toward(targets.p95, sample, state, limits, history, -0.12)
        if new_gain < state.gain:
            return Step(state.exposure, new_gain, "darken-lower-gain", notes=notes)
    new_exp = _snap(state.exposure * exp_ratio, limits.exp_min, limits.exp_max, limits.exp_step)
    if new_exp == state.exposure:
        notes.append("controls are too coarse to get closer")
        return Step(state.exposure, state.gain, "quantisation-limit", done=True, notes=notes)
    return Step(new_exp, state.gain, "darken-exposure", notes=notes)


def verdict(sample: Sample, targets: Targets, state: State, limits: Limits,
            fps: float = 0.0) -> dict:
    """Human-facing summary of where the loop ended up, and why.

    `fps` is the rate the camera was actually delivering at the end. It is
    reported separately from the exposure arithmetic because the two can
    disagree in a way the operator needs to see: a short exposure that still
    runs slow means the ceiling is the sensor or the USB link, not the
    exposure — and no amount of tuning will lift it.
    """
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
    fps_cap_ms = 1000.0 / targets.fps_target if targets.fps_target > 0 else None
    if fps_cap_ms is not None and exp_ms > fps_cap_ms * 1.02:
        issues.append("costs-frame-rate")
    if targets.fps_target > 0 and fps > 0 and fps < targets.fps_target * 0.9 \
       and (fps_cap_ms is None or exp_ms <= fps_cap_ms * 1.02):
        # Exposure is inside the frame period, yet the frames are not arriving:
        # the limit is the sensor mode or the USB bandwidth at this resolution.
        issues.append("camera-fps-ceiling")
    if limits.has_gain and limits.gain_max > limits.gain_min:
        gf = (state.gain - limits.gain_min) / (limits.gain_max - limits.gain_min)
        if gf > 0.75:
            issues.append("high-gain")
    return {"ok": ok, "issues": issues, "exposure_ms": round(exp_ms, 2),
            "fps": round(fps, 1) if fps else None,
            "fps_from_exposure": round(1000.0 / exp_ms, 1) if exp_ms > 0 else None}


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


def _measured_fps(src) -> float:
    """The grabber's own rolling rate, or 0 when the source cannot report one.

    Optional rather than required so the loop still runs against a bare test
    double; a missing rate degrades to "unknown", never to a wrong number."""
    getter = getattr(src, "capture_fps", None)
    if not callable(getter):
        return 0.0
    try:
        value = getter()
    except Exception:
        return 0.0
    try:
        return float(value or 0.0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


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
        # Applied before the `done` check, not after it: the dead-end guard ends
        # the loop by naming the best setting it MEASURED, which is usually not
        # the one the camera is sitting on. Breaking out first would report that
        # setting while leaving the camera on the last one it tried.
        if step.exposure != state.exposure:
            apply_control("exposure", step.exposure)
        if step.gain != state.gain:
            apply_control("gain", step.gain)
        state = State(step.exposure, step.gain)

        if step.done:
            final_step = step
            break

    # One last look, so the reported result is what the camera is actually
    # producing rather than what the last-but-one iteration measured. The frame
    # rate is read after that wait for the same reason: the grabber's rolling
    # window needs to have refilled at the final exposure, or it would report
    # the rate of whatever the loop was doing two steps ago.
    time.sleep(max(settle_s, 1.2))
    final = measure_frame(src.read())
    fps = _measured_fps(src)
    v = (verdict(final, targets, state, limits, fps) if final
         else {"ok": False, "issues": ["no-frame"]})
    return {
        "ok": v["ok"],
        "issues": v["issues"],
        "exposure_ms": v.get("exposure_ms"),
        "fps": v.get("fps"),
        "fps_from_exposure": v.get("fps_from_exposure"),
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
