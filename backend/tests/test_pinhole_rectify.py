"""Tests for the pinhole branch of the rectify helpers in app.api.routes."""
from __future__ import annotations

import numpy as np
import pytest

from app.api.routes import _new_K


def _synthetic_K(w=640, h=480, fx=500.0, fy=500.0):
    return np.array([[fx, 0.0, w / 2.0], [0.0, fy, h / 2.0], [0.0, 0.0, 1.0]], dtype=np.float64)


def _synthetic_D_pinhole(k1=-0.2, k2=0.05, p1=0.0, p2=0.0, k3=0.0):
    return np.array([k1, k2, p1, p2, k3], dtype=np.float64).reshape(-1, 1)


@pytest.mark.parametrize("alpha", [0.0, 0.5, 1.0])
def test_new_K_pinhole_returns_sane_matrix(alpha):
    K = _synthetic_K()
    D = _synthetic_D_pinhole()
    nK = _new_K("pinhole", K, D, 640, 480, alpha=alpha)
    assert nK.shape == (3, 3)
    assert nK[0, 0] > 0 and nK[1, 1] > 0
    # Principal point should land somewhere inside the image.
    assert 0 < nK[0, 2] < 640
    assert 0 < nK[1, 2] < 480


@pytest.mark.parametrize("alpha", [-1.0, 2.0, 1e9])
def test_new_K_pinhole_clamps_alpha(alpha):
    """Out-of-range alpha must not crash OpenCV — backend clamps to [0, 1]."""
    K = _synthetic_K()
    D = _synthetic_D_pinhole()
    nK = _new_K("pinhole", K, D, 640, 480, alpha=alpha)
    assert nK.shape == (3, 3)
    assert nK[0, 0] > 0 and nK[1, 1] > 0


def test_new_K_fisheye_unchanged():
    """Existing fisheye dispatch keeps producing a valid 3×3."""
    K = _synthetic_K()
    D = np.array([0.01, 0.0, 0.0, 0.0], dtype=np.float64).reshape(-1, 1)
    nK = _new_K("fisheye", K, D, 640, 480, balance=0.5, fov_scale=1.0)
    assert nK.shape == (3, 3)
    assert nK[0, 0] > 0 and nK[1, 1] > 0
