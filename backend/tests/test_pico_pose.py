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
