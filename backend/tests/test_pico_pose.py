"""PicoPoseSource maps xrobotoolkit_sdk's [x,y,z,qx,qy,qz,qw] poses to 4x4
matrices and skips momentarily-untracked devices. xrobotoolkit_sdk is stubbed
so these tests need no PICO hardware or PC Service."""
from __future__ import annotations

import math

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from app.sources.poses.pico import _pose7_to_4x4


def test_identity_quat_is_translation_only():
    m = _pose7_to_4x4([1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0])
    assert m is not None
    expected = [
        [1.0, 0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0, 2.0],
        [0.0, 0.0, 1.0, 3.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
    np.testing.assert_allclose(np.array(m), np.array(expected), atol=1e-9)


def test_rotation_matches_scipy():
    # 90 deg about Z, then translate.
    q = Rotation.from_euler("z", 90, degrees=True).as_quat()  # [qx,qy,qz,qw]
    m = _pose7_to_4x4([0.5, -0.5, 0.0, q[0], q[1], q[2], q[3]])
    R = np.array(m)[:3, :3]
    np.testing.assert_allclose(R, Rotation.from_quat(q).as_matrix(), atol=1e-9)
    assert [m[0][3], m[1][3], m[2][3]] == [0.5, -0.5, 0.0]


def test_zero_quaternion_returns_none():
    assert _pose7_to_4x4([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]) is None


def test_none_and_bad_length_return_none():
    assert _pose7_to_4x4(None) is None
    assert _pose7_to_4x4([1.0, 2.0, 3.0]) is None


import sys
import types


def _fake_xrt(left, right, head):
    m = types.ModuleType("xrobotoolkit_sdk")
    m.init = lambda: None
    m.close = lambda: None
    m.get_left_controller_pose = lambda: left
    m.get_right_controller_pose = lambda: right
    m.get_headset_pose = lambda: head
    return m


def _make_source(monkeypatch, fake):
    monkeypatch.setitem(sys.modules, "xrobotoolkit_sdk", fake)
    from app.sources.poses.pico import PicoPoseSource
    return PicoPoseSource()


def test_hello_lists_three_devices(monkeypatch):
    src = _make_source(monkeypatch, _fake_xrt(None, None, None))
    h = src.hello()
    assert h["devices"] == ["pico_ctrl_l", "pico_ctrl_r", "pico_hmd"]
    assert h["bases"] == 0


def test_poll_maps_all_devices(monkeypatch):
    src = _make_source(monkeypatch, _fake_xrt(
        [1, 0, 0, 0, 0, 0, 1], [0, 2, 0, 0, 0, 0, 1], [0, 0, 3, 0, 0, 0, 1]))
    out = src.poll(0.0)
    assert set(out) == {"pico_ctrl_l", "pico_ctrl_r", "pico_hmd"}
    assert out["pico_ctrl_l"][0][3] == 1.0
    assert out["pico_ctrl_r"][1][3] == 2.0
    assert out["pico_hmd"][2][3] == 3.0


def test_poll_skips_untracked_device(monkeypatch):
    # left zero-quat (untracked), head None — both skipped; right survives.
    src = _make_source(monkeypatch, _fake_xrt(
        [0, 0, 0, 0, 0, 0, 0], [5, 6, 7, 0, 0, 0, 1], None))
    out = src.poll(0.0)
    assert set(out) == {"pico_ctrl_r"}


def test_init_failure_raises_runtimeerror(monkeypatch):
    bad = types.ModuleType("xrobotoolkit_sdk")
    def _boom():
        raise OSError("PC Service not reachable")
    bad.init = _boom
    monkeypatch.setitem(sys.modules, "xrobotoolkit_sdk", bad)
    from app.sources.poses.pico import PicoPoseSource
    with pytest.raises(RuntimeError, match="PICO"):
        PicoPoseSource()


def test_missing_module_raises_runtimeerror(monkeypatch):
    monkeypatch.setitem(sys.modules, "xrobotoolkit_sdk", None)  # forces ImportError
    from app.sources.poses.pico import PicoPoseSource
    with pytest.raises(RuntimeError, match="INSTALL"):
        PicoPoseSource()
