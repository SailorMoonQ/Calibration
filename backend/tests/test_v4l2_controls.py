from pathlib import Path

import pytest

from app.sources.v4l2_controls import (
    LOCK_PARENTS,
    _apply_order,
    is_v4l2_device,
    parse_controls,
    sort_controls,
)

FIXTURE = Path(__file__).parent / "fixtures" / "v4l2_imx307_ctrls.txt"


@pytest.fixture(scope="module")
def imx307():
    return parse_controls(FIXTURE.read_text())


def _by_id(controls):
    return {c["id"]: c for c in controls}


def test_parses_every_control_from_a_real_camera(imx307):
    ids = [c["id"] for c in imx307]
    assert ids == [
        "brightness", "contrast", "saturation", "hue", "white_balance_automatic",
        "gamma", "gain", "power_line_frequency", "white_balance_temperature",
        "sharpness", "backlight_compensation",
        "auto_exposure", "exposure_time_absolute", "exposure_dynamic_framerate",
        "focus_absolute", "focus_automatic_continuous",
    ]


def test_int_control_carries_its_full_range(imx307):
    b = _by_id(imx307)["brightness"]
    assert b["type"] == "int"
    assert (b["min"], b["max"], b["step"]) == (-64, 64, 1)
    assert b["default"] == 0
    assert b["value"] == 40
    assert b["inactive"] is False


def test_negative_minimums_are_not_mangled(imx307):
    hue = _by_id(imx307)["hue"]
    assert (hue["min"], hue["max"]) == (-180, 180)


def test_non_unit_step_survives(imx307):
    wb = _by_id(imx307)["white_balance_temperature"]
    assert wb["step"] == 10


def test_bool_control_gets_a_synthetic_range(imx307):
    a = _by_id(imx307)["white_balance_automatic"]
    assert a["type"] == "bool"
    # v4l2 prints no min/max for bools; a slider-less widget still needs bounds.
    assert (a["min"], a["max"], a["step"]) == (0, 1, 1)
    assert a["default"] == 1 and a["value"] == 1


def test_menu_control_collects_its_options(imx307):
    m = _by_id(imx307)["power_line_frequency"]
    assert m["type"] == "menu"
    assert m["menu"] == [
        {"value": 0, "label": "Disabled"},
        {"value": 1, "label": "50 Hz"},
        {"value": 2, "label": "60 Hz"},
    ]


def test_menu_options_attach_to_the_right_control(imx307):
    # auto_exposure's options must not leak into the int control printed after it.
    ae = _by_id(imx307)["auto_exposure"]
    assert ae["menu"] == [
        {"value": 1, "label": "Manual Mode"},
        {"value": 3, "label": "Aperture Priority Mode"},
    ]
    assert "menu" not in _by_id(imx307)["exposure_time_absolute"]


def test_group_follows_the_section_header(imx307):
    by = _by_id(imx307)
    assert by["brightness"]["group"] == "user"
    assert by["auto_exposure"]["group"] == "camera"


def test_inactive_flag_and_inferred_lock_parent(imx307):
    by = _by_id(imx307)
    wb = by["white_balance_temperature"]
    assert wb["inactive"] is True
    assert wb["locked_by"] == {"id": "white_balance_automatic", "unlock_value": 0}

    focus = by["focus_absolute"]
    assert focus["inactive"] is True
    assert focus["locked_by"] == {"id": "focus_automatic_continuous", "unlock_value": 0}

    # This fixture was captured with auto_exposure already on Manual, so exposure
    # time is NOT locked — the flag must track the driver, not the lookup table.
    assert by["exposure_time_absolute"]["inactive"] is False
    assert by["exposure_time_absolute"]["locked_by"] is None


def test_inactive_control_with_no_known_parent_still_reports_inactive():
    ctrls = parse_controls(
        "User Controls\n\n"
        "   mystery_knob 0x00980999 (int)    : min=0 max=9 step=1 default=0 value=0 flags=inactive\n"
    )
    assert len(ctrls) == 1
    assert ctrls[0]["inactive"] is True
    # Unknown parent must not be guessed — the UI shows it disabled without an
    # "unlock" button rather than offering to change the wrong control.
    assert ctrls[0]["locked_by"] is None


def test_unsupported_control_types_are_skipped():
    ctrls = parse_controls(
        "User Controls\n\n"
        "   do_thing 0x00980aaa (button) : flags=write-only, execute-on-write\n"
        "   label    0x00980bbb (string) : min=0 max=16 step=1\n"
        "   keep_me  0x00980ccc (int)    : min=0 max=5 step=1 default=1 value=2\n"
    )
    assert [c["id"] for c in ctrls] == ["keep_me"]


def test_garbage_lines_do_not_break_the_parse():
    ctrls = parse_controls(
        "User Controls\n\n"
        "this line is nonsense\n"
        "   gain 0x00980913 (int) : min=0 max=128 step=1 default=64 value=80\n"
        "\t\t\t\tstray: menu option with no control\n"
    )
    assert [c["id"] for c in ctrls] == ["gain"]


def test_empty_and_none_input():
    assert parse_controls("") == []
    assert parse_controls(None) == []


def test_sort_puts_common_controls_first_in_a_fixed_order(imx307):
    ordered = sort_controls(imx307)
    ids = [c["id"] for c in ordered]
    assert ids[:6] == [
        "auto_exposure", "exposure_time_absolute", "gain", "brightness",
        "white_balance_automatic", "white_balance_temperature",
    ]
    assert all(c["common"] for c in ordered[:8])
    assert not any(c["common"] for c in ordered[8:])
    # Nothing may be dropped or duplicated by sorting.
    assert sorted(ids) == sorted(c["id"] for c in imx307)


def test_apply_order_puts_parents_before_children():
    order = _apply_order({"exposure_time_absolute": 300, "auto_exposure": 1, "gain": 64})
    assert order.index("auto_exposure") < order.index("exposure_time_absolute")


def test_apply_order_keeps_every_key():
    values = {"gain": 1, "auto_exposure": 1, "brightness": 2, "focus_absolute": 3,
              "focus_automatic_continuous": 0}
    assert sorted(_apply_order(values)) == sorted(values)


def test_every_lock_parent_is_a_plausible_control_name():
    # Guards against a typo in the table silently disabling the unlock button.
    for child, (parent, unlock) in LOCK_PARENTS.items():
        assert child != parent
        assert parent.replace("_", "").isalnum()
        assert unlock in (0, 1)


@pytest.mark.parametrize(
    "device,expected",
    [
        ("/dev/video0", True),
        ("/dev/video12", True),
        ("ros2:/camera/head/color/image_raw", False),
        ("/dev/videoX", False),
        ("", False),
        (None, False),
    ],
)
def test_is_v4l2_device(device, expected):
    assert is_v4l2_device(device) is expected


# ── clamping ────────────────────────────────────────────────────────────────
# The driver clamps out-of-range writes SILENTLY (gain=9999 on a max=128 control
# reports success and stores 128), so we clamp first and report that we did.

from app.sources.v4l2_controls import clamp_value  # noqa: E402


@pytest.mark.parametrize(
    "ctrl,value,expected,adjusted",
    [
        ({"min": 0, "max": 128, "step": 1}, 64, 64, False),
        ({"min": 0, "max": 128, "step": 1}, 9999, 128, True),
        ({"min": 0, "max": 128, "step": 1}, -5, 0, True),
        ({"min": -64, "max": 64, "step": 1}, -64, -64, False),
        ({"min": -64, "max": 64, "step": 1}, -100, -64, True),
        # step grid: 2800 + n*10
        ({"min": 2800, "max": 6500, "step": 10}, 4600, 4600, False),
        ({"min": 2800, "max": 6500, "step": 10}, 4604, 4600, True),
        ({"min": 2800, "max": 6500, "step": 10}, 4607, 4610, True),
    ],
)
def test_clamp_value(ctrl, value, expected, adjusted):
    assert clamp_value(ctrl, value) == (expected, adjusted)


def test_clamp_never_exceeds_max_when_snapping_up():
    # 6499 rounds up to 6500 which is exactly max — must not overshoot to 6510.
    v, _ = clamp_value({"min": 2800, "max": 6500, "step": 10}, 6499)
    assert v <= 6500


def test_clamp_on_a_max_not_on_the_step_grid():
    # A driver may advertise max=105 with step=10 from min=0. Snapping must stay
    # inside the range even though 110 would be the nearest grid point.
    v, adjusted = clamp_value({"min": 0, "max": 105, "step": 10}, 105)
    assert v <= 105 and adjusted is True


def test_clamp_tolerates_missing_bounds():
    # Some drivers omit min/max for odd control types; absence must pass through
    # rather than crash the whole panel.
    assert clamp_value({"step": 1}, 42) == (42, False)
    assert clamp_value({"min": 0, "step": 1}, -3) == (0, True)


def test_clamp_bool_range():
    assert clamp_value({"min": 0, "max": 1, "step": 1}, 5) == (1, True)
    assert clamp_value({"min": 0, "max": 1, "step": 1}, 1) == (1, False)
