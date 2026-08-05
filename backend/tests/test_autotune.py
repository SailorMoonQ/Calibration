import json
import math
from pathlib import Path

import pytest

from app.sources.autotune import (
    EXPOSURE_UNIT_MS,
    Limits,
    Sample,
    State,
    Targets,
    in_tolerance,
    plan_step,
    verdict,
)

FIXTURE = Path(__file__).parent / "fixtures" / "imx307_response.json"


_RESPONSE = json.loads(FIXTURE.read_text())


def _interp(points, x):
    """Monotone piecewise-linear lookup with log-linear extrapolation, so the
    simulator stays sane outside the sweep instead of going flat or negative."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if x <= xs[0]:
        # Log-space extrapolation needs a positive anchor; the gain axis starts
        # at 0, so clamp there rather than dividing by log(0).
        if xs[0] <= 0 or x <= 0:
            return ys[0]
        k = math.log(ys[1] / ys[0]) / math.log(xs[1] / xs[0])
        return max(0.05, ys[0] * (x / xs[0]) ** k)
    if x >= xs[-1]:
        k = math.log(ys[-1] / ys[-2]) / math.log(xs[-1] / xs[-2])
        return ys[-1] * (x / xs[-1]) ** k
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= x <= x1:
            f = (x - x0) / (x1 - x0)
            return y0 + f * (y1 - y0)
    return ys[-1]


def _inv_interp(points, y):
    """p95 → the exposure that would produce it, at the sweep's reference gain."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if y <= ys[0]:
        if xs[0] <= 0 or y <= 0:
            return max(1e-3, xs[0])
        k = math.log(ys[1] / ys[0]) / math.log(xs[1] / xs[0])
        return max(1e-3, xs[0] * (y / ys[0]) ** (1 / k))
    if y >= ys[-1]:
        k = math.log(ys[-1] / ys[-2]) / math.log(xs[-1] / xs[-2])
        return xs[-1] * (y / ys[-1]) ** (1 / k)
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if y0 <= y <= y1:
            f = (y - y0) / (y1 - y0)
            return x0 + f * (x1 - x0)
    return xs[-1]


# Gain expressed as an equivalent exposure multiplier, derived from the measured
# gain sweep by asking "what exposure would have produced this p95?". Building it
# this way means the simulator reproduces BOTH sweeps by construction rather than
# by fitting a curve that the measurements show is not a power law (the local
# exponent runs from 0.81 down to 0.44 across the range).
def _gain_multiplier(gain):
    gs = _RESPONSE["gain_sweep"]
    ref_exp = gs["exposure"]
    pts = _RESPONSE["exposure_sweep"]["points"]
    p95_at = _interp(gs["points"], gain)
    return _inv_interp(pts, p95_at) / ref_exp


class FakeCamera:
    """A sensor that reproduces the response measured on the test rig.

    Built from the recorded sweeps by interpolation rather than from a model,
    because the measurements show the response is NOT a power law: gain is
    logarithmic (gain=0 is unity, not black) and the ISP's gamma makes the
    exposure exponent drift from 0.81 to 0.44 across the range. Those two facts
    are exactly what defeated the earlier open-loop advice, so a controller that
    only works against a tidy model would be no evidence at all.

    `light` scales the scene: 1.0 reproduces the measured room, lower is dimmer.
    """

    REF_GAIN = _RESPONSE["exposure_sweep"]["gain"]

    def __init__(self, light=1.0, exposure=150, gain=64):
        self.light = light
        self.exposure = exposure
        self.gain = gain
        self.reads = 0

    def sample(self):
        self.reads += 1
        # Everything is folded into an equivalent exposure at the reference gain,
        # then run through the measured exposure curve.
        eq = self.exposure * self.light * (_gain_multiplier(self.gain) / _gain_multiplier(self.REF_GAIN))
        p95 = min(255.0, _interp(_RESPONSE["exposure_sweep"]["points"], eq))
        clip_high = 0.0 if p95 < 250 else min(1.0, (p95 - 249) / 6)
        clip_low = max(0.0, min(1.0, (40 - p95) / 40))
        return Sample(p95=p95, clip_high=clip_high, clip_low=clip_low, mean=p95 * 0.45)

    def apply(self, step):
        self.exposure = step.exposure
        self.gain = step.gain


def run_loop(cam, targets, limits, max_iter=None):
    """Drive plan_step to convergence the way the endpoint does."""
    max_iter = max_iter or targets.max_iterations
    state = State(exposure=cam.exposure, gain=cam.gain)
    history = []
    for _ in range(max_iter):
        s = cam.sample()
        history.append((State(state.exposure, state.gain), s))
        step = plan_step(s, state, targets, limits, history)
        if step.done:
            return state, s, history, step
        state = State(step.exposure, step.gain)
        cam.apply(step)
    s = cam.sample()
    return state, s, history, None


LIMITS = Limits(exp_min=50, exp_max=10000, exp_step=1, gain_min=0, gain_max=128, gain_step=1)


# ── the simulator itself must match the real camera ──────────────────────────

def test_simulator_reproduces_the_measured_response():
    """If the fake sensor does not behave like the real one, every control test
    below is worthless."""
    data = json.loads(FIXTURE.read_text())
    for exposure, p95 in data["exposure_sweep"]["points"]:
        cam = FakeCamera(exposure=exposure, gain=data["exposure_sweep"]["gain"])
        got = cam.sample().p95
        assert abs(got - p95) < max(8, p95 * 0.12), f"exp={exposure}: {got:.0f} vs measured {p95}"
    for gain, p95 in data["gain_sweep"]["points"]:
        cam = FakeCamera(exposure=data["gain_sweep"]["exposure"], gain=gain)
        got = cam.sample().p95
        assert abs(got - p95) < max(8, p95 * 0.15), f"gain={gain}: {got:.0f} vs measured {p95}"


def test_the_response_is_not_linear_in_either_control():
    # Pins the properties that make open-loop compensation impossible, so nobody
    # "simplifies" the controller back to arithmetic.
    a = FakeCamera(exposure=100, gain=64).sample().p95
    b = FakeCamera(exposure=200, gain=64).sample().p95
    assert b / a < 1.85, "doubling exposure must NOT double p95 (gamma)"
    zero_gain = FakeCamera(exposure=150, gain=0).sample().p95
    assert zero_gain > 30, "gain=0 is unity gain, not black"
    # And the exponent is not even constant: it flattens as the sensor saturates.
    lo = math.log(b / a) / math.log(2)
    c = FakeCamera(exposure=800, gain=64).sample().p95
    d = FakeCamera(exposure=1600, gain=64).sample().p95
    hi = math.log(d / c) / math.log(2)
    assert hi < lo, "the response must flatten at the top, as measured"


# ── the loop reaches the target ──────────────────────────────────────────────

def test_converges_from_a_dark_start():
    cam = FakeCamera(exposure=60, gain=0)
    t = Targets(exposure_max_ms=100.0)
    state, s, hist, step = run_loop(cam, t, LIMITS)
    assert in_tolerance(s, t), f"ended at p95={s.p95:.0f} after {len(hist)} steps"


def test_converges_from_an_overexposed_start():
    cam = FakeCamera(exposure=6000, gain=128)
    t = Targets(exposure_max_ms=100.0)
    state, s, hist, step = run_loop(cam, t, LIMITS)
    assert in_tolerance(s, t), f"ended at p95={s.p95:.0f}"


def test_converges_from_the_state_the_old_advice_produced():
    # gain 56 / exposure 160 was where the previous open-loop guidance settled,
    # and it left the picture at p95≈80 — the failure that motivated all this.
    cam = FakeCamera(exposure=160, gain=56)
    t = Targets(exposure_max_ms=100.0)
    state, s, hist, step = run_loop(cam, t, LIMITS)
    assert in_tolerance(s, t)
    assert s.p95 > 150, "the whole point is not to end up dark again"


@pytest.mark.parametrize("exposure,gain", [(50, 0), (150, 64), (900, 10), (3000, 100), (10000, 128)])
def test_converges_from_many_starting_points(exposure, gain):
    cam = FakeCamera(exposure=exposure, gain=gain)
    t = Targets(exposure_max_ms=100.0)
    _, s, hist, _ = run_loop(cam, t, LIMITS)
    assert in_tolerance(s, t), f"from ({exposure},{gain}) ended p95={s.p95:.0f}"


def test_converges_in_a_handful_of_steps():
    # Each measurement costs a settle delay on real hardware (~250 ms), so the
    # step count is what the user experiences as "how long does Auto take".
    # The bound is loose because correctness comes first: spending all the
    # exposure headroom before touching gain costs an extra round trip and is
    # worth it.
    cam = FakeCamera(exposure=60, gain=0)
    t = Targets(exposure_max_ms=100.0)
    _, _, hist, _ = run_loop(cam, t, LIMITS)
    assert len(hist) <= 12, f"took {len(hist)} measurements"


def test_the_loop_terminates_rather_than_oscillating():
    # A control that never reports done would spin against a real camera.
    cam = FakeCamera(exposure=150, gain=64)
    t = Targets(exposure_max_ms=100.0)
    _, _, _, step = run_loop(cam, t, LIMITS)
    assert step is not None and step.done


# ── priority: brightness is never traded away ────────────────────────────────

def test_a_dim_scene_exceeds_the_blur_limit_rather_than_staying_dark():
    # This is the crux. Under the old rules the loop would have "succeeded" with
    # a clean, low-gain, unusably dark frame. A slightly soft but well-exposed
    # frame has corners; a dark one does not.
    cam = FakeCamera(light=0.25, exposure=60, gain=0)
    t = Targets(exposure_max_ms=16.0, allow_exceed_blur=True)
    state, s, _, _ = run_loop(cam, t, LIMITS)
    assert s.p95 > 150, f"stayed dark at p95={s.p95:.0f}"
    assert state.exposure * EXPOSURE_UNIT_MS > 16.0
    assert "exceeds-blur-limit" in verdict(s, t, state, LIMITS)["issues"]


def test_gain_is_raised_only_after_exposure_hits_the_blur_limit():
    cam = FakeCamera(light=0.5, exposure=60, gain=0)
    t = Targets(exposure_max_ms=16.0, allow_exceed_blur=False)
    state, _, hist, _ = run_loop(cam, t, LIMITS)
    # Whenever gain went up, exposure was already at (or above) the cap.
    for (prev, _), (cur, _) in zip(hist, hist[1:]):
        if cur.gain > prev.gain:
            assert prev.exposure >= int(16.0 / EXPOSURE_UNIT_MS) - 1, \
                f"gain rose at exposure {prev.exposure}, below the blur cap"


def test_refusing_to_exceed_blur_reports_the_scene_as_too_dark():
    cam = FakeCamera(light=0.05, exposure=60, gain=0)
    t = Targets(exposure_max_ms=16.0, allow_exceed_blur=False)
    state, s, _, step = run_loop(cam, t, LIMITS)
    assert step is not None and step.reason == "too-dark-needs-light"
    # And it says so plainly rather than reporting success.
    assert verdict(s, t, state, LIMITS)["ok"] is False


# ── clipping outranks the brightness target ──────────────────────────────────

def test_clipping_is_fixed_before_anything_else():
    s = Sample(p95=200, clip_high=0.2, clip_low=0)
    st = State(exposure=500, gain=64)
    step = plan_step(s, st, Targets(), LIMITS)
    # p95 is exactly on target, yet the step must still act.
    assert step.done is False
    assert step.gain < 64 or step.exposure < 500


def test_clipping_is_relieved_by_cutting_gain_first():
    # Gain down removes noise as well as brightness; exposure down only darkens.
    s = Sample(p95=250, clip_high=0.2, clip_low=0)
    step = plan_step(s, State(exposure=500, gain=64), Targets(), LIMITS)
    assert step.gain < 64
    assert step.exposure == 500


def test_clipping_falls_back_to_exposure_once_gain_is_at_the_floor():
    s = Sample(p95=250, clip_high=0.2, clip_low=0)
    step = plan_step(s, State(exposure=500, gain=0), Targets(), LIMITS)
    assert step.exposure < 500


# ── gain minimisation, but only after the targets hold ───────────────────────

def test_on_target_with_headroom_trades_gain_down_for_exposure_up():
    s = Sample(p95=200, clip_high=0, clip_low=0)
    st = State(exposure=100, gain=100)
    step = plan_step(s, st, Targets(exposure_max_ms=100.0), LIMITS)
    assert step.done is False
    assert step.gain < 100 and step.exposure > 100


def test_on_target_without_headroom_simply_stops():
    s = Sample(p95=200, clip_high=0, clip_low=0)
    st = State(exposure=1000, gain=100)   # already at the 100 ms cap
    step = plan_step(s, st, Targets(exposure_max_ms=100.0), LIMITS)
    assert step.done is True


def test_on_target_at_minimum_gain_stops():
    s = Sample(p95=200, clip_high=0, clip_low=0)
    step = plan_step(s, State(exposure=100, gain=0), Targets(exposure_max_ms=100.0), LIMITS)
    assert step.done is True


def test_the_polish_pass_does_not_undo_the_brightness_it_just_achieved():
    cam = FakeCamera(exposure=60, gain=0)
    t = Targets(exposure_max_ms=100.0)
    _, s, _, _ = run_loop(cam, t, LIMITS)
    assert in_tolerance(s, t), "polishing must leave the sample in tolerance"


# ── degenerate hardware ──────────────────────────────────────────────────────

def test_a_camera_with_no_gain_control_still_converges():
    limits = Limits(exp_min=50, exp_max=10000, gain_min=0, gain_max=0, has_gain=False)
    cam = FakeCamera(exposure=60, gain=0)
    t = Targets(exposure_max_ms=100.0)
    _, s, _, _ = run_loop(cam, t, limits)
    assert in_tolerance(s, t)


def test_a_coarse_exposure_step_terminates_instead_of_hunting():
    limits = Limits(exp_min=100, exp_max=400, exp_step=300, gain_min=0, gain_max=0, has_gain=False)
    s = Sample(p95=205, clip_high=0, clip_low=0)
    step = plan_step(s, State(exposure=400, gain=0), Targets(p95=200, p95_tol=1), limits)
    assert step.done is True
    assert step.reason == "quantisation-limit"


def test_proposed_values_never_leave_the_control_range():
    limits = Limits(exp_min=50, exp_max=200, gain_min=10, gain_max=40)
    for p95 in (5, 50, 120, 200, 254):
        for st in (State(50, 10), State(200, 40), State(120, 25)):
            step = plan_step(Sample(p95=p95, clip_high=0, clip_low=0), st, Targets(), limits)
            assert limits.exp_min <= step.exposure <= limits.exp_max
            assert limits.gain_min <= step.gain <= limits.gain_max


# ── tolerance and verdict ────────────────────────────────────────────────────

def test_tolerance_is_honoured_in_both_directions():
    t = Targets(p95=200, p95_tol=12)
    assert in_tolerance(Sample(p95=190, clip_high=0, clip_low=0), t)
    assert in_tolerance(Sample(p95=211, clip_high=0, clip_low=0), t)
    assert not in_tolerance(Sample(p95=185, clip_high=0, clip_low=0), t)
    assert not in_tolerance(Sample(p95=215, clip_high=0, clip_low=0), t)


def test_tolerance_rejects_a_clipped_sample_even_when_p95_is_perfect():
    t = Targets(p95=200, p95_tol=12)
    assert not in_tolerance(Sample(p95=200, clip_high=0.5, clip_low=0), t)
    assert not in_tolerance(Sample(p95=200, clip_high=0, clip_low=0.5), t)


def test_verdict_names_every_thing_that_is_wrong():
    t = Targets(p95=200, p95_tol=12, exposure_max_ms=16.0)
    v = verdict(Sample(p95=60, clip_high=0, clip_low=0.5), t, State(400, 120), LIMITS)
    assert v["ok"] is False
    assert set(v["issues"]) >= {"too-dark", "clipped-low", "exceeds-blur-limit", "high-gain"}
    assert v["exposure_ms"] == pytest.approx(40.0)


def test_verdict_on_a_good_result_is_clean():
    t = Targets(p95=200, p95_tol=12, exposure_max_ms=100.0)
    v = verdict(Sample(p95=200, clip_high=0, clip_low=0), t, State(500, 10), LIMITS)
    assert v["ok"] is True
    assert v["issues"] == []


def test_the_measured_exponent_is_used_when_history_allows_it():
    hist = [(State(100, 64), Sample(p95=58, clip_high=0, clip_low=0))]
    step = plan_step(Sample(p95=98, clip_high=0, clip_low=0), State(200, 64),
                     Targets(exposure_max_ms=100.0), LIMITS, hist)
    assert any("exponent" in n for n in step.notes)
    # The measured slope (~0.76 here) must beat assuming linearity, which would
    # under-shoot the required exposure by a wide margin.
    assert step.exposure > 200 * (200 / 98) * 0.8


def test_history_from_a_different_gain_is_not_used_for_the_exposure_slope():
    hist = [(State(100, 10), Sample(p95=58, clip_high=0, clip_low=0))]
    step = plan_step(Sample(p95=98, clip_high=0, clip_low=0), State(200, 64),
                     Targets(exposure_max_ms=100.0), LIMITS, hist)
    assert not any("exponent" in n for n in step.notes)


# ── the blur cap is enforced, not merely checked at the end ─────────────────
# Found on hardware: starting from a state a previous run had left at 100 ms,
# the loop reported "on-target" and never brought the exposure back down — while
# simultaneously listing "exceeds-blur-limit" as a problem. The simulator tests
# all started dark, so none of them walked this path.

def test_an_over_cap_exposure_is_not_on_target_when_blur_is_refused():
    s = Sample(p95=200, clip_high=0, clip_low=0)
    st = State(exposure=1000, gain=43)          # 100 ms
    t = Targets(exposure_max_ms=16.0, allow_exceed_blur=False)
    assert in_tolerance(s, t) is True, "the picture itself is fine"
    assert in_tolerance(s, t, st) is False, "but it took 100 ms to take"


def test_the_loop_brings_an_over_cap_exposure_back_down():
    s = Sample(p95=200, clip_high=0, clip_low=0)
    st = State(exposure=1000, gain=43)
    t = Targets(exposure_max_ms=16.0, allow_exceed_blur=False)
    step = plan_step(s, st, t, LIMITS)
    assert step.done is False
    assert step.exposure <= 160
    assert step.gain > 43, "gain must take over the light exposure gives up"


def test_verdict_is_not_ok_while_it_lists_a_blur_problem():
    # ok=True alongside issues=['exceeds-blur-limit'] is a contradiction the
    # caller cannot act on.
    t = Targets(exposure_max_ms=16.0, allow_exceed_blur=False)
    v = verdict(Sample(p95=200, clip_high=0, clip_low=0), t, State(1000, 43), LIMITS)
    assert v["ok"] is False
    assert "exceeds-blur-limit" in v["issues"]


def test_exceeding_blur_is_fine_when_the_caller_allows_it():
    t = Targets(exposure_max_ms=16.0, allow_exceed_blur=True)
    v = verdict(Sample(p95=200, clip_high=0, clip_low=0), t, State(1000, 43), LIMITS)
    assert v["ok"] is True
    # Still reported, so the user knows a tripod would help.
    assert "exceeds-blur-limit" in v["issues"]


def test_enforcing_the_cap_converges_rather_than_ping_ponging():
    cam = FakeCamera(exposure=1000, gain=43)
    t = Targets(exposure_max_ms=16.0, allow_exceed_blur=False)
    _, s, hist, step = run_loop(cam, t, LIMITS)
    exposures = [st.exposure for st, _ in hist]
    assert all(e <= 200 for e in exposures[2:]), f"kept hunting: {exposures}"


# ── the frame-rate cap ───────────────────────────────────────────────────────
#
# A sensor cannot integrate for longer than one frame period. Measured on the
# rig at 1280x720: 33 ms -> 30 fps, 60 ms -> 16.6 fps, 200 ms -> 5.0 fps, i.e.
# exactly 1000/exposure_ms once the exposure passes the frame period. So asking
# for 60 fps IS asking for exposure <= 16.7 ms, and the controller has to treat
# it as a hard ceiling rather than a preference.

def test_the_frame_rate_sets_an_exposure_ceiling():
    t = Targets(exposure_max_ms=200.0, fps_target=60.0)
    assert t.exposure_cap_ms() == pytest.approx(1000 / 60)
    assert t.cap_reason() == "fps"


def test_the_tighter_of_the_two_caps_wins():
    # Handheld blur limit is stricter than a 30 fps frame period.
    t = Targets(exposure_max_ms=16.0, fps_target=30.0)
    assert t.exposure_cap_ms() == 16.0
    assert t.cap_reason() == "blur"


def test_no_frame_rate_target_leaves_the_blur_limit_alone():
    t = Targets(exposure_max_ms=200.0, fps_target=0.0)
    assert t.exposure_cap_ms() == 200.0
    assert t.cap_reason() == "blur"


def test_a_fixed_rig_at_60fps_stops_at_the_frame_period_not_at_200ms():
    """The bug this guards: 'fixed mount' used to mean a 200 ms cap, so a dim
    room walked the exposure to 2000 units and quietly dropped the camera to
    5 fps."""
    cam = FakeCamera(exposure=50, gain=0)
    t = Targets(exposure_max_ms=200.0, fps_target=60.0, allow_exceed_blur=False)
    state, _, hist, _ = run_loop(cam, t, LIMITS)
    cap_units = int((1000 / 60) / EXPOSURE_UNIT_MS)
    assert state.exposure <= cap_units, f"exposure ran past the frame period: {state.exposure}"
    assert all(st.exposure <= cap_units for st, _ in hist)


def test_gain_covers_what_the_frame_rate_cap_takes_away():
    """Capping exposure must not simply darken the picture — the light has to
    come from somewhere, and gain is the only other source."""
    cam = FakeCamera(exposure=50, gain=0)
    t = Targets(exposure_max_ms=200.0, fps_target=60.0, allow_exceed_blur=False)
    state, s, _, _ = run_loop(cam, t, LIMITS)
    assert state.gain > 0, "capped the exposure and left the gain at zero"
    assert s.p95 > 120, f"ended dark at p95={s.p95}"


def test_an_over_period_exposure_is_reported_as_costing_frame_rate():
    t = Targets(exposure_max_ms=200.0, fps_target=60.0, allow_exceed_blur=True)
    v = verdict(Sample(p95=200, clip_high=0, clip_low=0), t, State(1000, 43), LIMITS)
    assert "costs-frame-rate" in v["issues"]
    assert v["fps_from_exposure"] == pytest.approx(10.0), "100 ms exposure is 10 fps"


def test_a_slow_camera_at_a_short_exposure_is_blamed_on_the_camera():
    """Exposure inside the frame period yet the frames are not arriving: the
    ceiling is the sensor mode or the USB link, and no tuning will lift it.
    Measured: this rig tops out near 30 fps at 720p even at a 5 ms exposure."""
    t = Targets(exposure_max_ms=200.0, fps_target=60.0)
    v = verdict(Sample(p95=200, clip_high=0, clip_low=0), t, State(100, 20), LIMITS,
                fps=30.0)
    assert "camera-fps-ceiling" in v["issues"]
    assert "costs-frame-rate" not in v["issues"], "the exposure is not the problem"
    assert v["fps"] == 30.0


def test_the_camera_is_not_blamed_when_the_exposure_is_the_cause():
    t = Targets(exposure_max_ms=200.0, fps_target=60.0)
    v = verdict(Sample(p95=200, clip_high=0, clip_low=0), t, State(1000, 43), LIMITS,
                fps=10.0)
    assert "camera-fps-ceiling" not in v["issues"]
    assert "costs-frame-rate" in v["issues"]


def test_an_unknown_frame_rate_raises_no_frame_rate_complaint():
    t = Targets(exposure_max_ms=200.0, fps_target=60.0)
    v = verdict(Sample(p95=200, clip_high=0, clip_low=0), t, State(100, 20), LIMITS,
                fps=0.0)
    assert "camera-fps-ceiling" not in v["issues"]
    assert v["fps"] is None


# ── the controls are coarser than the tolerance band ─────────────────────────
#
# Found on hardware once the frame-rate cap pinned the exposure and left gain as
# the only free control: gain 78 gave p95 187 and gain 93 gave p95 215, against a
# target of 200 ± 12. The loop bounced between the two for the whole budget and
# stopped on whichever side the count ran out on.

def test_the_gain_step_shrinks_as_it_closes_in():
    """A fixed fraction of the range steps clean over a 24-level band. The step
    has to come from the camera's measured response, like the exposure step
    already does."""
    # Currently at gain 78 having come down from 93: ~1.85 p95 per gain unit.
    hist = [
        (State(exposure=166, gain=93), Sample(p95=215, clip_high=0, clip_low=0)),
        (State(exposure=166, gain=78), Sample(p95=187, clip_high=0, clip_low=0)),
    ]
    t = Targets(exposure_max_ms=200.0, fps_target=60.0)
    step = plan_step(hist[-1][1], hist[-1][0], t, LIMITS, hist)
    assert step.gain > 78, "must raise the gain"
    assert step.gain < 93, f"stepped past the band again: {step.gain}"


def test_the_loop_stops_instead_of_oscillating_over_the_band():
    """End to end against the simulated sensor, with a band tight enough that no
    integer gain lands inside it. The loop must stop rather than burn the whole
    budget bouncing across it."""
    cam = FakeCamera(exposure=50, gain=61)
    t = Targets(p95=200, p95_tol=1.0, exposure_max_ms=200.0, fps_target=60.0,
                max_iterations=40)
    _, _, _, step = run_loop(cam, t, LIMITS)
    assert step is not None, "ran out of iterations instead of settling"
    assert step.done is True


def test_it_settles_on_the_closest_setting_it_actually_measured():
    # Gain 80 measured p95 200 — 0.5 off a target the band is too tight to hold.
    # The controller lands back on 80, so there is nothing new left to try.
    hist = [
        (State(exposure=166, gain=60), Sample(p95=160, clip_high=0, clip_low=0)),
        (State(exposure=166, gain=80), Sample(p95=200, clip_high=0, clip_low=0)),
        (State(exposure=166, gain=60), Sample(p95=160, clip_high=0, clip_low=0)),
    ]
    t = Targets(p95=199.5, p95_tol=0.4, exposure_max_ms=200.0, fps_target=60.0)
    step = plan_step(hist[-1][1], hist[-1][0], t, LIMITS, hist)
    assert (step.exposure, step.gain) == (166, 80), "did not return to the best measurement"
    assert step.reason == "quantisation-limit"
    assert step.done is True


def test_a_clipped_setting_is_never_the_one_it_settles_on():
    # p95 is exactly on target at gain 80, but 6% of the picture is saturated
    # there and those white squares are gone for good. Gain 70 is 20 levels off
    # and still the better answer.
    hist = [
        (State(exposure=166, gain=60), Sample(p95=160, clip_high=0.0, clip_low=0)),
        (State(exposure=166, gain=80), Sample(p95=200, clip_high=0.06, clip_low=0)),
        (State(exposure=166, gain=70), Sample(p95=180, clip_high=0.0, clip_low=0)),
        (State(exposure=166, gain=60), Sample(p95=160, clip_high=0.0, clip_low=0)),
    ]
    t = Targets(p95=200, p95_tol=1, exposure_max_ms=200.0, fps_target=60.0)
    step = plan_step(hist[-1][1], hist[-1][0], t, LIMITS, hist)
    assert step.done is True
    assert step.gain == 70, "settled on a setting with blown highlights"


def test_settling_reports_on_target_when_the_best_actually_qualifies():
    hist = [
        (State(exposure=166, gain=78), Sample(p95=187, clip_high=0, clip_low=0)),
        (State(exposure=166, gain=93), Sample(p95=215, clip_high=0, clip_low=0)),
        (State(exposure=166, gain=78), Sample(p95=187, clip_high=0, clip_low=0)),
    ]
    t = Targets(p95=200, p95_tol=15, exposure_max_ms=200.0, fps_target=60.0)
    step = plan_step(hist[-1][1], hist[-1][0], t, LIMITS, hist)
    assert step.done is True
    assert step.reason == "on-target", "187 is inside 200 ± 15"


def test_settling_respects_a_refused_blur_limit():
    """The best-looking measurement may be one taken over the exposure cap. If
    the caller refused to exceed it, that setting is not a candidate."""
    hist = [
        (State(exposure=2000, gain=20), Sample(p95=200, clip_high=0, clip_low=0)),
        (State(exposure=166, gain=93), Sample(p95=180, clip_high=0, clip_low=0)),
        (State(exposure=2000, gain=20), Sample(p95=200, clip_high=0, clip_low=0)),
    ]
    t = Targets(p95=200, p95_tol=1, exposure_max_ms=200.0, fps_target=60.0,
                allow_exceed_blur=False)
    step = plan_step(hist[-1][1], hist[-1][0], t, LIMITS, hist)
    assert step.exposure == 166, "settled on a setting that breaks the frame rate"


def test_a_fresh_run_with_no_history_is_untouched_by_the_guard():
    s = Sample(p95=80, clip_high=0, clip_low=0)
    step = plan_step(s, State(exposure=100, gain=0), Targets(exposure_max_ms=100.0), LIMITS)
    assert step.done is False


def test_a_long_exposure_inherited_from_the_last_run_is_brought_back_down():
    """Hardware bug: a 60 fps run that started at the 31.6 ms exposure a 30 fps
    run had left behind called itself on-target on the first look — while listing
    costs-frame-rate as a problem. Being correctly exposed at an over-cap
    exposure says nothing about whether the same brightness is reachable within
    the cap, so the cap is worth trying even when exceeding it is permitted."""
    s = Sample(p95=200, clip_high=0, clip_low=0)
    st = State(exposure=316, gain=54)                 # 31.6 ms — 30 fps
    t = Targets(exposure_max_ms=200.0, fps_target=60.0, allow_exceed_blur=True)
    step = plan_step(s, st, t, LIMITS)
    assert step.done is False, "declared victory at half the requested frame rate"
    assert step.exposure <= 167
    assert step.gain > 54, "gain must take over the light exposure gives up"


def test_a_dark_scene_may_still_exceed_the_cap_when_that_is_permitted():
    """The cap attempt must not turn into a refusal: if the target genuinely is
    not reachable inside it, a bright frame beats a fast one."""
    cam = FakeCamera(light=0.10, exposure=50, gain=0)
    t = Targets(exposure_max_ms=200.0, fps_target=60.0, allow_exceed_blur=True,
                max_iterations=30)
    state, s, _, _ = run_loop(cam, t, LIMITS)
    assert state.exposure > 167, "stayed fast and dark instead of getting the picture"
    assert s.p95 > 120, f"ended dark at p95={s.p95:.0f}"
