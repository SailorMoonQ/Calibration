"""Regression test for the Quest 3S teleop-APK log-format compatibility patch.

The teleop APK on Quest 3S emits eight '&'-separated fields per logcat line
(transforms & buttons & timestamp_ns & five tracking-status pairs). Upstream
``OculusReader.process_data`` unpacks ``string.split('&')`` into exactly two
values, so every line raised ValueError and was dropped — ``poll()`` then saw
no transforms (the "0 samples" symptom). ``_patch_process_data`` collapses the
payload back to the transforms+buttons pair the upstream parser expects.
"""
from __future__ import annotations

import pytest

# Importing the source module adds the vendored oculus_reader to sys.path.
oculus = pytest.importorskip("app.sources.poses.oculus")
pytest.importorskip("ppadb")  # oculus_reader.reader imports ppadb at load time

from oculus_reader.reader import OculusReader  # noqa: E402

# A real logcat payload captured from a Quest 3S (the text after 'wE9ryARX: ').
# Eight '&'-separated fields: transforms & buttons & timestamp_ns & 5 status pairs.
_EIGHT_FIELD = (
    "l:0.729374 -0.0159622 0.683929 -0.0440595 0.674585 0.183077 -0.715135 "
    "0.0897328 -0.113796 0.982969 0.144299 -0.225205 0 0 0 1 "
    "|r:0.487568 -0.385181 0.783526 0.183707 0.651045 -0.437554 -0.620231 "
    "0.127373 0.581736 0.812516 0.0374327 -0.265678 0 0 0 1 "
    "&L,LThU,leftJS 0.000000 0.000000,leftTrig 0.000000,leftGrip 0.000000,"
    "R,RThU,rightJS 0.000000 0.000000,rightTrig 0.000000,rightGrip 0.000000"
    "&1779246685411609000&l:1*r:1&l:0*r:1&l:1*r:1&l:0*r:1&l:1*r:1"
)


def test_eight_field_payload_has_more_than_one_separator():
    """Guards the premise: the captured line is what breaks the strict unpack."""
    assert _EIGHT_FIELD.count("&") > 1


def test_patched_parser_keeps_multifield_lines():
    oculus._patch_process_data(OculusReader)
    transforms, _buttons = OculusReader.process_data(_EIGHT_FIELD)

    assert transforms is not None, "patched parser dropped a valid 8-field line"
    assert {"l", "r"} <= set(transforms)
    for ch in ("l", "r"):
        assert transforms[ch].shape == (4, 4)
        assert transforms[ch][3].tolist() == [0.0, 0.0, 0.0, 1.0]


def test_patched_parser_still_accepts_legacy_two_field_lines():
    oculus._patch_process_data(OculusReader)
    parts = _EIGHT_FIELD.split("&")
    legacy = parts[0] + "&" + parts[1]
    transforms, _buttons = OculusReader.process_data(legacy)
    assert transforms is not None and {"l", "r"} <= set(transforms)


def test_patch_is_idempotent():
    oculus._patch_process_data(OculusReader)
    patched = OculusReader.process_data
    oculus._patch_process_data(OculusReader)
    assert OculusReader.process_data is patched
